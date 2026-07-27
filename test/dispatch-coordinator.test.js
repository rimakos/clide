const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateStore } = require('../src/main/state-store');
const { DispatchCoordinator } = require('../src/main/dispatch-coordinator');

function fixture(input = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-coordinator-'));
  const store = new StateStore(path.join(dir, 'state.db'));
  const task = store.upsertTask({ title: 'Worker', repoRoot: '/repo', worktree: '/repo-worker', dispatch: { stage: 'worktree-created' }, ...input });
  return { store, task, coordinator: new DispatchCoordinator(store, { leaseMs: 60_000 }) };
}

test('coordinator claims setup before launch', () => {
  const { task, coordinator } = fixture({ setupCommand: 'npm install' });
  const claim = coordinator.claim(task.id, 'renderer:a');
  assert.equal(claim.ok, true);
  assert.equal(claim.action, 'setup');
  assert.equal(claim.task.dispatch.stage, 'setup-running');
});

test('coordinator blocks and later releases dependencies', () => {
  const { store, task, coordinator } = fixture();
  const dependency = store.upsertTask({ title: 'Dependency', repoRoot: '/repo', state: 'running' });
  store.patchTask(task.id, { dependencies: [dependency.id] });
  const blocked = coordinator.claim(task.id, 'renderer:a');
  assert.equal(blocked.action, 'wait');
  store.patchTask(dependency.id, { state: 'done' });
  const released = coordinator.claim(task.id, 'renderer:a');
  assert.equal(released.action, 'launch');
  assert.equal(released.task.dispatch.stage, 'launching');
});

test('coordinator lease prevents concurrent renderer claims', () => {
  const { task, coordinator } = fixture();
  const first = coordinator.claim(task.id, 'renderer:a');
  const second = coordinator.claim(task.id, 'renderer:b');
  assert.equal(first.ok, true);
  assert.equal(second.busy, true);
});

test('coordinator releases abandoned renderer leases for immediate recovery', () => {
  const { task, coordinator } = fixture();
  const first = coordinator.claim(task.id, 'renderer:old');
  assert.equal(first.ok, true);
  assert.equal(coordinator.claim(task.id, 'renderer:new').busy, true);
  assert.equal(coordinator.releaseLeases('renderer:').length, 1);
  assert.equal(coordinator.claim(task.id, 'renderer:new').ok, true);
});

test('coordinator preserves an explicit cleared lease at terminal handoff', () => {
  const { task, coordinator } = fixture({
    dispatch: {
      stage: 'prompt-delivered',
      leaseId: 'lease-a',
      leaseOwner: 'renderer:a',
      leaseExpiresAt: '2999-01-01T00:00:00.000Z'
    }
  });
  const result = coordinator.transition(task.id, {
    expected: 'prompt-delivered',
    to: 'running',
    leaseId: 'lease-a',
    patch: { leaseId: '', leaseOwner: '', leaseExpiresAt: '' }
  });
  assert.equal(result.ok, true);
  assert.equal(result.task.dispatch.leaseId, '');
  assert.equal(result.task.dispatch.leaseOwner, '');
  assert.equal(result.task.dispatch.leaseExpiresAt, '');
});

test('coordinator resolves ticket dependencies and rejects cycles', () => {
  const { store, task, coordinator } = fixture();
  const dependency = store.upsertTask({ title: 'Foundation', ticket: 'KAN-1', repoRoot: '/repo' });
  assert.deepEqual(coordinator.resolveDependencies(['KAN-1'], '/repo'), [dependency.id]);
  store.patchTask(dependency.id, { dependencies: [task.id] });
  assert.throws(() => coordinator.assertNoCycle(task.id, [dependency.id]), /cycle/i);
});

test('coordinator waits when workspace worker capacity is full', () => {
  const { store, task, coordinator } = fixture();
  store.setSetting('maxConcurrentWorkers', 1);
  store.upsertTask({ title: 'Active', repoRoot: '/repo', state: 'running', dispatch: { stage: 'running' } });
  const claim = coordinator.claim(task.id, 'renderer:a');
  assert.equal(claim.action, 'wait');
  assert.equal(claim.task.dispatch.stage, 'waiting-capacity');
  assert.equal(claim.capacity.limit, 1);
});
