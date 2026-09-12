import type { PrivateState } from './types.js';
export interface GuardInput {
    toolName: string;
    args?: Record<string, unknown>;
    cwd?: string;
    pending?: Pick<PrivateState, 'active' | 'manualOff' | 'pendingResumeToken'> | null;
}
export interface GuardDecision {
    decision: 'allow' | 'deny';
    reason?: string;
}
export declare function evaluatePendingGuard(input: GuardInput): GuardDecision;
//# sourceMappingURL=guard.d.ts.map