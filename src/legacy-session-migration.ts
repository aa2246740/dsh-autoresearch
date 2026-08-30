import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { markAutoresearchStateEventsIgnorable } from './recovery.js'

interface SessionHeaderLike {
  id: string
  cwd?: string
}

export interface SessionPersistenceLike {
  supportsRawArtifacts: boolean
  list(): Promise<SessionHeaderLike[]>
  readRaw(id: string): Promise<{ meta: SessionHeaderLike; content: string } | undefined>
  locate(meta: SessionHeaderLike): { kind: string; path: string } | undefined
  inspect(id: string): Promise<unknown>
}

export interface LegacySessionMigrationReport {
  alreadyComplete: boolean
  scanned: number
  repaired: Array<{ sessionId: string; eventSeqs: number[]; backupPath: string }>
  failures: Array<{ sessionId: string; error: string }>
  markerPath: string
}

interface MigrationOptions {
  dshHome?: string
  markerPath?: string
  candidateCwds?: ReadonlySet<string>
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function statIdentity(filePath: string): string {
  const stat = fs.statSync(filePath, { bigint: true })
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs].join(':')
}

function configuredCwds(dshHome: string): Set<string> {
  const root = path.join(dshHome, 'autoresearch', 'state')
  const result = new Set<string>()
  let entries: fs.Dirent[]
  try { entries = fs.readdirSync(root, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result
    throw error
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    try {
      const value = JSON.parse(fs.readFileSync(path.join(root, entry.name), 'utf8')) as { cwd?: unknown }
      if (typeof value.cwd === 'string' && value.cwd) result.add(path.resolve(value.cwd))
    } catch {
      // A malformed sidecar cannot authorize touching an unrelated session.
    }
  }
  return result
}

function encodeCandidate(content: string, targetPath: string): Buffer {
  if (!targetPath.endsWith('.zstd')) return Buffer.from(content)
  const boundary = content.indexOf('\n')
  if (boundary < 0) throw new Error('session JSONL has no header boundary')
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  const header = Buffer.from(content.slice(0, boundary + 1))
  const body = Buffer.from(content.slice(boundary + 1))
  const headerFrame = zstdCompressSync(header, options)
  const bodyFrame = zstdCompressSync(body, options)
  const decoded = Buffer.concat([
    zstdDecompressSync(headerFrame),
    zstdDecompressSync(bodyFrame),
  ]).toString('utf8')
  if (decoded !== content) throw new Error('Zstandard candidate did not round-trip exactly')
  return Buffer.concat([headerFrame, bodyFrame])
}

function writeAtomic(filePath: string, bytes: Buffer): void {
  const dir = path.dirname(filePath)
  const temp = path.join(dir, `.${path.basename(filePath)}.autoresearch-${process.pid}-${Date.now()}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(temp, filePath)
    const dirFd = fs.openSync(dir, 'r')
    try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}

function ensureBackup(targetPath: string, original: Buffer): string {
  const backupPath = `${targetPath}.autoresearch-state-v1-${sha256(original).slice(0, 12)}.bak`
  try {
    fs.copyFileSync(targetPath, backupPath, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(backupPath, 0o600)
    const backupFd = fs.openSync(backupPath, 'r')
    try { fs.fsyncSync(backupFd) } finally { fs.closeSync(backupFd) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!fs.readFileSync(backupPath).equals(original)) {
      throw new Error(`existing migration backup does not match ${targetPath}`)
    }
  }
  return backupPath
}

function writeMarker(markerPath: string, report: LegacySessionMigrationReport): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 })
  writeAtomic(markerPath, Buffer.from(`${JSON.stringify({
    version: 1,
    completedAt: Date.now(),
    scanned: report.scanned,
    repaired: report.repaired,
  }, null, 2)}\n`))
}

/**
 * One-time, fail-closed migration for the plugin's two historical custom
 * state events. Every modified raw log gets a byte-exact backup, an atomic
 * replacement, and a full validation through the active DSH persistence
 * implementation. Future versions never write this custom event again.
 */
export async function migrateLegacyAutoresearchSessions(
  persistence: SessionPersistenceLike,
  options: MigrationOptions = {},
): Promise<LegacySessionMigrationReport> {
  const dshHome = path.resolve(options.dshHome
    ?? (process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh')))
  const markerPath = path.resolve(options.markerPath
    ?? path.join(dshHome, 'autoresearch', 'migrations', 'ignorable-state-v1.json'))
  const report: LegacySessionMigrationReport = {
    alreadyComplete: fs.existsSync(markerPath),
    scanned: 0,
    repaired: [],
    failures: [],
    markerPath,
  }
  if (report.alreadyComplete) return report
  if (!persistence.supportsRawArtifacts) {
    report.failures.push({ sessionId: '*', error: 'active persistence backend has no per-session raw artifacts' })
    return report
  }

  const cwds = options.candidateCwds ?? configuredCwds(dshHome)
  const headers = (await persistence.list()).filter(header => (
    typeof header.cwd === 'string' && cwds.has(path.resolve(header.cwd))
  ))
  for (const header of headers) {
    report.scanned += 1
    try {
      const location = persistence.locate(header)
      if (location?.kind !== 'jsonl') throw new Error('session is not backed by a JSONL artifact')
      const beforeRead = statIdentity(location.path)
      const artifact = await persistence.readRaw(header.id)
      if (!artifact) continue
      const afterRead = statIdentity(location.path)
      if (beforeRead !== afterRead) throw new Error('session changed while the migration was reading it')
      const transformed = markAutoresearchStateEventsIgnorable(artifact.content)
      if (transformed.sessionId !== header.id) throw new Error('session identity changed while reading the raw artifact')
      if (transformed.markedEventSeqs.length === 0) continue

      const original = fs.readFileSync(location.path)
      if (afterRead !== statIdentity(location.path)) throw new Error('session changed before the migration could publish')
      const candidate = encodeCandidate(transformed.jsonl, location.path)
      const backupPath = ensureBackup(location.path, original)
      try {
        writeAtomic(location.path, candidate)
        await persistence.inspect(header.id)
      } catch (error) {
        writeAtomic(location.path, original)
        throw new Error(`official DSH validation rejected the migrated session: ${error instanceof Error ? error.message : String(error)}`)
      }
      report.repaired.push({
        sessionId: header.id,
        eventSeqs: transformed.markedEventSeqs,
        backupPath,
      })
    } catch (error) {
      report.failures.push({ sessionId: header.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (report.failures.length === 0) writeMarker(markerPath, report)
  return report
}
