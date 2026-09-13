import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client';
export declare const name = "dsh-autoresearch-client";
export declare const inject: string[];
type AnyCtx = ClientContext & {
    slots: {
        inject: (name: string, factory: () => unknown) => void;
        register: (options: Record<string, unknown>, component: unknown) => unknown;
    };
    sessions: {
        current?: {
            sessionId?: string;
        };
        binding?: (id: string) => unknown;
    };
    remote: {
        commands: {
            execute: (sessionId: string, line: string, images: unknown[]) => Promise<RemoteAnswer>;
        };
    };
    settingsScope: {
        bind: (opts: {
            namespace: string;
        }) => SettingsScope;
    };
    commandUi: CommandUiContract;
    on: (event: string, listener: (...args: any[]) => unknown) => unknown;
};
interface RemoteAnswer {
    ok?: boolean;
    error?: {
        message: string;
        code: string;
    };
    value?: {
        result?: {
            kind: string;
            text?: string;
            ok?: boolean;
            value?: unknown;
        };
        text?: string;
        current?: unknown;
        groups?: unknown;
    };
    result?: {
        ok?: boolean;
        error?: {
            message: string;
            code: string;
        };
        value?: unknown;
    };
}
interface SettingsScope {
    value: Record<string, unknown>;
    set: (field: string, value: unknown) => Promise<void> | void;
}
export declare function apply(ctx: AnyCtx): void;
export {};
//# sourceMappingURL=index.d.ts.map