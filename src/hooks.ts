import { spawn } from 'node:child_process'
import fs from 'node:fs'

import { hasAutoresearchConfigHeader } from './jsonl.js'
import { hookScriptPath } from './paths.js'

export const HOOK_TIMEOUT_MS = 30_000
export const HOOK_STDOUT_MAX_BYTES = 8 * 1024
const TRUNCATION_MARKER = '\n...[truncated: hook stdout exceeded 8KB]'

export interface HookPayload {
  event: 'before' | 'after'
  cwd: string
  [key: string]: unknown
}

export interface HookResult {
  fired: boolean
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

function executable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

function truncateUtf8(buffer: Buffer, maxBytes: number): Buffer {
  if (buffer.length <= maxBytes) return buffer
  let kept = buffer.subarray(0, maxBytes)
  const newline = kept.lastIndexOf(0x0a)
  if (newline >= 0) return kept.subarray(0, newline + 1)
  while (kept.length > 0 && (kept[kept.length - 1]! & 0xc0) === 0x80) {
    kept = kept.subarray(0, kept.length - 1)
  }
  if (kept.length > 0 && (kept[kept.length - 1]! & 0xc0) === 0xc0) {
    kept = kept.subarray(0, kept.length - 1)
  }
  return kept
}

export async function runHook(payload: HookPayload, { timeoutMs = HOOK_TIMEOUT_MS } = {}): Promise<HookResult> {
  const script = hookScriptPath(payload.cwd, payload.event)
  if (!executable(script)) {
    return { fired: false, stdout: '', stderr: '', exitCode: null, timedOut: false, durationMs: 0 }
  }

  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn('bash', [script], {
      cwd: payload.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return
      const remaining = HOOK_STDOUT_MAX_BYTES - stdoutBytes
      if (chunk.length <= remaining) {
        stdout.push(chunk)
        stdoutBytes += chunk.length
      } else {
        stdout.push(truncateUtf8(chunk, Math.max(0, remaining)))
        truncated = true
      }
    })
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk))

    const finish = (exitCode: number | null, extraError = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      let out = Buffer.concat(stdout).toString('utf8')
      if (truncated) out += TRUNCATION_MARKER
      const err = Buffer.concat(stderr).toString('utf8')
      resolve({
        fired: true,
        stdout: out,
        stderr: extraError ? [err, extraError].filter(Boolean).join('\n') : err,
        exitCode,
        timedOut,
        durationMs: Date.now() - startedAt,
      })
    }

    child.on('error', (error) => finish(null, error.message))
    child.on('close', (code) => finish(code))
    child.stdin.end(JSON.stringify(payload))
  })
}

export function steerMessageFor(stage: string, result: HookResult): string | null {
  if (!result.fired) return null
  if (result.timedOut) return `[${stage} hook timed out after ${HOOK_TIMEOUT_MS / 1000}s]`
  if (result.exitCode !== 0) {
    return [
      `[${stage} hook exited ${result.exitCode}]`,
      result.stderr.trim(),
      result.stdout.trim(),
    ].filter(Boolean).join('\n')
  }
  return result.stdout.trim() || null
}

export function hookLogEntry(stage: string, result: HookResult): Record<string, unknown> {
  return {
    type: 'hook',
    stage,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout_bytes: Buffer.byteLength(result.stdout, 'utf8'),
    timed_out: result.timedOut,
  }
}

export function appendHookLogEntryIfConfigured(jsonlPath: string, stage: string, result: HookResult): boolean {
  if (!result.fired || !fs.existsSync(jsonlPath)) return false
  try {
    if (!hasAutoresearchConfigHeader(fs.readFileSync(jsonlPath, 'utf8'))) return false
    fs.appendFileSync(jsonlPath, `${JSON.stringify(hookLogEntry(stage, result))}\n`)
    return true
  } catch {
    return false
  }
}
