const test = require('node:test');
const assert = require('node:assert/strict');
const { changedPathMap } = require('../src/main/overlap');

test('overlap detector only reports paths owned by multiple tasks', () => {
  const overlaps = changedPathMap([
    { taskId: 'a', files: [{ path: 'src/shared.js' }, { path: 'src/a.js' }] },
    { taskId: 'b', files: [{ path: 'src/shared.js' }] }
  ]);
  assert.deepEqual(overlaps, [{ path: 'src/shared.js', taskIds: ['a', 'b'], severity: 'conflict-risk' }]);
});
