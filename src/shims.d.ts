declare module '@deepseek-ai/cordis' {
  export class Context {
    tools: { register: (tool: unknown) => unknown }
    commands: { register: (definition: unknown) => unknown }
    systemPrompt: { section: (section: unknown) => unknown }
    skills: { register: (skill: unknown) => unknown }
    sessionProjections: { register: (definition: unknown) => unknown }
    inject: (deps: string[], callback: (ctx: Context) => void) => unknown
    on: (event: string, listener: (...args: never[]) => unknown) => unknown
    effect: (callback: () => unknown, label?: string) => unknown
    get: (name: string) => unknown
    logger: { warn: (...args: unknown[]) => void }
    [key: string]: unknown
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(definition: Record<string, unknown>): unknown
}

declare module '@deepseek-ai/dsh-settings' {
  export function settingsNamespace(name: string): string
  export function installSettingsSection(...args: unknown[]): unknown
}

declare module '@deepseek-ai/schemastery' {
  interface Schema<T> {
    (value?: unknown): T
  }
  interface SchemaFactory {
    object: (shape: Record<string, unknown>) => Schema<unknown>
    number: () => { step: (n: number) => { min: (n: number) => { default: (n: number) => unknown } } }
    boolean: () => { default: (n: boolean) => unknown }
    string: () => unknown
  }
  const z: SchemaFactory
  export default z
  export type { Schema }
}

declare module '@deepseek-ai/dsh-client-runtime/client' {
  export interface ClientContext {
    [key: string]: unknown
  }
  export type SessionId = string
}

declare module '@deepseek-ai/dsh-client-ui-settings-plugins/client' {}
declare module '@deepseek-ai/dsh-client-ui-conversation/client' {}
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { CSSProperties, RefObject } from 'react'
  export function useAnchoredPosition(options: {
    open: boolean
    anchorRef: RefObject<HTMLElement | null>
    panelRef: RefObject<HTMLElement | null>
    gap?: number
    margin?: number
  }): CSSProperties | null
}
declare module '@deepseek-ai/dsh-client-ui-commands/client' {
  export interface SelectOption {
    id: string
    label: string
    detail?: string
    active?: boolean
  }
  export interface CommandUiContract {
    decorate: (decoration: {
      name: string
      available: (session: { sessionId: string }) => boolean
      ui: {
        kind: 'popupSelect'
        options: (session: { sessionId: string }, signal: AbortSignal) => Promise<readonly SelectOption[]>
        onSelect: (option: SelectOption, session: { sessionId: string }) => void | Promise<void>
      }
    }) => () => void
  }
}

declare module 'react-dom' {
  import type { ReactNode, ReactPortal } from 'react'
  export function createPortal(children: ReactNode, container: Element | DocumentFragment): ReactPortal
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    autoresearch: import('./types.ts').AutoresearchSnapshot | null
  }
  interface SessionProjectionStateMap {
    autoresearch: import('./types.ts').AutoresearchSnapshot | null
  }
}
