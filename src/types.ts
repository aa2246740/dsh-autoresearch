import type { ExperimentRun, ExperimentStatus, MetricDirection, PersistedState } from './jsonl.js'

export type { ExperimentRun, ExperimentStatus, MetricDirection, PersistedState, AsiNotes } from './jsonl.js'

export type AutoresearchLoopState = 'idle' | 'active' | 'awaiting_user' | 'completed' | 'stopped' | 'blocked'

export interface AutoresearchConfig {
  workingDir?: string
  maxIterations?: number | null
  maxAutoResumeTurns?: number | null
  allowNoGit?: boolean
  hints?: {
    enabled?: boolean
    provider?: string
    model?: string
    maxRecentRuns?: number
    maxCallsPerSession?: number
    timeoutSeconds?: number
  }
}

export interface PrivateState {
  version: number
  cwd: string
  workDir: string
  /** Monotonic identity for each explicit new goal in this workspace. */
  sessionEpoch: number
  /** The explicit user goal for the current epoch, before/after experiment init. */
  goal: string | null
  /** A new goal exists but has not appended its config header yet. */
  pendingNewGoal: boolean
  active: boolean
  manualOff: boolean
  /** Durable lifecycle truth. `active` remains for backward compatibility. */
  loopState: AutoresearchLoopState
  completionReason: string | null
  completedAt: number | null
  decisionQuestion: string | null
  autoResumeTurns: number
  pendingResumeToken: string | null
  hintsThisSession: number
  lastRunChecks: { pass: boolean; output: string; duration: number } | null
  lastRunDuration: number | null
  protectedPaths: string[]
  protectionMode: 'pending' | 'git' | 'snapshot'
  updatedAt: number
  resumedAt?: number
}

export interface ResumePlan {
  shouldSchedule: boolean
  command: string | null
  token: string | null
  turn?: number
}

export interface ToolResult {
  ok: boolean
  text: string
  active?: boolean
  needsSetup?: boolean
  needsDecision?: boolean
  action?: string
  code?: string
  warning?: string | null
  hookMessage?: string | null
  configNotes?: string[]
  pendingContinuation?: boolean
  manualOff?: boolean
  loopState?: AutoresearchLoopState
  completionReason?: string | null
  completedAt?: number | null
  decisionQuestion?: string | null
  pendingNewGoal?: boolean
  sessionEpoch?: number
  currentSegmentRuns?: number
  totalRuns?: number
  bestKeptMetric?: number | null
  metricName?: string
  resume?: ResumePlan
  state?: PersistedState
  details?: Record<string, unknown>
  snapshot?: AutoresearchSnapshot
}

export interface AutoresearchSnapshot {
  cwd: string
  workDir: string
  active: boolean
  manualOff: boolean
  loopState: AutoresearchLoopState
  completionReason: string | null
  completedAt: number | null
  decisionQuestion: string | null
  pendingNewGoal: boolean
  needsSetup: boolean
  pendingContinuation: boolean
  gitOk: boolean
  gitError: string | null
  allowNoGit: boolean
  protectionMode: 'pending' | 'git' | 'snapshot'
  protectedPathCount: number
  goal: string | null
  sessionEpoch: number
  name: string | null
  metricName: string
  metricUnit: string
  direction: MetricDirection
  maxIterations: number | null
  maxAutoResumeTurns: number | null
  currentSegment: number
  currentSegmentRuns: number
  totalRuns: number
  baselineMetric: number | null
  bestKeptMetric: number | null
  lastStatus: ExperimentStatus | null
  results: ExperimentRun[]
  promptExists: boolean
  measureExists: boolean
  checksExists: boolean
  updatedAt: number
  /** Projection-only evidence that this session logged at least one real experiment. */
  boardReady?: boolean
}

export interface AutoresearchProjectionState {
  snapshot: AutoresearchSnapshot | null
  pendingCommands: Record<string, string>
  boardReady: boolean
}

export const STATE_MARKER = 'AUTORESEARCH_STATE_V1'
export const CONTINUE_MARKER = 'AUTORESEARCH_CONTINUE'
export const CONTINUATION_REQUIRED = 'AUTORESEARCH_CONTINUATION_REQUIRED'

/** Drop undefined keys and non-finite numbers so tool results pass harness JSON snapshotting. */
export function toJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Kept so old transcripts can still be parsed. New tool/command text must not use this. */
export function embedState(text: string, snapshot: AutoresearchSnapshot): string {
  return `${text}\n\n${STATE_MARKER} ${JSON.stringify(snapshot)}`
}

export function parseEmbeddedState(text: string): { text: string; snapshot?: AutoresearchSnapshot } {
  const idx = text.lastIndexOf(STATE_MARKER)
  if (idx < 0) return { text }
  const json = text.slice(idx + STATE_MARKER.length).trim()
  try {
    return { text: text.slice(0, idx).trim(), snapshot: JSON.parse(json) as AutoresearchSnapshot }
  } catch {
    return { text }
  }
}
