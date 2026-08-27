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
  cancelInitDock,
  closeOverlay,
  formatMetric,
  getLabState,
  openOverlay,
  parseRoundBudget,
  patchLab,
  rememberSession,
  showInitDock,
  showRunDock,
  subscribeLab,
  type ExperimentDraft,
} from './store.js'

export const name = 'dsh-autoresearch-client'
export const inject = [
  'slots',
  'sessions',
  'remote',
  'remote.commands',
  'settingsScope',
  'commandUi',
]

type AnyCtx = ClientContext & {
  slots: {
    inject: (name: string, factory: () => unknown) => void
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  sessions: { current?: { sessionId?: string }; binding?: (id: string) => unknown }
  remote: {
    commands: { execute: (sessionId: string, line: string, images: unknown[]) => Promise<RemoteAnswer> }
  }
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
  panel: 'var(--dsw-specific-tip, var(--dsw-alias-bg-secondary, Canvas))',
  text: 'var(--dsw-alias-label-primary, CanvasText)',
  muted: 'var(--dsw-alias-label-secondary, GrayText)',
  line: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2, ButtonBorder))',
  good: 'var(--dsw-alias-text-success, var(--dsw-alias-state-success-primary, #1a7f37))',
  bad: 'var(--dsw-alias-text-danger, var(--dsw-alias-state-error-primary, #cf222e))',
  accent: 'var(--dsw-alias-text-accent, var(--dsw-alias-state-business-primary, #0969da))',
  warn: 'var(--dsw-alias-text-warning, #9a6700)',
}

const font: CSSProperties = {
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif',
  color: colors.text,
}

const dockShell: CSSProperties = {
  ...font,
  boxSizing: 'border-box',
  width: 'calc(100% - var(--dsh-composer-side-clearance, 0px) * 2 - var(--dsh-composer-dock-inset, 0px) * 4)',
  maxWidth: 'calc(var(--dsh-composer-card-max-width, 960px) - var(--dsh-composer-dock-inset, 0px) * 2)',
  margin: '0 auto',
  border: `1px solid ${colors.line}`,
  borderRadius: 12,
  background: colors.panel,
  padding: '10px 12px',
}

function useLab() {
  return useSyncExternalStore(subscribeLab, getLabState, getLabState)
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

function Sparkline({ runs, direction }: { runs: ExperimentRun[]; direction: 'lower' | 'higher' }) {
  const points = runs.filter((run) => Number.isFinite(run.metric))
  if (points.length === 0) {
    return <div style={{ color: colors.muted, fontSize: 13 }}>还没有可绘制的指标。确认开始后，轮次会出现在这里。</div>
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

function InitDockCard({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string | null }) {
  const lab = useLab()
  const [draft, setDraft] = useState<ExperimentDraft>(lab.draft)

  async function onConfirm(event: FormEvent) {
    event.preventDefault()
    if (!sessionId) {
      patchLab({ error: '没有活动会话。先打开一个对话，再 /autoresearch。' })
      return
    }
    if (!draft.goal.trim()) {
      patchLab({ error: '请填写目标。普通聊天不会启动循环。' })
      return
    }
    if (parseRoundBudget(draft.maxRuns) === null) {
      patchLab({ error: '轮次必须是大于 0 的整数。' })
      return
    }
    patchLab({ draft, busy: true, error: null })
    try {
      await executeLine(ctx, sessionId, buildStartLine(draft))
      patchLab({ dock: 'run', page: 'lab', phase: 'running', overlayOpen: false, busy: false })
    } catch (error) {
      patchLab({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <form
      data-autoresearch="init-card"
      onSubmit={(event) => void onConfirm(event)}
      style={{ display: 'grid', gap: 8 }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>新开 Autoresearch</div>
        <div style={{ color: colors.muted, fontSize: 12 }}>确认前不会开跑</div>
      </div>
      <label style={{ display: 'grid', gap: 4, fontSize: 12, color: colors.muted }}>
        目标
        <textarea
          data-autoresearch-field="goal"
          value={draft.goal}
          onChange={(event) => setDraft({ ...draft, goal: event.target.value })}
          rows={4}
          placeholder="例如：把 examples/score.py 的错误数降到 0。每次只改一个变量。"
          style={{ ...fieldStyle(), resize: 'vertical', minHeight: 72, fontSize: 13 }}
        />
      </label>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: colors.muted }}>
          轮次
          <input
            data-autoresearch-field="rounds"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={draft.maxRuns}
            onChange={(event) => setDraft({ ...draft, maxRuns: event.target.value })}
            style={{ ...fieldStyle(), width: 88, fontSize: 13 }}
          />
        </label>
        <div style={{ flex: 1 }} />
        <LabButton onClick={cancelInitDock}>取消</LabButton>
        <LabButton type="submit" kind="primary" disabled={lab.busy}>
          {lab.busy ? '正在启动…' : '确认并开始'}
        </LabButton>
      </div>
      {lab.error ? <div style={{ color: colors.bad, fontSize: 12, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
    </form>
  )
}

function currentRuns(snapshot: ReturnType<typeof getLabState>['snapshot']): ExperimentRun[] {
  if (!snapshot) return []
  const last = snapshot.results.at(-1)?.segment
  return snapshot.results.filter((run) => run.segment === last || run.segment === 0)
}

function RunDockCard({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string | null }) {
  const lab = useLab()
  const snapshot = lab.snapshot
  const running = lab.phase === 'running' || Boolean(snapshot?.active)
  const budget = snapshot?.maxIterations ?? parseRoundBudget(lab.draft.maxRuns) ?? 3
  const round = snapshot?.currentSegmentRuns ?? 0
  const runs = currentRuns(snapshot)
  const latest = runs.at(-1)
  const metricName = snapshot?.metricName && snapshot.metricName !== 'metric' ? snapshot.metricName : null
  const liveValue = latest?.metric ?? snapshot?.bestKeptMetric ?? snapshot?.baselineMetric ?? null

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

  return (
    <div data-autoresearch="run-card" style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>
          第 {round} / {budget} 轮
          <span style={{ color: colors.muted, fontWeight: 400 }}>
            {' · '}
            {running ? '执行中' : snapshot?.manualOff ? '已暂停' : lab.phase === 'done' ? '已结束' : '监视'}
          </span>
        </div>
        <div style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}>
          {metricName ? `${metricName} ${formatMetric(snapshot, liveValue)}` : '等待账本指标'}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minHeight: 22 }}>
        {runs.length === 0 ? (
          <span style={{ color: colors.muted, fontSize: 12 }}>
            {running ? '正在跑第一轮。keep / discard 会写在这里。' : '还没有实验记录。'}
          </span>
        ) : runs.map((run) => (
          <span
            key={run.run}
            data-autoresearch-run={run.run}
            data-autoresearch-status={run.status}
            style={{
              fontSize: 12,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              color: statusColor(run.status),
              border: `1px solid ${statusColor(run.status)}`,
              borderRadius: 999,
              padding: '1px 8px',
            }}
          >
            #{run.run} {run.status}
          </span>
        ))}
      </div>
      {lab.error ? <div style={{ color: colors.bad, fontSize: 12, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        <LabButton disabled={!sessionId || lab.busy} onClick={() => sessionId && void executeLine(ctx, sessionId, '/autoresearch off')}>暂停续跑</LabButton>
        <LabButton onClick={openOverlay}>打开更大视图</LabButton>
      </div>
    </div>
  )
}

function AutoresearchDock({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string }) {
  const lab = useLab()
  rememberSession(sessionId)
  if (lab.dock === 'hidden') return null
  return (
    <div data-autoresearch="dock" style={dockShell}>
      {lab.dock === 'init' ? <InitDockCard ctx={ctx} sessionId={sessionId} /> : <RunDockCard ctx={ctx} sessionId={sessionId} />}
    </div>
  )
}

function LabDashboard({ ctx, sessionId }: { ctx: AnyCtx; sessionId: string | null }) {
  const lab = useLab()
  const snapshot = lab.snapshot
  const running = lab.phase === 'running' || Boolean(snapshot?.active)
  const current = currentRuns(snapshot)

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

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{snapshot?.name ?? '实验监视'}</div>
          <div style={{ color: colors.muted, fontSize: 13, marginTop: 4 }}>
            {running ? '执行中' : snapshot?.manualOff ? '已暂停自动续跑' : lab.phase === 'done' ? '本轮已结束' : '未激活'}
            {snapshot?.pendingContinuation ? ' · 等待同会话续跑' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <LabButton onClick={() => { showInitDock() }}>新开一次</LabButton>
          <LabButton disabled={!sessionId || lab.busy} onClick={() => sessionId && void executeLine(ctx, sessionId, '/autoresearch off')}>暂停续跑</LabButton>
          <LabButton kind="danger" disabled={!sessionId || lab.busy} onClick={() => sessionId && void executeLine(ctx, sessionId, '/autoresearch clear')}>清除账本</LabButton>
        </div>
      </div>
      {!snapshot?.gitOk && snapshot?.gitError ? (
        <div style={{ border: `1px solid ${colors.bad}`, borderRadius: 10, padding: 10, color: colors.bad, fontSize: 13 }}>{snapshot.gitError}</div>
      ) : null}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
        {[
          ['基线', formatMetric(snapshot, snapshot?.baselineMetric ?? null)],
          ['最佳 keep', formatMetric(snapshot, snapshot?.bestKeptMetric ?? null)],
          ['本段轮次', `${snapshot?.currentSegmentRuns ?? 0} / ${snapshot?.maxIterations ?? parseRoundBudget(lab.draft.maxRuns) ?? '—'}`],
          ['主指标', snapshot && snapshot.metricName !== 'metric' ? `${snapshot.metricName} · ${snapshot.direction}` : '账本尚未写入'],
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
  if (!lab.overlayOpen) return null
  return (
    <div data-autoresearch="overlay" style={{ position: 'fixed', inset: 0, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '8vh 16px 16px', pointerEvents: 'auto', background: 'rgba(0,0,0,0.42)', zIndex: 40 }}>
      <div style={{ ...font, width: 'min(960px, 100%)', maxHeight: '84vh', overflow: 'auto', background: colors.bg, border: `1px solid ${colors.line}`, borderRadius: 16, padding: 20, boxShadow: '0 18px 60px rgba(0,0,0,0.45)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: colors.muted, letterSpacing: '0.08em', textTransform: 'uppercase' }}>更大视图</div>
          <LabButton onClick={closeOverlay}>关闭</LabButton>
        </div>
        <LabDashboard ctx={ctx} sessionId={lab.sessionId} />
      </div>
    </div>
  )
}

function SettingsCard({ scope }: { scope: SettingsScope }) {
  const value = scope.value ?? {}
  return (
    <div style={{ ...font, display: 'grid', gap: 10, padding: 4 }}>
      <div>
        <div style={{ fontWeight: 700 }}>Autoresearch</div>
        <div style={{ color: colors.muted, fontSize: 12, marginTop: 4 }}>项目级 `.auto/config.json` 优先于这里的默认值。日常首页和 composer 不常驻实验入口；用 `/autoresearch` 打开引导卡。</div>
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
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'autoresearch',
    order: 25,
    inject: (sessionId: string) => {
      rememberSession(sessionId)
      return { sessionId }
    },
  }, (props: { sessionId: string }) => <AutoresearchDock ctx={ctx} sessionId={props.sessionId} />))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'autoresearch-overlay',
    order: 40,
    label: 'Autoresearch larger view',
  }, () => <OverlayRoot ctx={ctx} />))

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
        { id: 'start', label: '新开一次 Autoresearch', detail: '目标 + 轮次，确认后才执行' },
        { id: 'expand', label: '打开更大视图', detail: '图表与完整轮次表；默认不挡输出' },
        { id: 'resume', label: '继续', detail: '/autoresearch resume' },
        { id: 'status', label: '状态', detail: '/autoresearch status' },
        { id: 'off', label: '停止续跑', detail: '/autoresearch off' },
        { id: 'clear', label: '清除账本', detail: '/autoresearch clear' },
      ]),
      onSelect: async (option, session) => {
        rememberSession(session.sessionId)
        if (option.id === 'start') {
          showInitDock()
          return
        }
        if (option.id === 'expand') {
          showRunDock()
          openOverlay()
          return
        }
        const line = option.id === 'resume' ? '/autoresearch resume' : `/autoresearch ${option.id}`
        await executeLine(ctx, session.sessionId, line)
        if (option.id === 'resume' || option.id === 'status') showRunDock()
      },
    },
  })
}
