import { parseEmbeddedState, type AutoresearchSnapshot } from '../types.js'

export type DockMode = 'hidden' | 'init' | 'waiting'
export type LabPage = 'create' | 'lab'
export type LabPhase = 'idle' | 'configuring' | 'running' | 'done'

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
  })
}

/**
 * After 「确认并开始」: send the slash line, then leave the progress UI closed.
 * The agent may still ask about requirements; the board appears only after run/log.
 */
export function hideAfterConfirm(): void {
  patchLab({
    dock: 'waiting',
    page: 'create',
    phase: 'idle',
    busy: false,
    error: null,
  })
}

/** Hide the init/waiting dock. Progress cards are conversation-driven and ignore this. */
export function cancelInitDock(): void {
  if (state.dock !== 'init' && state.dock !== 'waiting') return
  patchLab({ dock: 'hidden', page: 'create', phase: 'idle', error: null })
}

export function rememberSession(sessionId: string): void {
  if (state.sessionId === sessionId) return
  patchLab({ sessionId })
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
