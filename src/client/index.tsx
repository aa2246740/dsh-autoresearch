import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { useAnchoredPosition } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-commands/client'
import type { CommandUiContract } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { AutoresearchSnapshot, ExperimentStatus } from '../types.js'
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
  applyCommandAcknowledgement,
  buildStartLine,
  cancelInitDock,
  dismissProgress,
  friendlyStartError,
  hideAfterConfirm,
  isProgressDismissed,
  parseRoundBudget,
  patchLab,
  progressIdentity,
  recordCommandAcknowledgement,
  rememberSession,
  showInitDock,
  startDecisionMessage,
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
  on: (event: string, listener: (...args: any[]) => unknown) => unknown
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
  bg: 'var(--dsw-alias-bg-layer-1, Canvas)',
  panel: 'color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 2.5%, var(--dsw-alias-bg-layer-1, Canvas))',
  subtle: 'color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 6.5%, var(--dsw-alias-bg-layer-1, Canvas))',
  text: 'var(--dsw-alias-label-primary, CanvasText)',
  muted: 'var(--dsw-alias-label-secondary, GrayText)',
  line: 'var(--dsw-alias-border-l1, var(--dsw-alias-border-l2, ButtonBorder))',
  lineStrong: 'color-mix(in srgb, var(--dsw-alias-label-primary, CanvasText) 18%, transparent)',
  good: 'var(--dsw-alias-text-success, var(--dsw-alias-state-success-primary, #1a7f37))',
  bad: 'var(--dsw-alias-text-danger, var(--dsw-alias-state-error-primary, #cf222e))',
  accent: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #2f6fed))',
  onAccent: 'var(--dsw-alias-label-primary-foreground, #ffffff)',
  warn: 'var(--dsw-alias-state-warn-label, #9a6700)',
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
  border: `1px solid ${colors.lineStrong}`,
  borderRadius: 14,
  background: colors.panel,
  padding: 16,
}

const mono: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
}

const tabular: CSSProperties = {
  fontVariantNumeric: 'tabular-nums',
  fontFeatureSettings: '"tnum" 1',
}

const PANEL_GAP = 8
const PANEL_MARGIN = 12
const UNPLACED_PANEL_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

const clientStyles = `
  @keyframes dsh-ar-spin { to { transform: rotate(360deg); } }
  @keyframes dsh-ar-panel-enter {
    from { opacity: 0; transform: translateY(-5px) scale(.992); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .dsh-ar-header-root { position: relative; }
  .dsh-ar-trigger {
    box-sizing: border-box;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid ${colors.line};
    border-radius: 999px;
    background: transparent;
    color: ${colors.text};
    cursor: pointer;
    transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, transform 100ms ease;
  }
  .dsh-ar-trigger:hover,
  .dsh-ar-trigger:focus-visible { background: var(--dsw-alias-interactive-bg-hover, ${colors.subtle}); }
  .dsh-ar-trigger:active { transform: scale(.96); }
  .dsh-ar-trigger:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
  .dsh-ar-trigger[data-open] {
    border-color: var(--dsw-alias-button-ghost-active-border, ${colors.accent});
    background: var(--dsw-alias-button-ghost-active-fill, ${colors.subtle});
  }
  .dsh-ar-trigger[data-state='running'],
  .dsh-ar-trigger[data-state='ready'] { color: ${colors.accent}; }
  .dsh-ar-trigger[data-state='waiting'],
  .dsh-ar-trigger[data-state='awaiting-user'] { color: ${colors.warn}; }
  .dsh-ar-trigger[data-state='completed'] { color: ${colors.good}; }
  .dsh-ar-trigger[data-state='stopped'],
  .dsh-ar-trigger[data-state='ended'] { color: ${colors.muted}; }
  .dsh-ar-trigger::after {
    content: '';
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 6px;
    height: 6px;
    border: 1.5px solid ${colors.panel};
    border-radius: 50%;
    background: ${colors.muted};
  }
  .dsh-ar-trigger[data-state='running']::after { background: ${colors.accent}; }
  .dsh-ar-trigger[data-state='ready']::after { background: ${colors.accent}; }
  .dsh-ar-trigger[data-state='waiting']::after { background: ${colors.warn}; }
  .dsh-ar-trigger[data-state='awaiting-user']::after { background: ${colors.warn}; }
  .dsh-ar-trigger[data-state='completed']::after { background: ${colors.good}; }
  .dsh-ar-trigger[data-state='stopped']::after,
  .dsh-ar-trigger[data-state='ended']::after { background: ${colors.muted}; }
  .dsh-ar-menu {
    position: fixed;
    z-index: 1100;
    box-sizing: border-box;
    width: min(420px, calc(100vw - 24px));
    max-width: calc(100vw - 24px);
    max-height: min(540px, calc(100vh - 24px));
    overflow: hidden;
    border: 1px solid ${colors.lineStrong};
    border-radius: 14px;
    background: ${colors.panel};
    box-shadow: var(--dsw-shadow-lv3, 0 12px 32px color-mix(in srgb, CanvasText 14%, transparent));
    color: ${colors.text};
    transform-origin: top right;
    animation: dsh-ar-panel-enter 180ms cubic-bezier(.2, .8, .2, 1);
    isolation: isolate;
  }
  .dsh-ar-panel-scroll {
    box-sizing: border-box;
    max-height: min(540px, calc(100vh - 24px));
    overflow: auto;
    padding: 20px 20px 14px;
    overscroll-behavior: contain;
  }
  .dsh-ar-compact-panel { min-height: 56px; display: flex; align-items: center; }
  .dsh-ar-button:hover:not(:disabled) { filter: brightness(0.97); }
  .dsh-ar-button:active:not(:disabled) { filter: brightness(0.93); }
  .dsh-ar-button:focus-visible { outline: 2px solid ${colors.accent}; outline-offset: 2px; }
  .dsh-ar-history-row {
    border-top: 1px solid ${colors.line};
  }
  .dsh-ar-history-row:first-child { border-top: 0; }
  .dsh-ar-history-summary {
    box-sizing: border-box;
    width: 100%;
    min-height: 44px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: start;
    column-gap: 16px;
    row-gap: 5px;
    padding: 11px 0 12px;
    border: 0;
    background: transparent;
    color: ${colors.text};
    text-align: left;
    cursor: pointer;
    font: inherit;
  }
  .dsh-ar-history-summary:hover .dsh-ar-history-disclosure { color: ${colors.text}; }
  .dsh-ar-history-summary:focus-visible,
  .dsh-ar-history-list-toggle:focus-visible {
    outline: 2px solid ${colors.accent};
    outline-offset: 2px;
    border-radius: 6px;
  }
  .dsh-ar-history-preview {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 1;
    overflow: hidden;
    color: ${colors.muted};
    font-size: 13px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .dsh-ar-history-disclosure {
    align-self: end;
    color: ${colors.muted};
    font-size: 11px;
    line-height: 1.5;
    white-space: nowrap;
  }
  .dsh-ar-history-detail {
    padding: 0 0 14px;
    color: ${colors.text};
    font-size: 13px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .dsh-ar-history-list-toggle {
    min-width: 44px;
    min-height: 32px;
    margin: -6px -4px -6px 0;
    padding: 0 4px;
    border: 0;
    background: transparent;
    color: ${colors.muted};
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  @media (max-width: 640px) {
    .dsh-ar-panel-scroll { padding: 18px 18px 12px; }
  }
  @media (prefers-reduced-motion: reduce) {
    [data-autoresearch-spinner] { animation: none !important; }
    .dsh-ar-menu { animation: none !important; }
  }
`

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

function LabButton(props: { children: string; onClick?: () => void; kind?: 'primary' | 'ghost' | 'danger'; disabled?: boolean; type?: 'button' | 'submit'; ariaLabel?: string }) {
  const kind = props.kind ?? 'ghost'
  const background = kind === 'primary' ? colors.accent : 'transparent'
  const color = kind === 'primary' ? colors.onAccent : kind === 'danger' ? colors.bad : colors.text
  const border = kind === 'primary' ? colors.accent : kind === 'danger' ? colors.bad : colors.line
  return (
    <button
      className="dsh-ar-button"
      type={props.type ?? 'button'}
      aria-label={props.ariaLabel}
      disabled={props.disabled}
      onClick={props.onClick}
      style={{
        ...font,
        background,
        color,
        border: `1px solid ${border}`,
        borderRadius: 8,
        minHeight: 44,
        padding: '0 14px',
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
      data-autoresearch-spinner
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

function AutoresearchIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path d="M7 2.75h6M8.25 3v4.4l-4.1 7.05A1.85 1.85 0 0 0 5.75 17h8.5a1.85 1.85 0 0 0 1.6-2.55L11.75 7.4V3" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M6.15 12h7.7" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
      <circle cx="8.15" cy="14.35" r=".7" fill="currentColor" />
      <circle cx="11.65" cy="13.55" r=".55" fill="currentColor" />
    </svg>
  )
}

function InitDockCard({
  ctx,
  sessionId,
  previousSnapshot,
}: {
  ctx: AnyCtx
  sessionId: string | null
  previousSnapshot: AutoresearchSnapshot | null
}) {
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
      const text = await executeLine(ctx, sessionId, buildStartLine(draft))
      const decision = startDecisionMessage(text)
      if (decision) {
        patchLab({ busy: false, error: decision })
        return
      }
      hideAfterConfirm(previousSnapshot ? progressIdentity(previousSnapshot) : null)
    } catch (error) {
      patchLab({ busy: false, error: friendlyStartError(error) })
    }
  }

  return (
    <form
      data-autoresearch="init-card"
      onSubmit={(event) => void onConfirm(event)}
      style={{ display: 'grid', gap: 8 }}
    >
      <style>{clientStyles}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>新开 Autoresearch</div>
        <div style={{ color: colors.muted, fontSize: 12 }}>确认前不会开跑</div>
      </div>
      <div data-autoresearch="git-safety-note" style={{ color: colors.muted, fontSize: 12 }}>
        首次使用会自动开启本地版本保护并保存当前状态；不会上传代码。
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
      {lab.error ? <div style={{ color: colors.warn, fontSize: 12, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
    </form>
  )
}

function WaitingCard() {
  return (
    <div data-autoresearch="waiting-card" role="status" style={{ display: 'flex', alignItems: 'center', color: colors.muted, fontSize: 13, minHeight: 28 }}>
      <style>{clientStyles}</style>
      <Spinner />
      正在准备新目标，完成第一轮后会显示结果
    </div>
  )
}

function RunningCard({ name, command }: { name: string | null; command: string | null }) {
  return (
    <div data-autoresearch="running-card" role="status" style={{ fontSize: 13, color: colors.text }}>
      <style>{clientStyles}</style>
      <Spinner />
      <span style={{ fontWeight: 600 }}>正在优化</span>
      {name ? <span style={{ color: colors.muted }}>{` · ${name}`}</span> : null}
      {command ? <span style={{ ...mono, color: colors.muted }}>{` · ${command}`}</span> : null}
      <span style={{ color: colors.muted }}> · 第一轮完成后显示结果</span>
    </div>
  )
}

function statusLabel(status: ExperimentStatus): string {
  if (status === 'keep') return '保留'
  if (status === 'discard') return '未采用'
  if (status === 'crash') return '运行失败'
  return '检查未通过'
}

function ProgressCard({
  model,
  snapshot,
  ctx,
  sessionId,
}: {
  model: DashboardModel
  snapshot: AutoresearchSnapshot
  ctx: AnyCtx
  sessionId: string | null
}) {
  const lab = useLab()
  const progressDelta = formatDeltaPct(model.progress?.deltaPct ?? null)
  const deltaTone = model.progress?.improved === true ? colors.good : model.progress?.improved === false ? colors.bad : colors.muted
  const terminal = model.lifecycle !== 'running' && model.lifecycle !== 'awaiting_user'
  const stateTone = model.lifecycle === 'completed'
    ? colors.good
    : model.lifecycle === 'awaiting_user'
      ? colors.warn
      : terminal
        ? colors.muted
        : colors.accent
  const stateLabel = model.lifecycle === 'completed'
    ? '目标已完成'
    : model.lifecycle === 'awaiting_user'
      ? '等待你拍板'
      : model.lifecycle === 'stopped'
        ? '本轮已停止'
        : model.lifecycle === 'ended'
          ? '本轮已结束'
          : model.running
            ? '正在执行'
            : '循环已开启'
  const issueCount = model.crashed + model.checksFailed
  const [showAllRuns, setShowAllRuns] = useState(false)
  const [expandedRun, setExpandedRun] = useState<number | null>(null)
  const historyId = useId()
  const historySectionRef = useRef<HTMLElement>(null)
  const snapshotIdentity = progressIdentity(snapshot)
  const visibleRows = showAllRuns ? model.allRows : model.rows

  useEffect(() => {
    setShowAllRuns(false)
    setExpandedRun(null)
  }, [snapshotIdentity])

  async function onPause(): Promise<void> {
    if (!sessionId || lab.busy) return
    patchLab({ busy: true, error: null })
    try {
      await executeLine(ctx, sessionId, '/autoresearch off')
      patchLab({ busy: false })
    } catch (error) {
      patchLab({ busy: false, error: friendlyStartError(error) })
    }
  }

  return (
    <section data-autoresearch="progress-card" aria-label="Autoresearch 结果" style={{ display: 'grid', gap: 0, fontSize: 14 }}>
      <style>{clientStyles}</style>
      <header
        data-ud-check="progress-header"
        data-ud-role="title"
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ color: colors.muted, fontSize: 12, marginBottom: 4 }}>Autoresearch</div>
          <div data-autoresearch="progress-title" style={{ fontSize: 17, lineHeight: 1.3, fontWeight: 620, overflowWrap: 'anywhere' }}>
            {model.name ?? '未命名目标'}
          </div>
        </div>
        <div
          role="status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            flex: '0 0 auto',
            gap: 6,
            color: stateTone,
            paddingTop: 2,
            fontSize: 12,
            fontWeight: 560,
          }}
        >
          <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: stateTone }} />
          {stateLabel}
        </div>
      </header>

      {model.lifecycle === 'awaiting_user' ? (
        <div
          role="status"
          data-autoresearch="decision-required"
          style={{
            display: 'grid',
            gap: 5,
            marginTop: 16,
            padding: '12px 14px',
            border: `1px solid color-mix(in srgb, ${colors.warn} 45%, transparent)`,
            borderRadius: 8,
            background: `color-mix(in srgb, ${colors.warn} 8%, ${colors.panel})`,
          }}
        >
          <strong style={{ color: colors.warn }}>等待你拍板</strong>
          <span>{snapshot.decisionQuestion ?? '下一步需要你的决定，请在对话中的确认卡选择。'}</span>
          {snapshot.completionReason ? <span style={{ color: colors.muted, fontSize: 12 }}>{snapshot.completionReason}</span> : null}
        </div>
      ) : null}

      <section
        className="dsh-ar-outcome"
        data-ud-check="progress-outcome"
        data-ud-role="panel"
        style={{
          padding: '24px 0 20px',
          borderBottom: `1px solid ${colors.line}`,
        }}
      >
        <div style={{ color: colors.muted, fontSize: 12, marginBottom: 7 }}>
          当前最佳 · {model.metricName}
        </div>
        <div
          data-autoresearch="progress-best"
          style={{ color: model.progress ? colors.text : colors.muted, fontSize: 32, lineHeight: 1.05, fontWeight: 650, ...tabular }}
        >
          {model.progress?.value ?? '—'}
        </div>
        <div style={{ color: colors.muted, fontSize: 12, lineHeight: 1.55, marginTop: 8, ...tabular }}>
          <span data-autoresearch="baseline">基线 {model.baseline?.value ?? '—'}</span>
          {progressDelta ? <span data-autoresearch="delta" style={{ color: deltaTone }}>{` · ${progressDelta}`}</span> : null}
          {model.progress ? <span>{` · 第 ${model.progress.run} 轮`}</span> : null}
        </div>
        <div style={{ color: colors.muted, fontSize: 12, lineHeight: 1.55, marginTop: 12, display: 'flex', gap: '5px 14px', flexWrap: 'wrap', ...tabular }}>
          <span>本轮 {model.runs} 轮</span>
          <span data-autoresearch="kept">保留 {model.kept} 次</span>
          {model.conf !== null ? <span data-autoresearch="conf">可信度 {model.conf.toFixed(1)}×</span> : null}
          {issueCount > 0 ? <span style={{ color: colors.bad }}>{issueCount} 次未通过</span> : null}
        </div>
      </section>

      <section ref={historySectionRef} data-ud-check="experiment-history" data-ud-role="panel" style={{ paddingTop: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, marginBottom: 2 }}>
          <div style={{ fontSize: 13, fontWeight: 620 }}>最近记录</div>
          <button
            type="button"
            className="dsh-ar-history-list-toggle"
            data-autoresearch="history-list-toggle"
            aria-expanded={showAllRuns}
            onClick={() => {
              setShowAllRuns((value) => !value)
              setExpandedRun(null)
              requestAnimationFrame(() => historySectionRef.current?.scrollIntoView({ block: 'start' }))
            }}
          >
            {showAllRuns ? '只看最近 3 轮' : `查看全部 ${model.allRows.length} 轮`}
          </button>
        </div>
        <ol aria-label="最近记录" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {visibleRows.map((row) => {
            const expanded = expandedRun === row.run
            const detailId = `${historyId}-run-${row.run}`
            return (
            <li
              className="dsh-ar-history-row"
              key={row.run}
              data-autoresearch-run={row.run}
              data-autoresearch-status={row.status}
            >
              <button
                type="button"
                className="dsh-ar-history-summary"
                data-autoresearch-expand-run={row.run}
                aria-expanded={expanded}
                aria-controls={detailId}
                onClick={() => setExpandedRun((value) => value === row.run ? null : row.run)}
              >
                <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 12 }}>
                  <span aria-label={`第 ${row.run} 轮`} style={{ color: colors.muted, ...tabular }}>#{row.run}</span>
                  <span aria-hidden="true" style={{ width: 5, height: 5, borderRadius: '50%', background: statusColor(row.status) }} />
                  <span style={{ color: statusColor(row.status), fontWeight: 560 }}>{statusLabel(row.status)}</span>
                </span>
                <span style={{ fontSize: 13, fontWeight: 620, textAlign: 'right', ...tabular }}>{row.metric}</span>
                {!expanded ? <span className="dsh-ar-history-preview">{row.description}</span> : <span />}
                <span className="dsh-ar-history-disclosure">{expanded ? '收起' : '展开'}</span>
              </button>
              {expanded ? (
                <div id={detailId} className="dsh-ar-history-detail" data-autoresearch-run-detail={row.run}>
                  <div>{row.description}</div>
                  {row.commit !== '—' ? <div style={{ ...mono, color: colors.muted, fontSize: 11, marginTop: 7 }}>版本 {row.commit}</div> : null}
                </div>
              ) : null}
            </li>
            )
          })}
        </ol>
      </section>

      {model.running ? (
        <div data-autoresearch="running-line" role="status" style={{ color: colors.muted, fontSize: 12, padding: '10px 0' }}>
          <Spinner />
          正在执行当前实验{model.runningCommand ? <span style={mono}>{` · ${model.runningCommand}`}</span> : null}
        </div>
      ) : null}
      {lab.error ? <div role="alert" style={{ color: colors.bad, fontSize: 12, whiteSpace: 'pre-wrap' }}>{lab.error}</div> : null}
      <div
        data-ud-check="progress-action"
        data-ud-role="panel"
        style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', minHeight: 44, paddingTop: 10, borderTop: `1px solid ${colors.line}` }}
      >
        {model.lifecycle === 'awaiting_user' ? (
          <span style={{ color: colors.muted, fontSize: 12 }}>请在对话中的确认卡拍板</span>
        ) : terminal ? (
          <LabButton ariaLabel="关闭本轮结果" onClick={() => dismissProgress(snapshot)}>关闭</LabButton>
        ) : (
          <LabButton disabled={!sessionId || lab.busy} onClick={() => void onPause()}>
            {lab.busy ? '正在暂停…' : '暂停'}
          </LabButton>
        )}
      </div>
    </section>
  )
}

function AutoresearchHeaderUtility({ ctx, sessionId, useSession, useProjection, session }: DockProps & { ctx: AnyCtx }) {
  const lab = useLab()
  rememberSession(sessionId)
  const live = useSession ? useSession((snapshot) => snapshot) : session
  const projected = snapshotFromMeta(typeof useProjection === 'function' ? useProjection('autoresearch') : undefined)
  const progress = inspectConversation(live ?? { runningCalls: [], nodes: [] })
  const projectedBoard = Boolean(projected?.boardReady && projected.results.length > 0)
  const baseSnapshot = progress.kind === 'board'
    ? preferLedgerSnapshot(progress.snapshot, projected) ?? progress.snapshot
    : projectedBoard
      ? projected
      : progress.snapshot
  const snapshot = applyCommandAcknowledgement(baseSnapshot, lab.commandAck, sessionId)
  const model = snapshot ? buildDashboardModel(snapshot, {
    running: progress.runningExperiment,
    runningCommand: progress.runningCommand,
  }) : null
  const superseded = Boolean(
    lab.dock === 'waiting'
    && lab.supersededProgressKey
    && snapshot
    && progressIdentity(snapshot) === lab.supersededProgressKey,
  )
  const acknowledgedBoard = lab.commandAck?.sessionId === sessionId && lab.commandAck.kind !== 'idle'
  const showBoard = !superseded && (progress.kind === 'board' || projectedBoard || acknowledgedBoard)
    && snapshot !== null && model !== null && model.runs > 0
  const showRunning = !showBoard && !superseded && progress.kind === 'running'
  const showWaiting = !showBoard && !showRunning && (
    lab.dock === 'waiting'
    || superseded
    || Boolean(snapshot?.active && (model?.runs ?? 0) === 0)
  )
  const dismissed = snapshot !== null && isProgressDismissed(snapshot)
  const visible = lab.dock !== 'init' && !dismissed && (showBoard || showRunning || showWaiting)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelPosition = useAnchoredPosition({
    open,
    anchorRef: triggerRef,
    panelRef,
    gap: PANEL_GAP,
    margin: PANEL_MARGIN,
  })

  useEffect(() => setOpen(false), [sessionId])
  useEffect(() => {
    if (visible) return
    setOpen(false)
  }, [visible])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return
      if (rootRef.current?.contains(event.target) === true) return
      if (panelRef.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  if (!visible) return null

  const monitorState = showBoard && model?.lifecycle === 'completed'
    ? 'completed'
    : showBoard && model?.lifecycle === 'awaiting_user'
      ? 'awaiting-user'
      : showBoard && model?.lifecycle === 'stopped'
        ? 'stopped'
        : showBoard && model?.lifecycle === 'ended'
          ? 'ended'
          : showRunning || progress.runningExperiment
            ? 'running'
            : showWaiting || snapshot?.pendingContinuation
              ? 'waiting'
              : 'ready'
  const stateLabel = monitorState === 'completed'
    ? '目标已完成'
    : monitorState === 'awaiting-user'
      ? '等待你拍板'
      : monitorState === 'stopped'
        ? '本轮已停止'
        : monitorState === 'ended'
          ? '本轮已结束'
          : monitorState === 'running'
            ? '正在执行实验'
            : monitorState === 'waiting'
              ? '正在准备下一轮'
              : '循环已开启'
  const goalLabel = model?.name ?? projected?.name ?? snapshot?.name ?? null

  return (
    <div ref={rootRef} className="dsh-ar-header-root" data-autoresearch="header-utility">
      <style>{clientStyles}</style>
      <button
        ref={triggerRef}
        type="button"
        className="dsh-ar-trigger"
        data-autoresearch="header-trigger"
        data-open={open ? '' : undefined}
        data-state={monitorState}
        aria-expanded={open}
        aria-label={`Autoresearch，${stateLabel}${goalLabel ? `，${goalLabel}` : ''}`}
        title={`Autoresearch · ${stateLabel}`}
        onClick={() => setOpen((value) => !value)}
      >
        <AutoresearchIcon />
      </button>

      {open
        ? createPortal(
          <div
            ref={panelRef}
            className="dsh-ar-menu"
            style={panelPosition ?? UNPLACED_PANEL_STYLE}
            role="dialog"
            aria-modal="false"
            aria-label="Autoresearch 监测面板"
            data-autoresearch="header-panel"
          >
            <div className={`dsh-ar-panel-scroll${showBoard ? '' : ' dsh-ar-compact-panel'}`}>
              {showBoard && model && snapshot
                ? <ProgressCard model={model} snapshot={snapshot} ctx={ctx} sessionId={sessionId} />
                : showRunning
                  ? <RunningCard name={projected?.name ?? snapshot?.name ?? null} command={progress.runningCommand} />
                  : <WaitingCard />}
            </div>
          </div>,
          document.body,
        )
        : null}
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
    : projected?.boardReady && projected.results.length > 0
      ? projected
      : progress.snapshot
  if (lab.dock === 'init') {
    return (
      <div data-autoresearch="dock" style={dockShell}>
        <InitDockCard ctx={ctx} sessionId={sessionId} previousSnapshot={snapshot} />
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
  ctx.on('command/executed', (sessionId: string, commandName: string, result: { kind?: string; text?: string }) => {
    if (commandName !== 'autoresearch' || result.kind !== 'success' || typeof result.text !== 'string') return
    recordCommandAcknowledgement(sessionId, result.text)
  })

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'autoresearch-monitor',
    order: 60,
    label: 'Autoresearch',
  }, (props: DockProps) => <AutoresearchHeaderUtility ctx={ctx} {...props} />))

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
