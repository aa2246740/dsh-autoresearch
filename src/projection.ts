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
    const next = snapshot.results?.length ?? 0
    const prev = state?.results?.length ?? 0
    if (next > prev) return snapshot
    if (next > 0 && next === prev) return snapshot
  }
  return state
}

export function preferLedgerSnapshot(
  conversation: AutoresearchSnapshot | null | undefined,
  projected: AutoresearchSnapshot | null | undefined,
): AutoresearchSnapshot | null {
  const convLen = conversation?.results?.length ?? 0
  const projLen = projected?.results?.length ?? 0
  if (projLen > convLen) return projected ?? null
  return conversation ?? projected ?? null
}
