import assert from 'node:assert/strict'
import test from 'node:test'
import { evaluatePendingGuard } from '../src/guard.ts'

test('guard allows control help/status/off/clear while a token is pending', () => {
  const pending = { active: true, manualOff: false, pendingResumeToken: 'abc' }
  for (const args of ['', 'help', 'status', 'off', 'clear', 'export']) {
    assert.equal(evaluatePendingGuard({ toolName: 'autoresearch_control', args: { args }, pending }).decision, 'allow', args)
  }
})
