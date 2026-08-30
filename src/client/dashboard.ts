import { parseEmbeddedState, type AutoresearchSnapshot } from '../types.js'
import type { ExperimentRun, ExperimentStatus, MetricDirection } from '../jsonl.js'
import { longerSnapshot } from '../projection.js'

export type ProgressCardKind = 'none' | 'running' | 'board'

export interface DashboardRow {
  run: number
  commit: string
  metric: string
  status: ExperimentStatus
  description: string
}

export interface DashboardSecondary {
  name: string
  value: string
  deltaPct: number | null
}

export interface DashboardModel {
  title: string
  name: string | null
  runs: number
  kept: number
  discarded: number
  crashed: number
  checksFailed: number
  conf: number | null
  metricName: string
  baseline: { value: string; run: number } | null
  progress: { value: string; run: number; deltaPct: number | null; improved: boolean | null } | null
  secondaries: DashboardSecondary[]
  rows: DashboardRow[]
  running: boolean
  runningCommand: string | null
  lifecycle: 'running' | 'completed' | 'awaiting_user' | 'stopped' | 'ended'
}

export interface ConversationInspectInput {
  runningCalls?: ReadonlyArray<{ name?: string; argsRaw?: string }>
  nodes?: readonly unknown[]
}

export interface ConversationProgress {
  kind: ProgressCardKind
  snapshot: AutoresearchSnapshot | null
  runningCommand: string | null
  hasRunStarted: boolean
  runningExperiment: boolean
}

const RUN_TOOL = 'autoresearch_run_experiment'
const LOG_TOOL = 'autoresearch_log_experiment'
const TABLE_ROWS = 6

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function currentSegmentOf(results: readonly ExperimentRun[]): number {
  return results.at(-1)?.segment ?? 0
}

function currentResults(results: readonly ExperimentRun[], segmentOverride?: number): ExperimentRun[] {
  const segment = segmentOverride ?? currentSegmentOf(results)
  return results.filter((run) => run.segment === segment)
}

function isBetter(current: number, best: number, direction: MetricDirection): boolean {
  return direction === 'lower' ? current < best : current > best
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** MAD-based confidence; null below 3 points — same rule as pi-autoresearch. */
export function confidenceFor(results: readonly ExperimentRun[], direction: MetricDirection): number | null {
  const current = currentResults(results).filter((run) => run.metric > 0)
  if (current.length < 3) return null
  const values = current.map((run) => run.metric)
  const center = median(values)
  const mad = median(values.map((value) => Math.abs(value - center)))
  if (mad === 0) return null
  const baseline = current[0]?.metric
  const kept = current.filter((run) => run.status === 'keep')
  if (!baseline || kept.length === 0) return null
  const best = kept.reduce(
    (value, run) => (isBetter(run.metric, value, direction) ? run.metric : value),
    kept[0].metric,
  )
  if (best === baseline) return null
  return Math.abs(best - baseline) / mad
}

export function formatNum(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const raw = value === Math.round(value) ? String(value) : value.toFixed(2)
  if (!unit) return raw
  const glue = unit.length <= 2 ? '' : ' '
  return `${raw}${glue}${unit}`
}

export function formatDeltaPct(pct: number | null): string | null {
  if (pct === null || !Number.isFinite(pct)) return null
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

export function progressCardKind(input: {
  results?: readonly unknown[] | null
  runningExperiment?: boolean
  hasRunStarted?: boolean
}): ProgressCardKind {
  if ((input.results?.length ?? 0) > 0) return 'board'
  if (input.runningExperiment || input.hasRunStarted) return 'running'
  return 'none'
}

function shortCommit(status: ExperimentStatus, commit: string): string {
  if (status !== 'keep') return '—'
  const trimmed = String(commit || '').trim()
  return trimmed ? trimmed.slice(0, 7) : '—'
}

function deltaPct(value: number, baseline: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0 || value === baseline) return null
  return ((value - baseline) / baseline) * 100
}

function secondaryNames(results: readonly ExperimentRun[], metricName: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const run of results) {
    for (const name of Object.keys(run.metrics ?? {})) {
      if (name === metricName || seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

export function buildDashboardModel(
  snapshot: AutoresearchSnapshot,
  opts: { running?: boolean; runningCommand?: string | null } = {},
): DashboardModel {
  const results = snapshot.results ?? []
  const current = currentResults(results, snapshot.currentSegment)
  const keptRuns = current.filter((run) => run.status === 'keep')
  const discarded = current.filter((run) => run.status === 'discard').length
  const crashed = current.filter((run) => run.status === 'crash').length
  const checksFailed = current.filter((run) => run.status === 'checks_failed').length
  const direction = snapshot.direction ?? 'lower'
  const unit = snapshot.metricUnit ?? ''
  const metricName = snapshot.metricName || 'metric'
  const baselineRun = current[0] ?? null
  const baselineValue = baselineRun?.metric ?? snapshot.baselineMetric
  const baselineIndex = results.findIndex((run) => run.segment === (baselineRun?.segment ?? currentSegmentOf(results)))
  const baselineNumber = baselineRun ? (baselineRun.run || baselineIndex + 1) : 0

  let best: ExperimentRun | null = null
  for (const run of keptRuns) {
    if (best === null || isBetter(run.metric, best.metric, direction)) best = run
  }

  const secondaries: DashboardSecondary[] = []
  if (best) {
    for (const name of secondaryNames(current, metricName)) {
      const value = best.metrics?.[name]
      if (value === undefined) continue
      const baselineSec = baselineRun?.metrics?.[name]
      secondaries.push({
        name,
        value: formatNum(value, name.endsWith('_ms') ? 'ms' : ''),
        deltaPct: baselineSec === undefined ? null : deltaPct(value, baselineSec),
      })
    }
  }

  const start = Math.max(0, current.length - TABLE_ROWS)
  const rows = current.slice(start).map((run) => ({
    run: run.run,
    commit: shortCommit(run.status, run.commit),
    metric: formatNum(run.metric, unit),
    status: run.status,
    description: String(run.description || run.asi?.hypothesis || '').trim() || '—',
  }))

  return {
    title: snapshot.name ? `autoresearch: ${snapshot.name}` : 'autoresearch',
    name: snapshot.name,
    runs: current.length,
    kept: keptRuns.length,
    discarded,
    crashed,
    checksFailed,
    conf: confidenceFor(current, direction),
    metricName,
    baseline: baselineRun && baselineValue !== null && baselineValue !== undefined
      ? { value: formatNum(baselineValue, unit), run: baselineNumber }
      : null,
    progress: best
      ? {
          value: formatNum(best.metric, unit),
          run: best.run,
          deltaPct: baselineValue === null || baselineValue === undefined ? null : deltaPct(best.metric, baselineValue),
          improved: baselineValue === null || baselineValue === undefined || best.metric === baselineValue
            ? null
            : isBetter(best.metric, baselineValue, direction),
        }
      : null,
    secondaries,
    rows,
    running: opts.running === true,
    runningCommand: opts.runningCommand ?? null,
    lifecycle: snapshot.loopState === 'completed'
      ? 'completed'
      : snapshot.loopState === 'awaiting_user'
        ? 'awaiting_user'
        : snapshot.loopState === 'stopped' || snapshot.loopState === 'blocked'
          ? 'stopped'
          : snapshot.active
            ? 'running'
            : 'ended',
  }
}

function snapshotFromUnknown(value: unknown): AutoresearchSnapshot | null {
  if (!isRecord(value)) return null
  if (Array.isArray(value.results) && typeof value.metricName === 'string') {
    return value as unknown as AutoresearchSnapshot
  }
  if (value.snapshot) return snapshotFromUnknown(value.snapshot)
  return null
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map((block) => (isRecord(block) && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

function snapshotFromNode(node: Record<string, unknown>): AutoresearchSnapshot | null {
  return snapshotFromUnknown(node.meta) ?? parseEmbeddedState(textFromContent(node.content)).snapshot ?? null
}

function toolNameOf(node: Record<string, unknown>): string {
  if (isRecord(node.call) && typeof node.call.name === 'string') return node.call.name
  if (typeof node.name === 'string') return node.name
  return ''
}

function commandFromArgsRaw(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (isRecord(parsed) && typeof parsed.command === 'string') return parsed.command
  } catch {
    /* raw may already be the command */
  }
  return raw
}

function visitRecord(node: Record<string, unknown>, visit: (node: Record<string, unknown>) => void, seen: Set<unknown>): void {
  if (seen.has(node)) return
  seen.add(node)
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) walkNodes(value, visit, seen)
    else if (isRecord(value) && value !== node.meta && value !== node.snapshot) walkNodes([value], visit, seen)
  }
}

function walkNodes(
  nodes: readonly unknown[],
  visit: (node: Record<string, unknown>) => void,
  seen: Set<unknown> = new Set(),
): void {
  for (const item of nodes) {
    if (!isRecord(item)) continue
    visitRecord(item, visit, seen)
  }
}

function conversationNodes(conv: ConversationInspectInput | Record<string, unknown> | null | undefined): unknown[] {
  if (!conv || typeof conv !== 'object') return []
  const rec = conv as Record<string, unknown>
  const out: unknown[] = []
  const push = (value: unknown) => {
    if (Array.isArray(value)) out.push(...value)
  }
  push(rec.nodes)
  if (isRecord(rec.chat)) {
    if (isRecord(rec.chat.legacy)) push(rec.chat.legacy.nodes)
    const store = rec.chat.nodes
    if (store && typeof (store as { values?: () => unknown[] }).values === 'function') {
      try { push((store as { values: () => unknown[] }).values()) } catch { /* ignore */ }
    }
  }
  return out
}

function isRunExperimentName(name: string): boolean {
  return name === RUN_TOOL || name.endsWith('run_experiment')
}

function isLogExperimentNode(node: Record<string, unknown>, name: string): boolean {
  if (name === LOG_TOOL || name.endsWith('log_experiment')) return true
  return node.kind === 'tool-result' && /Logged #\d+/.test(textFromContent(node.content))
}

/**
 * Progress comes from this conversation's run/log tools, not from /autoresearch status.
 * init_experiment alone (empty ledger) stays kind 'none'.
 * Longer log_experiment snapshots win, including when a shorter one is nested later.
 */
export function inspectConversation(conv: ConversationInspectInput | null | undefined): ConversationProgress {
  const runningCalls = conv?.runningCalls ?? []
  const runningCall = runningCalls.find((call) => call.name === RUN_TOOL)
  const runningExperiment = Boolean(runningCall)
  const runningCommand = commandFromArgsRaw(runningCall?.argsRaw)

  let hasRunStarted = runningExperiment
  let logSnapshot: AutoresearchSnapshot | null = null

  walkNodes(conversationNodes(conv), (node) => {
    const name = toolNameOf(node)
    const isResult = node.kind === 'tool-result' || name.startsWith('autoresearch_')
    if (!isResult && !isRunExperimentName(name) && !isLogExperimentNode(node, name)) return
    if (isRunExperimentName(name)) hasRunStarted = true
    const snapshot = snapshotFromNode(node)
    if (snapshot && isLogExperimentNode(node, name)) {
      logSnapshot = longerSnapshot(logSnapshot, snapshot)
    }
  })

  const kind = progressCardKind({
    // TypeScript does not model assignments performed by the synchronous walk callback.
    results: (logSnapshot as AutoresearchSnapshot | null)?.results,
    runningExperiment,
    hasRunStarted,
  })

  return {
    kind,
    snapshot: logSnapshot,
    runningCommand,
    hasRunStarted,
    runningExperiment,
  }
}

export function sampleRun(partial: Partial<ExperimentRun> & Pick<ExperimentRun, 'run' | 'metric' | 'status'>): ExperimentRun {
  return {
    commit: '',
    metrics: {},
    description: '',
    timestamp: 0,
    segment: 0,
    confidence: null,
    ...partial,
  }
}
