export type MetricDirection = 'lower' | 'higher';
export type ExperimentStatus = 'keep' | 'discard' | 'crash' | 'checks_failed';
export interface AsiNotes {
    hypothesis?: string;
    rollback_reason?: string;
    next_action_hint?: string;
    [key: string]: unknown;
}
export interface ExperimentRun {
    run: number;
    commit: string;
    metric: number;
    metrics: Record<string, number>;
    status: ExperimentStatus;
    description: string;
    timestamp: number;
    segment: number;
    confidence: number | null;
    asi?: AsiNotes;
}
export interface PersistedState {
    name: string | null;
    metricName: string;
    metricUnit: string;
    bestDirection: MetricDirection;
    currentSegment: number;
    results: ExperimentRun[];
    secondaryMetrics: Array<{
        name: string;
        unit: string;
    }>;
}
export declare function parseJsonlEntry(line: string): Record<string, unknown> | null;
export declare function isAutoresearchConfigEntry(entry: Record<string, unknown> | null): boolean;
export declare function isAutoresearchRunEntry(entry: Record<string, unknown> | null): boolean;
export declare function hasAutoresearchConfigHeader(jsonlContent: string): boolean;
export declare function extractAutoresearchSessionName(jsonlContent: string): string;
export declare function reconstructJsonlState(jsonlContent: string): PersistedState;
//# sourceMappingURL=jsonl.d.ts.map