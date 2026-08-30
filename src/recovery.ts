import { createHash } from 'node:crypto'

const KNOWN_BROKEN_PLAYBOOK_HASHES = new Set([
  // 2026-08-27 create / continue playbooks emitted by the original plugin.
  '7b4d60146c5384c73f577961ff40790c9d22aa69d752fb4082726853cefad7ae',
  'e35a19e352803cec5dd48058654bf2bf3e5d5420aa2d76660505ba6ebe81573e',
  // 2026-08-29 create / continue playbooks emitted before message identity was fixed.
  'bf9bb01c81cc273db5ee958da0356cd877f49f2be4fb5e21d11e6967622a1efb',
  '1d2af121cbeb37169528c613ec8daf6bbd17fbd7da7dff7b3968aa6e1c4e8b9f',
])

type JsonRecord = Record<string, unknown>
type PendingMessage = { id: string; text: string; repaired: boolean }

export interface SessionMessageRepair {
  eventSeq: number
  location: 'inbox' | 'message'
  messageId: string
}

export interface SessionRepairResult {
  jsonl: string
  repairs: SessionMessageRepair[]
  sessionId: string
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null
}

function messageText(message: JsonRecord): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content
    .map(block => record(block))
    .filter((block): block is JsonRecord => block?.type === 'text' && typeof block.text === 'string')
    .map(block => String(block.text))
    .join('\n')
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function assertKnownBrokenAutoresearchMessage(message: JsonRecord, seq: number): string {
  const text = messageText(message)
  const hash = digest(text)
  if (message.role !== 'user' || record(message.source)?.kind !== 'user'
    || !KNOWN_BROKEN_PLAYBOOK_HASHES.has(hash)) {
    throw new Error(`refusing unknown unidentified user message at session seq ${seq}`)
  }
  return text
}

function recoveredId(sessionId: string, seq: number, index: number, text: string): string {
  return `autoresearch-recovery-${digest(`${sessionId}\0${seq}\0${index}\0${text}`).slice(0, 32)}`
}

/**
 * Repair the exact historical Autoresearch identity defect in decompressed DSH
 * JSONL. The paired Inbox insertion and later user/message receive one stable
 * deterministic id. Any unidentified message outside the known playbook
 * fingerprints fails closed.
 */
export function repairAutoresearchSessionJsonl(input: string): SessionRepairResult {
  const trailingNewline = input.endsWith('\n')
  const lines = input.split('\n')
  if (trailingNewline) lines.pop()
  if (lines.length === 0) throw new Error('session JSONL is empty')

  const parsed = lines.map((line, index) => {
    try { return JSON.parse(line) as unknown }
    catch { throw new Error(`session JSONL line ${index + 1} is not valid JSON`) }
  })
  const header = record(parsed[0])
  const sessionId = typeof header?.id === 'string' && header.id ? header.id : null
  if (!sessionId) throw new Error('session JSONL header has no id')

  const queues: Record<'next-turn' | 'next-step', PendingMessage[]> = {
    'next-turn': [],
    'next-step': [],
  }
  const awaitingUser: PendingMessage[] = []
  const repairs: SessionMessageRepair[] = []
  const usedIds = new Set<string>()

  for (const value of parsed.slice(1)) {
    const event = record(value)
    const seq = Number(event?.seq)
    if (!event || !Number.isSafeInteger(seq) || seq < 0) continue

    if (event.type === 'agent/inbox/spliced') {
      const data = record(event.data)
      const target = data?.target
      if (!data || target !== 'next-turn' && target !== 'next-step') continue
      const inserted = Array.isArray(data.inserted) ? data.inserted : []
      const pendingInserted: PendingMessage[] = []
      for (const [index, candidate] of inserted.entries()) {
        const message = record(candidate)
        if (!message) throw new Error(`inbox insertion at session seq ${seq} is not a message`)
        let id = typeof message.id === 'string' ? message.id : ''
        let repaired = false
        const text = messageText(message)
        if (!id) {
          assertKnownBrokenAutoresearchMessage(message, seq)
          id = recoveredId(sessionId, seq, index, text)
          message.id = id
          repaired = true
          repairs.push({ eventSeq: seq, location: 'inbox', messageId: id })
        }
        if (usedIds.has(id) && !queues[target].some(item => item.id === id)) {
          throw new Error(`duplicate message id ${JSON.stringify(id)} at session seq ${seq}`)
        }
        usedIds.add(id)
        pendingInserted.push({ id, text, repaired })
      }

      const start = Number(data.start)
      const removedCount = data.removedCount === undefined ? 0 : Number(data.removedCount)
      if (!Number.isSafeInteger(start) || start < 0 || start > queues[target].length
        || !Number.isSafeInteger(removedCount) || removedCount < 0
        || start + removedCount > queues[target].length) {
        throw new Error(`invalid inbox splice at session seq ${seq}`)
      }
      const removed = queues[target].splice(start, removedCount, ...pendingInserted)
      if (data.outcome === undefined) awaitingUser.push(...removed)
      continue
    }

    if (event.type !== 'user/message') continue
    const message = record(event.data)
    if (!message) throw new Error(`user message at session seq ${seq} is not a record`)
    let id = typeof message.id === 'string' ? message.id : ''
    if (!id) {
      const text = assertKnownBrokenAutoresearchMessage(message, seq)
      const match = awaitingUser.findIndex(item => item.repaired && item.text === text)
      if (match < 0) throw new Error(`unidentified user message at session seq ${seq} has no repaired Inbox origin`)
      const origin = awaitingUser.splice(match, 1)[0]
      if (!origin) throw new Error(`missing repaired Inbox origin at session seq ${seq}`)
      id = origin.id
      message.id = id
      repairs.push({ eventSeq: seq, location: 'message', messageId: id })
    } else {
      const match = awaitingUser.findIndex(item => item.id === id)
      if (match >= 0) awaitingUser.splice(match, 1)
      usedIds.add(id)
    }
  }

  const unmatched = awaitingUser.filter(item => item.repaired)
  if (unmatched.length) throw new Error(`${unmatched.length} repaired Inbox messages have no matching user/message`)
  const output = parsed.map((value, index) => repairs.some(repair => repair.eventSeq === record(value)?.seq)
    ? JSON.stringify(value)
    : lines[index]).join('\n') + (trailingNewline ? '\n' : '')
  return { jsonl: output, repairs, sessionId }
}
