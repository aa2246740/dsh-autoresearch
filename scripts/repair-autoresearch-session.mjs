#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {
  markAutoresearchStateEventsIgnorable,
  repairAutoresearchSessionJsonl,
} from '../lib/types/recovery.js'

function fail(message) {
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function zstd(args, input) {
  return execFileSync('zstd', args, { input, maxBuffer: 1024 * 1024 * 1024 })
}

const inputPath = argument('--input')
const outputPath = argument('--output')
if (!inputPath) {
  fail('usage: repair-autoresearch-session --input <session.jsonl[.zstd]> [--output <candidate>]')
} else if (!existsSync(inputPath)) {
  fail(`input does not exist: ${inputPath}`)
} else if (outputPath && path.resolve(outputPath) === path.resolve(inputPath)) {
  fail('refusing to overwrite the input; write a candidate and validate it first')
} else if (outputPath && existsSync(outputPath)) {
  fail(`output already exists: ${outputPath}`)
} else {
  const compressed = inputPath.endsWith('.zstd')
  const inputBytes = readFileSync(inputPath)
  const raw = compressed ? zstd(['-dc', '--', inputPath]).toString('utf8') : inputBytes.toString('utf8')
  const stateMigration = markAutoresearchStateEventsIgnorable(raw)
  const result = repairAutoresearchSessionJsonl(stateMigration.jsonl)
  let candidateBytes
  if (compressed) {
    const firstNewline = result.jsonl.indexOf('\n')
    if (firstNewline < 0) throw new Error('repaired JSONL has no header boundary')
    const header = Buffer.from(result.jsonl.slice(0, firstNewline + 1))
    const events = Buffer.from(result.jsonl.slice(firstNewline + 1))
    candidateBytes = Buffer.concat([
      zstd(['-q', '-c'], header),
      zstd(['-q', '-c'], events),
    ])
  } else {
    candidateBytes = Buffer.from(result.jsonl)
  }

  if (outputPath) {
    const temp = `${outputPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    writeFileSync(temp, candidateBytes, { flag: 'wx', mode: 0o600 })
    renameSync(temp, outputPath)
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    sessionId: result.sessionId,
    repairs: result.repairs,
    stateEventsMarkedIgnorable: stateMigration.markedEventSeqs,
    inputSha256: createHash('sha256').update(inputBytes).digest('hex'),
    candidateSha256: createHash('sha256').update(candidateBytes).digest('hex'),
    output: outputPath ?? null,
  }, null, 2)}\n`)
}
