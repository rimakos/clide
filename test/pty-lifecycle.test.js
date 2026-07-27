const test = require('node:test');
const assert = require('node:assert/strict');
const { resizePtySession } = require('../src/main/pty-lifecycle');

test('PTY resize forwards valid dimensions for an active session', () => {
  const calls = [];
  const item = { pty: { resize: (cols, rows) => calls.push([cols, rows]) }, exited: false };

  assert.equal(resizePtySession(item, 120, 32), true);
  assert.deepEqual(calls, [[120, 32]]);
});

test('PTY resize is ignored after exit or explicit close', () => {
  let calls = 0;
  const pty = { resize: () => { calls += 1; } };

  assert.equal(resizePtySession({ pty, exited: true }, 120, 32), false);
  assert.equal(resizePtySession({ pty, explicitClose: true }, 120, 32), false);
  assert.equal(calls, 0);
});

test('native ioctl resize failures never escape the IPC boundary', () => {
  const item = { pty: { resize: () => { throw new Error('ioctl(2) failed'); } } };
  let unexpected = null;

  assert.doesNotThrow(() => {
    assert.equal(resizePtySession(item, 120, 32, error => { unexpected = error; }), false);
  });
  assert.equal(unexpected, null);
});

test('unexpected native resize failures are reported without throwing', () => {
  const failure = new Error('unexpected resize failure');
  const item = { pty: { resize: () => { throw failure; } } };
  let reported = null;

  assert.equal(resizePtySession(item, 120, 32, error => { reported = error; }), false);
  assert.equal(reported, failure);
});
