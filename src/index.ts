/**
 * DeepSeek Harness host plugin: durable auto-research experiment loop.
 * Named `apply` only — no default export (dshx function/client contract).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { AutoresearchController } from './controller.js'
import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from './compaction.js'
import { evaluatePendingGuard } from './guard.js'
import { migrateLegacyAutoresearchSessions, type SessionPersistenceLike } from './legacy-session-migration.js'
import { CONTINUE_PLAYBOOK, CREATE_PLAYBOOK, skillBodies } from './playbook.js'
import { ensureParentDir, sessionFilePath } from './paths.js'
import {
  autoresearchProjectionSchema,
  autoresearchProjectionStateSchema,
  foldAutoresearchProjection,
  initialAutoresearchProjectionState,
} from './projection.js'
import { toJsonValue, type AutoresearchProjectionState, type AutoresearchSnapshot, type ToolResult } from './types.js'

export const name = 'dsh-autoresearch'
export const inject = ['tools', 'sessionPersistence']
export const NS = settingsNamespace('autoresearch')

export interface Config {
  maxIterations?: number
  maxAutoResumeTurns?: number
  hintsEnabled?: boolean
}

export const Config = z.object({
  maxIterations: z.number().step(1).min(0).default(20),
  maxAutoResumeTurns: z.number().step(1).min(0).default(20),
  hintsEnabled: z.boolean().default(false),
}) as unknown

const MARKER = '[dsh-autoresearch] loaded'
const controllers = new Map<string, AutoresearchController>()

type SessionLike = {
  header?: { cwd?: string }
  events?: readonly unknown[]
}

type FollowupAgent = {
  followup?: (message: UserMessage) => void
  session?: SessionLike
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function portableWorkspacePath(cwd: string, changedPath: unknown): string | null {
  if (typeof changedPath !== 'string' || !changedPath.trim()) return null
  const absolute = path.resolve(cwd, changedPath)
  const relative = path.relative(cwd, absolute)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null
  const portable = relative.split(path.sep).join('/')
  if (portable === '.git' || portable.startsWith('.git/')) return null
  if (portable === '.auto' || portable.startsWith('.auto/')) return null
  return portable
}

/** Extract file targets before a mutating tool runs, so protection is lazy and exact. */
export function mutationPathsFromToolCall(name: string, rawArgs: unknown, cwd: string): string[] {
  const toolName = String(name || '').toLowerCase()
  if (!/(?:^|_)(?:write|edit|search_replace|replace|apply_patch|delete|remove|move|rename)(?:_|$)/.test(toolName)) return []
  let args = record(rawArgs)
  if (!args && typeof rawArgs === 'string') {
    try { args = record(JSON.parse(rawArgs)) } catch { /* raw patch payload handled below */ }
  }
  const selected = new Set<string>()
  const add = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) add(item)
      return
    }
    const portable = portableWorkspacePath(cwd, value)
    if (portable) selected.add(portable)
  }
  for (const key of ['file_path', 'filePath', 'path', 'paths', 'old_path', 'new_path', 'source_path', 'destination_path']) {
    add(args?.[key])
  }
  const patchText = String(args?.patch ?? args?.input ?? (typeof rawArgs === 'string' ? rawArgs : ''))
  for (const match of patchText.matchAll(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) add(match[1].trim())
  for (const match of patchText.matchAll(/^\*\*\* Move to:\s*(.+)$/gm)) add(match[1].trim())
  return [...selected]
}

/**
 * Find files this conversation already changed so an umbrella workspace can
 * receive narrow local version protection without staging sibling projects.
 */
export function protectedPathsFromSession(session: SessionLike | undefined, cwd: string): string[] {
  const selected = new Set<string>()
  const addPath = (changedPath: unknown): boolean => {
    if (typeof changedPath !== 'string' || !changedPath.trim()) return false
    const absolute = path.resolve(cwd, changedPath)
    const relative = path.relative(cwd, absolute)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false
    selected.add(relative.split(path.sep).join('/'))
    return selected.size >= 256
  }
  for (const rawEvent of session?.events ?? []) {
    const event = record(rawEvent)
    if (event?.type === 'tool/call') {
      const data = record(event.data)
      for (const changedPath of mutationPathsFromToolCall(String(data?.name ?? ''), data?.arguments, cwd)) {
        if (addPath(changedPath)) return [...selected]
      }
      continue
    }
    if (event?.type !== 'tool/result') continue
    const data = record(event.data)
    const message = record(data?.message)
    const meta = record(data?.meta) ?? record(message?.meta)
    const diffs = Array.isArray(meta?.diffs) ? meta.diffs : []
    for (const rawDiff of diffs) {
      const changedPath = record(rawDiff)?.path
      if (addPath(changedPath)) return [...selected]
    }
  }
  return [...selected]
}

function workspaceOf(agent: { session?: SessionLike } | undefined): string {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd()
}

function controllerFor(cwd: string): AutoresearchController {
  const key = cwd
  const existing = controllers.get(key)
  if (existing) return existing
  const created = new AutoresearchController({ cwd })
  controllers.set(key, created)
  return created
}

export function createAutoresearchFollowupMessage(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name, form: 'instructions' },
  })
}

function withSnapshot(controller: AutoresearchController, result: { text?: string; [key: string]: unknown }): ToolResult {
  const snapshot = toJsonValue(controller.snapshot() as AutoresearchSnapshot)
  return toJsonValue({
    ...(result as unknown as ToolResult),
    snapshot,
    // Human text only. Snapshot rides presentationMeta so the GUI can update
    // the dock without dumping the ledger JSON into the transcript.
    text: String(result.text ?? ''),
  })
}

function toolOutput() {
  return {
    schema: { type: 'json' },
    render: (_args: unknown, value: ToolResult) => [{ type: 'text', text: value.text }],
    presentationMeta: (_args: unknown, value: ToolResult) => (
      value.snapshot ? { snapshot: value.snapshot } : {}
    ),
  }
}

export function queueAutoresearchFollowup(agent: FollowupAgent | undefined, text: string): void {
  if (!agent?.followup) return
  agent.followup(createAutoresearchFollowupMessage(text))
}

function playbookFor(result: ToolResult): string {
  if (!result.needsSetup) return CONTINUE_PLAYBOOK
  const goal = result.snapshot?.goal?.trim()
  return goal ? `${CREATE_PLAYBOOK}\n\nCurrent explicit goal: ${goal}` : CREATE_PLAYBOOK
}

function isActivating(args: string): boolean {
  const command = args.trim().toLowerCase()
  if (!command) return false
  if (/^(help|status|off|complete|clear|export|finalize|hooks)\b/.test(command)) return false
  return true
}

function enableAllowNoGit(controller: AutoresearchController, raw: string): void {
  if (!/\ballow[- ]?no[- ]?git\b/i.test(raw)) return
  const configPath = sessionFilePath(controller.cwd, 'config')
  ensureParentDir(configPath)
  writeFileSync(configPath, `${JSON.stringify({ ...controller.config(), allowNoGit: true }, null, 2)}\n`)
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const migration = await migrateLegacyAutoresearchSessions(
    (ctx as Context & { sessionPersistence: SessionPersistenceLike }).sessionPersistence,
  )
  if (migration.failures.length > 0) {
    ctx.logger.warn('[dsh-autoresearch] legacy session migration deferred', migration.failures)
  }
  console.log(MARKER)

  let source = () => config
  try {
    installSettingsSection(ctx, NS, Config, config, {
      setSource: (current: unknown) => {
        source = typeof current === 'function' ? current as () => Config : () => current as Config
      },
      onChange: () => { void source() },
    })
  } catch {
    /* settings service is optional */
  }

  ctx.on('tools/pre-execute', (exec: { name: string; arguments?: unknown; agent?: { session?: { header?: { cwd?: string } } } }, next: () => Promise<unknown>) => {
    const cwd = workspaceOf(exec.agent)
    const controller = controllerFor(cwd)
    const pending = controller.privateState()
    const args = exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments as Record<string, unknown>
      : undefined
    const decision = evaluatePendingGuard({ toolName: exec.name, args, cwd, pending })
    if (decision.decision === 'deny') {
      return { kind: 'deny', reason: decision.reason }
    }
    const mutationPaths = mutationPathsFromToolCall(exec.name, exec.arguments, cwd)
    if (mutationPaths.length) {
      const protectedResult = controller.protectPathsBeforeMutation(mutationPaths)
      if (!protectedResult.ok) {
        return {
          kind: 'deny',
          reason: protectedResult.text ?? '这个特殊路径需要你确认后才能修改。',
        }
      }
    }
    return next()
  })

  const tool = (spec: Parameters<typeof defineTool>[0]) => ctx.tools.register(defineTool(spec))

  tool({
    name: 'autoresearch_control',
    description: 'Handle an explicit /autoresearch command: start/resume a goal, show help/status, stop, or clear. Ordinary user prompts must never call this tool to activate a loop.',
    parameters: {
      args: { type: 'string', description: 'Raw /autoresearch arguments' },
    },
    output: toolOutput(),
    async execute(args: { args?: string }, exec: { agent?: FollowupAgent }) {
      const cwd = workspaceOf(exec.agent)
      const controller = controllerFor(cwd)
      const raw = String(args.args ?? '')
      enableAllowNoGit(controller, raw)
      const result = withSnapshot(controller, await controller.control({
        args: raw,
        protectedPaths: protectedPathsFromSession(exec.agent?.session, cwd),
      }))
      if (result.ok && result.active && isActivating(raw)) {
        queueAutoresearchFollowup(exec.agent, playbookFor(result))
      }
      return result
    },
  })

  tool({
    name: 'autoresearch_status',
    description: 'Read durable autoresearch state for this workspace without activating it.',
    parameters: {},
    output: toolOutput(),
    async execute(_args: unknown, exec: { agent?: { session?: { header?: { cwd?: string }; append?: (type: string, data: unknown) => void } } }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      const result = withSnapshot(controller, await controller.status())
      return result
    },
  })

  tool({
    name: 'autoresearch_init_experiment',
    description: 'Initialize or reinitialize an active experiment segment and append its config header.',
    parameters: {
      name: { type: 'string', required: true, description: 'Experiment name' },
      metric_name: { type: 'string', required: true, description: 'Primary METRIC name' },
      metric_unit: { type: 'string', description: 'Optional unit' },
      direction: { type: 'string', enum: ['lower', 'higher'], description: 'Whether lower or higher is better' },
    },
    output: toolOutput(),
    async execute(args: { name: string; metric_name: string; metric_unit?: string; direction?: string }, exec: { agent?: { session?: { header?: { cwd?: string }; append?: (type: string, data: unknown) => void } } }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      const result = withSnapshot(controller, await controller.initExperiment(args))
      return result
    },
  })

  tool({
    name: 'autoresearch_run_experiment',
    description: 'Run the stable benchmark for an active loop with timing, cancellation, METRIC parsing, and optional correctness checks. Always follow with autoresearch_log_experiment.',
    parameters: {
      command: { type: 'string', required: true, description: 'Benchmark command, usually bash .auto/measure.sh' },
      timeout_seconds: { type: 'number', description: 'Benchmark timeout in seconds' },
      checks_timeout_seconds: { type: 'number', description: 'Optional checks.sh timeout' },
    },
    output: toolOutput(),
    async execute(args: { command: string; timeout_seconds?: number; checks_timeout_seconds?: number }, exec: { agent?: { session?: { header?: { cwd?: string } } }; signal?: AbortSignal }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      return withSnapshot(controller, await controller.runExperiment({ ...args, signal: exec.signal } as never))
    },
  })

  tool({
    name: 'autoresearch_log_experiment',
    description: 'Durably record one actual experiment and atomically decide whether to continue, complete, or wait for the user. keep commits; discard/crash/checks_failed revert while preserving .auto.',
    parameters: {
      commit: { type: 'string', description: 'Optional short commit hash' },
      metric: { type: 'number', required: true, description: 'Primary metric value' },
      metrics: { type: 'json', description: 'Secondary METRIC map' },
      status: { type: 'string', required: true, enum: ['keep', 'discard', 'crash', 'checks_failed'] },
      description: { type: 'string', required: true, description: 'What changed in this run' },
      asi: { type: 'json', required: true, description: 'Hypothesis and notes for the next iteration' },
      force: { type: 'boolean', description: 'Allow adding new secondary metrics' },
      next_action: { type: 'string', required: true, enum: ['continue', 'complete', 'needs_user'], description: 'The durable next lifecycle decision for this loop' },
      decision_reason: { type: 'string', required: true, description: 'Evidence-based reason for the next lifecycle decision' },
      user_question: { type: 'string', description: 'Required when next_action is needs_user; ask this exact decision question' },
    },
    output: toolOutput(),
    async execute(args: Record<string, unknown>, exec: {
      agent?: FollowupAgent
      concludeTurn?: () => void
    }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      const result = withSnapshot(controller, await controller.logExperiment(args))
      if (result.resume?.shouldSchedule) {
        queueAutoresearchFollowup(exec.agent, CONTINUE_PLAYBOOK)
        exec.concludeTurn?.()
        if (result.resume.token) {
          try { controller.consumeResumeToken(result.resume.token) } catch { /* already consumed or cancelled */ }
        }
      }
      return result
    },
  })

  tool({
    name: 'autoresearch_finish',
    description: 'Close an active autoresearch loop after later verification, or pause it for an explicit user decision. Use this before claiming completion when no new experiment is being logged.',
    parameters: {
      outcome: { type: 'string', required: true, enum: ['complete', 'needs_user'] },
      reason: { type: 'string', required: true, description: 'Evidence-based completion or decision reason' },
      user_question: { type: 'string', description: 'Required when outcome is needs_user' },
    },
    output: toolOutput(),
    async execute(args: { outcome: string; reason: string; user_question?: string }, exec: { agent?: FollowupAgent }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      return withSnapshot(controller, await controller.finish(args))
    },
  })

  tool({
    name: 'autoresearch_compaction_summary',
    description: 'Build a deterministic summary from .auto artifacts so the active loop can survive context compaction.',
    parameters: {},
    output: toolOutput(),
    async execute(_args: unknown, exec: { agent?: { session?: { header?: { cwd?: string } } } }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      const text = buildAutoresearchCompactionSummary(autoresearchSummaryPathsFor(controller.workDir()))
      return withSnapshot(controller, { ok: true, text })
    },
  })

  ctx.inject(['commands'], (commandCtx: Context) => {
    commandCtx.commands.register({
      name: 'autoresearch',
      description: 'Explicitly start, resume, inspect, or stop a durable autoresearch experiment loop',
      input: { hint: '<goal | resume | status | off | clear>' },
      handler: async (invocation: { agent: FollowupAgent; rawInput: string }) => {
        const cwd = workspaceOf(invocation.agent)
        const controller = controllerFor(cwd)
        const raw = invocation.rawInput
        enableAllowNoGit(controller, raw)
        const result = withSnapshot(controller, await controller.control({
          args: raw,
          protectedPaths: protectedPathsFromSession(invocation.agent.session, cwd),
        }))
        if (result.ok && result.active && isActivating(raw)) {
          queueAutoresearchFollowup(invocation.agent, playbookFor(result))
        }
        return { kind: result.ok ? 'success' : 'error', text: result.text }
      },
    })
  })

  ctx.inject(['systemPrompt'], (promptCtx: Context) => {
    promptCtx.systemPrompt.section({
      name: 'tool:autoresearch',
      order: 118,
      text: (assemble: { agent?: { session?: { header?: { cwd?: string } } } }) => {
        const cwd = workspaceOf(assemble.agent)
        const state = controllerFor(cwd).privateState()
        if (state.loopState === 'awaiting_user') {
          return [
            'Autoresearch is paused for an explicit user decision.',
            `Question: ${state.decisionQuestion ?? 'Ask the user whether to continue or complete.'}`,
            `Reason: ${state.completionReason ?? 'Further progress requires user judgment.'}`,
            'Use the host decision-question UI. If the user chooses to continue, run /autoresearch resume. If the user chooses to stop, call autoresearch_finish with outcome=complete before the final answer.',
          ].join('\n')
        }
        if (state.active !== true || state.manualOff === true) return ''
        return state.pendingNewGoal && state.goal
          ? `${CREATE_PLAYBOOK}\n\nCurrent explicit goal: ${state.goal}`
          : CREATE_PLAYBOOK
      },
    })
  })

  ctx.inject(['skills'], (skillCtx: Context) => {
    const bodies = skillBodies()
    skillCtx.skills.register({
      name: 'autoresearch-create',
      description: 'Supporting setup playbook for an explicitly activated /autoresearch loop. Never activates autoresearch by itself.',
      source: 'runtime',
      content: bodies.create,
      invocation: { modelInvocable: false, userInvocable: false },
    })
    if (bodies.finalize) {
      skillCtx.skills.register({
        name: 'autoresearch-finalize',
        description: 'Finalize an autoresearch session into clean, reviewable branches.',
        source: 'runtime',
        content: bodies.finalize,
        invocation: { modelInvocable: false, userInvocable: false },
      })
    }
    if (bodies.hooks) {
      skillCtx.skills.register({
        name: 'autoresearch-hooks',
        description: 'Author before/after hooks for an autoresearch session.',
        source: 'runtime',
        content: bodies.hooks,
        invocation: { modelInvocable: false, userInvocable: false },
      })
    }
  })

  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register({
      key: 'autoresearch',
      stateSchema: autoresearchProjectionStateSchema,
      init: initialAutoresearchProjectionState,
      apply: (state: AutoresearchProjectionState, event: { type: string; time?: number; data: unknown }) => {
        return foldAutoresearchProjection(state, event)
      },
      wire: {
        viewSchema: autoresearchProjectionSchema,
        view: (state: AutoresearchProjectionState) => state.snapshot
          ? { ...state.snapshot, boardReady: state.boardReady }
          : null,
      },
      stateVersion: 6,
    })
  })
}
