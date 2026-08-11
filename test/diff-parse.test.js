'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseUnifiedDiff, pairRows, countChanges } = require('../lib/diff-parse');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('parseUnifiedDiff');

const SIMPLE = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,5 +1,6 @@ function boot()',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 22;',
  '+const c = 3;',
  ' const d = 4;',
  ''
].join('\n');

t('file paths and hunk header', () => {
  const p = parseUnifiedDiff(SIMPLE);
  assert.strictEqual(p.files.length, 1);
  assert.strictEqual(p.files[0].oldPath, 'src/app.js');
  assert.strictEqual(p.files[0].newPath, 'src/app.js');
  assert.strictEqual(p.files[0].hunks.length, 1);
  assert.strictEqual(p.files[0].hunks[0].heading, 'function boot()');
});

t('line numbers advance independently on each side', () => {
  const rows = parseUnifiedDiff(SIMPLE).files[0].hunks[0].rows;
  assert.deepStrictEqual(rows.map(r => [r.type, r.oldNo, r.newNo]), [
    ['ctx', 1, 1],
    ['del', 2, null],
    ['add', null, 2],
    ['add', null, 3],
    ['ctx', 3, 4]
  ]);
});

t('index and mode lines are not treated as content', () => {
  const rows = parseUnifiedDiff(SIMPLE).files[0].hunks[0].rows;
  assert.ok(!rows.some(r => r.text.startsWith('ndex ')), 'the "index" line leaked in as content');
  assert.strictEqual(rows.length, 5);
});

t('a modified line pairs old against new on one row', () => {
  const paired = pairRows(parseUnifiedDiff(SIMPLE).files[0].hunks[0].rows);
  assert.deepStrictEqual(paired.map(p => p.kind), ['ctx', 'mod', 'add', 'ctx']);
  assert.strictEqual(paired[1].left.text, 'const b = 2;');
  assert.strictEqual(paired[1].right.text, 'const b = 22;');
  assert.strictEqual(paired[2].left, null, 'a pure insertion has an empty left cell');
  assert.strictEqual(paired[2].right.text, 'const c = 3;');
});

t('pure deletion leaves the right cell empty', () => {
  const p = parseUnifiedDiff([
    '--- a/x', '+++ b/x', '@@ -1,3 +1,1 @@', ' keep', '-gone one', '-gone two', ''
  ].join('\n'));
  const paired = pairRows(p.files[0].hunks[0].rows);
  assert.deepStrictEqual(paired.map(x => x.kind), ['ctx', 'del', 'del']);
  assert.strictEqual(paired[1].right, null);
});

t('new file: old path is null', () => {
  const p = parseUnifiedDiff([
    'diff --git a/new.txt b/new.txt', 'new file mode 100644',
    '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''
  ].join('\n'));
  assert.strictEqual(p.files[0].oldPath, null);
  assert.strictEqual(p.files[0].newPath, 'new.txt');
  assert.strictEqual(countChanges(p).added, 2);
});

t('multiple hunks in one file', () => {
  const p = parseUnifiedDiff([
    '--- a/m', '+++ b/m',
    '@@ -1,2 +1,2 @@', ' a', '-b', '+B',
    '@@ -20,2 +20,2 @@', ' y', '-z', '+Z', ''
  ].join('\n'));
  assert.strictEqual(p.files[0].hunks.length, 2);
  assert.strictEqual(p.files[0].hunks[1].oldStart, 20);
  assert.strictEqual(p.files[0].hunks[1].rows[0].oldNo, 20);
});

t('multiple files in one diff', () => {
  const p = parseUnifiedDiff([
    'diff --git a/one b/one', '--- a/one', '+++ b/one', '@@ -1 +1 @@', '-x', '+y',
    'diff --git a/two b/two', '--- a/two', '+++ b/two', '@@ -1 +1 @@', '-p', '+q', ''
  ].join('\n'));
  assert.strictEqual(p.files.length, 2);
  assert.deepStrictEqual(p.files.map(f => f.newPath), ['one', 'two']);
});

t('binary files are flagged, not parsed as text', () => {
  const p = parseUnifiedDiff([
    'diff --git a/img.png b/img.png',
    'Binary files a/img.png and b/img.png differ', ''
  ].join('\n'));
  assert.strictEqual(p.files[0].binary, true);
  assert.strictEqual(p.files[0].hunks.length, 0);
});

t('"no newline at end of file" marker is ignored', () => {
  const p = parseUnifiedDiff([
    '--- a/n', '+++ b/n', '@@ -1 +1 @@', '-a', '\\ No newline at end of file', '+b', ''
  ].join('\n'));
  const rows = p.files[0].hunks[0].rows;
  assert.deepStrictEqual(rows.map(r => r.type), ['del', 'add']);
});

t('a line that is only a minus sign is a deletion of an empty line', () => {
  const p = parseUnifiedDiff(['--- a/e', '+++ b/e', '@@ -1,2 +1,1 @@', ' keep', '-', ''].join('\n'));
  const rows = p.files[0].hunks[0].rows;
  assert.strictEqual(rows[1].type, 'del');
  assert.strictEqual(rows[1].text, '');
});

t('empty input does not throw', () => {
  assert.deepStrictEqual(parseUnifiedDiff('').files, []);
  assert.deepStrictEqual(countChanges(parseUnifiedDiff('')), { added: 0, removed: 0 });
});

t('parses real git output, including a renamed and a unicode path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-diff-'));
  const g = a => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '.']); g(['config', 'user.email', 't@t.t']); g(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(root, 'café.js'), 'let a = 1;\nlet b = 2;\nlet c = 3;\n');
  g(['add', '-A']); g(['commit', '-qm', 'seed']);
  fs.writeFileSync(path.join(root, 'café.js'), 'let a = 1;\nlet b = 22;\nlet c = 3;\nlet d = 4;\n');
  const raw = g(['diff', '--', 'café.js']);
  const p = parseUnifiedDiff(raw);
  assert.strictEqual(p.files.length, 1);
  assert.strictEqual(p.files[0].newPath, 'café.js', 'got: ' + p.files[0].newPath);
  const ch = countChanges(p);
  assert.strictEqual(ch.added, 2);
  assert.strictEqual(ch.removed, 1);
  const paired = pairRows(p.files[0].hunks[0].rows);
  assert.strictEqual(paired.find(x => x.kind === 'mod').right.text, 'let b = 22;');
  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
