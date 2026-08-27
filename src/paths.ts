import fs from 'node:fs'
import path from 'node:path'

export const AUTO_DIR = '.auto'

const CURRENT_HOOKS_DIR = 'hooks'
const LEGACY_HOOKS_DIR = 'autoresearch.hooks'

const SESSION_FILE_NAMES = {
  log: { current: 'log.jsonl', legacy: 'autoresearch.jsonl' },
  prompt: { current: 'prompt.md', legacy: 'autoresearch.md' },
  ideas: { current: 'ideas.md', legacy: 'autoresearch.ideas.md' },
  checks: { current: 'checks.sh', legacy: 'autoresearch.checks.sh' },
  measure: { current: 'measure.sh', legacy: 'autoresearch.sh' },
  config: { current: 'config.json', legacy: 'autoresearch.config.json' },
} as const

export type SessionFileKind = keyof typeof SESSION_FILE_NAMES

function currentSessionPath(dir: string, kind: SessionFileKind): string {
  return path.join(dir, AUTO_DIR, SESSION_FILE_NAMES[kind].current)
}

function legacySessionPath(dir: string, kind: SessionFileKind): string {
  return path.join(dir, SESSION_FILE_NAMES[kind].legacy)
}

function currentLayoutExists(dir: string): boolean {
  for (const kind of Object.keys(SESSION_FILE_NAMES) as SessionFileKind[]) {
    if (fs.existsSync(currentSessionPath(dir, kind))) return true
  }
  return fs.existsSync(path.join(dir, AUTO_DIR, CURRENT_HOOKS_DIR))
}

export function sessionFileCandidates(dir: string, kind: SessionFileKind): { current: string; legacy: string } {
  if (!SESSION_FILE_NAMES[kind]) throw new Error(`Unknown autoresearch session file kind: ${kind}`)
  return {
    current: currentSessionPath(dir, kind),
    legacy: legacySessionPath(dir, kind),
  }
}

export function sessionFilePath(dir: string, kind: SessionFileKind): string {
  const candidates = sessionFileCandidates(dir, kind)
  if (currentLayoutExists(dir)) return candidates.current
  return fs.existsSync(candidates.legacy) ? candidates.legacy : candidates.current
}

export function hookScriptPath(workDir: string, stage: 'before' | 'after'): string {
  if (stage !== 'before' && stage !== 'after') {
    throw new Error(`Unknown autoresearch hook stage: ${stage}`)
  }
  const current = path.join(workDir, AUTO_DIR, CURRENT_HOOKS_DIR, `${stage}.sh`)
  const legacy = path.join(workDir, LEGACY_HOOKS_DIR, `${stage}.sh`)
  if (currentLayoutExists(workDir)) return current
  return fs.existsSync(legacy) ? legacy : current
}

export function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
}
