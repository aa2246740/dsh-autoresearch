import { type AutoresearchSnapshot } from '../types.js';
export type DockMode = 'hidden' | 'init' | 'waiting';
export type LabPage = 'create' | 'lab';
export type LabPhase = 'idle' | 'configuring' | 'running' | 'done';
export type CommandLifecycleKind = 'completed' | 'stopped' | 'idle';
export interface CommandLifecycleAck {
    sessionId: string;
    kind: CommandLifecycleKind;
    reason: string | null;
    at: number;
}
export interface ReadReceiptStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
}
/** Init card fields only. Metric / direction / measure.sh are inferred after confirm. */
export interface ExperimentDraft {
    goal: string;
    maxRuns: string;
}
export declare const emptyDraft: () => ExperimentDraft;
export interface LabState {
    /** Reserved composer dock: hidden on the daily home; init before confirm; waiting is at most one alignment line. */
    dock: DockMode;
    page: LabPage;
    phase: LabPhase;
    sessionId: string | null;
    snapshot: AutoresearchSnapshot | null;
    draft: ExperimentDraft;
    error: string | null;
    busy: boolean;
    notice: string | null;
    /** Previous rendered result hidden while an explicit new goal is preparing. */
    supersededProgressKey: string | null;
    /** Immediate authoritative acknowledgement from this browser's slash command. */
    commandAck: CommandLifecycleAck | null;
}
export declare function getLabState(): LabState;
export declare function subscribeLab(listener: () => void): () => void;
export declare function patchLab(patch: Partial<LabState>): void;
export declare function resetLab(): void;
/** `/autoresearch` or slash 「新开」: show the init card. Does not activate the loop. */
export declare function showInitDock(): void;
/**
 * After 「确认并开始」: send the slash line, then leave the progress UI closed.
 * The agent may still ask about requirements; the board appears only after run/log.
 */
export declare function hideAfterConfirm(previousProgressKey?: string | null): void;
/** Hide the init/waiting dock. Progress cards are conversation-driven and ignore this. */
export declare function cancelInitDock(): void;
export declare function rememberSession(sessionId: string): void;
/**
 * The client command service emits this exact Host result after a local slash
 * submission settles. It bridges the short gap before a cold read/projection
 * refresh; durable truth remains in command/done and the controller sidecar.
 */
export declare function recordCommandAcknowledgement(sessionId: string, text: string): void;
export declare function applyCommandAcknowledgement(snapshot: AutoresearchSnapshot | null, ack: CommandLifecycleAck | null, sessionId: string): AutoresearchSnapshot | null;
export declare function progressIdentity(snapshot: AutoresearchSnapshot): string;
/**
 * A read receipt belongs to one durable completion, not merely to the project.
 * `completedAt` is authoritative for current logs; `updatedAt` keeps imported
 * legacy completions distinguishable without making ordinary UI reads mutable.
 */
export declare function completionIdentity(snapshot: AutoresearchSnapshot): string;
export declare function completionReceiptKey(sessionId: string): string;
export declare function isCompletionUnread(sessionId: string, snapshot: AutoresearchSnapshot, storage?: ReadReceiptStorage | null): boolean;
export declare function markCompletionRead(sessionId: string, snapshot: AutoresearchSnapshot, storage?: ReadReceiptStorage | null): string;
/**
 * Legacy parser for old logs that still carry AUTORESEARCH_STATE_V1.
 * Must not open a progress dock — confirm/status/init snapshots stay off the board.
 */
export declare function applyCommandText(text: string): AutoresearchSnapshot | undefined;
export declare function parseRoundBudget(raw: string): number | null;
/** Never expose internal process/Git failures in the beginner start card. */
export declare function friendlyStartError(error: unknown): string;
/** A recoverable decision keeps the confirmation card open instead of looking successful. */
export declare function startDecisionMessage(text: string): string | null;
/**
 * Command sent only after 「确认并开始」.
 * Goal is natural language; rounds become maxIterations via `for N runs`.
 * Metric / direction / allowNoGit are not encoded — the agent infers them after confirm.
 */
export declare function buildStartLine(draft: ExperimentDraft): string;
//# sourceMappingURL=store.d.ts.map