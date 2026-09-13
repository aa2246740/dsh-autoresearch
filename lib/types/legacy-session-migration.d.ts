interface SessionHeaderLike {
    id: string;
    cwd?: string;
}
export interface SessionPersistenceLike {
    supportsRawArtifacts: boolean;
    list(): Promise<SessionHeaderLike[]>;
    readRaw(id: string): Promise<{
        meta: SessionHeaderLike;
        content: string;
    } | undefined>;
    locate(meta: SessionHeaderLike): {
        kind: string;
        path: string;
    } | undefined;
    inspect(id: string): Promise<unknown>;
}
export interface LegacySessionMigrationReport {
    alreadyComplete: boolean;
    scanned: number;
    repaired: Array<{
        sessionId: string;
        eventSeqs: number[];
        backupPath: string;
    }>;
    failures: Array<{
        sessionId: string;
        error: string;
    }>;
    markerPath: string;
}
interface MigrationOptions {
    dshHome?: string;
    markerPath?: string;
    candidateCwds?: ReadonlySet<string>;
}
/**
 * One-time, fail-closed migration for the plugin's two historical custom
 * state events. Every modified raw log gets a byte-exact backup, an atomic
 * replacement, and a full validation through the active DSH persistence
 * implementation. Future versions never write this custom event again.
 */
export declare function migrateLegacyAutoresearchSessions(persistence: SessionPersistenceLike, options?: MigrationOptions): Promise<LegacySessionMigrationReport>;
export {};
//# sourceMappingURL=legacy-session-migration.d.ts.map