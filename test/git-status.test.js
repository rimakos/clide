'use strict';
const assert = require('assert');
const { parseStatusZ } = require('../lib/git-status');

// Fixtures below are literal `git status --porcelain=v1 -z -b -uall` output,
// captured from real repos. NUL is written as \0.
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('parseStatusZ');

t('branch, upstream and ahead count', () => {
  const r = parseStatusZ('## main...origin/main [ahead 2]\0');
  assert.strictEqual(r.branch, 'main');
  assert.strictEqual(r.upstream, 'origin/main');
  assert.strictEqual(r.ahead, 2);
  assert.strictEqual(r.behind, 0);
  assert.strictEqual(r.detached, false);
});

t('ahead and behind together', () => {
  const r = parseStatusZ('## feat...origin/feat [ahead 3, behind 7]\0');
  assert.strictEqual(r.ahead, 3);
  assert.strictEqual(r.behind, 7);
});

t('branch with no upstream', () => {
  const r = parseStatusZ('## solo\0');
  assert.strictEqual(r.branch, 'solo');
  assert.strictEqual(r.upstream, null);
});

t('detached HEAD', () => {
  const r = parseStatusZ('## HEAD (no branch)\0 M src/deep/keep.txt\0');
  assert.strictEqual(r.detached, true);
  assert.strictEqual(r.branch, 'HEAD');
  assert.strictEqual(r.files.length, 1);
});

t('non-ASCII path survives verbatim', () => {
  // This is the bug: porcelain without -z gives "caf\303\251.txt" and staging fails.
  const r = parseStatusZ('## main\0?? src/café note.txt\0');
  assert.strictEqual(r.files[0].path, 'src/café note.txt');
  assert.strictEqual(r.files[0].untracked, true);
});

t('path containing spaces is one field', () => {
  const r = parseStatusZ('## main\0?? my file.txt\0');
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].path, 'my file.txt');
});

t('rename consumes the old path and does not emit a phantom entry', () => {
  const r = parseStatusZ('## main\0R  src/renamed.txt\0src/old.txt\0?? after.txt\0');
  assert.strictEqual(r.files.length, 2);
  assert.strictEqual(r.files[0].path, 'src/renamed.txt');
  assert.strictEqual(r.files[0].orig, 'src/old.txt');
  assert.strictEqual(r.files[0].index, 'R');
  assert.strictEqual(r.files[1].path, 'after.txt', 'entry after a rename must not be swallowed');
});

t('staged and unstaged flags', () => {
  const r = parseStatusZ('## main\0M  staged.txt\0 M dirty.txt\0MM both.txt\0?? new.txt\0');
  const by = Object.fromEntries(r.files.map(f => [f.path, f]));
  assert.strictEqual(by['staged.txt'].staged, true);
  assert.strictEqual(by['staged.txt'].unstaged, false);
  assert.strictEqual(by['dirty.txt'].staged, false);
  assert.strictEqual(by['dirty.txt'].unstaged, true);
  assert.strictEqual(by['both.txt'].staged, true);
  assert.strictEqual(by['both.txt'].unstaged, true);
  assert.strictEqual(by['new.txt'].untracked, true);
  assert.strictEqual(by['new.txt'].staged, false);
});

t('conflicts are flagged', () => {
  const r = parseStatusZ('## main\0UU clash.txt\0AA both-added.txt\0');
  assert.strictEqual(r.files[0].conflicted, true);
  assert.strictEqual(r.files[1].conflicted, true);
});

t('empty output is a clean repo, not a crash', () => {
  const r = parseStatusZ('');
  assert.strictEqual(r.files.length, 0);
  assert.strictEqual(r.branch, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
