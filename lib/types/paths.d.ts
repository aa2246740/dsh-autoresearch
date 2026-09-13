export declare const AUTO_DIR = ".auto";
declare const SESSION_FILE_NAMES: {
    readonly log: {
        readonly current: "log.jsonl";
        readonly legacy: "autoresearch.jsonl";
    };
    readonly prompt: {
        readonly current: "prompt.md";
        readonly legacy: "autoresearch.md";
    };
    readonly ideas: {
        readonly current: "ideas.md";
        readonly legacy: "autoresearch.ideas.md";
    };
    readonly checks: {
        readonly current: "checks.sh";
        readonly legacy: "autoresearch.checks.sh";
    };
    readonly measure: {
        readonly current: "measure.sh";
        readonly legacy: "autoresearch.sh";
    };
    readonly config: {
        readonly current: "config.json";
        readonly legacy: "autoresearch.config.json";
    };
};
export type SessionFileKind = keyof typeof SESSION_FILE_NAMES;
export declare function sessionFileCandidates(dir: string, kind: SessionFileKind): {
    current: string;
    legacy: string;
};
export declare function sessionFilePath(dir: string, kind: SessionFileKind): string;
export declare function hookScriptPath(workDir: string, stage: 'before' | 'after'): string;
export declare function ensureParentDir(filePath: string): void;
export {};
//# sourceMappingURL=paths.d.ts.map