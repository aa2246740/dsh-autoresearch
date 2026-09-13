import type { Context } from '@deepseek-ai/cordis';
import { type UserMessage } from '@deepseek-ai/dsh-llm';
export declare const name = "dsh-autoresearch";
export declare const inject: string[];
export declare const NS = "autoresearch";
export interface Config {
    maxIterations?: number;
    maxAutoResumeTurns?: number;
    hintsEnabled?: boolean;
}
export declare const Config: unknown;
type SessionLike = {
    header?: {
        cwd?: string;
    };
    events?: readonly unknown[];
};
type FollowupAgent = {
    followup?: (message: UserMessage) => void;
    session?: SessionLike;
};
/** Extract file targets before a mutating tool runs, so protection is lazy and exact. */
export declare function mutationPathsFromToolCall(name: string, rawArgs: unknown, cwd: string): string[];
/**
 * Find files this conversation already changed so an umbrella workspace can
 * receive narrow local version protection without staging sibling projects.
 */
export declare function protectedPathsFromSession(session: SessionLike | undefined, cwd: string): string[];
export declare function createAutoresearchFollowupMessage(text: string): UserMessage;
export declare function queueAutoresearchFollowup(agent: FollowupAgent | undefined, text: string): void;
export declare function apply(ctx: Context, config: Config): Promise<void>;
export {};
//# sourceMappingURL=index.d.ts.map