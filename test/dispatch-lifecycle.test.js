const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDispatch, canTransition, leaseExpired, isRecoverable } = require('../src/shared/dispatch-lifecycle');

test('dispatch lifecycle validates forward and recovery transitions', () => {
  assert.equal(canTransition('worktree-created', 'setup-running'), true);
  assert.equal(canTransition('setup-running', 'requested'), false);
  assert.equal(canTransition('failed', 'launching'), true);
});

test('dispatch normalization is explicit and legacy-safe', () => {
  assert.equal(normalizeDispatch(null), null);
  const dispatch = normalizeDispatch({ stage: 'worktree-created', attempt: 2 });
  assert.equal(dispatch.stage, 'worktree-created');
  assert.equal(dispatch.attempt, 2);
  assert.equal(isRecoverable(dispatch), true);
});

test('dispatch leases expire deterministically', () => {
  assert.equal(leaseExpired({ leaseId: 'a', leaseExpiresAt: '2020-01-01T00:00:00.000Z' }, Date.now()), true);
  assert.equal(leaseExpired({ leaseId: 'a', leaseExpiresAt: '2999-01-01T00:00:00.000Z' }, Date.now()), false);
});
