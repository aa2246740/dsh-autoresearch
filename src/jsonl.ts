export type MetricDirection = 'lower' | 'higher'
export type ExperimentStatus = 'keep' | 'discard' | 'crash' | 'checks_failed'

export interface AsiNotes {
  hypothesis?: string
  rollback_reason?: string
  next_action_hint?: string
  [key: string]: unknown
}

export interface ExperimentRun {
  run: number
  commit: string
  metric: number
  metrics: Record<string, number>
  status: ExperimentStatus
  description: string
  timestamp: number
  segment: number
  confidence: number | null
  asi?: AsiNotes
}

export interface PersistedState {
  name: string | null
  metricName: string
  metricUnit: string
  bestDirection: MetricDirection
  currentSegment: number
  results: ExperimentRun[]
  secondaryMetrics: Array<{ name: string; unit: string }>
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function inferMetricUnit(name: string): string {
  if (name.endsWith('µs')) return 'µs'
  if (name.endsWith('_ms')) return 'ms'
  if (name.endsWith('_s') || name.endsWith('_sec')) return 's'
  if (name.endsWith('_kb')) return 'kb'
  if (name.endsWith('_mb')) return 'mb'
  return ''
}

function metricMapFrom(value: unknown): Record<string, number> {
  if (!isObjectRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([, metric]) => typeof metric === 'number' && Number.isFinite(metric)),
  ) as Record<string, number>
}

function statusFrom(value: unknown): ExperimentStatus {
  return value === 'discard' || value === 'crash' || value === 'checks_failed' ? value : 'keep'
}

function freshState(): PersistedState {
  return {
    name: null,
    metricName: 'metric',
    metricUnit: '',
    bestDirection: 'lower',
    currentSegment: 0,
    results: [],
    secondaryMetrics: [],
  }
}

export function parseJsonlEntry(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown
    return isObjectRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isAutoresearchConfigEntry(entry: Record<string, unknown> | null): boolean {
  return isObjectRecord(entry) && entry.type === 'config'
}

export function isAutoresearchRunEntry(entry: Record<string, unknown> | null): boolean {
  return isObjectRecord(entry) && typeof entry.run === 'number'
}

function entries(jsonlContent: string): Record<string, unknown>[] {
  return String(jsonlContent).split('\n').filter(Boolean).map(parseJsonlEntry).filter((entry): entry is Record<string, unknown> => entry !== null)
}

export function hasAutoresearchConfigHeader(jsonlContent: string): boolean {
  return entries(jsonlContent).some(isAutoresearchConfigEntry)
}

export function extractAutoresearchSessionName(jsonlContent: string): string {
  const config = entries(jsonlContent).find(isAutoresearchConfigEntry)
  return typeof config?.name === 'string' && config.name ? config.name : 'Autoresearch'
}

export function reconstructJsonlState(jsonlContent: string): PersistedState {
  const state = freshState()
  let segment = 0

  for (const entry of entries(jsonlContent)) {
    if (isAutoresearchConfigEntry(entry)) {
      if (state.results.length > 0) {
        segment += 1
        state.secondaryMetrics = []
      }
      if (typeof entry.name === 'string') state.name = entry.name
      if (typeof entry.metricName === 'string') state.metricName = entry.metricName
      if (typeof entry.metricUnit === 'string') state.metricUnit = entry.metricUnit
      state.bestDirection = entry.bestDirection === 'higher' ? 'higher' : 'lower'
      state.currentSegment = segment
      continue
    }
    if (!isAutoresearchRunEntry(entry)) continue

    const metrics = metricMapFrom(entry.metrics)
    const run: ExperimentRun = {
      run: entry.run as number,
      commit: typeof entry.commit === 'string' ? entry.commit : '',
      metric: typeof entry.metric === 'number' ? entry.metric : 0,
      metrics,
      status: statusFrom(entry.status),
      description: typeof entry.description === 'string' ? entry.description : '',
      timestamp: typeof entry.timestamp === 'number' ? entry.timestamp : 0,
      segment,
      confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
      ...(isObjectRecord(entry.asi) ? { asi: entry.asi as AsiNotes } : {}),
    }
    state.results.push(run)
    for (const name of Object.keys(metrics)) {
      if (name === state.metricName) continue
      if (!state.secondaryMetrics.some((metric) => metric.name === name)) {
        state.secondaryMetrics.push({ name, unit: inferMetricUnit(name) })
      }
    }
  }

  return state
}
