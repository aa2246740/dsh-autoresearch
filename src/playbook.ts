import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

function readSkill(name: string): string {
  try {
    return readFileSync(join(here, '..', 'skills', name, 'SKILL.md'), 'utf8')
  } catch {
    return ''
  }
}

export const CREATE_PLAYBOOK = `Autoresearch is active for this session. Ordinary chat must not start a new loop.

Before doing anything, call autoresearch_status. If it is inactive, stop.

Tools:
- autoresearch_init_experiment — configure name, metric_name, metric_unit, direction. Call again for a new baseline.
- autoresearch_run_experiment — run the stable benchmark, parse METRIC lines, run optional .auto/checks.sh.
- autoresearch_log_experiment — record one run. keep commits; discard/crash/checks_failed revert code but preserve .auto/. Always include asi.hypothesis; on discard/crash/checks_failed also include asi.rollback_reason and asi.next_action_hint.
- autoresearch_compaction_summary — rebuild context from the ledger after compaction.

Session files live in .auto/: prompt.md, measure.sh (emits METRIC name=number), log.jsonl, optional ideas.md, checks.sh, config.json, hooks/before.sh, hooks/after.sh.

Loop rules:
1. Change one coherent variable per run.
2. Primary metric decides keep vs discard. Secondary metrics are guardrails.
3. Never invent a result. Never manually commit or revert — log_experiment owns local protection.
4. Modify source through file edit/write tools, not shell redirection, sed -i, rm, or generated overwrite commands. The pre-execute hook snapshots each file before its first mutation. Bash is for inspection, builds, tests, and benchmarks.
5. After every run, always call autoresearch_log_experiment.
6. Continue until a tool reports a limit, the user runs /autoresearch off, the work is blocked, or the user interrupts.
7. When the host follows up after a logged run, call autoresearch_status, then run the next experiment.

If setup is incomplete, inspect the project, write .auto/prompt.md and a deterministic .auto/measure.sh, then init_experiment and log a baseline.`

export const CONTINUE_PLAYBOOK = `${CREATE_PLAYBOOK}

AUTORESEARCH_CONTINUE. The previous experiment is already logged. Call autoresearch_status, re-read .auto/prompt.md and .auto/ideas.md if needed, then perform the next experiment.`

export function skillBodies(): { create: string; finalize: string; hooks: string } {
  return {
    create: readSkill('autoresearch-create') || CREATE_PLAYBOOK,
    finalize: readSkill('autoresearch-finalize'),
    hooks: readSkill('autoresearch-hooks'),
  }
}
