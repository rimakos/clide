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
