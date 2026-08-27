import { parseEmbeddedState, type AutoresearchSnapshot } from '../types.js'

export type DockMode = 'hidden' | 'init' | 'run'
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
  /** Reserved composer dock: hidden on the daily home, init or run after `/autoresearch`. */
  dock: DockMode
  /** Optional larger view. Default off so Agent output stays visible. */
  overlayOpen: boolean
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
  overlayOpen: false,
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
    overlayOpen: false,
    page: 'create',
    phase: 'configuring',
    draft: emptyDraft(),
    error: null,
    busy: false,
  })
}

/** Same reserved dock, run-monitor state. Overlay stays closed unless asked. */
export function showRunDock(): void {
  const running = state.snapshot?.active === true
  const done = (state.snapshot?.totalRuns ?? 0) > 0 && !running
  patchLab({
    dock: 'run',
    page: 'lab',
    phase: running ? 'running' : done ? 'done' : state.phase === 'configuring' ? 'running' : state.phase,
    error: null,
  })
}

export function openOverlay(): void {
  patchLab({ overlayOpen: true, page: 'lab', error: null })
}

export function closeOverlay(): void {
  patchLab({ overlayOpen: false })
}

/** Hide the init dock. Running monitor stays up (长显). */
export function cancelInitDock(): void {
  if (state.dock === 'run' || state.phase === 'running') return
  patchLab({ dock: 'hidden', overlayOpen: false, page: 'create', phase: 'idle', error: null })
}

export function rememberSession(sessionId: string): void {
  if (state.sessionId === sessionId) return
  patchLab({ sessionId })
}

export function applyCommandText(text: string): AutoresearchSnapshot | undefined {
  const parsed = parseEmbeddedState(text)
  if (parsed.snapshot) {
    const active = parsed.snapshot.active
    const hasRuns = (parsed.snapshot.totalRuns ?? 0) > 0
    const phase: LabPhase = active ? 'running' : hasRuns ? 'done' : state.phase === 'configuring' ? 'configuring' : 'idle'
    const dock: DockMode = state.dock === 'init' && !active ? 'init' : (active || hasRuns || state.dock === 'run' ? 'run' : state.dock)
    patchLab({
      snapshot: parsed.snapshot,
      error: null,
      notice: parsed.text,
      phase,
      dock,
      page: dock === 'run' ? 'lab' : state.page,
    })
  }
  return parsed.snapshot
}

export function formatMetric(snapshot: AutoresearchSnapshot | null, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const unit = snapshot?.metricUnit ?? ''
  return `${Number.isInteger(value) ? String(value) : value.toFixed(3)}${unit}`
}

export function parseRoundBudget(raw: string): number | null {
  const parsed = Number.parseInt(String(raw).trim(), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
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
