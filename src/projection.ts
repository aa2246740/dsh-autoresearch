import type { AutoresearchProjectionState, AutoresearchSnapshot } from './types.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function snapshotFromMeta(meta: unknown): AutoresearchSnapshot | null {
  if (!isRecord(meta)) return null
  if (Array.isArray(meta.results) && typeof meta.metricName === 'string') {
    return meta as unknown as AutoresearchSnapshot
  }
  if (meta.snapshot) return snapshotFromMeta(meta.snapshot)
  return null
}

/** Identity schema: host registry requires `.parse`; values are already JSON snapshots. */
export const autoresearchProjectionSchema = {
  parse(value: unknown): AutoresearchSnapshot | null {
    if (value == null) return null
    return snapshotFromMeta(value)
  },
}

export const autoresearchProjectionStateSchema = {
  parse(value: unknown): AutoresearchProjectionState {
    if (!isRecord(value)) throw new Error('autoresearch projection state must be an object')
    const snapshot = autoresearchProjectionSchema.parse(value.snapshot)
    if (!isRecord(value.pendingCommands)) throw new Error('autoresearch pending commands must be an object')
    if (typeof value.boardReady !== 'boolean') throw new Error('autoresearch boardReady must be a boolean')
    const pendingCommands: Record<string, string> = {}
    for (const [id, args] of Object.entries(value.pendingCommands)) {
      if (typeof args !== 'string') throw new Error(`autoresearch pending command ${id} must be a string`)
      pendingCommands[id] = args
    }
    return { snapshot, pendingCommands, boardReady: value.boardReady }
  },
}

export function initialAutoresearchProjectionState(): AutoresearchProjectionState {
  return { snapshot: null, pendingCommands: {}, boardReady: false }
}

export function ledgerLength(snapshot: AutoresearchSnapshot | null | undefined): number {
  return snapshot?.results?.length ?? 0
}

/** Keep the longer ledger; equal length prefers the later `updatedAt`. */
export function longerSnapshot(
  current: AutoresearchSnapshot | null | undefined,
  next: AutoresearchSnapshot | null | undefined,
): AutoresearchSnapshot | null {
  if (!next) return current ?? null
  if (!current) return next
  const nextEpoch = next.sessionEpoch ?? 0
  const currentEpoch = current.sessionEpoch ?? 0
  if (nextEpoch > currentEpoch) return next
  if (nextEpoch < currentEpoch) return current
  const nextSegment = next.currentSegment ?? next.results.at(-1)?.segment ?? 0
  const currentSegment = current.currentSegment ?? current.results.at(-1)?.segment ?? 0
  if (nextSegment > currentSegment) return next
  if (nextSegment < currentSegment) return current
  const nextLen = ledgerLength(next)
  const currentLen = ledgerLength(current)
  if (nextLen > currentLen) return next
  if (nextLen < currentLen) return current
  if ((next.updatedAt ?? 0) >= (current.updatedAt ?? 0)) return next
  return current
}

/**
 * Host session projection fold. Later tool/result metas with a longer ledger
 * replace earlier ones so the GUI can follow .auto/log.jsonl without polling
 * /autoresearch status into the transcript.
 */
export function foldAutoresearchSnapshot(
  state: AutoresearchSnapshot | null,
  event: { type: string; data?: unknown },
): AutoresearchSnapshot | null {
  if (event.type === 'autoresearch/state') {
    return snapshotFromMeta(event.data) ?? state
  }
  if (event.type === 'tool/result') {
    const snapshot = snapshotFromMeta(isRecord(event.data) ? event.data.meta : undefined)
    if (!snapshot) return state
    const next = longerSnapshot(state, snapshot)
    return next === state ? state : next
  }
  return state
}

function commandData(event: { data?: unknown }): Record<string, unknown> | null {
  return isRecord(event.data) ? event.data : null
}

function containsLoggedMarker(value: unknown): boolean {
  if (typeof value === 'string') return /(?:^|\n)Logged #\d+:/.test(value)
  if (Array.isArray(value)) return value.some(containsLoggedMarker)
  if (!isRecord(value)) return false
  return Object.values(value).some(containsLoggedMarker)
}

function commandStartsNewBoard(rawArgs: string): boolean {
  const raw = rawArgs.trim().toLowerCase()
  if (!raw || /^(help|status|off|complete|clear|export|finalize|hooks)\b/.test(raw)) return false
  return !/^resume\s*$/.test(raw)
}

function commandLifecycleSnapshot(
  snapshot: AutoresearchSnapshot | null,
  rawArgs: string,
  eventTime: number | undefined,
): AutoresearchSnapshot | null {
  if (!snapshot) return null
  const raw = rawArgs.trim()
  const lower = raw.toLowerCase()
  const updatedAt = Number.isFinite(eventTime) ? Number(eventTime) : snapshot.updatedAt + 1
  if (!raw || /^(help|status|export|finalize|hooks)\b/.test(lower)) return snapshot
  if (lower === 'clear') return null
  if (lower === 'off') {
    return {
      ...snapshot,
      active: false,
      manualOff: true,
      loopState: 'stopped',
      completionReason: 'Stopped by the user.',
      completedAt: null,
      decisionQuestion: null,
      pendingContinuation: false,
      updatedAt,
    }
  }
  if (lower === 'complete' || lower.startsWith('complete ')) {
    return {
      ...snapshot,
      active: false,
      manualOff: false,
      loopState: 'completed',
      completionReason: raw.slice('complete'.length).trim() || 'The verified goal is complete.',
      completedAt: updatedAt,
      decisionQuestion: null,
      pendingContinuation: false,
      updatedAt,
    }
  }
  if (/^resume\s*$/.test(lower)) {
    return {
      ...snapshot,
      active: true,
      manualOff: false,
      loopState: 'active',
      completionReason: null,
      completedAt: null,
      decisionQuestion: null,
      pendingContinuation: false,
      updatedAt,
    }
  }

  const goal = raw.replace(/^start\s*/i, '').trim()
  if (!goal) return snapshot
  return {
    ...snapshot,
    active: true,
    manualOff: false,
    loopState: 'active',
    completionReason: null,
    completedAt: null,
    decisionQuestion: null,
    pendingContinuation: false,
    pendingNewGoal: true,
    goal,
    sessionEpoch: snapshot.sessionEpoch + 1,
    currentSegment: snapshot.currentSegment + 1,
    currentSegmentRuns: 0,
    baselineMetric: null,
    bestKeptMetric: null,
    lastStatus: null,
    updatedAt,
  }
}

/**
 * External plugins cannot add required custom event types to DSH's closed
 * persistence vocabulary. Fold official command lifecycle events instead;
 * legacy autoresearch/state records remain readable only after the migration
 * marks their envelopes ignorable.
 */
export function foldAutoresearchProjection(
  state: AutoresearchProjectionState,
  event: { type: string; time?: number; data?: unknown },
): AutoresearchProjectionState {
  const snapshot = foldAutoresearchSnapshot(state.snapshot, event)
  if (snapshot !== state.snapshot) {
    const legacyBoard = event.type === 'autoresearch/state' && (snapshot?.results.length ?? 0) > 0
    const loggedBoard = event.type === 'tool/result'
      && containsLoggedMarker(commandData(event)?.message)
    return { ...state, snapshot, boardReady: state.boardReady || legacyBoard || loggedBoard }
  }

  const data = commandData(event)
  if (event.type === 'command/run' && data?.name === 'autoresearch'
    && typeof data.commandId === 'string') {
    const args = typeof data.args === 'string' ? data.args : ''
    return {
      snapshot: state.snapshot,
      pendingCommands: { ...state.pendingCommands, [data.commandId]: args },
      boardReady: state.boardReady,
    }
  }
  if (event.type !== 'command/done' || typeof data?.commandId !== 'string') return state
  const rawArgs = state.pendingCommands[data.commandId]
  if (rawArgs === undefined) return state
  const pendingCommands = { ...state.pendingCommands }
  delete pendingCommands[data.commandId]
  return {
    snapshot: data.kind === 'success'
      ? commandLifecycleSnapshot(state.snapshot, rawArgs, event.time)
      : state.snapshot,
    pendingCommands,
    boardReady: data.kind === 'success' && (rawArgs.trim().toLowerCase() === 'clear' || commandStartsNewBoard(rawArgs))
      ? false
      : state.boardReady,
  }
}

/**
 * Upgrade a conversation log snapshot with a longer projected ledger.
 * Never invent a progress board from projection alone (status/init leftovers).
 */
export function preferLedgerSnapshot(
  conversation: AutoresearchSnapshot | null | undefined,
  projected: AutoresearchSnapshot | null | undefined,
): AutoresearchSnapshot | null {
  if (ledgerLength(conversation) === 0) return conversation ?? null
  if (!projected) return conversation ?? null
  const terminal = projected.loopState === 'completed'
    || projected.loopState === 'stopped'
    || projected.loopState === 'blocked'
  const projectedSegment = projected.currentSegment ?? projected.results.at(-1)?.segment ?? 0
  const projectedCurrentRuns = projected.results.filter((run) => run.segment === projectedSegment).length
  // v1.0.2 and earlier could mistake a natural-language goal for a second
  // start, leaving a higher-epoch, zero-run shell in the projection cache.
  // A later official complete/off command correctly owns lifecycle truth, but
  // that shell must never replace a longer real ledger recovered from the
  // conversation. Overlay only the terminal fields; an *active* zero-run new
  // goal still supersedes the old board through the ordinary epoch rule.
  if (conversation && terminal && projectedCurrentRuns === 0) {
    return {
      ...conversation,
      active: false,
      manualOff: projected.manualOff,
      loopState: projected.loopState,
      completionReason: projected.completionReason,
      completedAt: projected.completedAt,
      decisionQuestion: null,
      pendingContinuation: false,
      updatedAt: Math.max(conversation.updatedAt, projected.updatedAt),
    }
  }
  if (conversation?.name && projected?.name && conversation.name !== projected.name) {
    const projectedEpoch = projected.sessionEpoch ?? 0
    const conversationEpoch = conversation.sessionEpoch ?? 0
    if (projectedEpoch <= conversationEpoch) return conversation
  }
  return longerSnapshot(conversation, projected)
}
