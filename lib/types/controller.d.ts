export declare const DEFAULT_MAX_AUTORESUME_TURNS = 20;
export declare const EXPERIMENT_MAX_LINES = 10;
export declare const EXPERIMENT_MAX_BYTES: number;
export declare function inferAutoresearchConfigFromPrompt(prompt: any): {} | null;
export declare function readAutoresearchConfig(cwd: any): any;
export declare function applyInferredAutoresearchConfig(cwd: any, inferred: any): string[];
export declare class AutoresearchController {
    cwd: string;
    dataDir: string;
    listeners: Set<unknown>;
    constructor({ cwd, dataDir, }?: {
        cwd?: string | undefined;
        dataDir?: string | undefined;
    });
    subscribe(listener: any): () => boolean;
    notifyChange(): void;
    config(): any;
    workDir(): string;
    protectedPaths(candidates?: any): string[];
    protectionPathspecs(candidates?: any): any;
    snapshotRoot(): string;
    snapshotManifestPath(): string;
    snapshotManifest(): {
        version: number;
        files: any;
    };
    captureSnapshots(candidates: any, { overwrite }?: {
        overwrite?: boolean | undefined;
    }): {
        ok: boolean;
        paths: string[];
        warnings: string[];
    };
    restoreSnapshots(candidates?: any): {
        ok: boolean;
        paths: string[];
        warnings: string[];
    };
    statePath(): string;
    privateState(): any;
    savePrivate(patch: any): any;
    resumeFor(privateState?: any): {
        shouldSchedule: boolean;
        command: null;
        token: null;
        turn?: undefined;
    } | {
        shouldSchedule: boolean;
        token: any;
        turn: any;
        command: null;
    };
    consumeResumeToken(token: any): {
        ok: boolean;
        text: string;
        turn: any;
    };
    pendingGate(privateState?: any): {
        ok: boolean;
        code: string;
        active: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        text: string;
    } | null;
    persisted(): import("./jsonl.js").PersistedState;
    gitSafety(): {
        ok: boolean;
        code: string;
        workDir: string;
        allowNoGit: boolean;
        needsDecision: boolean;
        error: string;
        protectionMode?: undefined;
        protectedPaths?: undefined;
        gitRoot?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        allowNoGit: boolean;
        protectionMode: string;
        protectedPaths: string[];
        code?: undefined;
        needsDecision?: undefined;
        error?: undefined;
        gitRoot?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        gitRoot: string;
        allowNoGit: false;
        protectionMode: string;
        protectedPaths: string[];
        code?: undefined;
        needsDecision?: undefined;
        error?: undefined;
    };
    prepareGitSafety(proposedProtectedPaths?: string[]): {
        ok: boolean;
        code: string;
        workDir: string;
        allowNoGit: boolean;
        needsDecision: boolean;
        error: string;
        protectionMode?: undefined;
        protectedPaths?: undefined;
        gitRoot?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        allowNoGit: boolean;
        protectionMode: string;
        protectedPaths: string[];
        code?: undefined;
        needsDecision?: undefined;
        error?: undefined;
        gitRoot?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        gitRoot: string;
        allowNoGit: false;
        protectionMode: string;
        protectedPaths: string[];
        code?: undefined;
        needsDecision?: undefined;
        error?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        allowNoGit: boolean;
        protectionMode: string;
        protectedPaths: string[];
        protectionFallback: boolean;
        internalReason: null;
        setupText: string;
    } | {
        ok: boolean;
        code: string;
        needsDecision: boolean;
        workDir: string;
        protectedPaths: string[];
        error: string;
        gitRoot?: undefined;
        allowNoGit?: undefined;
        initialized?: undefined;
        baselineCreated?: undefined;
        protectionMode?: undefined;
        setupText?: undefined;
        configuredIdentity?: undefined;
        commit?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        gitRoot: string;
        allowNoGit: boolean;
        initialized: boolean;
        baselineCreated: boolean;
        protectionMode: string;
        protectedPaths: string[];
        setupText: string;
        code?: undefined;
        needsDecision?: undefined;
        error?: undefined;
        configuredIdentity?: undefined;
        commit?: undefined;
    } | {
        ok: boolean;
        workDir: string;
        gitRoot: string;
        allowNoGit: boolean;
        initialized: boolean;
        baselineCreated: boolean;
        protectionMode: string;
        protectedPaths: string[];
        configuredIdentity: string[];
        commit: string;
        setupText: string;
        code?: undefined;
        needsDecision?: undefined;
        error?: undefined;
    };
    protectPathsBeforeMutation(candidates?: string[]): {
        ok: boolean;
        active: boolean;
        protectedPaths: string[];
        needsDecision?: undefined;
        code?: undefined;
        text?: undefined;
        protectionMode?: undefined;
    } | {
        ok: boolean;
        needsDecision: boolean;
        code: string;
        text: string;
        active?: undefined;
        protectedPaths?: undefined;
        protectionMode?: undefined;
    } | {
        ok: boolean;
        active: boolean;
        protectedPaths: string[];
        protectionMode: string;
        needsDecision?: undefined;
        code?: undefined;
        text?: undefined;
    };
    fireHook(event: any, extra: any): Promise<{
        result: import("./hooks.js").HookResult;
        steer: string | null;
    }>;
    finish({ outcome, reason, user_question }?: {
        outcome?: string | undefined;
        reason?: string | undefined;
        user_question?: string | undefined;
    }): Promise<{
        ok: boolean;
        active: any;
        text: string;
        needsDecision?: undefined;
        loopState?: undefined;
        completionReason?: undefined;
        completedAt?: undefined;
        decisionQuestion?: undefined;
    } | {
        ok: boolean;
        active: boolean;
        needsDecision: boolean;
        loopState: string;
        completionReason: string;
        completedAt: any;
        decisionQuestion: string | null;
        text: string;
    }>;
    control({ args, protectedPaths }?: {
        args?: string;
        protectedPaths?: string[];
    }): Promise<{
        ok: boolean;
        active: boolean;
        manualOff: boolean;
        loopState: any;
        completionReason: any;
        completedAt: any;
        decisionQuestion: any;
        pendingNewGoal: boolean;
        sessionEpoch: any;
        currentSegmentRuns: number;
        totalRuns: number;
        bestKeptMetric: number | null;
        metricName: string;
        pendingContinuation: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        text: string;
        state: import("./jsonl.js").PersistedState;
    } | {
        ok: boolean;
        active: any;
        text: string;
        needsDecision?: undefined;
        loopState?: undefined;
        completionReason?: undefined;
        completedAt?: undefined;
        decisionQuestion?: undefined;
    } | {
        ok: boolean;
        active: boolean;
        needsDecision: boolean;
        loopState: string;
        completionReason: string;
        completedAt: any;
        decisionQuestion: string | null;
        text: string;
    } | {
        action: string;
        text: string;
        ok: boolean;
        active: boolean;
        manualOff: boolean;
        loopState: any;
        completionReason: any;
        completedAt: any;
        decisionQuestion: any;
        pendingNewGoal: boolean;
        sessionEpoch: any;
        currentSegmentRuns: number;
        totalRuns: number;
        bestKeptMetric: number | null;
        metricName: string;
        pendingContinuation: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        state: import("./jsonl.js").PersistedState;
        needsDecision?: undefined;
        details?: undefined;
        needsSetup?: undefined;
        configNotes?: undefined;
        warning?: undefined;
        hookMessage?: undefined;
    } | {
        ok: boolean;
        active: any;
        action: string;
        text: string;
        needsDecision?: undefined;
        details?: undefined;
        needsSetup?: undefined;
        configNotes?: undefined;
        warning?: undefined;
        hookMessage?: undefined;
    } | {
        ok: boolean;
        active: boolean;
        needsDecision: boolean;
        action: string;
        text: any;
        details: {
            ok: boolean;
            code: string;
            workDir: string;
            allowNoGit: boolean;
            needsDecision: boolean;
            error: string;
            protectionMode?: undefined;
            protectedPaths?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            allowNoGit: boolean;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            gitRoot: string;
            allowNoGit: false;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            allowNoGit: boolean;
            protectionMode: string;
            protectedPaths: string[];
            protectionFallback: boolean;
            internalReason: null;
            setupText: string;
        } | {
            ok: boolean;
            code: string;
            needsDecision: boolean;
            workDir: string;
            protectedPaths: string[];
            error: string;
            gitRoot?: undefined;
            allowNoGit?: undefined;
            initialized?: undefined;
            baselineCreated?: undefined;
            protectionMode?: undefined;
            setupText?: undefined;
            configuredIdentity?: undefined;
            commit?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            gitRoot: string;
            allowNoGit: boolean;
            initialized: boolean;
            baselineCreated: boolean;
            protectionMode: string;
            protectedPaths: string[];
            setupText: string;
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
            configuredIdentity?: undefined;
            commit?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            gitRoot: string;
            allowNoGit: boolean;
            initialized: boolean;
            baselineCreated: boolean;
            protectionMode: string;
            protectedPaths: string[];
            configuredIdentity: string[];
            commit: string;
            setupText: string;
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
        };
        needsSetup?: undefined;
        configNotes?: undefined;
        warning?: undefined;
        hookMessage?: undefined;
    } | {
        ok: boolean;
        active: boolean;
        needsSetup: any;
        configNotes: string[];
        warning: any;
        hookMessage: string | null;
        text: string;
        action?: undefined;
        needsDecision?: undefined;
        details?: undefined;
    }>;
    initExperiment({ name, metric_name, metric_unit, direction }?: {
        metric_name?: string | undefined;
        metric_unit?: string | undefined;
        direction?: string | undefined;
    }): Promise<{
        ok: boolean;
        code: string;
        active: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        text: string;
    } | {
        ok: boolean;
        text: string;
        details?: undefined;
    } | {
        ok: boolean;
        text: string | undefined;
        details: {
            ok: boolean;
            code: string;
            workDir: string;
            allowNoGit: boolean;
            needsDecision: boolean;
            error: string;
            protectionMode?: undefined;
            protectedPaths?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            allowNoGit: boolean;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            gitRoot: string;
            allowNoGit: false;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
        };
    } | {
        ok: boolean;
        text: string;
        details: {
            state: import("./jsonl.js").PersistedState;
        };
    }>;
    runExperiment({ command, timeout_seconds, checks_timeout_seconds, signal }?: {
        timeout_seconds?: number | undefined;
        checks_timeout_seconds?: number | undefined;
    }): Promise<{
        ok: boolean;
        code: string;
        active: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        text: string;
    } | {
        ok: boolean;
        text: string;
        details?: undefined;
        active?: undefined;
    } | {
        ok: boolean;
        text: string | undefined;
        details: {
            ok: boolean;
            code: string;
            workDir: string;
            allowNoGit: boolean;
            needsDecision: boolean;
            error: string;
            protectionMode?: undefined;
            protectedPaths?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            allowNoGit: boolean;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            gitRoot: string;
            allowNoGit: false;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
        };
        active?: undefined;
    } | {
        ok: boolean;
        active: boolean;
        text: string;
        details?: undefined;
    } | {
        ok: boolean;
        text: string;
        details: {
            command: any;
            benchmarkPath: string;
        };
        active?: undefined;
    } | {
        ok: boolean;
        text: string;
        details: {
            command: any;
            exitCode: any;
            durationSeconds: any;
            passed: boolean;
            crashed: boolean;
            timedOut: any;
            tailOutput: string;
            checksPass: boolean | null;
            checksTimedOut: boolean;
            checksOutput: string;
            checksDuration: number;
            parsedMetrics: {
                [k: string]: any;
            };
            parsedPrimary: any;
            metricName: string;
            metricUnit: string;
            fullOutputPath: any;
            truncation: {
                content: string;
                truncated: boolean;
                truncatedBy: string | null;
                totalLines: number;
                outputLines: number;
            } | undefined;
        };
        active?: undefined;
    }>;
    logExperiment({ commit, metric, metrics, status, description, asi, force, next_action, decision_reason, user_question, }?: {
        commit?: string | undefined;
        metrics?: {} | undefined;
        description?: string | undefined;
        force?: boolean | undefined;
        decision_reason?: string | undefined;
        user_question?: string | undefined;
    }): Promise<{
        ok: boolean;
        code: string;
        active: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        text: string;
    } | {
        ok: boolean;
        text: string;
        details?: undefined;
        resume?: undefined;
        needsDecision?: undefined;
        loopState?: undefined;
        completionReason?: undefined;
        decisionQuestion?: undefined;
    } | {
        ok: boolean;
        text: string | undefined;
        details: {
            ok: boolean;
            code: string;
            workDir: string;
            allowNoGit: boolean;
            needsDecision: boolean;
            error: string;
            protectionMode?: undefined;
            protectedPaths?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            allowNoGit: boolean;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
            gitRoot?: undefined;
        } | {
            ok: boolean;
            workDir: string;
            gitRoot: string;
            allowNoGit: false;
            protectionMode: string;
            protectedPaths: string[];
            code?: undefined;
            needsDecision?: undefined;
            error?: undefined;
        };
        resume?: undefined;
        needsDecision?: undefined;
        loopState?: undefined;
        completionReason?: undefined;
        decisionQuestion?: undefined;
    } | {
        ok: boolean;
        text: string;
        details: {
            experiment: {
                asi?: any;
                run: number;
                commit: string;
                metric: any;
                metrics: {};
                status: any;
                description: string;
                timestamp: number;
                segment: number;
                confidence: null;
            };
            state: import("./jsonl.js").PersistedState;
            wallClockSeconds: any;
        };
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
        };
        needsDecision: boolean;
        loopState: string;
        completionReason: string;
        decisionQuestion: any;
    }>;
    status(): Promise<{
        ok: boolean;
        active: boolean;
        manualOff: boolean;
        loopState: any;
        completionReason: any;
        completedAt: any;
        decisionQuestion: any;
        pendingNewGoal: boolean;
        sessionEpoch: any;
        currentSegmentRuns: number;
        totalRuns: number;
        bestKeptMetric: number | null;
        metricName: string;
        pendingContinuation: boolean;
        resume: {
            shouldSchedule: boolean;
            command: null;
            token: null;
            turn?: undefined;
        } | {
            shouldSchedule: boolean;
            token: any;
            turn: any;
            command: null;
        };
        text: string;
        state: import("./jsonl.js").PersistedState;
    }>;
    snapshot(): {
        cwd: string;
        workDir: string;
        active: boolean;
        manualOff: boolean;
        loopState: any;
        completionReason: any;
        completedAt: any;
        decisionQuestion: any;
        pendingNewGoal: boolean;
        needsSetup: boolean;
        pendingContinuation: boolean;
        gitOk: boolean;
        gitError: string | null;
        allowNoGit: boolean;
        protectionMode: any;
        protectedPathCount: number;
        goal: any;
        sessionEpoch: any;
        name: any;
        metricName: string;
        metricUnit: string;
        direction: import("./jsonl.js").MetricDirection;
        maxIterations: number | null;
        maxAutoResumeTurns: number | null;
        currentSegment: number;
        currentSegmentRuns: number;
        totalRuns: number;
        baselineMetric: number;
        bestKeptMetric: number | null;
        lastStatus: import("./jsonl.js").ExperimentStatus | null;
        results: import("./jsonl.js").ExperimentRun[];
        promptExists: boolean;
        measureExists: boolean;
        checksExists: boolean;
        updatedAt: any;
    };
    askHint(): Promise<{
        ok: boolean;
        text: string;
    }>;
    close(): Promise<void>;
}
//# sourceMappingURL=controller.d.ts.map