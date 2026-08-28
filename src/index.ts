/**
 * DeepSeek Harness host plugin: durable auto-research experiment loop.
 * Named `apply` only — no default export (dshx function/client contract).
 */
import { writeFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { AutoresearchController } from './controller.js'
import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from './compaction.js'
import { evaluatePendingGuard } from './guard.js'
import { CONTINUE_PLAYBOOK, CREATE_PLAYBOOK, skillBodies } from './playbook.js'
import { ensureParentDir, sessionFilePath } from './paths.js'
import { type AutoresearchSnapshot, type ToolResult } from './types.js'

export const name = 'dsh-autoresearch'
export const inject = ['tools']
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

function workspaceOf(agent: { session?: { header?: { cwd?: string } } } | undefined): string {
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

function userMessage(text: string): { role: 'user'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' } } {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function withSnapshot(controller: AutoresearchController, result: { text?: string; [key: string]: unknown }): ToolResult {
  const snapshot = controller.snapshot() as AutoresearchSnapshot
  return {
    ...(result as unknown as ToolResult),
    snapshot,
    // Human text only. Snapshot rides presentationMeta so the GUI can update
    // the dock without dumping the ledger JSON into the transcript.
    text: String(result.text ?? ''),
  }
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

function followup(agent: { followup?: (message: unknown) => void } | undefined, text: string): void {
  if (!agent?.followup) return
  agent.followup(userMessage(text))
}

function isActivating(args: string): boolean {
  const command = args.trim().toLowerCase()
  if (!command) return false
  if (/^(help|status|off|clear|export|finalize|hooks)\b/.test(command)) return false
  return true
}

function enableAllowNoGit(controller: AutoresearchController, raw: string): void {
  if (!/\ballow[- ]?no[- ]?git\b/i.test(raw)) return
  const configPath = sessionFilePath(controller.cwd, 'config')
  ensureParentDir(configPath)
  writeFileSync(configPath, `${JSON.stringify({ ...controller.config(), allowNoGit: true }, null, 2)}\n`)
}

export function apply(ctx: Context, config: Config): void {
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
    const pending = controllerFor(cwd).privateState()
    const args = exec.arguments && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? exec.arguments as Record<string, unknown>
      : undefined
    const decision = evaluatePendingGuard({ toolName: exec.name, args, cwd, pending })
    if (decision.decision === 'deny') {
      return { kind: 'deny', reason: decision.reason }
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
    async execute(args: { args?: string }, exec: { agent?: { followup?: (message: unknown) => void; session?: { header?: { cwd?: string }; append?: (type: string, data: unknown) => void } } }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      const raw = String(args.args ?? '')
      enableAllowNoGit(controller, raw)
      const result = withSnapshot(controller, await controller.control({ args: raw }))
      if (result.ok && result.active && isActivating(raw)) {
        followup(exec.agent, result.needsSetup ? CREATE_PLAYBOOK : CONTINUE_PLAYBOOK)
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
    description: 'Durably record one actual experiment. keep commits; discard/crash/checks_failed revert while preserving .auto. If resume.shouldSchedule is true, end the turn; the host follows up the same session.',
    parameters: {
      commit: { type: 'string', description: 'Optional short commit hash' },
      metric: { type: 'number', required: true, description: 'Primary metric value' },
      metrics: { type: 'json', description: 'Secondary METRIC map' },
      status: { type: 'string', required: true, enum: ['keep', 'discard', 'crash', 'checks_failed'] },
      description: { type: 'string', required: true, description: 'What changed in this run' },
      asi: { type: 'json', required: true, description: 'Hypothesis and notes for the next iteration' },
      force: { type: 'boolean', description: 'Allow adding new secondary metrics' },
    },
    output: toolOutput(),
    async execute(args: Record<string, unknown>, exec: {
      agent?: { followup?: (message: unknown) => void; session?: { header?: { cwd?: string }; append?: (type: string, data: unknown) => void } }
      concludeTurn?: () => void
    }) {
      const controller = controllerFor(workspaceOf(exec.agent))
      const result = withSnapshot(controller, await controller.logExperiment(args))
      if (result.resume?.shouldSchedule) {
        followup(exec.agent, CONTINUE_PLAYBOOK)
        exec.concludeTurn?.()
        if (result.resume.token) {
          try { controller.consumeResumeToken(result.resume.token) } catch { /* already consumed or cancelled */ }
        }
      }
      return result
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
      handler: async (invocation: { agent: { followup?: (message: unknown) => void; session?: { header?: { cwd?: string }; append?: (type: string, data: unknown) => void } }; rawInput: string }) => {
        const controller = controllerFor(workspaceOf(invocation.agent))
        const raw = invocation.rawInput
        enableAllowNoGit(controller, raw)
        const result = withSnapshot(controller, await controller.control({ args: raw }))
        if (result.ok && result.active && isActivating(raw)) {
          followup(invocation.agent, result.needsSetup ? CREATE_PLAYBOOK : CONTINUE_PLAYBOOK)
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
        if (state.active !== true || state.manualOff === true) return ''
        return CREATE_PLAYBOOK
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
        invocation: { modelInvocable: false, userInvocable: true },
      })
    }
    if (bodies.hooks) {
      skillCtx.skills.register({
        name: 'autoresearch-hooks',
        description: 'Author before/after hooks for an autoresearch session.',
        source: 'runtime',
        content: bodies.hooks,
        invocation: { modelInvocable: false, userInvocable: true },
      })
    }
  })

  ctx.inject(['sessionProjections'], (projectionCtx: Context) => {
    projectionCtx.sessionProjections.register({
      key: 'autoresearch',
      init: () => null,
      apply: (state: AutoresearchSnapshot | null, event: { type: string; data: unknown }) => {
        // Session.append cannot mark out-of-repo types ignorable, so this plugin
        // does not write autoresearch/* events. GUI state travels in tool presentationMeta.
        if (event.type === 'autoresearch/state') return event.data
        if (event.type === 'turn/start' && state && !state.active) return state
        return state
      },
      stateVersion: 1,
    })
  })
}
