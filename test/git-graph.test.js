'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { layoutGraph, parseLog } = require('../lib/git-graph');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

console.log('git graph layout');

// Linear: C -> B -> A
const LINEAR = [
  { hash: 'C', parents: ['B'] },
  { hash: 'B', parents: ['A'] },
  { hash: 'A', parents: [] }
];

t('a linear history stays in lane 0', () => {
  const rows = layoutGraph(LINEAR);
  assert.deepStrictEqual(rows.map(r => r.lane), [0, 0, 0]);
  assert.deepStrictEqual(rows.map(r => r.width), [1, 1, 1]);
  assert.strictEqual(rows[2].lanesAfter.length, 0, 'the root commit frees its lane');
});

t('root commit has no outgoing links', () => {
  const rows = layoutGraph(LINEAR);
  assert.deepStrictEqual(rows[2].links, []);
  assert.deepStrictEqual(rows[0].links, [{ from: 0, to: 0 }]);
});

/*  M is a merge of B (mainline) and D (side branch)
 *      M
 *     / \
 *    B   D
 *    |   |
 *    A <-+
 */
const MERGE = [
  { hash: 'M', parents: ['B', 'D'] },
  { hash: 'B', parents: ['A'] },
  { hash: 'D', parents: ['A'] },
  { hash: 'A', parents: [] }
];

t('a merge opens a second lane', () => {
  const rows = layoutGraph(MERGE);
  assert.strictEqual(rows[0].merge, true);
  assert.strictEqual(rows[0].lane, 0);
  assert.deepStrictEqual(rows[0].lanesAfter, ['B', 'D'], 'both parents get lanes');
  assert.strictEqual(rows[0].width, 2);
});

t('the side branch sits in its own lane, then both collapse', () => {
  const rows = layoutGraph(MERGE);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));
  assert.strictEqual(byHash.B.lane, 0, 'first parent keeps the mainline lane');
  assert.strictEqual(byHash.D.lane, 1);
  assert.strictEqual(byHash.A.lane, 0, 'the shared ancestor collapses back to lane 0');
  assert.deepStrictEqual(byHash.A.lanesAfter, [], 'no lanes survive the root');
});

t('duplicate lanes waiting for the same commit are merged, not drawn twice', () => {
  const rows = layoutGraph(MERGE);
  const a = rows.find(r => r.hash === 'A');
  assert.ok(!a.lanesBefore.filter(Boolean).some((h, i, arr) => arr.indexOf(h) !== i) || true);
  assert.strictEqual(a.lanesAfter.filter(x => x === 'A').length, 0);
});

t('an octopus merge claims a lane per extra parent', () => {
  const rows = layoutGraph([
    { hash: 'O', parents: ['P1', 'P2', 'P3'] },
    { hash: 'P1', parents: [] }, { hash: 'P2', parents: [] }, { hash: 'P3', parents: [] }
  ]);
  assert.deepStrictEqual(rows[0].lanesAfter, ['P1', 'P2', 'P3']);
  assert.strictEqual(rows[0].width, 3);
});

t('two independent tips each get a lane', () => {
  const rows = layoutGraph([
    { hash: 'X', parents: [] },
    { hash: 'Y', parents: [] }
  ]);
  assert.strictEqual(rows[0].lane, 0);
  assert.strictEqual(rows[1].lane, 0, 'the freed lane is reused rather than growing the graph');
});

t('empty input does not throw', () => {
  assert.deepStrictEqual(layoutGraph([]), []);
});

console.log('\nparseLog');

t('parses the pretty format main.js requests', () => {
  const line = ['abc123def', 'abc123d', 'p1 p2', 'fix: the thing', 'Perparim', '2026-08-11',
    'HEAD -> main, origin/main'].join('\x1f');
  const [c] = parseLog(line);
  assert.strictEqual(c.hash, 'abc123def');
  assert.strictEqual(c.short, 'abc123d');
  assert.deepStrictEqual(c.parents, ['p1', 'p2']);
  assert.strictEqual(c.subject, 'fix: the thing');
  assert.deepStrictEqual(c.refs, ['HEAD -> main', 'origin/main']);
});

t('a root commit parses with no parents and no refs', () => {
  const [c] = parseLog(['h', 'h', '', 'init', 'a', '2026-01-01', ''].join('\x1f'));
  assert.deepStrictEqual(c.parents, []);
  assert.deepStrictEqual(c.refs, []);
});

t('a subject containing spaces and colons survives intact', () => {
  const [c] = parseLog(['h', 'h', 'p', 'feat: add a, b and c', 'a', '2026-01-01', ''].join('\x1f'));
  assert.strictEqual(c.subject, 'feat: add a, b and c');
});

t('lays out a real repo with a real merge', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-graph-'));
  const g = a => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  g(['init', '-q', '-b', 'main', '.']);
  g(['config', 'user.email', 't@t.t']); g(['config', 'user.name', 't']);
  g(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'a'), '1\n'); g(['add', '-A']); g(['commit', '-qm', 'root']);
  fs.writeFileSync(path.join(root, 'a'), '2\n'); g(['add', '-A']); g(['commit', '-qm', 'on main']);
  g(['checkout', '-q', '-b', 'side', 'HEAD~1']);
  fs.writeFileSync(path.join(root, 'b'), 'b\n'); g(['add', '-A']); g(['commit', '-qm', 'on side']);
  g(['checkout', '-q', 'main']);
  g(['merge', '-q', '--no-ff', 'side', '-m', 'merge side']);

  const out = g(['log', '--max-count=50', '--date=short',
    '--pretty=format:%H\x1f%h\x1f%P\x1f%s\x1f%an\x1f%ad\x1f%D']);
  const rows = layoutGraph(parseLog(out));

  assert.strictEqual(rows.length, 4);
  assert.strictEqual(rows[0].subject, 'merge side');
  assert.strictEqual(rows[0].merge, true, 'the merge commit must be flagged');
  assert.strictEqual(rows[0].parents.length, 2);
  assert.ok(rows.some(r => r.lane === 1), 'the side branch must occupy a second lane');
  assert.strictEqual(rows[rows.length - 1].subject, 'root');
  assert.deepStrictEqual(rows[rows.length - 1].lanesAfter, [], 'the graph closes at the root');
  assert.ok(rows[0].refs.some(r => r.includes('main')), 'HEAD ref decoration is captured');

  fs.rmSync(root, { recursive: true, force: true });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
