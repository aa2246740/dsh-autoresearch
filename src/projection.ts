import type { AutoresearchSnapshot } from './types.js'

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
export function foldAutoresearchProjection(
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
  if (conversation?.name && projected?.name && conversation.name !== projected.name) {
    const projectedEpoch = projected.sessionEpoch ?? 0
    const conversationEpoch = conversation.sessionEpoch ?? 0
    if (projectedEpoch <= conversationEpoch) return conversation
  }
  return longerSnapshot(conversation, projected)
}
