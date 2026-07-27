const test = require('node:test');
const assert = require('node:assert/strict');
const { allocateAvailablePort } = require('../src/main/port-manager');

test('port manager skips stored and externally occupied ports', async () => {
  const checks = [];
  const allocated = await allocateAvailablePort({ one: { port: 4200 } }, {
    start: 4200, end: 4204,
    isAvailable: async port => { checks.push(port); return port !== 4201; }
  });
  assert.equal(allocated, 4202);
  assert.deepEqual(checks, [4201, 4202]);
});
