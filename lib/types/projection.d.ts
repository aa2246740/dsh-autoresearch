import type { AutoresearchProjectionState, AutoresearchSnapshot } from './types.js';
export declare function snapshotFromMeta(meta: unknown): AutoresearchSnapshot | null;
/** Identity schema: host registry requires `.parse`; values are already JSON snapshots. */
export declare const autoresearchProjectionSchema: {
    parse(value: unknown): AutoresearchSnapshot | null;
};
export declare const autoresearchProjectionStateSchema: {
    parse(value: unknown): AutoresearchProjectionState;
};
export declare function initialAutoresearchProjectionState(): AutoresearchProjectionState;
export declare function ledgerLength(snapshot: AutoresearchSnapshot | null | undefined): number;
/** Keep the longer ledger; equal length prefers the later `updatedAt`. */
export declare function longerSnapshot(current: AutoresearchSnapshot | null | undefined, next: AutoresearchSnapshot | null | undefined): AutoresearchSnapshot | null;
/**
 * Host session projection fold. Later tool/result metas with a longer ledger
 * replace earlier ones so the GUI can follow .auto/log.jsonl without polling
 * /autoresearch status into the transcript.
 */
export declare function foldAutoresearchSnapshot(state: AutoresearchSnapshot | null, event: {
    type: string;
    data?: unknown;
}): AutoresearchSnapshot | null;
/**
 * External plugins cannot add required custom event types to DSH's closed
 * persistence vocabulary. Fold official command lifecycle events instead;
 * legacy autoresearch/state records remain readable only after the migration
 * marks their envelopes ignorable.
 */
export declare function foldAutoresearchProjection(state: AutoresearchProjectionState, event: {
    type: string;
    time?: number;
    data?: unknown;
}): AutoresearchProjectionState;
/**
 * Upgrade a conversation log snapshot with a longer projected ledger.
 * Never invent a progress board from projection alone (status/init leftovers).
 */
export declare function preferLedgerSnapshot(conversation: AutoresearchSnapshot | null | undefined, projected: AutoresearchSnapshot | null | undefined): AutoresearchSnapshot | null;
//# sourceMappingURL=projection.d.ts.map