import type { PrivateState } from './types.js'

export interface GuardInput {
  toolName: string
  args?: Record<string, unknown>
  cwd?: string
  pending?: Pick<PrivateState, 'active' | 'manualOff' | 'pendingResumeToken'> | null
}

export interface GuardDecision {
  decision: 'allow' | 'deny'
  reason?: string
}

const CONTROL_OK = /(?:^|_)autoresearch_control$/
const READ_OK = /(?:^|_)autoresearch_(?:status|compaction_summary)$/

function controlArgsAllowWhilePending(args: Record<string, unknown> | undefined): boolean {
  const raw = String(args?.args ?? '').trim().toLowerCase()
  return raw === '' || /^(help|status|off|clear|export|finalize|hooks)\b/.test(raw)
}

export function evaluatePendingGuard(input: GuardInput): GuardDecision {
  const pending = input.pending
  if (!pending || pending.active !== true || pending.manualOff === true || !pending.pendingResumeToken) {
    return { decision: 'allow' }
  }
  const toolName = String(input.toolName || '')
  if (CONTROL_OK.test(toolName) && controlArgsAllowWhilePending(input.args)) {
    return { decision: 'allow' }
  }
  if (READ_OK.test(toolName)) return { decision: 'allow' }
  return {
    decision: 'deny',
    reason:
      'Autoresearch has a pending same-session continuation. End this turn and wait for the host follow-up, or run /autoresearch off to cancel it.',
  }
}
