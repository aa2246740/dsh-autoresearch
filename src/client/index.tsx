import { useEffect, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ExperimentRun } from '../types.js'
import { parseEmbeddedState } from '../types.js'
import {
  applyCommandText,
  buildStartLine,
  closeLab,
  emptyDraft,
  formatMetric,
  getLabState,
  openLab,
  patchLab,
  rememberSession,
  subscribeLab,
  type ExperimentDraft,
} from './store.js'

export const name = 'dsh-autoresearch-client'
export const inject = [
  'slots',
  'sessions',
  'remote',
  'remote.commands',
  'connection',
  'settingsScope',
  'commandUi',
]

type ModelOption = { key: string; provider: string; model: string; label: string }

type SessionModelsApi = {
  models: (payload: { sessionId: string }) => Promise<RemoteAnswer>
  selectModel: (payload: { sessionId: string; provider: string; model: string }) => Promise<RemoteAnswer>
}

type AnyCtx = ClientContext & {
  slots: {
    inject: (name: string, factory: () => unknown) => void
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  sessions: { current?: { sessionId?: string }; binding?: (id: string) => unknown }
  remote: {
    commands: { execute: (sessionId: string, line: string, images: unknown[]) => Promise<RemoteAnswer> }
  }
  get?: (name: string) => { api?: { sessions?: SessionModelsApi } } | undefined
  settingsScope: { bind: (opts: { namespace: string }) => SettingsScope }
  commandUi: CommandUiContract
}

interface RemoteAnswer {
  ok?: boolean
  error?: { message: string; code: string }
  value?: { result?: { kind: string; text?: string; ok?: boolean; value?: unknown }; text?: string; current?: unknown; groups?: unknown }
  result?: { ok?: boolean; error?: { message: string; code: string }; value?: unknown }
}

interface SettingsScope {
  value: Record<string, unknown>
  set: (field: string, value: unknown) => Promise<void> | void
}

const colors = {
  bg: 'var(--dsw-alias-bg-primary, Canvas)',
  panel: 'var(--dsw-alias-bg-secondary, Canvas)',
  text: 'var(--dsw-alias-label-primary, CanvasText)',
  muted: 'var(--dsw-alias-label-secondary, GrayText)',
  line: 'var(--dsw-alias-border-l2, ButtonBorder)',
  good: 'var(--dsw-alias-text-success, #1a7f37)',
  bad: 'var(--dsw-alias-text-danger, #cf222e)',
  accent: 'var(--dsw-alias-text-accent, #0969da)',
  warn: 'var(--dsw-alias-text-warning, #9a6700)',
}

const font: CSSProperties = {
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  color: colors.text,
}

function useLab() {
  return useSyncExternalStore(subscribeLab, getLabState, getLabState)
}

function unwrapRpc(answered: RemoteAnswer): { ok: boolean; value?: unknown; error?: string } {
  if (answered.result && typeof answered.result === 'object') {
    const inner = answered.result
    if (inner.ok === false) return { ok: false, error: `${inner.error?.message ?? 'rpc failed'} (${inner.error?.code ?? 'error'})` }
    if (inner.ok === true) return { ok: true, value: inner.value }
  }
  if (answered.ok === false) return { ok: false, error: `${answered.error?.message ?? 'rpc failed'} (${answered.error?.code ?? 'error'})` }
  return { ok: true, value: answered.value }
}

async function executeLine(ctx: AnyCtx, sessionId: string, line: string): Promise<string> {
  const answered = await ctx.remote.commands.execute(sessionId, line, [])
  if (!answered.ok) throw new Error(`${answered.error?.message ?? 'command failed'} (${answered.error?.code ?? 'error'})`)
  if (answered.value === undefined) throw new Error(`unknown command: ${line}`)
  const payload = answered.value
  const result = payload.result ?? payload
  const text = result.text ?? ''
  applyCommandText(text)
  if ('kind' in result && result.kind === 'error') throw new Error(parseEmbeddedState(text).text || text)
  return text
}

function statusColor(status: ExperimentRun['status']): string {
  if (status === 'keep') return colors.good
  if (status === 'discard') return colors.warn
  return colors.bad
}

function LabButton(props: { children: string; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit' }) {
  const kind = props.kind ?? 'ghost'
  const background = kind === 'primary' ? colors.accent : 'transparent'
  const color = kind === 'primary' ? '#0b1220' : kind === 'danger' ? colors.bad : colors.text
  const border = kind === 'danger' ? colors.bad : colors.line
  return (
    <button
      type={props.type ?? 'button'}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        ...font,
        background,
        color,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '6px 10px',
        cursor: props.disabled ? 'not-allowed' : 'pointer',
        opacity: props.disabled ? 0.55 : 1,
        fontSize: 13,
      }}
    >
      {props.children}
    </button>
  )
}

function fieldStyle(): CSSProperties {
  return { ...font, background: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 8, padding: 8 }
}

const FALLBACK_MODELS: ModelOption[] = [
  { key: 'openrouter::minimax/minimax-m2.7:free', provider: 'openrouter', model: 'minimax/minimax-m2.7:free', label: 'OpenRouter / MiniMax M2.7 (free)' },
  { key: 'openrouter::minimax/minimax-m3:free', provider: 'openrouter', model: 'minimax/minimax-m3:free', label: 'OpenRouter / MiniMax M3 (free)' },
  { key: 'zai-coding-cn::glm-4.5-air', provider: 'zai-coding-cn', model: 'glm-4.5-air', label: 'Z.AI Coding CN / GLM-4.5-Air' },
  { key: 'zai-coding-cn::glm-4.7', provider: 'zai-coding-cn', model: 'glm-4.7', label: 'Z.AI Coding CN / GLM-4.7' },
]

function sessionModelsApi(ctx: AnyCtx): SessionModelsApi | undefined {
  try {
    return ctx.get?.('connection')?.api?.sessions
  } catch {
    return undefined
  }
}

async function loadModelOptions(ctx: AnyCtx, sessionId: string): Promise<{ options: ModelOption[]; current?: ModelOption }> {
  const options: ModelOption[] = [...FALLBACK_MODELS]
  const api = sessionModelsApi(ctx)
  if (!api?.models) return { options }
  const answered = await api.models({ sessionId })
  const rpc = unwrapRpc(answered)
  if (!rpc.ok) return { options }
  const payload = (rpc.value ?? {}) as {
    current?: { provider?: string; model?: string }
    groups?: Array<{ id: string; name: string; models?: Array<{ id: string; name: string }> }>
  }
  for (const group of payload.groups ?? []) {
    for (const model of group.models ?? []) {
      const key = `${group.id}::${model.id}`
      if (options.some((item) => item.key === key)) continue
      options.push({
        key,
        provider: group.id,
        model: model.id,
        label: `${group.name} / ${model.name}`,
      })
    }
  }
  const current = payload.current?.provider && payload.current.model
    ? options.find((item) => item.provider === payload.current!.provider && item.model === payload.current!.model)
      ?? { key: `${payload.current.provider}::${payload.current.model}`, provider: payload.current.provider, model: payload.current.model, label: `${payload.current.provider} / ${payload.current.model}` }
    : undefined
  return { options, current }
}

async function selectSessionModel(ctx: AnyCtx, sessionId: string, draft: ExperimentDraft): Promise<void> {
  if (!draft.provider || !draft.model) return
  const api = sessionModelsApi(ctx)
  if (!api?.selectModel) throw new Error('当前客户端拿不到 session.selectModel，无法切换到所选模型。')
  const answered = await api.selectModel({ sessionId, provider: draft.provider, model: draft.model })
  const rpc = unwrapRpc(answered)
  if (!rpc.ok) throw new Error(rpc.error ?? '切换模型失败')
}

function Sparkline({ runs, direction }: { runs: ExperimentRun[]; direction: 'lower' | 'higher' }) {
  const points = runs.filter((run) => Number.isFinite(run.metric))
  if (points.length === 0) {
    return <div style={{ color: colors.muted, fontSize: 13 }}>还没有可绘制的指标。确认开始后，轮次会出现在这里，而不是首页聊天里。</div>
  }
  const values = points.map((run) => run.metric)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const w = 640
  const h = 180
  const d = points.map((run, index) => {
    const x = points.length === 1 ? w / 2 : (index / (points.length - 1)) * (w - 24) + 12
    const y = h - 16 - ((run.metric - min) / span) * (h - 32)
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" height="180" role="img" aria-label="metric chart">
      <rect x="0" y="0" width={w} height={h} fill="transparent" />
      <path d={d} fill="none" stroke={colors.accent} strokeWidth="2.5" />
      {points.map((run, index) => {
        const x = points.length === 1 ? w / 2 : (index / (points.length - 1)) * (w - 24) + 12
        const y = h - 16 - ((run.metric - min) / span) * (h - 32)
        return <circle key={run.run} cx={x} cy={y} r="3.5" fill={statusColor(run.status)} />
      })}
      <text x="12" y="14" fill={colors.muted} fontSize="11">{direction === 'lower' ? '越低越好' : '越高越好'}</text>
    </svg>
  )
}

function CreateForm({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string | null }) {
  const lab = useLab()
  const [draft, setDraft] = useState<ExperimentDraft>(lab.draft)
  const [models, setModels] = useState<ModelOption[]>([])
  const [loadingModels, setLoadingModels] = useState(false)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setLoadingModels(true)
    void loadModelOptions(ctx, sessionId).then(({ options, current }) => {
      if (cancelled) return
      setModels(options)
      setDraft((prev) => {
        if (prev.provider && prev.model) return prev
        if (!current) return prev
        return { ...prev, provider: current.provider, model: current.model, modelLabel: current.label }
      })
    }).catch((error: unknown) => {
      if (!cancelled) patchLab({ error: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (!cancelled) setLoadingModels(false)
    })
    return () => { cancelled = true }
  }, [ctx, sessionId])

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!sessionId) {
      patchLab({ error: '没有活动会话。先打开一个对话，再新开 Autoresearch。' })
      return
    }
    if (!draft.goal.trim()) {
      patchLab({ error: '请填写要研究的问题。普通聊天不会启动循环。' })
      return
    }
    if (!draft.success.trim()) {
      patchLab({ error: '请填写成功标准，确认后才会执行。' })
      return
    }
    patchLab({ draft, page: 'confirm', error: null, phase: 'configuring' })
  }

  return (
    <form onSubmit={onSubmit} style={{ display: 'grid', gap: 12 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>新开一次 Autoresearch</div>
        <div style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
          先配参数，下一步确认后才执行。首页不会常驻实验面板。
        </div>
      </div>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        问题
        <textarea
          value={draft.goal}
          onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
          rows={4}
          placeholder="例如：把 examples/score.py 的错误数降到 0。每次只改一个变量，最多 3 轮。"
          style={{ ...fieldStyle(), resize: 'vertical' }}
        />
      </label>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        模型
        <select
          value={draft.provider && draft.model ? `${draft.provider}::${draft.model}` : ''}
          onChange={(event) => {
            const next = models.find((item) => item.key === event.target.value)
            setDraft({
              ...draft,
              provider: next?.provider ?? '',
              model: next?.model ?? '',
              modelLabel: next?.label ?? '当前会话模型',
            })
          }}
          style={fieldStyle()}
        >
          <option value="">{loadingModels ? '正在读取模型目录…' : '使用当前会话模型'}</option>
          {models.map((item) => (
            <option key={item.key} value={item.key}>{item.label}</option>
          ))}
        </select>
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          轮次 / 预算
          <input value={draft.maxRuns} onChange={(event) => setDraft({ ...draft, maxRuns: event.target.value })} style={fieldStyle()} />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          主指标
          <input value={draft.metricName} onChange={(event) => setDraft({ ...draft, metricName: event.target.value })} style={fieldStyle()} />
        </label>
        <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
          方向
          <select value={draft.direction} onChange={(event) => setDraft({ ...draft, direction: event.target.value as 'lower' | 'higher' })} style={fieldStyle()}>
            <option value="lower">越低越好</option>
            <option value="higher">越高越好</option>
          </select>
        </label>
      </div>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        成功标准
        <input
          value={draft.success}
          onChange={(event) => setDraft({ ...draft, success: event.target.value })}
          placeholder="例如：errors = 0，否则本轮 discard"
          style={fieldStyle()}
        />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: colors.muted }}>
        <input type="checkbox" checked={draft.allowNoGit} onChange={(event) => setDraft({ ...draft, allowNoGit: event.target.checked })} />
        允许无 Git（仅一次性试跑；keep/discard 将无法安全提交或回滚）
      </label>
      {lab.error ? <div style={{ color: colors.bad, fontSize: 13, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <LabButton onClick={closeLab}>取消</LabButton>
        <LabButton type="submit" kind="primary">下一步：确认参数</LabButton>
      </div>
    </form>
  )
}

function ConfirmForm({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string | null }) {
  const lab = useLab()
  const draft = lab.draft

  async function onConfirm() {
    if (!sessionId) {
      patchLab({ error: '没有活动会话。' })
      return
    }
    patchLab({ busy: true, error: null })
    try {
      await selectSessionModel(ctx, sessionId, draft)
      await executeLine(ctx, sessionId, buildStartLine(draft))
      patchLab({ page: 'lab', phase: 'running', busy: false, open: true })
    } catch (error) {
      patchLab({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const rows: Array<[string, string]> = [
    ['问题', draft.goal],
    ['模型', draft.modelLabel],
    ['轮次 / 预算', `${draft.maxRuns} 轮`],
    ['主指标', `${draft.metricName} · ${draft.direction === 'higher' ? '越高越好' : '越低越好'}`],
    ['成功标准', draft.success],
  ]

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>确认后才执行</div>
        <div style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>核对下面的实验参数。点确认才会激活循环并打开专属实验室。</div>
      </div>
      <div style={{ display: 'grid', gap: 8, background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 12, padding: 14 }}>
        {rows.map(([label, value]) => (
          <div key={label}>
            <div style={{ color: colors.muted, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ marginTop: 4, whiteSpace: 'pre-wrap' }}>{value || '—'}</div>
          </div>
        ))}
      </div>
      {lab.error ? <div style={{ color: colors.bad, fontSize: 13, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <LabButton onClick={() => patchLab({ page: 'create' })}>返回修改</LabButton>
        <LabButton kind="primary" disabled={lab.busy} onClick={() => void onConfirm()}>{lab.busy ? '正在启动…' : '确认并开始'}</LabButton>
      </div>
    </div>
  )
}

function LabDashboard({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string | null }) {
  const lab = useLab()
  const snapshot = lab.snapshot
  const running = lab.phase === 'running' || Boolean(snapshot?.active)

  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    const tick = () => {
      void executeLine(ctx, sessionId, '/autoresearch status').catch((error: unknown) => {
        if (!cancelled) patchLab({ error: error instanceof Error ? error.message : String(error) })
      })
    }
    tick()
    const id = window.setInterval(tick, 2000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
  }, [ctx, sessionId])

  const current = snapshot?.results.filter((run) => run.segment === snapshot.results.at(-1)?.segment || run.segment === 0) ?? snapshot?.results ?? []

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{snapshot?.name ?? '实验实验室'}</div>
          <div style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
            {running ? '执行中 · 过程与结果只在这个窗口里可视化' : snapshot?.manualOff ? '已暂停自动续跑' : lab.phase === 'done' ? '本轮已结束' : '未激活'}
            {snapshot?.pendingContinuation ? ' · 等待同会话续跑' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <LabButton onClick={() => patchLab({ page: 'create', draft: emptyDraft(), phase: 'configuring', error: null })}>新开一次</LabButton>
          <LabButton disabled={!sessionId || lab.busy} onClick={() => sessionId && executeLine(ctx, sessionId, '/autoresearch off')}>暂停续跑</LabButton>
          <LabButton kind="danger" disabled={!sessionId || lab.busy} onClick={() => sessionId && executeLine(ctx, sessionId, '/autoresearch clear')}>清除账本</LabButton>
        </div>
      </div>
      <div style={{
        border: `1px solid ${running ? colors.accent : colors.line}`,
        background: colors.panel,
        borderRadius: 12,
        padding: 12,
        fontSize: 13,
      }}>
        <strong>{running ? '执行中' : lab.phase === 'done' ? '结果' : '实验室'}</strong>
        <span style={{ color: colors.muted }}> · 模型 {lab.draft.modelLabel} · 成功标准 {lab.draft.success || '—'}</span>
      </div>
      {!snapshot?.gitOk && snapshot?.gitError ? (
        <div style={{ border: `1px solid ${colors.bad}`, borderRadius: 10, padding: 10, color: colors.bad, fontSize: 13 }}>{snapshot.gitError}</div>
      ) : null}
      {snapshot && !snapshot.measureExists ? (
        <div style={{ border: `1px solid ${colors.warn}`, borderRadius: 10, padding: 10, color: colors.warn, fontSize: 13 }}>还没有 `.auto/measure.sh`。确认开始后模型应先写确定性基准，再 init / run / log。</div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        {[
          ['基线', formatMetric(snapshot, snapshot?.baselineMetric ?? null)],
          ['最佳 keep', formatMetric(snapshot, snapshot?.bestKeptMetric ?? null)],
          ['本段轮次', String(snapshot?.currentSegmentRuns ?? 0)],
          ['主指标', snapshot ? `${snapshot.metricName} · ${snapshot.direction}` : '—'],
        ].map(([label, value]) => (
          <div key={label} style={{ background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 12, padding: 12 }}>
            <div style={{ color: colors.muted, fontSize: 11, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</div>
            <div style={{ marginTop: 8, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 22, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 12, padding: 10 }}>
        <Sparkline runs={current} direction={snapshot?.direction ?? 'lower'} />
      </div>
      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ color: colors.muted, textAlign: 'left' }}>
              {['#', '状态', '指标', '假设', '提交'].map((head) => (
                <th key={head} style={{ padding: '8px 6px', borderBottom: `1px solid ${colors.line}`, fontWeight: 500 }}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(snapshot?.results ?? []).length === 0 ? (
              <tr><td colSpan={5} style={{ padding: 16, color: colors.muted }}>{running ? '正在跑第一轮。结果写入 `.auto/log.jsonl` 后会出现在这张表里。' : '还没有实验记录。确认开始后才会执行。'}</td></tr>
            ) : snapshot!.results.map((run) => (
              <tr key={run.run}>
                <td style={{ padding: '8px 6px', borderBottom: `1px solid ${colors.line}`, fontFamily: 'ui-monospace, monospace' }}>{run.run}</td>
                <td style={{ padding: '8px 6px', borderBottom: `1px solid ${colors.line}`, color: statusColor(run.status) }}>{run.status}</td>
                <td style={{ padding: '8px 6px', borderBottom: `1px solid ${colors.line}`, fontFamily: 'ui-monospace, monospace' }}>{formatMetric(snapshot, run.metric)}</td>
                <td style={{ padding: '8px 6px', borderBottom: `1px solid ${colors.line}` }}>{run.asi?.hypothesis || run.description || '—'}</td>
                <td style={{ padding: '8px 6px', borderBottom: `1px solid ${colors.line}`, fontFamily: 'ui-monospace, monospace' }}>{run.commit || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lab.error ? <div style={{ color: colors.bad, fontSize: 13, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
      {lab.notice ? <pre style={{ ...font, whiteSpace: 'pre-wrap', color: colors.muted, fontSize: 12, margin: 0 }}>{lab.notice}</pre> : null}
    </div>
  )
}

function OverlayRoot({ ctx }: { ctx: AnyCtx }) {
  const lab = useLab()
  if (!lab.open) return null
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '8vh 16px 16px', pointerEvents: 'auto', background: 'rgba(0,0,0,0.42)', zIndex: 40 }}>
      <div style={{ ...font, width: 'min(960px, 100%)', maxHeight: '84vh', overflow: 'auto', background: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 16, padding: 20, boxShadow: '0 18px 60px rgba(0,0,0,0.45)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: colors.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>Autoresearch 实验室</div>
          <LabButton onClick={closeLab}>关闭</LabButton>
        </div>
        {lab.page === 'create' ? <CreateForm ctx={ctx} sessionId={lab.sessionId} /> : null}
        {lab.page === 'confirm' ? <ConfirmForm ctx={ctx} sessionId={lab.sessionId} /> : null}
        {lab.page === 'lab' ? <LabDashboard ctx={ctx} sessionId={lab.sessionId} /> : null}
      </div>
    </div>
  )
}

function InitEntry({ sessionId }: { sessionId: string }) {
  const lab = useLab()
  rememberSession(sessionId)
  const running = lab.phase === 'running' || Boolean(lab.snapshot?.active)
  const done = lab.phase === 'done' || ((lab.snapshot?.totalRuns ?? 0) > 0 && !running)
  const label = running || done ? '打开实验室' : '新开 Autoresearch'
  return (
    <button
      type="button"
      data-autoresearch="init-entry"
      title={label}
      onClick={() => openLab(running || done ? 'lab' : 'create')}
      style={{
        ...font,
        display: 'inline-flex',
        alignItems: 'center',
        height: 28,
        padding: '0 8px',
        background: 'transparent',
        color: colors.text,
        border: `1px solid ${colors.line}`,
        borderRadius: 8,
        cursor: 'pointer',
        fontSize: 12,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  )
}

function SettingsCard({ scope }: { scope: SettingsScope }) {
  const value = scope.value ?? {}
  return (
    <div style={{ ...font, display: 'grid', gap: 10, padding: 4 }}>
      <div>
        <div style={{ fontWeight: 700 }}>Autoresearch</div>
        <div style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>项目级 `.auto/config.json` 优先于这里的默认值。循环不会出现在首页侧栏。</div>
      </div>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        默认最大轮数（0 表示不在设置里封顶）
        <input
          type="number"
          defaultValue={Number(value.maxIterations ?? 20)}
          onBlur={(event) => void scope.set('maxIterations', Number(event.target.value))}
          style={fieldStyle()}
        />
      </label>
      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        默认自动续跑次数
        <input
          type="number"
          defaultValue={Number(value.maxAutoResumeTurns ?? 20)}
          onBlur={(event) => void scope.set('maxAutoResumeTurns', Number(event.target.value))}
          style={fieldStyle()}
        />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <input
          type="checkbox"
          defaultChecked={value.hintsEnabled === true}
          onChange={(event) => void scope.set('hintsEnabled', event.target.checked)}
        />
        允许侧模型 hint（默认关闭）
      </label>
    </div>
  )
}

export function apply(ctx: AnyCtx): void {
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'autoresearch-overlay',
    order: 40,
    label: 'Autoresearch Lab',
  }, () => <OverlayRoot ctx={ctx} />))

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'autoresearch-init',
    order: 40,
    label: '新开 Autoresearch',
    inject: (sessionId: string) => {
      rememberSession(sessionId)
      return { sessionId }
    },
  }, (props: { sessionId: string }) => <InitEntry sessionId={props.sessionId} />))

  const scope = ctx.settingsScope.bind({ namespace: 'autoresearch' })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: 'autoresearch',
  }, () => <SettingsCard scope={scope} />))

  ctx.commandUi.decorate({
    name: 'autoresearch',
    available: () => true,
    ui: {
      kind: 'popupSelect',
      options: async () => ([
        { id: 'start', label: '新开一次 Autoresearch', detail: '打开配置，确认后才执行' },
        { id: 'lab', label: '打开实验室', detail: '专属过程 / 结果可视化' },
        { id: 'resume', label: '继续', detail: '/autoresearch resume' },
        { id: 'status', label: '状态', detail: '/autoresearch status' },
        { id: 'off', label: '停止续跑', detail: '/autoresearch off' },
        { id: 'clear', label: '清除账本', detail: '/autoresearch clear' },
      ]),
      onSelect: async (option, session) => {
        rememberSession(session.sessionId)
        if (option.id === 'start') {
          openLab('create')
          return
        }
        if (option.id === 'lab') {
          openLab('lab')
          return
        }
        const line = option.id === 'resume' ? '/autoresearch resume' : `/autoresearch ${option.id}`
        await executeLine(ctx, session.sessionId, line)
        if (option.id === 'resume' || option.id === 'status') openLab('lab')
      },
    },
  })
}
