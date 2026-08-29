import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { AutoresearchController, inferAutoresearchConfigFromPrompt } from '../src/controller.ts'
import { mutationPathsFromToolCall, protectedPathsFromSession } from '../src/index.ts'
import { reconstructJsonlState } from '../src/jsonl.ts'
import { appendHookLogEntryIfConfigured, runHook } from '../src/hooks.ts'
import { autoresearchSummaryPathsFor, buildAutoresearchCompactionSummary } from '../src/compaction.ts'
import { sessionFilePath } from '../src/paths.ts'
import { evaluatePendingGuard } from '../src/guard.ts'
import { CONTINUE_MARKER, toJsonValue } from '../src/types.ts'
import { foldAutoresearchProjection, preferLedgerSnapshot } from '../src/projection.ts'
import {
  applyCommandText,
  buildStartLine,
  cancelInitDock,
  emptyDraft,
  friendlyStartError,
  getLabState,
  hideAfterConfirm,
  parseRoundBudget,
  resetLab,
  showInitDock,
} from '../src/client/store.ts'
import {
  buildDashboardModel,
  formatNum,
  inspectConversation,
  progressCardKind,
  sampleRun,
} from '../src/client/dashboard.ts'
import type { AutoresearchSnapshot } from '../src/types.ts'

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

function emptySnapshot(overrides: Partial<AutoresearchSnapshot> = {}): AutoresearchSnapshot {
  return {
    cwd: '/tmp',
    workDir: '/tmp',
    active: false,
    manualOff: false,
    needsSetup: true,
    pendingContinuation: false,
    gitOk: true,
    gitError: null,
    allowNoGit: false,
    protectionMode: 'git',
    protectedPathCount: 0,
    name: null,
    metricName: 'metric',
    metricUnit: '',
    direction: 'lower',
    maxIterations: 3,
    maxAutoResumeTurns: 3,
    currentSegmentRuns: 0,
    totalRuns: 0,
    baselineMetric: null,
    bestKeptMetric: null,
    lastStatus: null,
    results: [],
    promptExists: false,
    measureExists: false,
    checksExists: false,
    updatedAt: 1,
    ...overrides,
  }
}

test('opening the init dock does not activate the loop', () => {
  resetLab()
  assert.equal(getLabState().dock, 'hidden')
  showInitDock()
  const lab = getLabState()
  assert.equal(lab.dock, 'init')
  assert.equal(lab.phase, 'configuring')
  assert.equal(lab.snapshot, null)
  cancelInitDock()
  assert.equal(getLabState().dock, 'hidden')
  assert.equal(getLabState().phase, 'idle')
})

test('confirm hides the init card and does not open a progress dock', () => {
  resetLab()
  showInitDock()
  hideAfterConfirm()
  const lab = getLabState()
  assert.equal(lab.dock, 'waiting')
  assert.equal(lab.phase, 'idle')
  assert.notEqual(lab.dock, 'init')
  assert.equal(progressCardKind({ results: lab.snapshot?.results, runningExperiment: false }), 'none')
})

test('GUI start line is only goal plus round budget, sent after confirm', () => {
  const line = buildStartLine({
    ...emptyDraft(),
    goal: 'drop errors in score.py',
    maxRuns: '3',
  })
  assert.equal(line, '/autoresearch drop errors in score.py for 3 runs')
  assert.doesNotMatch(line, /成功标准/)
  assert.doesNotMatch(line, /metric /)
  assert.doesNotMatch(line, /allowNoGit/)
  assert.doesNotMatch(line, /higher is better|lower is better/)
  assert.equal(parseRoundBudget('3'), 3)
  assert.equal(parseRoundBudget('0'), null)
})

test('init draft has no metric, direction, measure, or allowNoGit fields', () => {
  const draft = emptyDraft()
  assert.deepEqual(Object.keys(draft).sort(), ['goal', 'maxRuns'])
  assert.equal('metricName' in draft, false)
  assert.equal('direction' in draft, false)
  assert.equal('allowNoGit' in draft, false)
  assert.equal('success' in draft, false)
  assert.doesNotMatch(JSON.stringify(draft), /gemini|google|minimax-cn|MINIMAXCN/i)
})

test('the beginner start card never exposes internal Git or process errors', () => {
  const message = friendlyStartError(new Error('Could not inspect project (spawnSync git ENOBUFS)'))
  assert.match(message, /自动准备没有完成/)
  assert.doesNotMatch(message, /git|spawn|enobufs|error/i)
})

test('status snapshots do not open a progress dock', () => {
  resetLab()
  applyCommandText(`idle\n\nAUTORESEARCH_STATE_V1 ${JSON.stringify(emptySnapshot({ active: false }))}`)
  assert.equal(getLabState().dock, 'hidden')
  assert.equal(getLabState().snapshot?.active, false)
  applyCommandText(`active\n\nAUTORESEARCH_STATE_V1 ${JSON.stringify(emptySnapshot({ active: true, needsSetup: true }))}`)
  assert.equal(getLabState().dock, 'hidden')
  assert.equal(progressCardKind({ results: [], runningExperiment: false }), 'none')
})

test('progress card kind waits for run then log, not init or confirm', () => {
  assert.equal(progressCardKind({ results: [], runningExperiment: false, hasRunStarted: false }), 'none')
  assert.equal(progressCardKind({ results: [], runningExperiment: true }), 'running')
  assert.equal(progressCardKind({ results: [], hasRunStarted: true }), 'running')
  assert.equal(progressCardKind({
    results: [sampleRun({ run: 1, metric: 10, status: 'keep' })],
    runningExperiment: true,
  }), 'board')
})

test('inspectConversation hides the board until log_experiment, even after init', () => {
  const initOnly = inspectConversation({
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      call: { name: 'autoresearch_init_experiment' },
      meta: { snapshot: emptySnapshot({ name: 'tiny', metricName: 'score', active: true }) },
    }],
  })
  assert.equal(initOnly.kind, 'none')

  const running = inspectConversation({
    runningCalls: [{ name: 'autoresearch_run_experiment', argsRaw: '{"command":"bash .auto/measure.sh"}' }],
    nodes: [{
      kind: 'tool-result',
      call: { name: 'autoresearch_init_experiment' },
      meta: { snapshot: emptySnapshot({ name: 'tiny', metricName: 'score', active: true }) },
    }],
  })
  assert.equal(running.kind, 'running')
  assert.equal(running.runningCommand, 'bash .auto/measure.sh')

  const logged = inspectConversation({
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      call: { name: 'autoresearch_log_experiment' },
      meta: {
        snapshot: emptySnapshot({
          name: 'tiny',
          metricName: 'score',
          results: [
            sampleRun({ run: 1, commit: 'abc1234', metric: 10, status: 'keep', description: 'baseline', metrics: { latency_ms: 5 } }),
            sampleRun({ run: 2, commit: 'def5678', metric: 8, status: 'keep', description: 'faster', metrics: { latency_ms: 4 } }),
            sampleRun({ run: 3, metric: 12, status: 'discard', description: 'worse' }),
          ],
          totalRuns: 3,
          currentSegmentRuns: 3,
          baselineMetric: 10,
          bestKeptMetric: 8,
        }),
      },
    }],
  })
  assert.equal(logged.kind, 'board')
  const board = buildDashboardModel(logged.snapshot!)
  assert.equal(board.title, 'autoresearch: tiny')
  assert.equal(board.runs, 3)
  assert.equal(board.kept, 2)
  assert.equal(board.discarded, 1)
  assert.equal(board.baseline?.value, '10')
  assert.equal(board.progress?.value, '8')
  assert.equal(board.progress?.deltaPct, -20)
  assert.equal(board.progress?.improved, true)
  assert.match(board.rows.map((row) => row.status).join(','), /discard/)
})

test('inspectConversation uses the longest log_experiment snapshot, not the last walked node', () => {
  const first = emptySnapshot({
    name: 'tiny',
    metricName: 'score',
    results: [sampleRun({ run: 1, metric: 10, status: 'keep', description: 'baseline' })],
    updatedAt: 1,
  })
  const later = emptySnapshot({
    name: 'tiny',
    metricName: 'score',
    results: [
      sampleRun({ run: 1, metric: 10, status: 'keep', description: 'baseline' }),
      sampleRun({ run: 2, metric: 8, status: 'keep', description: 'better' }),
      sampleRun({ run: 3, metric: 12, status: 'discard', description: 'worse' }),
    ],
    updatedAt: 2,
  })
  const nestedLater = inspectConversation({
    runningCalls: [],
    nodes: [
      { kind: 'tool-result', call: { name: 'autoresearch_log_experiment' }, meta: { snapshot: first } },
      { kind: 'assistant', blocks: [
        { kind: 'tool-result', call: { name: 'autoresearch_log_experiment' }, meta: { snapshot: later } },
      ] },
    ],
  })
  assert.equal(nestedLater.kind, 'board')
  assert.equal(nestedLater.snapshot?.results.length, 3)
  assert.equal(buildDashboardModel(nestedLater.snapshot!).discarded, 1)

  const shorterChild = inspectConversation({
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      call: { name: 'autoresearch_log_experiment' },
      meta: { snapshot: later },
      extra: { kind: 'tool-result', call: { name: 'autoresearch_log_experiment' }, meta: { snapshot: first } },
    }],
  })
  assert.equal(shorterChild.snapshot?.results.length, 3)
})

test('inspectConversation treats Logged # text as log_experiment when the call head is truncated', () => {
  const later = emptySnapshot({
    name: 'tiny',
    metricName: 'score',
    results: [
      sampleRun({ run: 1, metric: 10, status: 'keep' }),
      sampleRun({ run: 2, metric: 8, status: 'keep' }),
      sampleRun({ run: 3, metric: 12, status: 'discard' }),
    ],
  })
  const seen = inspectConversation({
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      call: null,
      content: [{ type: 'text', text: 'Logged #3: discard - worse' }],
      meta: { snapshot: later },
    }],
  })
  assert.equal(seen.kind, 'board')
  assert.equal(seen.snapshot?.results.length, 3)
  assert.equal(buildDashboardModel(seen.snapshot!).discarded, 1)
})

test('status and init tool results never open the progress board', () => {
  const leftover = emptySnapshot({
    name: 'old',
    metricName: 'score',
    results: [
      sampleRun({ run: 1, metric: 10, status: 'keep' }),
      sampleRun({ run: 2, metric: 12, status: 'discard' }),
    ],
  })
  const statusOnly = inspectConversation({
    runningCalls: [],
    nodes: [{
      kind: 'tool-result',
      call: { name: 'autoresearch_status' },
      meta: { snapshot: leftover },
    }],
  })
  assert.equal(statusOnly.kind, 'none')
  assert.equal(statusOnly.snapshot, null)

  const runWithLeftover = inspectConversation({
    runningCalls: [{ name: 'autoresearch_run_experiment', argsRaw: '{"command":"bash .auto/measure.sh"}' }],
    nodes: [{
      kind: 'tool-result',
      call: { name: 'autoresearch_status' },
      meta: { snapshot: leftover },
    }],
  })
  assert.equal(runWithLeftover.kind, 'running')
  assert.equal(runWithLeftover.snapshot, null)
})

test('projection fold keeps the longer ledger from later tool results', () => {
  const first = emptySnapshot({
    results: [sampleRun({ run: 1, metric: 10, status: 'keep' })],
  })
  const later = emptySnapshot({
    results: [
      sampleRun({ run: 1, metric: 10, status: 'keep' }),
      sampleRun({ run: 2, metric: 8, status: 'keep' }),
      sampleRun({ run: 3, metric: 12, status: 'discard' }),
    ],
  })
  const afterFirst = foldAutoresearchProjection(null, { type: 'tool/result', data: { meta: { snapshot: first } } })
  const afterLater = foldAutoresearchProjection(afterFirst, { type: 'tool/result', data: { meta: { snapshot: later } } })
  assert.equal(afterLater?.results.length, 3)
  const ignoredShrink = foldAutoresearchProjection(afterLater, { type: 'tool/result', data: { meta: { snapshot: first } } })
  assert.equal(ignoredShrink?.results.length, 3)
  assert.equal(ignoredShrink, afterLater)
  assert.equal(preferLedgerSnapshot(first, later)?.results.length, 3)
  assert.equal(preferLedgerSnapshot(null, later), null)
  const namedFirst = emptySnapshot({ name: 'tiny', results: first.results })
  assert.equal(preferLedgerSnapshot(namedFirst, emptySnapshot({ name: 'other', results: later.results }))?.name, 'tiny')
})

test('formatNum glues short units and spaces longer ones', () => {
  assert.equal(formatNum(2, 'ms'), '2ms')
  assert.equal(formatNum(2, 'count'), '2 count')
  assert.equal(formatNum(8.5, ''), '8.50')
})

test('client daily chrome has no experiment chip and init form is goal+rounds', () => {
  const source = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dsh: { client: { inject: string[] } } }
  assert.equal(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'), false)
  assert.equal(/slots\.inject\(\s*['"]sidebar/.test(source), false)
  assert.equal(/slots\.inject\(\s*['"]shell\.sidebar/.test(source), false)
  assert.equal(/slots\.inject\(\s*['"]shell\.footer/.test(source), false)
  assert.equal(/conversation\.input\.left/.test(source), false)
  assert.doesNotMatch(source, /实验循环/)
  assert.doesNotMatch(source, /data-autoresearch="init-entry"/)
  assert.match(source, /conversation\.input\.dock/)
  assert.match(source, /data-autoresearch="init-card"/)
  assert.match(source, /data-autoresearch-field="goal"/)
  assert.match(source, /data-autoresearch-field="rounds"/)
  assert.match(source, /确认并开始/)
  assert.doesNotMatch(source, /data-autoresearch-field="metric"/)
  assert.doesNotMatch(source, /data-autoresearch-field="direction"/)
  const initCard = source.slice(source.indexOf('function InitDockCard'), source.indexOf('function WaitingCard'))
  assert.match(initCard, /确认并开始/)
  assert.match(initCard, /自动开启本地版本保护/)
  assert.match(initCard, /不会上传代码/)
  assert.doesNotMatch(initCard, /主指标/)
  assert.doesNotMatch(initCard, /metricName/)
  assert.doesNotMatch(initCard, /direction/)
  assert.doesNotMatch(initCard, /allowNoGit/)
  assert.doesNotMatch(initCard, /成功标准/)
  assert.doesNotMatch(initCard, /measure\.sh/)
  assert.doesNotMatch(source, /minimax-cn/)
  assert.doesNotMatch(source, /gemini|GEMINI|GOOGLE_API_KEY/i)
  assert.doesNotMatch(source, /selectSessionModel|selectModel/)
})

test('GUI drops overlay, status polling, and STATE_V1 chat dumps', () => {
  const source = fs.readFileSync(new URL('../src/client/index.tsx', import.meta.url), 'utf8')
  const host = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /打开更大视图/)
  assert.doesNotMatch(source, /OverlayRoot/)
  assert.doesNotMatch(source, /Sparkline/)
  assert.doesNotMatch(source, /shell\.overlay/)
  assert.doesNotMatch(source, /id: 'expand'/)
  assert.doesNotMatch(source, /showRunDock/)
  assert.doesNotMatch(source, /setInterval/)
  assert.doesNotMatch(source, /window\.setInterval/)
  assert.doesNotMatch(source, /executeLine\(ctx, sessionId, '\/autoresearch status'\)/)
  assert.match(source, /hideAfterConfirm/)
  assert.match(source, /running…/)
  assert.match(source, /等 agent 在对话里对齐需求/)
  assert.match(source, /data-autoresearch="progress-card"/)
  assert.doesNotMatch(host, /embedState\(/)
  assert.match(host, /presentationMeta/)
  assert.doesNotMatch(host, /AUTORESEARCH_STATE_V1/)
  assert.match(host, /stateSchema/)
  assert.match(host, /viewSchema/)
  assert.match(host, /wire:/)
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

test('controller automatically creates a local Git safety baseline for beginners', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-no-git-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-no-git-state-'))
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'before autoresearch\n')
  const controller = new AutoresearchController({ cwd, dataDir })

  const started = await controller.control({ args: 'optimize this' })
  assert.equal(started.ok, true)
  assert.equal(git(cwd, 'rev-parse', '--is-inside-work-tree'), 'true')
  assert.match(git(cwd, 'log', '-1', '--pretty=%s'), /autoresearch safety baseline/i)
  assert.match(started.text, /本地保护/)

  fs.writeFileSync(path.join(cwd, 'target.txt'), 'candidate\n')
  git(cwd, 'checkout', '--', 'target.txt')
  assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'before autoresearch\n')
  await controller.close()
})

test('empty startup scope stays fast and learns the first edited file before mutation', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-deferred-scope-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-deferred-state-'))
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(cwd, 'project'))
  fs.writeFileSync(path.join(cwd, 'project', 'target.txt'), 'before\n')
  fs.mkdirSync(path.join(cwd, 'large-neighbor'))
  for (let index = 0; index < 2_000; index += 1) {
    fs.writeFileSync(path.join(cwd, 'large-neighbor', `${index}.txt`), 'unrelated\n')
  }

  const controller = new AutoresearchController({ cwd, dataDir })
  const started = await controller.control({ args: 'make the target faster', protectedPaths: [] } as never)
  assert.equal(started.ok, true)
  assert.deepEqual(controller.privateState().protectedPaths, [])
  assert.equal(git(cwd, 'show', '--name-only', '--pretty=format:', 'HEAD'), '')

  const protectedResult = controller.protectPathsBeforeMutation(['project/target.txt'])
  assert.equal(protectedResult.ok, true)
  assert.deepEqual(controller.privateState().protectedPaths, ['project/target.txt'])
  fs.writeFileSync(path.join(cwd, 'project', 'target.txt'), 'candidate\n')
  await controller.initExperiment({ name: 'dynamic scope', metric_name: 'score' })
  const discarded = await controller.logExperiment({ metric: 2, status: 'discard', description: 'worse' })
  assert.equal(discarded.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'project', 'target.txt'), 'utf8'), 'before\n')
  assert.equal(fs.readFileSync(path.join(cwd, 'large-neighbor', '1999.txt'), 'utf8'), 'unrelated\n')
  await controller.close()
})

test('missing Git silently falls back to local snapshots and still restores edits', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-snapshot-fallback-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-snapshot-state-'))
  const emptyPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-empty-path-'))
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(emptyPath, { recursive: true, force: true })
  })
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'before\n')
  const previousPath = process.env.PATH
  process.env.PATH = emptyPath
  try {
    const controller = new AutoresearchController({ cwd, dataDir })
    const started = await controller.control({ args: 'optimize this', protectedPaths: ['target.txt'] } as never)
    assert.equal(started.ok, true)
    assert.equal(started.active, true)
    assert.equal(controller.privateState().protectionMode, 'snapshot')
    assert.doesNotMatch(started.text, /git|enoent|spawn|failed/i)
    assert.match(started.text, /本地保护/)

    fs.writeFileSync(path.join(cwd, 'target.txt'), 'candidate\n')
    await controller.initExperiment({ name: 'snapshot fallback', metric_name: 'score' })
    const discarded = await controller.logExperiment({ metric: 2, status: 'discard', description: 'worse' })
    assert.equal(discarded.ok, true)
    assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'before\n')
    assert.doesNotMatch(discarded.text, /git|enoent|spawn|failed/i)
    await controller.close()
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
})

test('automatic setup protects the session working set without scanning an umbrella workspace', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-umbrella-'))
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-umbrella-state-'))
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  fs.writeFileSync(path.join(cwd, 'ink-particle-wall.html'), 'before autoresearch\n')
  const noiseDir = path.join(cwd, 'unrelated-project')
  fs.mkdirSync(noiseDir)
  const longStem = 'x'.repeat(180)
  for (let index = 0; index < 6_500; index += 1) {
    fs.writeFileSync(path.join(noiseDir, `${String(index).padStart(5, '0')}-${longStem}.txt`), '')
  }

  const controller = new AutoresearchController({ cwd, dataDir })
  const started = await controller.control({
    args: 'optimize the particle wall',
    protectedPaths: ['ink-particle-wall.html'],
  } as never)

  assert.equal(started.ok, true)
  assert.doesNotMatch(started.text, /ENOBUFS/)
  assert.equal(git(cwd, 'show', '--name-only', '--pretty=format:', 'HEAD'), 'ink-particle-wall.html')
  assert.match(git(cwd, 'status', '--porcelain=v1', '--untracked-files=normal'), /unrelated-project\//)

  await controller.initExperiment({ name: 'particle fps', metric_name: 'fps', direction: 'higher' })
  fs.writeFileSync(path.join(cwd, 'ink-particle-wall.html'), 'candidate\n')
  fs.writeFileSync(path.join(noiseDir, 'keep-me.txt'), 'unrelated user work\n')
  const discarded = await controller.logExperiment({ metric: 30, status: 'discard', description: 'slow candidate' })
  assert.equal(discarded.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'ink-particle-wall.html'), 'utf8'), 'before autoresearch\n')
  assert.equal(fs.readFileSync(path.join(noiseDir, 'keep-me.txt'), 'utf8'), 'unrelated user work\n')
  await controller.close()
})

test('session diff metadata selects only files inside the current workspace', () => {
  const cwd = '/workspace'
  const session = {
    events: [
      {
        type: 'tool/call',
        data: {
          name: 'write',
          arguments: JSON.stringify({ file_path: '/workspace/new-benchmark.js' }),
        },
      },
      {
        type: 'tool/result',
        data: {
          message: {
            meta: {
              diffs: [
                { path: '/workspace/ink-particle-wall.html' },
                { path: '/workspace/ink-particle-wall.html' },
                { path: '/somewhere-else/private.txt' },
              ],
            },
          },
        },
      },
    ],
  }
  assert.deepEqual(protectedPathsFromSession(session, cwd), ['new-benchmark.js', 'ink-particle-wall.html'])
})

test('pre-execute mutation path extraction covers edit tools and patch payloads', () => {
  const cwd = '/workspace'
  assert.deepEqual(mutationPathsFromToolCall('edit', { file_path: '/workspace/src/app.ts' }, cwd), ['src/app.ts'])
  assert.deepEqual(mutationPathsFromToolCall('search_replace', { path: 'src/score.ts' }, cwd), ['src/score.ts'])
  assert.deepEqual(mutationPathsFromToolCall('apply_patch', {
    patch: [
      '*** Update File: src/one.ts',
      '*** Add File: src/two.ts',
      '*** Delete File: ../outside.ts',
    ].join('\n'),
  }, cwd), ['src/one.ts', 'src/two.ts'])
  assert.deepEqual(mutationPathsFromToolCall('read', { path: 'src/app.ts' }, cwd), [])
})

test('a newly created file is learned before write and removed on discard', async () => {
  const cwd = createGitFixture()
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  await controller.control({ args: 'try a generated helper for 1 run' })
  await controller.initExperiment({ name: 'new file rollback', metric_name: 'score' })
  const protectedResult = controller.protectPathsBeforeMutation(['src/generated.ts'])
  assert.equal(protectedResult.ok, true)
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true })
  fs.writeFileSync(path.join(cwd, 'src', 'generated.ts'), 'export const candidate = true\n')
  const discarded = await controller.logExperiment({ metric: 9, status: 'discard', description: 'generated helper was slower' })
  assert.equal(discarded.ok, true)
  assert.equal(fs.existsSync(path.join(cwd, 'src', 'generated.ts')), false)
  await controller.close()
})

test('pre-existing dirty work switches to snapshots without committing or changing the index', async () => {
  const cwd = createGitFixture()
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'user work before autoresearch\n')
  fs.writeFileSync(path.join(cwd, 'staged.txt'), 'already staged\n')
  git(cwd, 'add', 'staged.txt')
  const beforeIndex = git(cwd, 'diff', '--cached', '--name-only')
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  const started = await controller.control({ args: 'optimize only target', protectedPaths: ['target.txt'] } as never)
  assert.equal(started.ok, true)
  assert.equal(controller.privateState().protectionMode, 'snapshot')
  assert.equal(git(cwd, 'log', '-1', '--pretty=%s'), 'initial')
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), beforeIndex)
  await controller.initExperiment({ name: 'dirty safety', metric_name: 'score' })
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'bad candidate\n')
  const discarded = await controller.logExperiment({ metric: 99, status: 'discard', description: 'worse' })
  assert.equal(discarded.ok, true)
  assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'user work before autoresearch\n')
  assert.equal(git(cwd, 'diff', '--cached', '--name-only'), beforeIndex)
  await controller.close()
})

test('automatic setup supplies a repository-local identity when Git has none', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-no-identity-'))
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM
  process.env.GIT_CONFIG_GLOBAL = path.join(cwd, 'empty-global-gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  try {
    fs.writeFileSync(path.join(cwd, 'target.txt'), 'baseline\n')
    const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
    const started = await controller.control({ args: 'optimize this' })
    assert.equal(started.ok, true)
    assert.equal(git(cwd, 'config', '--local', '--get', 'user.name'), 'DSH Autoresearch')
    assert.equal(git(cwd, 'config', '--local', '--get', 'user.email'), 'autoresearch@local.invalid')
    await controller.close()
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem
  }
})

test('allowNoGit skips Git but retains automatic snapshot protection', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-allow-no-git-'))
  fs.mkdirSync(path.join(cwd, '.auto'), { recursive: true })
  fs.writeFileSync(path.join(cwd, '.auto', 'config.json'), '{"allowNoGit":true}\n')
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  const started = await controller.control({ args: 'optimize this' })
  assert.equal(started.ok, true)
  assert.match(started.text, /本地保护/)
  assert.equal(controller.privateState().protectionMode, 'snapshot')
  assert.equal(fs.existsSync(path.join(cwd, '.git')), false)
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
  fs.writeFileSync(path.join(cwd, 'target.txt'), 'user work before autoresearch\n')
  fs.writeFileSync(path.join(cwd, 'notes.txt'), 'untracked user note\n')
  const controller = new AutoresearchController({ cwd, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-autoresearch-state-')) })
  const started = await controller.control({ args: 'test one idea' })
  assert.match(started.text, /本地保护/)
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
  assert.equal(fs.readFileSync(path.join(cwd, 'target.txt'), 'utf8'), 'user work before autoresearch\n')
  assert.equal(fs.readFileSync(path.join(cwd, 'notes.txt'), 'utf8'), 'untracked user note\n')
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
  fs.writeFileSync(path.join(workDir, 'candidate.txt'), 'keep me\n')
  const kept = await controller.logExperiment({
    metric: 1,
    status: 'keep',
    description: 'scoped change',
    asi: { hypothesis: 'workingDir is isolated' },
  })
  assert.equal(kept.ok, true)
  assert.equal(fs.existsSync(path.join(workDir, '.auto', 'log.jsonl')), true)
  assert.equal(fs.existsSync(path.join(workDir, '.auto', 'config.json')), false)
  assert.equal(fs.existsSync(path.join(cwd, '.auto', 'config.json')), true)
  assert.equal(git(root, 'ls-files', '--', 'control/.auto/config.json'), '')
  assert.match(git(root, 'status', '--short', '--', 'control/.auto/config.json'), /^\?\? /)
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
  assert.match(source, /toJsonValue/)
})

test('tool payloads drop undefined keys so harness JSON snapshotting succeeds', () => {
  const cleaned = toJsonValue({
    ok: true,
    text: 'Benchmark passed',
    details: { command: 'bash .auto/measure.sh', truncation: undefined, parsedPrimary: 2 },
  })
  assert.deepEqual(cleaned, {
    ok: true,
    text: 'Benchmark passed',
    details: { command: 'bash .auto/measure.sh', parsedPrimary: 2 },
  })
})
