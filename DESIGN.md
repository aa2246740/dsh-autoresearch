---
version: alpha
name: Autoresearch Instrument Panel
description: A quiet, outcome-first experiment monitor for beginner users inside the DSH conversation composer.

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

Autoresearch is a compact instrument panel embedded above the DSH composer. Its audience is a beginner who cares about the result, not Git, commits, or internal loop machinery. The visual read is quiet and technical without looking like a terminal: the best result dominates, state and next action are unambiguous, and experiment history remains readable without becoming a spreadsheet.

## Colors

- Host DSH semantic variables are authoritative in the running product; front-matter values are accessible light-theme fallbacks.
- Primary is reserved for the current action. Secondary denotes retained improvements. Tertiary denotes discarded or waiting work. Error is reserved for actual failures.
- State is always written in text as well as color.

## Typography

- Use the host system sans stack for all user-facing copy and mixed Chinese/English descriptions.
- Use tabular figures for metrics, deltas, run numbers, and confidence. Monospace is limited to short commit references and commands.
- Descriptions wrap in full. Do not truncate the experiment explanation or rely on hover for critical meaning.

## Layout

- One framed progress panel, not cards inside cards.
- Reading order: state and goal, baseline-to-best outcome, run health, recent experiment history, current action.
- Desktop history rows use a stable grid. Below 640 px they reflow to metric/status metadata above a full-width description; the page must not scroll horizontally at 320 px.
- Use the 4/8/12/16/24 spacing rhythm. The outcome band may be denser than the history list, but no readable zones may touch.

## Elevation & Depth

- Use the host border and tonal surface to separate the panel. Do not add large soft shadows, glass, gradients, or nested elevated tiles.
- Rows are separated by hairlines and whitespace, not individual containers.

## Shapes

- The outer panel uses `rounded.lg`; controls use `rounded.md`; status chips alone may use `rounded.full` because they encode a compact semantic state.
- Do not turn every count or metric into a pill.

## Components

### Progress panel

- Purpose: show what is running, whether the run ended, the measurable outcome, recent experiments, and the single valid next action.
- Running state: state label `正在优化`; primary action `暂停`.
- Ended state: state label `本轮已结束`; action `关闭结果`. Never show `暂停` after the controller is inactive.
- Dismissal is local to the displayed run. Starting a later goal creates a new run identity and is never suppressed by an earlier dismissal.
- The best metric is the visual focus; baseline, percentage delta, kept/discarded counts, confidence, and commit ids are secondary.

### Experiment row

- Shows run number, localized status, metric, description, and a demoted commit reference when available.
- Status copy: `保留`, `未采用`, `运行失败`, `检查未通过`.
- Rows remain readable with long Chinese descriptions and missing commit ids.

### Action button

- Minimum height is 44 CSS px, with visible keyboard focus and disabled/busy feedback.
- Frequent safe actions are immediate and quiet. Repeated pause clicks are locked while the command is pending.

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
- Latest user override: implement the changes, test them in the formal DSH installation, and keep the workflow beginner-friendly and automatic.
- Deliverable: source, tests, built plugin, formal DSH installation, live verification, and publication to `main`.
- Primary audience: non-technical DSH users who may run several unrelated Autoresearch goals in one project and conversation.
- Core job to be done: understand the current outcome at a glance and safely start, pause, finish, close, then start another research goal without stale state.
- Success criteria: completed cards never show Pause; Close dismisses the ended card; a new goal starts a fresh segment and hides the old one immediately; internal finalize/hooks skills do not appear in user autocomplete; the redesigned panel is readable at desktop and narrow widths.
- Non-goals: redesign the whole DSH shell, expose advanced Git controls, erase the historical `.auto/log.jsonl` ledger, or add decorative motion.
- Must preserve: automatic local protection, existing experiment data, DSH theme compatibility, same-session continuation safety, and current `/autoresearch` entry point.
- Validation must check against: the supplied session event order, controller state after `off -> new goal`, card action by active state, repeated-run identity/dismissal, skill invocation visibility, desktop/narrow rendered states, and formal Host/client activation.

## Content Model

- User intent: see whether the current research improved the project and choose the only sensible next action.
- Message hierarchy: lifecycle state and goal -> best result vs baseline -> run health -> experiment explanations -> action.
- First-screen answers: what goal this is, whether it is still running, what changed, and what the user can do next.
- Primary action meaning: `暂停` stops automatic continuation but preserves results; `关闭结果` only dismisses an already-ended result card.
- Voice and tone: calm, concise, plain Chinese; technical identifiers are secondary evidence.
- Terminology rules: use `本轮`, `保留`, `未采用`, `正在优化`, `本轮已结束`, and `关闭结果`; avoid `paused`, `keep`, `discard`, `commit`, and internal skill names as primary copy.
- State language rules: preparing = `正在准备新目标`; running = `正在优化`; ended = `本轮已结束`; dismissed = no card; a new explicit goal always creates a fresh goal identity.
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
| `design-okf/content/state-language.md` | Give preparing, running, ended, dismissed states distinct copy and recovery | Progress panel and actions | Copy/source assertions and rendered states |
| `design-okf/content/semantic-binding.md` | Use native buttons, accessible names, and wrapping critical descriptions | Progress panel JSX | Rendered UI Audit and source review |
| `design-okf/digital/accessibility-usability.md` | Preserve focus, 44 px actions, textual state parity, and recovery | Buttons and status labels | Keyboard/focus and target-size audit |
| `design-okf/digital/responsive-interaction.md` | Replace the horizontal table with a reflowing history grid | Experiment history | 320/375/768/1280 screenshots and overflow audit |
| `design-okf/systems/typography-system.md` | Use system sans for copy and tabular figures for data | Metric rail and rows | Mixed Chinese/English screenshot review |
| `design-okf/foundations/visual-hierarchy.md` | Make best result the single focal point and demote commit ids | Outcome summary | Critique pass and screenshot review |
| `design-okf/systems/taste-engine.md` | Use a quiet instrument-panel read and reject terminal-table/card-stack defaults | Entire progress panel | Anti-default critique and rendered review |
| `design-okf/foundations/necessary-design-judgment.md` | Remove Pause from ended state and remove commit as a primary column | State action and history | Lifecycle/action tests and Delete Test |
| `design-okf/governance/design-to-code-governance.md` | Trace persistent tokens and component states to this contract | `DESIGN.md` and client implementation | Contract validator and source diff |
| `design-okf/governance/request-integrity.md` | Keep all four user requests in the release gate | Whole change set | Final acceptance matrix |

## Information Architecture

- Core user tasks: read outcome, inspect recent experiments, pause an active loop, close an ended result, start a different goal.
- Page or screen inventory: start card, preparing line, first-run line, running progress panel, ended progress panel, dismissed state.
- Navigation model: `/autoresearch` opens a new-start card; progress stays in the composer dock; Close removes only the visible result.
- Content hierarchy: state/goal, outcome, health summary, history, action.
- Primary CTA rules: exactly one primary state action; no Pause when inactive.

## Taste Signature

- Design read: a quiet scientific instrument for a repeated desktop workflow, not a developer console.
- Necessary judgment: remove the raw table header hierarchy and the invalid Pause action; keep outcome, provenance, and experiment explanations.
- Taste dials: visual variance 3, information density 7, motion depth 1, brand distinction 4, type expressiveness 2, experiment risk 2.
- Category defaults avoided: gray terminal slab, nested cards, generic KPI chip grid, decorative gradient, and equal emphasis on every datum.
- Layout families: outcome rail plus editorial experiment list.
- Visual memory feature: the baseline-to-best outcome line paired with a calm lifecycle badge.
- Type personality: utility-first system sans; tabular numerals provide precision while Chinese explanations stay humane.
- Asset/reference policy: use only actual experiment data; no illustrative or fake product assets.
- Anti-default locks: no glass, no gradient, no huge shadow, no monospaced body copy, no horizontal data table on mobile.
- Intentional exceptions: semantic state badges are allowed because they communicate lifecycle, not decoration.

## Quality Gates

- Request Anchor fit: all four requested changes are independently tested.
- Visual: best result is primary; descriptions scan cleanly; no generic table/card-stack appearance.
- Accessibility: semantic buttons, visible focus, textual state, named close/pause action, >=44 px action height.
- Responsive: no page-level horizontal overflow at 320 px; history reflows without losing descriptions.
- Interaction: pause is locked while pending; ended result closes locally; a new goal is not hidden by an old dismissal.
- Motion: static-first; spinner stops under reduced motion.
- Performance: no polling or new persistent client timer.
- I18n/legal: mixed Chinese/English wraps; numbers use tabular figures; no external assets or claims.
- Contract consistency: implementation values and state copy match this file.

## Implementation And Governance

- CSS architecture: component-local React styles plus one scoped responsive/focus style block; DSH semantic variables remain runtime truth.
- Token implementation: constants map to the front-matter roles and host aliases.
- Component naming: `ProgressCard` with named outcome, history, and state-action zones.
- State naming: preparing, running, ended, dismissed, and superseded-by-new-goal.
- Theme strategy: inherit DSH semantic variables with accessible light fallbacks.
- Dark mode: provided by host variables; no fixed white text assumptions.
- Framework notes: React 18 client bundle through DSHX external client bundling.
- Performance budget: no polling; render at most six recent rows.
- Visual regression: deterministic fixture screenshots at key lifecycle and viewport states.
- Rendered UI Audit: sparse `data-ud-check` zones for header, outcome, history, and action.
- Accessibility testing: browser name/target/overflow checks plus source-level semantic assertions.
- CI checks: package tests, typecheck, build, DSHX check, and contract validation.

## Assumptions

- An inactive controller with at least one logged result is truthfully `本轮已结束`; only the Agent or user can decide whether the target was semantically achieved.
- Existing DSH semantic variables provide sufficient dark-theme contrast.
- Historical rows remain in `.auto/log.jsonl`; the UI scopes them by the current experiment segment.

## Open Questions

- A future version may add an explicit model-side `complete` outcome distinct from manual stop; it is not required to fix the current false Pause action.

## Review Log

| Version | Date | Change | Reason | Reviewer |
|---|---|---|---|---|
| 0.1 | 2026-08-30 | Initial contract for lifecycle and progress-card redesign | User reported stale state, invalid action, repeat-run failure, and internal-skill exposure | Codex |
| 0.2 | 2026-08-30 | Accepted outcome-first card in running/ended states at 1180 px and 390 px | Pinned Playwright found four semantic zones, zero overflow/errors, 44 px actions, visible focus, and correct lifecycle copy | Codex |
