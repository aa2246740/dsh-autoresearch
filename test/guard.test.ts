import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePendingGuard } from '../src/guard.ts'

test('guard allows read and terminal transitions while a token is pending', () => {
  const pending = { active: true, manualOff: false, pendingResumeToken: 'abc' }
  for (const args of ['', 'help', 'status', 'off', 'complete verified', 'clear', 'export']) {
    assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_control', args: { args }, pending }).decision, 'allow', args)
  }
  assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_finish', args: { outcome: 'complete' }, pending }).decision, 'allow')
})
