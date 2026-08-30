---
version: alpha
name: Autoresearch Header Monitor
description: A quiet, outcome-first experiment monitor that stays collapsed in the DSH session header until the user asks to inspect it.

colors:
  primary: "#2F6FED"
  secondary: "#16835B"
  tertiary: "#9A6700"
  neutral: "#667085"
  surface: "#FFFFFF"
  on-surface: "#172033"
  error: "#B42318"

typography:
  headline-lg:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 20px
    fontWeight: 650
    lineHeight: 1.25
  body-md:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.55
  label-md:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
    fontSize: 13px
    fontWeight: 600
    lineHeight: 1.35

rounded:
  none: 0px
  sm: 4px
  md: 8px
  lg: 14px
  full: 9999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px

components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    typography: "{typography.label-md}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
  progress-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.on-surface}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.lg}"
---

# Design System

## Overview

Autoresearch is a compact session-header monitor. Its audience is a beginner who cares about the result, not Git, commits, or internal loop machinery. The header keeps one quiet status trigger visible while the result board stays collapsed by default, preserving the transcript as the primary reading surface. When opened, the panel behaves like a restrained utility popover: one result, one summary, three recent proof points, an action only when intervention is required, and explicit paths to every run and every complete explanation.

## Colors

- Host DSH semantic variables are authoritative in the running product; front-matter values are accessible light-theme fallbacks.
- Primary is reserved for the current action. Secondary denotes retained improvements. Tertiary denotes discarded or waiting work. Error is reserved for actual failures.
- State is always written in text as well as color.

## Typography

- Use the host system sans stack for all user-facing copy and mixed Chinese/English descriptions.
- Use tabular figures for metrics, deltas, run numbers, and confidence. Monospace is limited to short commit references and commands.
- The monitor uses a one-line preview only when the same row is an obvious keyboard-operable expansion control. Expanded rows show the complete explanation and retained version reference; `查看全部` exposes every run. Critical meaning never depends on hover, title text, or an external ledger.

## Layout

- One framed, anchored progress panel opened from the session header, not cards inside cards.
- Reading order: state and goal, current best result, one-line run summary, three recent records, explicit full-history/full-detail controls, then a state action only when one is valid.
- History rows use a quiet two-column metadata line with the description below. The panel must not scroll horizontally at 320 px.
- Use the 4/8/12/16/24 spacing rhythm. The outcome band may be denser than the history list, but no readable zones may touch.
- The composer dock is reserved for the explicit new-goal confirmation form. Monitoring, waiting, running, and completed-result states never consume transcript or composer height.

## Elevation & Depth

- Use the host menu surface, one visible level-2 border, and a restrained shadow to separate the anchored panel from the shell. Inside, use whitespace and hairline dividers rather than nested boxes. Do not add glass, gradients, or nested elevated tiles.
- Rows are separated by hairlines and whitespace, not individual containers.

## Shapes

- The outer panel uses `rounded.lg`; controls use `rounded.md`; the lifecycle indicator is plain text plus a small semantic dot, not a pill.
- Do not turn counts, metrics, or states into decorative capsules.

## Components

### Progress panel

- Purpose: show what is running, whether the run ended, the measurable outcome, recent experiments, and a next action only while user intervention is required.
- Seat: `conversation.session.header.utilities`, after Watcher and before the files utility. The 32 px trigger is collapsed by default and exposes state through text in its accessible name as well as color.
- Disclosure: click toggles the panel; clicking outside or pressing Escape closes it and returns focus to the trigger. Opening the panel never resizes the conversation or composer.
- Running state: state label `正在优化`; primary action `暂停`.
- Ended state: state label `本轮已结束`; no footer action. Never show `暂停` after the controller is inactive, and never imply a durable close with a volatile client-only hide.
- The latest completed result remains available from the quiet header trigger across refresh. Starting a later goal supersedes it; an explicit durable log clear removes it.
- The best metric is the only visual focus; baseline, delta, kept count, confidence, and failed-check count are secondary. Discard counts, secondary metrics, and commit ids stay out of this compact monitor.

### Experiment row

- Collapsed: run number and localized status on the left, metric plus a right-pointing disclosure chevron on the same first line, then the one-line preview below. The disclosure never trails the description.
- Expanded: the chevron points down and the complete description plus retained version reference appears below the row. Only one row expands at a time.
- `查看全部 N 轮` exposes the complete current-goal history inside the scrollable popover; `只看最近 3 轮` returns to the quiet default.
- Status copy: `保留`, `未采用`, `运行失败`, `检查未通过`.
- Rows remain readable with long Chinese descriptions and missing commit ids.

### Action button

- Render only for active work (`暂停`) or an awaiting-user instruction. Terminal results have no footer action.
- Minimum active-action height is 44 CSS px, with visible keyboard focus and disabled/busy feedback. Repeated pause clicks are locked while the command is pending.

## Do's and Don'ts

- Do make state and the next action explicit in beginner language.
- Do preserve the full experiment ledger while showing only the current goal segment.
- Do hide internal authoring skills from ordinary slash autocomplete.
- Don't expose Git, snapshot, continuation-token, or support-skill vocabulary in the progress panel.
- Don't show an old goal's rows while a new goal is being prepared.
- Don't use a monospaced five-column table as the main visual language.

## Agent Execution Rules

- Read this file before modifying the client UI or state copy.
- Reuse DSH semantic theme variables; update this contract before introducing persistent visual tokens.
- Keep lifecycle behavior and visible labels covered by regression tests.
- Mark the meaningful rendered zones with sparse `data-ud-check` attributes.

## Request Anchor

- Original user request: redesign the ugly state card; replace Pause with Close when the goal is done; support repeated independent Autoresearch goals without retaining the old card; hide the two internal support skills from ordinary users.
- Latest user override: a completed-result `关闭` must not pretend to be durable when refresh restores it. Keep the quiet top-bar status trigger persistently available, remove the misleading terminal close action, and let a new goal or explicit durable clear replace/remove the result. Do not modify DSH core.
- Deliverable: source, tests, built plugin, formal DSH installation, live verification, and publication to `main`.
- Primary audience: non-technical DSH users who may run several unrelated Autoresearch goals in one project and conversation.
- Core job to be done: understand the latest outcome at a glance, safely pause active work, and start another research goal without managing stale or fake-dismissed UI state.
- Success criteria: completed cards show neither Pause nor Close; the collapsed completed-state trigger survives refresh; a new goal starts a fresh segment and supersedes the old result immediately; internal finalize/hooks skills do not appear in user autocomplete; the monitoring board occupies no composer/transcript height while collapsed; header click, outside click, and Escape collapse work; every current-goal run is reachable through `查看全部`; every clamped preview has a mouse and keyboard full-view path; desktop and narrow views have no clipping or horizontal overflow.
- Non-goals: redesign the whole DSH shell, expose advanced Git controls, erase the historical `.auto/log.jsonl` ledger, or add decorative motion.
- Must preserve: automatic local protection, existing experiment data, DSH theme compatibility, same-session continuation safety, current `/autoresearch` entry point, and an unmodified DSH core checkout.
- Validation must check against: the supplied session event order, controller state after `off -> new goal`, action absence in terminal state, completed-trigger survival after browser refresh, new-goal supersession, skill invocation visibility, desktop/narrow rendered states, and formal Host/client activation.

## Content Model

- User intent: see whether the latest research improved the project and intervene only when the loop is still active or awaiting a decision.
- Message hierarchy: lifecycle state and goal -> best result vs baseline -> run health -> experiment explanations -> action only when required.
- Collapsed header answers: Autoresearch exists for this session and whether it is running or ended. The open panel answers what goal this is, what changed, and what the user can do next.
- Primary action meaning: `暂停` stops automatic continuation but preserves results. Terminal results intentionally have no action.
- Voice and tone: calm, concise, plain Chinese; technical identifiers are secondary evidence.
- Terminology rules: use `本轮`, `保留`, `未采用`, `正在优化`, and `本轮已结束`; avoid `paused`, `keep`, `discard`, `commit`, `关闭结果`, and internal skill names as primary copy.
- State language rules: preparing = `正在准备新目标`; running = `正在优化`; ended = `本轮已结束` and remains inspectable; a new explicit goal always creates a fresh goal identity and supersedes the prior result.
- Trust, risk, and help content: the start card may state that local protection is automatic and code is not uploaded. Progress UI does not teach Git.
- Content risks: `已达成` cannot be inferred from a manual stop alone, so the neutral truthful completion label is `本轮已结束`.

## OKF Preflight

### Active OKF Concepts

- `design-okf/methods/senior-design-process.md`
- `design-okf/content/state-language.md`
- `design-okf/content/semantic-binding.md`
- `design-okf/digital/accessibility-usability.md`
- `design-okf/digital/responsive-interaction.md`
- `design-okf/systems/typography-system.md`
- `design-okf/foundations/visual-hierarchy.md`
- `design-okf/systems/taste-engine.md`
- `design-okf/foundations/necessary-design-judgment.md`
- `design-okf/governance/design-to-code-governance.md`
- `design-okf/governance/request-integrity.md`

### Support References

- `branch-web-product.md`, `audit-polish.md`, `content-model.md`, `principles.md`, `design-okf/index.md`, `design-contract.md`, `design-okf/governance/design-md-standard.md`, `design-okf/governance/design-md-agent-governance.md`, `visual-verification.md`, and `quality-gates.md`.

### Execution Mode

- `single-agent`: one state machine and one client surface need a single accountable implementation writer.

### Decision Record

- Constraints extracted: embedded composer width, DSH semantic tokens, long mixed-language descriptions, preserved ledger history, no user-facing Git complexity, and state-driven actions.
- Deliberate exceptions: 14 px body text is retained for the host's dense embedded-tool context; 44 px is still used for actions.
- Verification hooks: controller regression tests, conversation replay fixture, source visibility assertion, pinned-browser semantic-zone audit, screenshot review, DSHX checks, and formal Host/client proof.

## OKF Decision Bindings

| Reference | Decision | Artifact target | Verification |
|---|---|---|---|
| `design-okf/methods/senior-design-process.md` | Define lifecycle and user outcome before visual styling | Controller, dashboard model, this contract | State transition tests precede implementation |
| `design-okf/content/state-language.md` | Give preparing, running, awaiting-user, and ended states truthful copy; ended has no fake close action | Progress panel and actions | Copy/source assertions, refresh replay, and rendered states |
| `design-okf/content/semantic-binding.md` | Bind every one-line preview to a native expanded-state button and an in-panel full-text region | History rows and full-history control | Keyboard expansion, aria-expanded, full-text equality, and source review |
| `design-okf/digital/accessibility-usability.md` | Preserve focus, 44 px active actions, textual state parity, Escape collapse, and focus return | Header trigger, panel, buttons, status labels | Keyboard/focus and target-size audit |
| `design-okf/digital/responsive-interaction.md` | Use an anchored non-blocking header panel and a reflowing history grid | Header utility and experiment history | 320/375/768/1280 screenshots, closed-height and overflow audit |
| `design-okf/systems/typography-system.md` | Use system sans for copy and tabular figures for data | Metric rail and rows | Mixed Chinese/English screenshot review |
| `design-okf/foundations/visual-hierarchy.md` | Make best result the single focal point and demote commit ids | Outcome summary | Critique pass and screenshot review |
| `design-okf/systems/taste-engine.md` | Use a quiet instrument-panel read and reject terminal-table/card-stack defaults | Entire progress panel | Anti-default critique and rendered review |
| `design-okf/foundations/necessary-design-judgment.md` | Remove both Pause and volatile Close from ended state; remove commit as a primary column | State action and history | Lifecycle/action/refresh tests and Delete Test |
| `design-okf/governance/design-to-code-governance.md` | Trace persistent tokens and component states to this contract | `DESIGN.md` and client implementation | Contract validator and source diff |
| `design-okf/governance/request-integrity.md` | Keep all four user requests in the release gate | Whole change set | Final acceptance matrix |

## Information Architecture

- Core user tasks: read outcome, inspect recent experiments, pause an active loop, start a different goal.
- Page or screen inventory: start card, preparing line, first-run line, running progress panel, ended progress panel, superseded-by-new-goal state.
- Navigation model: `/autoresearch` opens a new-start card in the composer; after confirmation, the header trigger owns waiting/running/results; its panel is collapsed by default; completed status persists until a new goal supersedes it or durable state is cleared.
- Content hierarchy: state/goal, one outcome, one summary line, three recent proof points, on-demand full history and row detail, action.
- Primary CTA rules: exactly one primary state action when intervention is valid; no terminal action.

## Taste Signature

- Design read: a quiet utility instrument for a repeated desktop workflow, not a developer console or analytics dashboard.
- Necessary judgment: remove the outcome box, state pill, always-visible commit ids, secondary metrics, discarded count, surplus default rows, and repeated labels; keep lifecycle truth, the best result, compact evidence, and one-step access to all demoted information.
- Taste dials: visual variance 2, information density 4, motion depth 1, brand distinction 3, type expressiveness 1, experiment risk 1.
- Category defaults avoided: gray terminal slab, nested cards, KPI chip grid, status badges, decorative gradient, and equal emphasis on every datum.
- Layout families: compact header utility plus a single-column result popover and editorial evidence list.
- Visual memory feature: the small experiment-flask trigger and one calm, tabular result figure.
- Type personality: utility-first system sans; tabular numerals provide precision while Chinese explanations stay humane.
- Asset/reference policy: use only actual experiment data; no illustrative or fake product assets.
- Anti-default locks: no glass, no gradient, no huge shadow, no monospaced body copy, no horizontal data table on mobile.
- Intentional exceptions: a small state dot is allowed only with adjacent lifecycle text.

## Quality Gates

- Request Anchor fit: all four requested changes are independently tested.
- Visual: the 420 px default panel keeps one result primary and three previews visible; opening one row or all history uses the existing internal scroll region without widening or resizing the conversation.
- Accessibility: semantic buttons, visible focus, textual state, and a named >=44 px Pause action only while active.
- Responsive: no page-level horizontal overflow at 320 px; history reflows without losing descriptions; the open panel stays inside a 12 px viewport margin and never covers content while closed.
- Interaction: header trigger, outside click, and Escape collapse the panel; focus returns to the trigger; pause is locked while pending; ended result survives refresh; a new goal supersedes the old result.
- Motion: static-first; spinner stops under reduced motion.
- Performance: no polling or new persistent client timer.
- I18n/legal: mixed Chinese/English wraps; numbers use tabular figures; no external assets or claims.
- Contract consistency: implementation values and state copy match this file.

## Implementation And Governance

- CSS architecture: component-local React styles plus one scoped responsive/focus style block; the header panel is portaled to `document.body` and positioned with the host anchored-position helper; DSH semantic variables remain runtime truth.
- Token implementation: constants map to the front-matter roles and host aliases.
- Component naming: `ProgressCard` with named outcome, history, and state-action zones.
- State naming: preparing, executing, active-ready, awaiting-user, completed, stopped, and superseded-by-new-goal. Durable completion is a structured controller transition, never inferred from prose.
- Theme strategy: inherit DSH semantic variables with accessible light fallbacks.
- Dark mode: provided by host variables; no fixed white text assumptions.
- Framework notes: React 18 client bundle through DSHX external client bundling.
- Performance budget: no polling; render three recent rows by default and all current-goal rows only after explicit user action.
- Visual regression: deterministic fixture screenshots at key lifecycle and viewport states.
- Rendered UI Audit: sparse `data-ud-check` zones for header, outcome, history, and the conditional active/decision action.
- Accessibility testing: browser name/target/overflow checks plus source-level semantic assertions.
- CI checks: package tests, typecheck, build, DSHX check, and contract validation.

## Assumptions

- Completion is a structured controller transition; inactive-with-results is not guessed to mean success.
- Existing DSH semantic variables provide sufficient dark-theme contrast.
- Historical rows remain in `.auto/log.jsonl`; the UI scopes them by the current experiment segment.

## Open Questions

- A future DSH release may expose a public external event-vocabulary registry; this plugin remains on official command/tool events until that contract exists.

## Review Log

| Version | Date | Change | Reason | Reviewer |
|---|---|---|---|---|
| 0.1 | 2026-08-30 | Initial contract for lifecycle and progress-card redesign | User reported stale state, invalid action, repeat-run failure, and internal-skill exposure | Codex |
| 0.2 | 2026-08-30 | Accepted outcome-first card in running/ended states at 1180 px and 390 px | Pinned Playwright found four semantic zones, zero overflow/errors, 44 px actions, visible focus, and correct lifecycle copy | Codex |
| 0.3 | 2026-08-30 | Move monitoring to a collapsed session-header utility and strengthen panel figure/ground | User reported weak boundary contrast and loss of transcript reading space | Codex |
| 0.4 | 2026-08-30 | Accept the header monitor at 1280 px and 390 px | Same-page pinned-browser verification confirmed 1 px panel/outcome borders, distinct tonal surfaces, 12 px viewport clearance, zero overflow/errors, and keyboard/outside-click dismissal | Codex |
| 0.5 | 2026-08-30 | Bind the header monitor to structured continue/complete/needs-user transitions | A completed Agent answer previously left `active=true`; atomic lifecycle decisions now prevent stale working state and preserve explicit user authority for tradeoffs | Codex |
| 0.6 | 2026-08-30 | Remove future custom session writes and migrate legacy state envelopes with backup plus official reload validation | DSH intentionally refuses unknown required external events, so plugin-only state must ride the official command/tool vocabulary | Codex |
| 0.7 | 2026-08-30 | Reduce the result panel to one outcome, one summary, three recent records, and one quiet action | User found the previous board visually overstuffed and asked for more restrained, disciplined hierarchy | Codex |
| 0.8 | 2026-08-30 | Accept the restrained 420 px result popover at desktop and 390 px | Pinned-browser critique repaired a hidden-action P1; final render keeps all three recent records and Close visible with zero overflow or runtime errors | Codex |
| 0.9 | 2026-08-30 | Add progressive disclosure for complete history and row details | User correctly identified that visual truncation without a full-view path sacrificed the monitor's core information job | Codex |
| 1.0 | 2026-08-30 | Move row disclosure from the description tail to the first-line trailing edge | The previous text affordance looked detached from the record header and competed with the explanation | Codex |
| 1.1 | 2026-08-31 | Remove the volatile terminal Close action and retain the quiet completed trigger | Refresh restored the result because dismissal lived only in client memory; a fake durable close was less honest and less useful than no terminal action | Codex |
