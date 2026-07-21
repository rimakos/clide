const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { taskSlug, normalizeTask, isWithin, validHttpUrl } = require('../src/shared/validation');

test('task slugs are safe and bounded', () => {
  assert.equal(taskSlug(' KAN-42 / Add Billing! '), 'kan-42-add-billing');
  assert.ok(taskSlug('x'.repeat(100)).length <= 60);
});

test('tasks normalize provider and state', () => {
  const task = normalizeTask({ title: 'Ship it', provider: 'codex', state: 'running' });
  assert.equal(task.provider, 'codex');
  assert.equal(task.state, 'running');
  assert.throws(() => normalizeTask({}), /title/i);
});

test('path containment rejects siblings and prefix tricks', () => {
  const root = path.resolve('/tmp/project');
  assert.equal(isWithin(root, path.join(root, 'src/a.js')), true);
  assert.equal(isWithin(root, '/tmp/project-other/a.js'), false);
  assert.equal(isWithin(root, '/tmp/other'), false);
});

test('external URLs are limited to http(s)', () => {
  assert.equal(validHttpUrl('https://example.com'), true);
  assert.equal(validHttpUrl('javascript:alert(1)'), false);
  assert.equal(validHttpUrl('file:///etc/passwd'), false);
});
