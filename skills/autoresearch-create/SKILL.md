---
name: autoresearch-create
description: Supporting setup playbook for an explicitly activated /autoresearch loop in DeepSeek Harness. Never activates autoresearch by itself; first verify autoresearch_status is active.
user-invocable: false
---

# Autoresearch

Autonomous experiment loop: try ideas, keep what works, discard what doesn't, and continue within configured limits.

Before doing anything, call `autoresearch_status`. If it is inactive, stop and tell the user to invoke `/autoresearch <goal>` explicitly. Never activate the loop from an ordinary prompt.

## Tools

- **`autoresearch_init_experiment`** — configure session (name, metric, unit, direction). Call again to re-initialize with a new baseline when the optimization target changes.
- **`autoresearch_run_experiment`** — runs a command, times it, captures output, and parses metrics.
- **`autoresearch_log_experiment`** — records a result and atomically requires `next_action=continue|complete|needs_user` plus an evidence-based `decision_reason`. `needs_user` also requires the exact `user_question`. `keep` advances the local protection point; `discard`/`crash`/`checks_failed` restore protected code while preserving autoresearch files.
- **`autoresearch_finish`** — closes the durable loop after later read-only verification, or pauses it for a user decision. Call it before claiming completion when no new experiment is being logged.
- **`the optional hint tool (disabled by default)`** — optional advisory side-model hint, available only when the user explicitly enables it in config.

## Session files

All session files live in a single `.auto/` subfolder at the working directory root. This keeps everything in one place — easy to preserve across reverts, gitignore, and clean up.

| File | Purpose |
|------|---------|
| `.auto/prompt.md` | Experiment prompt / playbook (heart of the session) |
| `.auto/measure.sh` | Benchmark script — emits `METRIC name=value` lines |
| `.auto/log.jsonl` | Append-only result log (written by the tools) |
| `.auto/ideas.md` | Ideas backlog (optional) |
| `.auto/checks.sh` | Correctness checks (optional) |
| `.auto/config.json` | Session config (optional) |
| `.auto/hooks/{before,after}.sh` | Lifecycle hooks (optional) |

> Always create files in the `.auto/` layout. Legacy flat `autoresearch.*` files are still read for in-flight sessions, but new sessions should use `.auto/`.

## Setup

1. Ask (or infer): **Goal**, **Command**, **Metric** (+ direction), **Files in scope**, **Constraints**.
2. Treat local protection as already handled by `/autoresearch`: the controller uses the current repository when that is safe, creates local protection when needed, and silently falls back to private file snapshots if Git is missing, busy, dirty, or unavailable. Never ask a beginner to run Git commands and never expose an internal Git error. Only ask the user to choose a concrete project folder when the folder itself is missing or a special path cannot be protected automatically.
3. Read the source files. Understand the workload deeply before writing anything.
4. Create `.auto/prompt.md` and `.auto/measure.sh` with file write/edit tools (see below). Do not create a branch or commit manually.
5. Modify source through file write/edit tools so the pre-execute hook can save each file before its first mutation. Do not modify source with shell redirection, `sed -i`, `rm`, or generated overwrite commands; use Bash only for read-only inspection, builds, tests, and benchmarks.
6. `autoresearch_init_experiment` -> run baseline -> `autoresearch_log_experiment` with `next_action=continue` -> start looping immediately.

### `.auto/prompt.md`

This is the heart of the session. A fresh agent with no context should be able to read this file and run the loop effectively. Invest time making it excellent.

```markdown
# Autoresearch: <goal>

## Objective
<Specific description of what we're optimizing and the workload.>

## Metrics
- **Primary**: <name> (<unit>, lower/higher is better) — the optimization target
- **Secondary**: <name>, <name>, ... — independent tradeoff monitors

## How to Run
`./.auto/measure.sh` — outputs `METRIC name=number` lines.

## Files in Scope
<Every file the agent may modify, with a brief note on what it does.>

## Off Limits
<What must NOT be touched.>

## Constraints
<Hard rules: tests must pass, no new deps, etc.>

## What's Been Tried
<Update this section as experiments accumulate. Note key wins, dead ends,
and architectural insights so the agent doesn't repeat failed approaches.>
```

Update `.auto/prompt.md` periodically — especially the "What's Been Tried" section — so resuming agents have full context.

### `.auto/measure.sh`

Bash script (`set -euo pipefail`) that: pre-checks fast (syntax errors in <1s), runs the benchmark, and outputs structured lines to stdout. Keep the script fast — every second is multiplied by hundreds of runs.

**For fast, noisy benchmarks** (< 5s), run the workload multiple times inside the script and report the median. This produces stable data points and makes the confidence score reliable from the start. Slow workloads (ML training, large builds) don't need this — single runs are fine.

#### Structured output

- `METRIC name=value` — primary metric (must match `autoresearch_init_experiment`'s `metric_name`) and any secondary metrics. Parsed automatically by `autoresearch_run_experiment`.

#### Design the script to inform optimization

The script should output **whatever data helps you make better decisions in the next iteration.** Think about what you'll need to see after each run to know where to focus:

- Phase timings when the workload has distinct stages
- Error counts, failure categories, or test names when checks can fail in different ways
- Memory usage, cache hit rates, or other runtime diagnostics when relevant
- Anything domain-specific that would help localize regressions or identify bottlenecks

The script runs the same code every iteration — but you can **update it during the loop** if you discover you need more signal. Add instrumentation as you learn what matters.

#### Agent-supplied ASI via `autoresearch_log_experiment`

Use `autoresearch_log_experiment`'s `asi` parameter to annotate each run with **whatever would help the next iteration make a better decision.** Free-form key/value pairs — you decide what's worth recording. Don't repeat the description or raw output; capture what you'd lose after a context reset.

Every log must also make exactly one durable lifecycle decision: `continue` when another safe experiment has positive value, `complete` when the explicit goal and guardrails are verified, or `needs_user` when further progress requires a product/tradeoff choice. Never encode this decision only in prose.

**Annotate failures and crashes heavily.** Discarded and crashed runs are reverted — the code changes are gone. The only record that survives is the description and ASI in `.auto/log.jsonl`. If you don't capture what you tried and why it failed, future iterations will waste time re-discovering the same dead ends.

### `.auto/config.json` (optional)

JSON config file that lives in `.auto/` under the Grok workspace root. Supported fields:

- **`maxIterations`** (number) — maximum experiments before auto-stopping.
- **`maxAutoResumeTurns`** (number or null) — maximum automatic resume prompts before the safety valve stops the loop. Defaults to 20. Set to `null` or `0` for intentional unlimited auto-resume.
- **`workingDir`** (string) — override the directory for all autoresearch operations: file I/O (`.auto/log.jsonl`, `.auto/prompt.md`, `.auto/measure.sh`, `.auto/checks.sh`, `.auto/ideas.md`), command execution, and git operations. Supports absolute paths or relative paths (resolved against `ctx.cwd`). The config file itself always stays under `ctx.cwd`. Fails if the directory doesn't exist.
- **`allowNoGit`** (boolean) — advanced compatibility switch. It skips Git integration but keeps private local snapshot protection. Normal users never need to set it.
- **`hints`** (object) — optional side-model hint config. Do not create this by default. Only add it when the user explicitly wants `the optional hint tool (disabled by default)` to call a configured model for advisory strategy help.

```json
{
  "workingDir": "/path/to/project",
  "maxIterations": 50,
  "maxAutoResumeTurns": 50,
  "allowNoGit": false
}
```

The `/autoresearch` command also understands common natural-language loop controls and writes this config automatically. Phrases like “for 50 runs” set `maxIterations` and the auto-resume budget; phrases like “run forever”, “continue indefinitely”, or “never stop” set unlimited auto-resume and remove the experiment cap.

When the user explicitly wants the hint tool, add:

```json
{
  "hints": {
    "enabled": true,
    "provider": "xai",
    "model": "grok-4.5",
    "thinkingLevel": "high",
    "maxRecentRuns": 8,
    "maxCallsPerSession": 5,
    "timeoutSeconds": 120
  }
}
```

### `.auto/checks.sh` (optional)

Bash script (`set -euo pipefail`) for backpressure/correctness checks: tests, types, lint, etc. **Only create this file when the user's constraints require correctness validation** (e.g., "tests must pass", "types must check").

When this file exists:
- Runs automatically after every **passing** benchmark in `autoresearch_run_experiment`.
- If checks fail, `autoresearch_run_experiment` reports it clearly — log as `checks_failed`.
- Its execution time does **NOT** affect the primary metric.
- You cannot `keep` a result when checks have failed.
- Has a separate timeout (default 300s, configurable via `checks_timeout_seconds`).

When this file does **not** exist, everything behaves exactly as before — no changes to the loop.

**Keep output minimal.** Only the last 80 lines of checks output are fed back to the agent on failure. Suppress verbose progress/success output and let only errors through. This keeps context lean and helps the agent pinpoint what broke.

```bash
#!/bin/bash
set -euo pipefail
# Example: run tests and typecheck — suppress success output, only show errors
pnpm test --run --reporter=dot 2>&1 | tail -50
pnpm typecheck 2>&1 | grep -i error || true
```

## Loop Rules

**RUN AUTONOMOUSLY, END TRUTHFULLY.** Do not ask routine “should I continue?” questions, but do not leave the controller active after the verified goal is complete.

- **Primary metric is king.** Improved → `keep`. Worse/equal → `discard`. Secondary metrics rarely affect this.
- **Annotate every run with `asi`.** Record what you learned — not what you did. What would help the next iteration or a fresh agent resuming this session?
- **Watch the confidence score.** After 3+ runs, `autoresearch_log_experiment` reports a confidence score (best improvement as a multiple of the session noise floor). >=2.0x means the improvement is likely real. <1.0x means it is within noise; consider re-running to confirm before keeping. The score is advisory and never auto-discards.
- **Simpler is better.** Removing code for equal perf = keep. Ugly complexity for tiny gain = probably discard.
- **Don't thrash.** Repeatedly reverting the same idea? Try something structurally different.
- **Crashes:** fix if trivial, otherwise log and move on. Don't over-invest.
- **Think longer when stuck.** Re-read source files, study the profiling data, reason about what the CPU is actually doing. The best ideas come from deep understanding, not from trying random variations.
- **Resuming:** if `.auto/prompt.md` exists, read it and `.auto/log.jsonl`, then continue looping. Git knowledge is never required.
- **Completion is structured:** use `next_action=complete` in the final log. If completion becomes clear after later verification, call `autoresearch_finish(outcome=complete)` before the final answer.
- **User decisions are explicit:** use `next_action=needs_user` or `autoresearch_finish(outcome=needs_user)`, ask the exact `user_question` through the host decision UI, and stop automatic work until the answer arrives.

Keep going while the loop state is active and another safe experiment has value. Stop automatically on `completed`, `awaiting_user`, configured limits, blockers, or user interruption.

## Ideas Backlog

When you discover complex but promising optimizations that you won't pursue right now, **append them as bullets to `.auto/ideas.md`**. Don't let good ideas get lost.

On resume (context limit, crash), check `.auto/ideas.md` — prune stale/tried entries, experiment with the rest. When all paths are exhausted, delete the file and write a final summary.

## User Messages During Experiments

If the user sends a message while an experiment is running, finish the current `autoresearch_run_experiment` + `autoresearch_log_experiment` cycle first, then incorporate their feedback in the next iteration. Do not abandon a running experiment unless the user explicitly asks to stop.
