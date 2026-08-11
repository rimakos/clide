'use strict';
/**
 * Exercises the git command sequences the IPC handlers issue, against a real
 * throwaway repo. Mirrors main.js rather than importing it, because main.js
 * requires electron and cannot load under plain node.
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseStatusZ } = require('../lib/git-status');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e.message || e)); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-git-'));
const repo = path.join(root, 'work');
const remote = path.join(root, 'remote.git');

function git(args, cwd = repo, allowFail) {
  const env = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' });
  try {
    return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return { failed: true, err: (e.stderr || '') + (e.stdout || '') };
    throw new Error(`git ${args.join(' ')} failed: ${e.stderr || e.message}`);
  }
}
function status() {
  return parseStatusZ(git(['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all']));
}
// The push handler from main.js, in sequence form.
function pushLikeClide() {
  const up = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo, true);
  if (!up.failed && String(up).trim()) return git(['push'], repo, true);
  const remotes = git(['remote'], repo, true);
  const names = String(remotes.failed ? '' : remotes).split('\n').map(s => s.trim()).filter(Boolean);
  if (!names.length) return { failed: true, err: 'No remote configured.' };
  const target = names.includes('origin') ? 'origin' : names[0];
  return git(['push', '-u', target, 'HEAD'], repo, true);
}
// The commit handler from main.js: stage the checked set, then commit --only.
function commitLikeClide(message, paths, amend) {
  if (paths.length) git(['add', '--', ...paths]);
  const args = ['commit'];
  if (amend) args.push('--amend');
  args.push('-m', message);
  if (paths.length) args.push('--only', '--', ...paths);
  return git(args, repo, true);
}

console.log('git command sequences');

fs.mkdirSync(repo, { recursive: true });
git(['init', '-q', '.']);
git(['config', 'user.email', 't@t.t']);
git(['config', 'user.name', 't']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
git(['add', '-A']);
git(['commit', '-qm', 'init']);

t('non-ASCII filename round-trips from status into git add', () => {
  const name = 'café note.txt';
  fs.writeFileSync(path.join(repo, name), 'x\n');
  const st = status();
  const f = st.files.find(f => f.path === name);
  assert.ok(f, 'status must report the raw filename, got: ' + JSON.stringify(st.files.map(x => x.path)));
  const r = git(['add', '--', f.path], repo, true);
  assert.ok(!r.failed, 'staging the parsed path must succeed, got: ' + (r.err || ''));
  assert.strictEqual(status().files.find(x => x.path === name).staged, true);
  git(['commit', '-qm', 'add unicode']);
});

t('commit --only commits just the checked files', () => {
  fs.writeFileSync(path.join(repo, 'wanted.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, 'ignored.txt'), 'b\n');
  const r = commitLikeClide('only wanted', ['wanted.txt'], false);
  assert.ok(!r.failed, 'commit failed: ' + (r.err || ''));
  const committed = git(['show', '--name-only', '--pretty=format:', 'HEAD']).trim().split('\n').filter(Boolean);
  assert.deepStrictEqual(committed, ['wanted.txt']);
  const st = status();
  assert.ok(st.files.some(f => f.path === 'ignored.txt' && f.untracked),
    'the unchecked file must stay uncommitted and untracked');
});

t('push on a new branch with no upstream succeeds', () => {
  git(['init', '-q', '--bare', remote], root);
  git(['remote', 'add', 'origin', remote]);
  git(['checkout', '-qb', 'feature-x']);
  fs.writeFileSync(path.join(repo, 'feat.txt'), 'f\n');
  commitLikeClide('feature work', ['feat.txt'], false);

  const bare = git(['push'], repo, true);
  assert.ok(bare.failed, 'a bare push is expected to fail here; that is the bug being fixed');
  assert.match(bare.err, /no upstream branch/i);

  const r = pushLikeClide();
  assert.ok(!r.failed, 'push -u fallback must succeed, got: ' + (r.err || ''));
  assert.match(git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim(), /^origin\/feature-x$/);
});

t('second push uses the now-configured upstream', () => {
  fs.writeFileSync(path.join(repo, 'feat.txt'), 'f2\n');
  commitLikeClide('more', ['feat.txt'], false);
  const r = pushLikeClide();
  assert.ok(!r.failed, 'got: ' + (r.err || ''));
  assert.strictEqual(status().ahead, 0);
});

t('amend replaces the last commit instead of adding one', () => {
  const before = git(['rev-list', '--count', 'HEAD']).trim();
  const r = commitLikeClide('reworded', [], true);
  assert.ok(!r.failed, 'amend failed: ' + (r.err || ''));
  assert.strictEqual(git(['rev-list', '--count', 'HEAD']).trim(), before, 'history length must not grow');
  assert.strictEqual(git(['log', '-1', '--pretty=%s']).trim(), 'reworded');
});

t('rename is reported with its old path and no phantom entry', () => {
  git(['mv', 'wanted.txt', 'renamed.txt']);
  const st = status();
  const r = st.files.find(f => f.index === 'R');
  assert.ok(r, 'expected a rename entry');
  assert.strictEqual(r.path, 'renamed.txt');
  assert.strictEqual(r.orig, 'wanted.txt');
  assert.ok(!st.files.some(f => f.path === 'wanted.txt' && f.index !== 'R'),
    'the old path must not appear as its own entry');
});

t('status surfaces the upstream and counts a new local commit as ahead', () => {
  // The amend above rewrote an already-pushed commit, so the branch is already
  // ahead here. Assert the increment, not an absolute count.
  const before = status().ahead;
  fs.writeFileSync(path.join(repo, 'feat.txt'), 'f3\n');
  commitLikeClide('one more', ['feat.txt'], false);
  const after = status();
  assert.strictEqual(after.ahead, before + 1);
  assert.strictEqual(after.upstream, 'origin/feature-x');
});

/* ---------- sync tests get their own repo pair ----------
 * The commit tests above deliberately leave the branch diverged (amend rewrites
 * a pushed commit), which would make every push here fail for unrelated reasons.
 */
const sync = path.join(root, 'sync');
const syncRemote = path.join(root, 'sync-remote.git');
function sgit(args, cwd, allowFail) { return git(args, cwd || sync, allowFail); }
function sstatus(cwd) {
  return parseStatusZ(sgit(['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], cwd));
}
// The outgoing handler from main.js: what a push would actually send.
function outgoingLikeClide(cwd) {
  const up = sgit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], cwd, true);
  const upstream = up.failed ? '' : String(up).trim();
  const args = ['log', upstream ? `${upstream}..HEAD` : 'HEAD', '--max-count=50',
    '--date=relative', '--pretty=format:%h\x1f%s\x1f%an\x1f%ad'];
  if (!upstream) args.push('--not', '--remotes');
  const r = sgit(args, cwd, true);
  if (r.failed) return { upstream, commits: [] };
  const commits = String(r).split('\n').filter(Boolean).map(ln => {
    const [sha, subject, author, date] = ln.split('\x1f');
    return { sha, subject, author, date };
  });
  return { upstream, commits };
}
function scommit(msg, file, body) {
  fs.writeFileSync(path.join(sync, file), body);
  sgit(['add', '--', file]);
  sgit(['commit', '-qm', msg]);
}

git(['init', '-q', '--bare', syncRemote], root);
fs.mkdirSync(sync, { recursive: true });
sgit(['init', '-q', '.']);
sgit(['config', 'user.email', 't@t.t']);
sgit(['config', 'user.name', 't']);
sgit(['config', 'commit.gpgsign', 'false']);
sgit(['remote', 'add', 'origin', syncRemote]);
scommit('seed', 'seed.txt', 'seed\n');
sgit(['push', '-q', '-u', 'origin', 'HEAD']);

t('outgoing lists exactly the commits a push would send', () => {
  assert.strictEqual(outgoingLikeClide().commits.length, 0, 'nothing outgoing right after a push');
  scommit('outgoing one', 'o1.txt', '1\n');
  scommit('outgoing two', 'o2.txt', '2\n');
  const out = outgoingLikeClide();
  assert.deepStrictEqual(out.commits.map(c => c.subject), ['outgoing two', 'outgoing one']);
  assert.ok(out.commits[0].sha && out.commits[0].author && out.commits[0].date);
  sgit(['push', '-q']);
});

t('outgoing on a branch with no upstream lists only unpushed commits', () => {
  sgit(['checkout', '-qb', 'no-upstream']);
  scommit('only on the new branch', 'n1.txt', 'n\n');
  const out = outgoingLikeClide();
  assert.strictEqual(out.upstream, '', 'a fresh branch has no upstream');
  assert.deepStrictEqual(out.commits.map(c => c.subject), ['only on the new branch'],
    'commits already on a remote must not be listed as outgoing');
});

t('fetch updates behind after the remote moves ahead', () => {
  sgit(['checkout', '-q', '-']);            // back to the tracked branch
  // A second clone pushes, so our remote-tracking ref goes stale.
  const other = path.join(root, 'sync-other');
  git(['clone', '-q', syncRemote, other], root);
  git(['config', 'user.email', 't@t.t'], other);
  git(['config', 'user.name', 't'], other);
  fs.writeFileSync(path.join(other, 'remote-side.txt'), 'r\n');
  git(['add', '-A'], other);
  git(['commit', '-qm', 'from the other clone'], other);
  git(['push', '-q'], other);

  assert.strictEqual(sstatus().behind, 0, 'a stale tracking ref reports 0 behind: that is the bug');
  sgit(['fetch', '--prune', '--quiet']);
  assert.strictEqual(sstatus().behind, 1, 'after fetch the panel can finally see it is behind');
});

t('pull --rebase clears behind and replays local work on top', () => {
  scommit('local work', 'local-side.txt', 'l\n');
  const r = sgit(['pull', '--rebase'], sync, true);
  assert.ok(!r.failed, 'pull --rebase failed: ' + (r.err || ''));
  assert.strictEqual(sstatus().behind, 0);
  assert.strictEqual(sgit(['log', '-1', '--pretty=%s']).trim(), 'local work',
    'the rebase must replay local work on top of the fetched commit');
  assert.strictEqual(sgit(['log', '-2', '--pretty=%s']).trim().split('\n')[1], 'from the other clone');
});

t('pull is refused on a branch with no upstream', () => {
  sgit(['checkout', '-q', 'no-upstream']);
  const up = sgit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], sync, true);
  assert.ok(up.failed, 'no upstream, so main.js short-circuits instead of running pull');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
