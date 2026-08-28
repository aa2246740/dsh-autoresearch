import { useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ExperimentStatus } from '../types.js'
import { parseEmbeddedState } from '../types.js'
import {
  buildDashboardModel,
  formatDeltaPct,
  inspectConversation,
  type ConversationInspectInput,
  type DashboardModel,
} from './dashboard.js'
import { preferLedgerSnapshot, snapshotFromMeta } from '../projection.js'
import {
  applyCommandText,
  buildStartLine,
  cancelInitDock,
  hideAfterConfirm,
  parseRoundBudget,
  patchLab,
  rememberSession,
  showInitDock,
  subscribeLab,
  getLabState,
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

type ConversationSelector = <T>(selector: (snapshot: ConversationInspectInput) => T) => T
type ProjectionReader = (key: string) => unknown

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

interface DockProps {
  sessionId: string
  useSession?: ConversationSelector
  useProjection?: ProjectionReader
  session?: ConversationInspectInput
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

const mono: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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

function statusColor(status: ExperimentStatus): string {
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

function Spinner() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        marginRight: 6,
        border: `2px solid ${colors.line}`,
        borderTopColor: colors.warn,
        borderRadius: '50%',
        animation: 'dsh-ar-spin 0.8s linear infinite',
        verticalAlign: 'middle',
      }}
    />
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
      hideAfterConfirm()
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

function WaitingCard() {
  return (
    <div data-autoresearch="waiting-card" style={{ color: colors.muted, fontSize: 13 }}>
      等 agent 在对话里对齐需求
    </div>
  )
}

function RunningCard({ name, command }: { name: string | null; command: string | null }) {
  return (
    <div data-autoresearch="running-card" style={{ ...mono, fontSize: 13, color: colors.text }}>
      <style>{'@keyframes dsh-ar-spin { to { transform: rotate(360deg); } }'}</style>
      <Spinner />
      <span style={{ color: colors.warn }}>running…</span>
      {name ? <span style={{ color: colors.muted }}>{` │ ${name}`}</span> : null}
      {command ? <span style={{ color: colors.muted }}>{` │ ${command}`}</span> : null}
      <span style={{ color: colors.muted }}> │ waiting for first logged result</span>
    </div>
  )
}

function ProgressCard({
  model,
  ctx,
  sessionId,
}: {
  model: DashboardModel
  ctx: AnyCtx
  sessionId: string | null
}) {
  const lab = useLab()
  const progressDelta = formatDeltaPct(model.progress?.deltaPct ?? null)
  const deltaTone = model.progress?.improved === true ? colors.good : model.progress?.improved === false ? colors.bad : colors.muted

  return (
    <div data-autoresearch="progress-card" style={{ display: 'grid', gap: 8, fontSize: 13 }}>
      <style>{'@keyframes dsh-ar-spin { to { transform: rotate(360deg); } }'}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <div data-autoresearch="progress-title" style={{ fontSize: 13, fontWeight: 600 }}>{model.title}</div>
        {model.paused ? <span style={{ color: colors.warn, fontSize: 12 }}>paused</span> : null}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
        <span>Runs {model.runs}</span>
        <span data-autoresearch="kept" style={{ color: colors.good }}>{model.kept} kept</span>
        {model.conf !== null ? (
          <span data-autoresearch="conf" style={{ color: colors.muted }}>{`(conf: ${model.conf.toFixed(1)}×)`}</span>
        ) : null}
        {model.discarded > 0 ? (
          <span data-autoresearch="discarded" style={{ color: colors.warn }}>{model.discarded} discarded</span>
        ) : null}
        {model.crashed > 0 ? (
          <span style={{ color: colors.bad }}>{model.crashed} crashed</span>
        ) : null}
        {model.checksFailed > 0 ? (
          <span style={{ color: colors.bad }}>{model.checksFailed} checks failed</span>
        ) : null}
      </div>
      {model.baseline ? (
        <div data-autoresearch="baseline" style={{ color: colors.muted }}>
          Baseline ★ {model.metricName}: {model.baseline.value} #{model.baseline.run}
        </div>
      ) : null}
      {model.progress ? (
        <div data-autoresearch="progress-best">
          <span style={{ color: colors.muted }}>Progress </span>
          <span style={{ color: colors.warn, fontWeight: 600 }}>
            ★ {model.metricName}: {model.progress.value}
          </span>
          <span style={{ color: colors.muted }}>{` #${model.progress.run}`}</span>
          {progressDelta ? (
            <span data-autoresearch="delta" style={{ color: deltaTone }}>
              {` ${progressDelta}`}
            </span>
          ) : null}
        </div>
      ) : null}
      {model.secondaries.length > 0 ? (
        <div style={{ color: colors.muted, fontSize: 12 }}>
          {model.secondaries.map((item) => {
            const delta = formatDeltaPct(item.deltaPct)
            return (
              <span key={item.name} style={{ marginRight: 10 }}>
                {item.name}: {item.value}
                {delta ? ` ${delta}` : ''}
              </span>
            )
          })}
        </div>
      ) : null}
      <div style={{ overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, ...mono }}>
          <thead>
            <tr style={{ color: colors.muted, textAlign: 'left' }}>
              {['#', 'commit', `★ ${model.metricName}`, 'status', 'description'].map((head) => (
                <th key={head} style={{ padding: '4px 6px', borderBottom: `1px solid ${colors.line}`, fontWeight: 500 }}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows.map((row) => (
              <tr key={row.run} data-autoresearch-run={row.run} data-autoresearch-status={row.status}>
                <td style={{ padding: '4px 6px', borderBottom: `1px solid ${colors.line}` }}>{row.run}</td>
                <td style={{ padding: '4px 6px', borderBottom: `1px solid ${colors.line}` }}>{row.commit}</td>
                <td style={{ padding: '4px 6px', borderBottom: `1px solid ${colors.line}` }}>{row.metric}</td>
                <td style={{ padding: '4px 6px', borderBottom: `1px solid ${colors.line}`, color: statusColor(row.status) }}>{row.status}</td>
                <td style={{ padding: '4px 6px', borderBottom: `1px solid ${colors.line}`, fontFamily: font.fontFamily }}>{row.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {model.running ? (
        <div data-autoresearch="running-line" style={{ ...mono, color: colors.warn, fontSize: 12 }}>
          <Spinner />
          running…{model.runningCommand ? ` ${model.runningCommand}` : ''}
        </div>
      ) : null}
      {lab.error ? <div style={{ color: colors.bad, fontSize: 12, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <LabButton disabled={!sessionId || lab.busy} onClick={() => sessionId && void executeLine(ctx, sessionId, '/autoresearch off')}>暂停</LabButton>
      </div>
    </div>
  )
}

function AutoresearchDock({ ctx, sessionId, useSession, useProjection, session }: DockProps & { ctx: AnyCtx }) {
  const lab = useLab()
  rememberSession(sessionId)
  const live = useSession ? useSession((snapshot) => snapshot) : session
  const projected = snapshotFromMeta(typeof useProjection === 'function' ? useProjection('autoresearch') : undefined)
  const progress = inspectConversation(live ?? { runningCalls: [], nodes: [] })
  const snapshot = progress.kind === 'board'
    ? preferLedgerSnapshot(progress.snapshot, projected) ?? progress.snapshot
    : progress.snapshot

  if (lab.dock === 'init') {
    return (
      <div data-autoresearch="dock" style={dockShell}>
        <InitDockCard ctx={ctx} sessionId={sessionId} />
      </div>
    )
  }

  if (progress.kind === 'board' && snapshot && (snapshot.results?.length ?? 0) > 0) {
    const model = buildDashboardModel(snapshot, {
      running: progress.runningExperiment,
      runningCommand: progress.runningCommand,
    })
    return (
      <div data-autoresearch="dock" style={dockShell}>
        <ProgressCard model={model} ctx={ctx} sessionId={sessionId} />
      </div>
    )
  }

  if (progress.kind === 'running') {
    return (
      <div data-autoresearch="dock" style={dockShell}>
          <RunningCard name={projected?.name ?? snapshot?.name ?? null} command={progress.runningCommand} />
      </div>
    )
  }

  if (lab.dock === 'waiting') {
    return (
      <div data-autoresearch="dock" style={dockShell}>
        <WaitingCard />
      </div>
    )
  }

  return null
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
  }, (props: DockProps) => <AutoresearchDock ctx={ctx} {...props} />))

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
        const line = option.id === 'resume' ? '/autoresearch resume' : `/autoresearch ${option.id}`
        await executeLine(ctx, session.sessionId, line)
      },
    },
  })
}
