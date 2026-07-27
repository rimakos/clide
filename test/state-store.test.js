const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateStore } = require('../src/main/state-store');

test('state store persists tasks transactionally', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-store-'));
  const file = path.join(dir, 'state.db');
  const first = new StateStore(file);
  const task = first.upsertTask({ title: 'Task A', provider: 'claude', repoRoot: '/repo' });
  first.patchTask(task.id, { state: 'done' });
  const second = new StateStore(file);
  assert.equal(second.listTasks('/repo')[0].state, 'done');
});

test('two store clients do not overwrite each other', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-store-concurrent-'));
  const file = path.join(dir, 'state.db');
  const first = new StateStore(file); const second = new StateStore(file);
  const task = first.upsertTask({ title: 'Shared task', provider: 'claude', repoRoot: '/repo' });
  second.patchTask(task.id, { findings: [{ body: 'from MCP' }] });
  first.patchTask(task.id, { messages: [{ body: 'from UI' }] });
  const final = first.snapshot().tasks[task.id];
  assert.equal(final.findings[0].body, 'from MCP');
  assert.equal(final.messages[0].body, 'from UI');
});

test('dispatch transitions are atomic and audited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-dispatch-store-'));
  const file = path.join(dir, 'state.db');
  const first = new StateStore(file); const second = new StateStore(file);
  const task = first.upsertTask({ title: 'Durable worker', repoRoot: '/repo', dispatch: { stage: 'worktree-created' } });
  const claimed = first.transitionDispatch(task.id, { expected: 'worktree-created', to: 'setup-running', actor: 'renderer:a' });
  assert.equal(claimed.ok, true);
  const stale = second.transitionDispatch(task.id, { expected: 'worktree-created', to: 'launching', actor: 'renderer:b' });
  assert.equal(stale.conflict, true);
  const final = second.snapshot().tasks[task.id];
  assert.equal(final.dispatch.stage, 'setup-running');
  assert.equal(final.audit.at(-1).from, 'worktree-created');
  assert.equal(final.audit.at(-1).to, 'setup-running');
});

test('concurrent list appends never drop an entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-store-append-'));
  const file = path.join(dir, 'state.db');
  const first = new StateStore(file); const second = new StateStore(file);
  const task = first.upsertTask({ title: 'Shared task', repoRoot: '/repo' });
  first.appendTaskLists(task.id, { findings: [{ body: 'one' }] });
  second.appendTaskLists(task.id, { findings: [{ body: 'two' }] });
  first.appendTaskLists(task.id, { findings: [{ body: 'three' }] });
  assert.deepEqual(second.snapshot().tasks[task.id].findings.map(item => item.body), ['one', 'two', 'three']);
});

test('cached state picks up writes from another process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-store-fresh-'));
  const file = path.join(dir, 'state.db');
  const reader = new StateStore(file); const writer = new StateStore(file);
  const task = writer.upsertTask({ title: 'Shared task', repoRoot: '/repo' });
  assert.equal(reader.state.tasks[task.id].state, 'draft');
  writer.patchTask(task.id, { state: 'running' });
  assert.equal(reader.state.tasks[task.id].state, 'running');
  writer.setSetting('maxConcurrentWorkers', 3);
  assert.equal(reader.state.settings.maxConcurrentWorkers, 3);
});

test('state store protects its directory and database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-permissions-'));
  const home = path.join(dir, 'private'); const file = path.join(home, 'state.db');
  const db = new StateStore(file); db.close();
  assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
