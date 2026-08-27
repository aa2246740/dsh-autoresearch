import { parseEmbeddedState, type AutoresearchSnapshot } from '../types.js'

export type LabPage = 'create' | 'confirm' | 'lab'
export type LabPhase = 'idle' | 'configuring' | 'running' | 'done'

export interface ExperimentDraft {
  goal: string
  provider: string
  model: string
  modelLabel: string
  maxRuns: string
  metricName: string
  direction: 'lower' | 'higher'
  success: string
  allowNoGit: boolean
}

export const emptyDraft = (): ExperimentDraft => ({
  goal: '',
  provider: 'minimax-cn',
  model: 'MiniMax-M2.7',
  modelLabel: 'MiniMax CN / MiniMax-M2.7',
  maxRuns: '3',
  metricName: 'errors',
  direction: 'lower',
  success: 'errors 降到 0',
  allowNoGit: false,
})

export interface LabState {
  open: boolean
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
  open: false,
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

export function openLab(page: LabPage = 'create'): void {
  const phase = page === 'lab' ? state.phase : 'configuring'
  patchLab({ open: true, page, phase, error: null })
}

export function closeLab(): void {
  patchLab({ open: false })
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
    patchLab({ snapshot: parsed.snapshot, error: null, notice: parsed.text, phase })
  }
  return parsed.snapshot
}

export function formatMetric(snapshot: AutoresearchSnapshot | null, value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const unit = snapshot?.metricUnit ?? ''
  return `${Number.isInteger(value) ? String(value) : value.toFixed(3)}${unit}`
}

export function buildStartLine(draft: ExperimentDraft): string {
  const bits = [
    draft.goal.trim(),
    draft.success.trim() ? `成功标准：${draft.success.trim()}` : '',
    `for ${draft.maxRuns.trim() || '3'} runs`,
    `metric ${draft.metricName.trim() || 'errors'}`,
    draft.direction === 'higher' ? 'higher is better' : 'lower is better',
  ]
  if (draft.allowNoGit) bits.push('allowNoGit')
  return `/autoresearch ${bits.filter(Boolean).join(' ')}`
}
