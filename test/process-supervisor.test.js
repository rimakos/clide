const test = require('node:test');
const assert = require('node:assert/strict');
const supervisor = require('../src/main/process-supervisor');

test('persistent process IDs are screen-safe and bounded', () => {
  assert.equal(supervisor.safeId('Task 42 / Billing!'), 'clide-task-42-billing');
  assert.ok(supervisor.safeId('x'.repeat(200)).length <= 60);
});
