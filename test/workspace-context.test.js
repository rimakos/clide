const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeWorkspaceContext, workerContextPrompt } = require('../src/shared/workspace-context');

test('workspace context produces a bounded worker brief', () => {
  const context = normalizeWorkspaceContext({ summary: 'Build Clide', constraints: ['No automatic pushes'], commands: ['npm test'], decisions: [{ title: 'Local first', body: 'SQLite is authoritative.' }] });
  const prompt = workerContextPrompt(context);
  assert.match(prompt, /Build Clide/); assert.match(prompt, /No automatic pushes/); assert.match(prompt, /SQLite is authoritative/);
  assert.ok(prompt.length <= 12000);
});
