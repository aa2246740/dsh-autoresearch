import { type AutoresearchSnapshot } from '../types.js';
import type { ExperimentRun, ExperimentStatus, MetricDirection } from '../jsonl.js';
export type ProgressCardKind = 'none' | 'running' | 'board';
export interface DashboardRow {
    run: number;
    commit: string;
    metric: string;
    status: ExperimentStatus;
    description: string;
}
export interface DashboardSecondary {
    name: string;
    value: string;
    deltaPct: number | null;
}
export interface DashboardModel {
    title: string;
    name: string | null;
    runs: number;
    kept: number;
    discarded: number;
    crashed: number;
    checksFailed: number;
    conf: number | null;
    metricName: string;
    baseline: {
        value: string;
        run: number;
    } | null;
    progress: {
        value: string;
        run: number;
        deltaPct: number | null;
        improved: boolean | null;
    } | null;
    secondaries: DashboardSecondary[];
    allRows: DashboardRow[];
    rows: DashboardRow[];
    running: boolean;
    runningCommand: string | null;
    lifecycle: 'running' | 'completed' | 'awaiting_user' | 'stopped' | 'ended';
}
export interface ConversationInspectInput {
    runningCalls?: ReadonlyArray<{
        name?: string;
        argsRaw?: string;
    }>;
    nodes?: readonly unknown[];
}
export interface ConversationProgress {
    kind: ProgressCardKind;
    snapshot: AutoresearchSnapshot | null;
    runningCommand: string | null;
    hasRunStarted: boolean;
    runningExperiment: boolean;
}
/** MAD-based confidence; null below 3 points — same rule as pi-autoresearch. */
export declare function confidenceFor(results: readonly ExperimentRun[], direction: MetricDirection): number | null;
export declare function formatNum(value: number | null | undefined, unit?: string): string;
export declare function formatDeltaPct(pct: number | null): string | null;
export declare function progressCardKind(input: {
    results?: readonly unknown[] | null;
    runningExperiment?: boolean;
    hasRunStarted?: boolean;
}): ProgressCardKind;
export declare function buildDashboardModel(snapshot: AutoresearchSnapshot, opts?: {
    running?: boolean;
    runningCommand?: string | null;
}): DashboardModel;
/**
 * Progress comes from this conversation's run/log tools, not from /autoresearch status.
 * init_experiment alone (empty ledger) stays kind 'none'.
 * Longer log_experiment snapshots win, including when a shorter one is nested later.
 */
export declare function inspectConversation(conv: ConversationInspectInput | null | undefined): ConversationProgress;
export declare function sampleRun(partial: Partial<ExperimentRun> & Pick<ExperimentRun, 'run' | 'metric' | 'status'>): ExperimentRun;
//# sourceMappingURL=dashboard.d.ts.map