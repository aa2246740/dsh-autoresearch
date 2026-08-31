import { parseEmbeddedState, type AutoresearchSnapshot } from '../types.js'

export type DockMode = 'hidden' | 'init' | 'waiting'
export type LabPage = 'create' | 'lab'
export type LabPhase = 'idle' | 'configuring' | 'running' | 'done'
export type CommandLifecycleKind = 'completed' | 'stopped' | 'idle'

export interface CommandLifecycleAck {
  sessionId: string
  kind: CommandLifecycleKind
  reason: string | null
  at: number
}

export interface ReadReceiptStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

const READ_RECEIPT_PREFIX = 'dsh-autoresearch.read.v1'

/** Init card fields only. Metric / direction / measure.sh are inferred after confirm. */
export interface ExperimentDraft {
  goal: string
  maxRuns: string
}

export const emptyDraft = (): ExperimentDraft => ({
  goal: '',
  maxRuns: '3',
})

export interface LabState {
  /** Reserved composer dock: hidden on the daily home; init before confirm; waiting is at most one alignment line. */
  dock: DockMode
  page: LabPage
  phase: LabPhase
  sessionId: string | null
  snapshot: AutoresearchSnapshot | null
  draft: ExperimentDraft
  error: string | null
  busy: boolean
  notice: string | null
  /** Previous rendered result hidden while an explicit new goal is preparing. */
  supersededProgressKey: string | null
  /** Immediate authoritative acknowledgement from this browser's slash command. */
  commandAck: CommandLifecycleAck | null
}

const initial: LabState = {
  dock: 'hidden',
  page: 'create',
  phase: 'idle',
  sessionId: null,
  snapshot: null,
  draft: emptyDraft(),
  error: null,
  busy: false,
  notice: null,
  supersededProgressKey: null,
  commandAck: null,
}

let state = initial
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function getLabState(): LabState {
  return state
}

export function subscribeLab(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function patchLab(patch: Partial<LabState>): void {
  state = { ...state, ...patch }
  emit()
}

export function resetLab(): void {
  state = { ...initial, draft: emptyDraft() }
  emit()
}

/** `/autoresearch` or slash 「新开」: show the init card. Does not activate the loop. */
export function showInitDock(): void {
  patchLab({
    dock: 'init',
    page: 'create',
    phase: 'configuring',
    draft: emptyDraft(),
    error: null,
    busy: false,
    supersededProgressKey: null,
    commandAck: null,
  })
}

/**
 * After 「确认并开始」: send the slash line, then leave the progress UI closed.
 * The agent may still ask about requirements; the board appears only after run/log.
 */
export function hideAfterConfirm(previousProgressKey: string | null = null): void {
  patchLab({
    dock: 'waiting',
    page: 'create',
    phase: 'idle',
    busy: false,
    error: null,
    supersededProgressKey: previousProgressKey,
  })
}

/** Hide the init/waiting dock. Progress cards are conversation-driven and ignore this. */
export function cancelInitDock(): void {
  if (state.dock !== 'init' && state.dock !== 'waiting') return
  patchLab({ dock: 'hidden', page: 'create', phase: 'idle', error: null, supersededProgressKey: null })
}

export function rememberSession(sessionId: string): void {
  if (state.sessionId === sessionId) return
  patchLab({ sessionId, supersededProgressKey: null, commandAck: null })
}

/**
 * The client command service emits this exact Host result after a local slash
 * submission settles. It bridges the short gap before a cold read/projection
 * refresh; durable truth remains in command/done and the controller sidecar.
 */
export function recordCommandAcknowledgement(sessionId: string, text: string): void {
  const completed = /^Autoresearch completed:\s*(.*)$/s.exec(text)
  if (completed) {
    patchLab({ commandAck: {
      sessionId,
      kind: 'completed',
      reason: completed[1]?.trim() || 'The verified goal is complete.',
      at: Date.now(),
    } })
    return
  }
  if (text === 'Autoresearch is off. Any pending automatic continuation was cancelled.') {
    patchLab({ commandAck: { sessionId, kind: 'stopped', reason: 'Stopped by the user.', at: Date.now() } })
    return
  }
  if (text === 'Autoresearch log cleared and automatic continuation stopped.') {
    patchLab({ commandAck: { sessionId, kind: 'idle', reason: null, at: Date.now() } })
    return
  }
  if (text.startsWith('Autoresearch is active.')) patchLab({ commandAck: null })
}

export function applyCommandAcknowledgement(
  snapshot: AutoresearchSnapshot | null,
  ack: CommandLifecycleAck | null,
  sessionId: string,
): AutoresearchSnapshot | null {
  if (!snapshot || !ack || ack.sessionId !== sessionId) return snapshot
  if (ack.kind === 'idle') return null
  return {
    ...snapshot,
    active: false,
    manualOff: ack.kind === 'stopped',
    loopState: ack.kind,
    completionReason: ack.reason,
    completedAt: ack.kind === 'completed' ? ack.at : null,
    decisionQuestion: null,
    pendingContinuation: false,
    updatedAt: Math.max(snapshot.updatedAt, ack.at),
  }
}

export function progressIdentity(snapshot: AutoresearchSnapshot): string {
  const segment = snapshot.currentSegment ?? snapshot.results.at(-1)?.segment ?? 0
  const epoch = snapshot.sessionEpoch ?? 0
  return [snapshot.workDir, epoch, segment, snapshot.name ?? snapshot.goal ?? 'autoresearch'].join('::')
}

/**
 * A read receipt belongs to one durable completion, not merely to the project.
 * `completedAt` is authoritative for current logs; `updatedAt` keeps imported
 * legacy completions distinguishable without making ordinary UI reads mutable.
 */
export function completionIdentity(snapshot: AutoresearchSnapshot): string {
  const completedAt = snapshot.completedAt ?? snapshot.updatedAt ?? 0
  return `${progressIdentity(snapshot)}::completed@${completedAt}`
}

export function completionReceiptKey(sessionId: string): string {
  return `${READ_RECEIPT_PREFIX}:${sessionId}`
}

function browserReadReceiptStorage(): ReadReceiptStorage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage
  } catch {
    return null
  }
}

export function isCompletionUnread(
  sessionId: string,
  snapshot: AutoresearchSnapshot,
  storage: ReadReceiptStorage | null = browserReadReceiptStorage(),
): boolean {
  if (!storage) return true
  try {
    return storage.getItem(completionReceiptKey(sessionId)) !== completionIdentity(snapshot)
  } catch {
    return true
  }
}

export function markCompletionRead(
  sessionId: string,
  snapshot: AutoresearchSnapshot,
  storage: ReadReceiptStorage | null = browserReadReceiptStorage(),
): string {
  const identity = completionIdentity(snapshot)
  try {
    storage?.setItem(completionReceiptKey(sessionId), identity)
  } catch {
    // Storage can be unavailable in privacy-restricted contexts. The caller
    // still keeps the identity in React state for this page lifetime.
  }
  return identity
}

/**
 * Legacy parser for old logs that still carry AUTORESEARCH_STATE_V1.
 * Must not open a progress dock — confirm/status/init snapshots stay off the board.
 */
export function applyCommandText(text: string): AutoresearchSnapshot | undefined {
  const parsed = parseEmbeddedState(text)
  if (parsed.snapshot) {
    patchLab({
      snapshot: parsed.snapshot,
      error: null,
      notice: parsed.text,
    })
  }
  return parsed.snapshot
}

export function parseRoundBudget(raw: string): number | null {
  const parsed = Number.parseInt(String(raw).trim(), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/** Never expose internal process/Git failures in the beginner start card. */
export function friendlyStartError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  if (/没有活动会话|请填写目标|轮次必须|项目目录不可用|特殊路径无法自动保护/.test(raw)) return raw
  return '自动准备没有完成，但项目和会话都没有损坏。请再点一次“确认并开始”；如果仍未完成，请重新打开目标项目会话。'
}

/** A recoverable decision keeps the confirmation card open instead of looking successful. */
export function startDecisionMessage(text: string): string | null {
  return /项目目录不可用|特殊路径无法自动保护/.test(text) ? text : null
}

/**
 * Command sent only after 「确认并开始」.
 * Goal is natural language; rounds become maxIterations via `for N runs`.
 * Metric / direction / allowNoGit are not encoded — the agent infers them after confirm.
 */
export function buildStartLine(draft: ExperimentDraft): string {
  const goal = draft.goal.trim()
  const runs = parseRoundBudget(draft.maxRuns) ?? 3
  return `/autoresearch ${goal} for ${runs} runs`
}
