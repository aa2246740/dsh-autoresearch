export declare const HOOK_TIMEOUT_MS = 30000;
export declare const HOOK_STDOUT_MAX_BYTES: number;
export interface HookPayload {
    event: 'before' | 'after';
    cwd: string;
    [key: string]: unknown;
}
export interface HookResult {
    fired: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
}
export declare function runHook(payload: HookPayload, { timeoutMs }?: {
    timeoutMs?: number | undefined;
}): Promise<HookResult>;
export declare function steerMessageFor(stage: string, result: HookResult): string | null;
export declare function hookLogEntry(stage: string, result: HookResult): Record<string, unknown>;
export declare function appendHookLogEntryIfConfigured(jsonlPath: string, stage: string, result: HookResult): boolean;
//# sourceMappingURL=hooks.d.ts.map