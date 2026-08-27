import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AutoresearchController, inferAutoresearchConfigFromPrompt } from '../src/controller.ts'
import { reconstructJsonlState } from '../src/jsonl.ts'
import { appendHookLogEntryIfConfigured, runHook } from '../src/hooks.ts'
import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from '../src/compaction.ts'
import { sessionFilePath } from '../src/paths.ts'
import { evaluatePendingGuard } from '../src/guard.ts'
import { CONTINUE_MARKER } from '../src/types.ts'
import { buildStartLine, emptyDraft } from '../src/client/store.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function createGitFixture(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-test-'))
  git(cwd, 'init', '-q')
  git(cwd, 'config', 'user.name', 'Autoresearch Test')
  git(cwd, 'config', 'user.email', 'autoresearch@example.invalid')
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'baseline\n')
  git(cwd, 'add', 'target.txt')
  git(cwd, 'commit', '-qm', 'initial')
  return cwd
}

function writeExecutable(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, content)
  fs.chmodSync(filePath, 0o755)
}

test('session paths preserve current-layout precedence over stale legacy peers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-paths-'))
  fs.writeFileSync(path.join(cwd, 'autoresearch.md'), 'legacy')
  assert.equal(sessionFilePath(cwd, 'prompt'), path.join(cwd, 'autoresearch.md'))
  fs.mkdirSync(path.join(cwd, '.auto', 'hooks'), { recursive: true })
  assert.equal(sessionFilePath(cwd, 'prompt'), path.join(cwd, '.auto', 'prompt.md'))
})

test('JSONL reconstruction ignores bad lines and derives segments from config headers', () => {
  const state = reconstructJsonlState([
    JSON.stringify({ type: 'config', name: 'first', metricName: 'score', bestDirection: 'lower' }),
    'not json',
    JSON.stringify({ run: 1, metric: 10, metrics: { latency_ms: 5 }, status: 'keep' }),
    JSON.stringify({ type: 'hook', stage: 'after' }),
    JSON.stringify({ type: 'config', name: 'second', metricName: 'accuracy', bestDirection: 'higher' }),
    JSON.stringify({ run: 2, metric: 0.8, status: 'keep', segment: 99 }),
  ].join('\n'))
  assert.equal(state.name, 'second')
  assert.equal(state.currentSegment, 1)
  assert.deepEqual(state.results.map((run) => run.segment), [0, 1])
})

test('GUI start line stays inert until confirm and encodes budget plus success criterion', () => {
  const line = buildStartLine({
    ...emptyDraft(),
    goal: 'drop errors in score.py',
    success: 'errors = 0',
    maxRuns: '3',
    metricName: 'errors',
    direction: 'lower',
  })
  assert.match(line, /^\/autoresearch /)
  assert.match(line, /成功标准：errors = 0/)
  assert.match(line, /for 3 runs/)
  assert.match(line, /metric errors/)
  assert.doesNotMatch(line, /allowNoGit/)
})

test('natural-language loop controls retain finite and unlimited Pi semantics', () => {
  assert.deepEqual(inferAutoresearchConfigFromPrompt('optimize this for 12 runs'), {
    maxIterations: 12,
    maxAutoResumeTurns: 12,
  })
  assert.deepEqual(inferAutoresearchConfigFromPrompt('continue forever'), {
    maxAutoResumeTurns: null,
    clearMaxIterations: true,
  })
  assert.equal(inferAutoresearchConfigFromPrompt('watch for 5 minutes'), null)
  assert.deepEqual(inferAutoresearchConfigFromPrompt('最多迭代 3 次'), {
    maxIterations: 3,
    maxAutoResumeTurns: 3,
  })
})

test('controller blocks no-Git loops unless allowNoGit is explicit', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-no-git-'))
  const controller = new AutoresearchController({ cwd, dataDir: path.join(cwd, '.private-state') })
  const blocked = await controller.control({ args: 'optimize this' })
  assert.equal(blocked.ok, false)
  assert.match(blocked.text, /requires .*git working tree/i)
  fs.mkdirSync(path.join(cwd, '.auto'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.auto', 'config.json'), '{"allowNoGit":true}\n')
  const allowed = await controller.control({ args: 'optimize this' })
  assert.equal(allowed.ok, true)
  assert.match(allowed.text, /allowNoGit=true/)
  await controller.close()
})

test('status and support routes never activate autoresearch implicitly', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-explicit-'))
  const controller = new AutoresearchController({ cwd, dataDir: path.join(cwd, '.private-state') })
  const status = await controller.control({ args: 'status' })
  assert.equal(status.active, false)
  const finalize = await controller.control({ args: 'finalize' })
  assert.equal(finalize.action, 'finalize')
  assert.equal((await controller.status()).active, false)
  const hooks = await controller.control({ args: 'hooks' })
  assert.equal(hooks.action, 'hooks')
  assert.equal((await controller.status()).active, false)
  await controller.close()
})

test('controller runs, logs, commits, schedules continuation, and stops at max iterations', async () => {
  const cwd = createGitFixture()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-'))
  writeExecutable(path.join(cwd, '.auto', 'measure.sh'), "#!/usr/bin/env bash\nprintf 'METRIC score=10\\nMETRIC latency_ms=5\\n'\n")
  const controller = new AutoresearchController({ cwd, dataDir })

  const started = await controller.control({ args: 'optimize target for 2 runs' })
  assert.equal(started.ok, true)
  assert.equal(started.active, true)
  assert.equal(started.needsSetup, true)

  const initialized = await controller.initExperiment({ name: 'tiny score', metric_name: 'score', metric_unit: '', direction: 'lower' })
  assert.equal(initialized.ok, true)

  const firstRun = await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  assert.equal(firstRun.ok, true)
  assert.equal(firstRun.details.parsedPrimary, 10)
  assert.deepEqual(firstRun.details.parsedMetrics, { score: 10, latency_ms: 5 })

  fs.writeFileSync(path.join(cwd, 'target.txt'), 'candidate one\n')
  const firstLog = await controller.logExperiment({
    commit: git(cwd, 'rev-parse', '--short=7', 'HEAD'),
    metric: 10,
    metrics: { score: 10, latency_ms: 5 },
    status: 'keep',
    description: 'baseline',
    asi: { hypothesis: 'establish baseline' },
  })
  assert.equal(firstLog.ok, true)
  assert.equal(firstLog.resume.shouldSchedule, true)
  assert.ok(firstLog.resume.token)
  assert.equal(firstLog.resume.command, null)
  assert.equal(git(cwd, 'show', 'HEAD:target.txt'), 'candidate one')
  const consumed = controller.consumeResumeToken(firstLog.resume.token)
  assert.match(consumed.text, new RegExp(CONTINUE_MARKER))

  writeExecutable(path.join(cwd, '.auto', 'measure.sh'), "#!/usr/bin/env bash\nprintf 'METRIC score=9\\nMETRIC latency_ms=4\\n'\n")
  const secondRun = await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  assert.equal(secondRun.details.parsedPrimary, 9)
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'candidate two\n')
  const secondLog = await controller.logExperiment({
    commit: git(cwd, 'rev-parse', '--short=7', 'HEAD'),
    metric: 9,
    metrics: { latency_ms: 4 },
    status: 'keep',
    description: 'improve score',
    asi: { hypothesis: 'smaller is faster' },
  })
  assert.equal(secondLog.ok, true)
  assert.equal(secondLog.resume.shouldSchedule, false)
  assert.match(secondLog.text, /Maximum experiments reached/)
  const status = await controller.status()
  assert.equal(status.active, false)
  assert.equal(status.currentSegmentRuns, 2)
  assert.equal(status.bestKeptMetric, 9)
  await controller.close()
})

test('discard restores worktree changes while preserving autoresearch artifacts', async () => {
  const cwd = createGitFixture()
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  await controller.control({ args: 'test one idea' })
  await controller.initExperiment({ name: 'discard', metric_name: 'score' })
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'bad change\n')
  const logged = await controller.logExperiment({
    commit: git(cwd, 'rev-parse', '--short=7', 'HEAD'),
    metric: 99,
    status: 'discard',
    description: 'bad change',
    asi: { hypothesis: 'bad', rollback_reason: 'worse' },
  })
  assert.equal(logged.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'baseline\n')
  assert.equal(fs.existsSync(path.join(cwd, '.auto', 'log.jsonl')), true)
  await controller.close()
})

test('failed correctness checks cannot be kept and are reverted when logged', async () => {
  const cwd = createGitFixture()
  writeExecutable(path.join(cwd, '.auto', 'measure.sh'), "#!/usr/bin/env bash\nprintf 'METRIC score=8\\n'\n")
  writeExecutable(path.join(cwd, '.auto', 'checks.sh'), "#!/usr/bin/env bash\nprintf 'broken invariant\\n' >&2\nexit 1\n")
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  await controller.control({ args: 'test correctness' })
  await controller.initExperiment({ name: 'checks', metric_name: 'score' })
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'invalid candidate\n')
  const run = await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  assert.equal(run.details.checksPass, false)
  const rejectedKeep = await controller.logExperiment({
    metric: 8,
    status: 'keep',
    description: 'invalid candidate',
    asi: { hypothesis: 'break the invariant' },
  })
  assert.equal(rejectedKeep.ok, false)
  assert.match(rejectedKeep.text, /cannot keep/i)
  const logged = await controller.logExperiment({
    metric: 8,
    status: 'checks_failed',
    description: 'invalid candidate',
    asi: { hypothesis: 'break the invariant', rollback_reason: 'checks failed' },
  })
  assert.equal(logged.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'baseline\n')
  assert.equal(git(cwd, 'log', '-1', '--pretty=%s'), 'initial')
  await controller.close()
})

test('large output spills to disk without losing an early METRIC line', async () => {
  const cwd = createGitFixture()
  writeExecutable(path.join(cwd, '.auto', 'measure.sh'), "#!/usr/bin/env bash\nprintf 'METRIC score=7\\n'\nhead -c 100000 /dev/zero | tr '\\0' x\nprintf '\\n'\n")
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  await controller.control({ args: 'large output' })
  await controller.initExperiment({ name: 'large', metric_name: 'score' })
  const run = await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  assert.equal(run.ok, true)
  assert.equal(run.details.parsedPrimary, 7)
  assert.ok(run.details.fullOutputPath)
  assert.ok(fs.statSync(run.details.fullOutputPath).size > 90_000)
  assert.ok(run.text.length < 10_000)
  await controller.close()
})

test('experiment timeout terminates the process and returns a loggable crash result', async () => {
  const cwd = createGitFixture()
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  await controller.control({ args: 'timeout' })
  await controller.initExperiment({ name: 'timeout', metric_name: 'score' })
  const startedAt = Date.now()
  const run = await controller.runExperiment({ command: 'sleep 5', timeout_seconds: 0.05 })
  assert.equal(run.ok, true)
  assert.equal(run.details.timedOut, true)
  assert.equal(run.details.crashed, true)
  assert.ok(Date.now() - startedAt < 2_000)
  await controller.close()
})

test('workingDir keeps config at the workspace root and experiment artifacts in the target', async () => {
  const root = createGitFixture()
  const cwd = path.join(root, 'control')
  const workDir = path.join(root, 'project')
  fs.mkdirSync(path.join(cwd, '.auto'), { recursive: true })
  fs.mkdirSync(workDir, { recursive: true })
  fs.writeFileSync(path.join(cwd, '.auto', 'config.json'), '{"workingDir":"../project"}\n')
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  assert.equal((await controller.control({ args: 'redirected' })).ok, true)
  assert.equal((await controller.initExperiment({ name: 'redirected', metric_name: 'score' })).ok, true)
  assert.equal(fs.existsSync(path.join(workDir, '.auto', 'log.jsonl')), true)
  assert.equal(fs.existsSync(path.join(workDir, '.auto', 'config.json')), false)
  assert.equal(fs.existsSync(path.join(cwd, '.auto', 'config.json')), true)
  await controller.close()
})

test('same-session resume tokens are one-shot and manual off cancels pending work', async () => {
  const cwd = createGitFixture()
  writeExecutable(path.join(cwd, '.auto', 'measure.sh'), "#!/usr/bin/env bash\nprintf 'METRIC score=1\\n'\n")
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  await controller.control({ args: 'optimize for 4 runs' })
  await controller.initExperiment({ name: 'resume', metric_name: 'score' })
  await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  const first = await controller.logExperiment({
    metric: 1,
    status: 'keep',
    description: 'baseline',
    asi: { hypothesis: 'baseline' },
  })
  const pendingStatus = await controller.status()
  assert.equal(pendingStatus.pendingContinuation, true)
  assert.equal(pendingStatus.resume.shouldSchedule, true)
  assert.equal(pendingStatus.resume.token, first.resume.token)
  const blockedRun = await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  assert.equal(blockedRun.ok, false)
  assert.equal(blockedRun.code, 'continuation-pending')
  const output = controller.consumeResumeToken(first.resume.token)
  assert.match(output.text, new RegExp(CONTINUE_MARKER))
  assert.throws(() => controller.consumeResumeToken(first.resume.token))

  await controller.runExperiment({ command: 'bash .auto/measure.sh' })
  const second = await controller.logExperiment({
    metric: 1,
    status: 'keep',
    description: 'repeat',
    asi: { hypothesis: 'repeat' },
  })
  assert.equal(second.resume.shouldSchedule, true)
  await controller.control({ args: 'off' })
  assert.throws(() => controller.consumeResumeToken(second.resume.token))
  const status = await controller.status()
  assert.equal(status.active, false)
  assert.equal(status.pendingContinuation, false)
  await controller.close()
})

test('pending guard blocks same-turn edits until the resume token is consumed', () => {
  const pending = { active: true, manualOff: false, pendingResumeToken: 'one-shot-token' }
  assert.equal(evaluatePendingGuard({ toolName: 'search_replace', pending }).decision, 'deny')
  assert.equal(evaluatePendingGuard({ toolName: 'bash', pending }).decision, 'deny')
  assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_run_experiment', pending }).decision, 'deny')
  assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_control', args: { args: 'off' }, pending }).decision, 'allow')
  assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_status', pending }).decision, 'allow')
  assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_control', args: { args: 'keep going' }, pending }).decision, 'deny')
  assert.equal(evaluatePendingGuard({ toolName: 'bash', pending: null }).decision, 'allow')
})

test('hooks receive JSON stdin, truncate output at 8KB, and append observability', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-hooks-'))
  fs.mkdirSync(path.join(cwd, '.auto'), { recursive: true })
  const logPath = path.join(cwd, '.auto', 'log.jsonl')
  fs.writeFileSync(logPath, `${JSON.stringify({ type: 'config', name: 'hooks' })}\n`)
  writeExecutable(
    path.join(cwd, '.auto', 'hooks', 'before.sh'),
    "#!/usr/bin/env bash\ncat > .auto/hook-payload.json\nhead -c 9000 /dev/zero | tr '\\0' x\n",
  )
  const result = await runHook({
    event: 'before',
    cwd,
    next_run: 2,
    last_run: null,
    session: { metric_name: 'score', metric_unit: '', direction: 'lower', baseline_metric: null, best_metric: null, run_count: 0, goal: 'hooks' },
  })
  assert.equal(result.fired, true)
  assert.match(result.stdout, /truncated/)
  assert.ok(Buffer.byteLength(result.stdout) < 8_500)
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.auto', 'hook-payload.json'), 'utf8')).next_run, 2)
  assert.equal(appendHookLogEntryIfConfigured(logPath, 'before', result), true)
  assert.match(fs.readFileSync(logPath, 'utf8'), /"type":"hook"/)
})

test('compaction summary is deterministic and keeps rules, ideas, and recent state', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-summary-'))
  fs.mkdirSync(path.join(cwd, '.auto'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.auto', 'prompt.md'), '# Rules\nChange one thing.\n')
  fs.writeFileSync(path.join(cwd, '.auto', 'ideas.md'), '- Try caching\n')
  fs.writeFileSync(path.join(cwd, '.auto', 'log.jsonl'), [
    JSON.stringify({ type: 'config', name: 'speed', metricName: 'score', bestDirection: 'lower' }),
    JSON.stringify({ run: 1, metric: 10, status: 'keep', description: 'baseline', asi: { hypothesis: 'measure' } }),
    JSON.stringify({ run: 2, metric: 8, status: 'keep', description: 'cache', asi: { hypothesis: 'cache' } }),
  ].join('\n'))
  const paths = autoresearchSummaryPathsFor(cwd)
  const first = buildAutoresearchCompactionSummary(paths)
  assert.equal(first, buildAutoresearchCompactionSummary(paths))
  assert.match(first, /Goal: speed/)
  assert.match(first, /Best \(#2\): 8 \(-20\.0%\)/)
  assert.match(first, /Change one thing/)
  assert.match(first, /Try caching/)
})

test('snapshot does not activate the loop', async () => {
  const cwd = createGitFixture()
  const controller = new AutoresearchController({ cwd, dataDir: path.join(cwd, '.private-state') })
  const snapshot = controller.snapshot()
  assert.equal(snapshot.active, false)
  assert.equal((await controller.status()).active, false)
  await controller.close()
})

test('host plugin source is a named apply without a default export', () => {
  const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.match(source, /export function apply/)
  assert.match(source, /\[dsh-autoresearch\] loaded/)
  assert.equal(/export\s+default\s+/.test(source), false)
  assert.equal(/append\?\.\(\['"]autoresearch\//.test(source), false)
})
