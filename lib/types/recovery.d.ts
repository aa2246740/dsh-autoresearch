export interface SessionMessageRepair {
    eventSeq: number;
    location: 'inbox' | 'message';
    messageId: string;
}
export interface SessionRepairResult {
    jsonl: string;
    repairs: SessionMessageRepair[];
    sessionId: string;
}
export interface IgnorableStateMigrationResult {
    jsonl: string;
    sessionId: string;
    markedEventSeqs: number[];
}
/**
 * Mark only the exact legacy state snapshot event written by this plugin as
 * ignorable. DSH deliberately treats every out-of-repo event type as unknown;
 * this envelope flag makes old sessions portable without discarding the event
 * when Autoresearch is installed. No seq, time, data, or unrelated line moves.
 */
export declare function markAutoresearchStateEventsIgnorable(input: string): IgnorableStateMigrationResult;
/**
 * Repair the exact historical Autoresearch identity defect in decompressed DSH
 * JSONL. The paired Inbox insertion and later user/message receive one stable
 * deterministic id. Any unidentified message outside the known playbook
 * fingerprints fails closed.
 */
export declare function repairAutoresearchSessionJsonl(input: string): SessionRepairResult;
//# sourceMappingURL=recovery.d.ts.map