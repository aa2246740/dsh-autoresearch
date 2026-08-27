import fs from 'node:fs'
import path from 'node:path'

import { reconstructJsonlState } from './jsonl.js'
import { sessionFilePath } from './paths.js'

const RECENT_RUN_LIMIT = 50

function read(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function metric(value: number): string {
  if (!Number.isFinite(value)) return '-'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

function delta(value: number, baseline: number | null | undefined): string {
  if (!baseline || value === baseline) return ''
  const percent = ((value - baseline) / baseline) * 100
  return ` (${percent > 0 ? '+' : ''}${percent.toFixed(1)}%)`
}

function relative(workDir: string, filePath: string): string {
  const result = path.relative(workDir, filePath)
  return !result || result.startsWith('..') || path.isAbsolute(result) ? filePath : result
}

export function autoresearchSummaryPathsFor(workDir: string): {
  workDir: string
  jsonlPath: string
  mdPath: string
  ideasPath: string
} {
  return {
    workDir,
    jsonlPath: sessionFilePath(workDir, 'log'),
    mdPath: sessionFilePath(workDir, 'prompt'),
    ideasPath: sessionFilePath(workDir, 'ideas'),
  }
}

export function buildAutoresearchCompactionSummary(paths: {
  workDir: string
  jsonlPath: string
  mdPath: string
  ideasPath: string
}): string {
  const state = reconstructJsonlState(read(paths.jsonlPath))
  const current = state.results.filter((run) => run.segment === state.currentSegment)
  const baseline = current[0] ?? null
  const kept = current.filter((run) => run.status === 'keep' && Number.isFinite(run.metric))
  const best = kept.reduce((winner, run) => {
    if (!winner) return run
    const better = state.bestDirection === 'lower' ? run.metric < winner.metric : run.metric > winner.metric
    return better ? run : winner
  }, null as typeof kept[number] | null)
  const counts = Object.fromEntries(['keep', 'discard', 'crash', 'checks_failed'].map((key) => [key, 0])) as Record<string, number>
  for (const run of current) counts[run.status] += 1

  const sections = [
    [
      '# Autoresearch Compaction Summary',
      '',
      'Conversation history was compacted. Persisted autoresearch artifacts below are the source of truth.',
    ].join('\n'),
    [
      '## Session',
      '',
      `Goal: ${state.name ?? '-'}`,
      `Metric: ${state.metricName} - ${state.bestDirection} is better`,
      `Runs so far: ${current.length} (${Object.entries(counts).filter(([, count]) => count).map(([name, count]) => `${count} ${name}`).join('; ') || 'none'})`,
      ...(baseline ? [`Baseline (#${baseline.run}): ${metric(baseline.metric)}${state.metricUnit}`] : []),
      ...(best && best.run !== baseline?.run ? [`Best (#${best.run}): ${metric(best.metric)}${state.metricUnit}${delta(best.metric, baseline.metric)}`] : []),
    ].join('\n'),
  ]

  const rules = read(paths.mdPath).trim()
  if (rules) sections.push(`## Experiment Rules (${relative(paths.workDir, paths.mdPath)})\n\n${rules}`)
  const ideas = read(paths.ideasPath).trim()
  if (ideas) sections.push(`## Ideas Backlog (${relative(paths.workDir, paths.ideasPath)})\n\n${ideas}`)

  const recent = state.results.slice(-RECENT_RUN_LIMIT)
  sections.push(recent.length === 0
    ? '## Recent Runs\n\nNo runs yet - start with the first hypothesis.'
    : [
        `## Recent Runs (last ${recent.length})`,
        '',
        ...recent.map((run) => {
          const segmentBaseline = state.results.find((other) => other.segment === run.segment)?.metric ?? null
          const asi = run.asi ?? {}
          return [
            `#${run.run} ${run.status.padEnd(13)} ${metric(run.metric)}${delta(run.metric, segmentBaseline)}`,
            run.description ? `desc: ${run.description}` : '',
            typeof asi.hypothesis === 'string' ? `hyp: ${asi.hypothesis}` : '',
            typeof asi.next_action_hint === 'string' ? `next: ${asi.next_action_hint}` : '',
            typeof asi.rollback_reason === 'string' ? `rollback: ${asi.rollback_reason}` : '',
          ].filter(Boolean).join(' | ')
        }),
        '',
        `Read ${relative(paths.workDir, paths.jsonlPath)} for full history.`,
      ].join('\n'))

  sections.push([
    '## Next Step',
    '',
    'Choose the most promising remaining hypothesis, run it with autoresearch_run_experiment, and always record it with autoresearch_log_experiment.',
  ].join('\n'))
  return sections.join('\n\n')
}
