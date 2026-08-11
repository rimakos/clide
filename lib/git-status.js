'use strict';

/**
 * Parse the output of `git status --porcelain=v1 -z -b --untracked-files=all`.
 *
 * -z is what makes this correct: with the default output git quotes and
 * octal-escapes any path that isn't plain ASCII, so `café.txt` arrives as
 * "caf\303\251.txt" and handing that back to `git add` fails with
 * `fatal: pathspec ... did not match any files`. -z emits raw bytes and
 * separates entries with NUL, so there is nothing to unquote.
 *
 * Field shapes, all verified against git:
 *   branch header  `## main...origin/main [ahead 2, behind 1]`  (one field)
 *   detached HEAD  `## HEAD (no branch)`
 *   ordinary entry `XY path`
 *   rename or copy `RY newpath` followed by a second field holding the old path
 */
function parseStatusZ(out) {
  const parts = String(out || '').split('\0');
  const files = [];
  let branch = null, upstream = null, ahead = 0, behind = 0, detached = false;

  for (let i = 0; i < parts.length; i++) {
    const ln = parts[i];
    if (!ln) continue;

    if (ln.startsWith('## ')) {
      const head = ln.slice(3);
      if (head.startsWith('HEAD (no branch)')) {
        detached = true;
        branch = 'HEAD';
      } else {
        const track = head.split(' [')[0];
        const [local, remote] = track.split('...');
        branch = local.trim() || null;
        upstream = remote ? remote.trim() : null;
      }
      const a = /\bahead (\d+)/.exec(ln);
      const b = /\bbehind (\d+)/.exec(ln);
      ahead = a ? +a[1] : 0;
      behind = b ? +b[1] : 0;
      continue;
    }

    const x = ln[0], y = ln[1];
    const path = ln.slice(3);
    let orig = null;
    // A rename/copy spends a second field on the old path. Consume it so it is
    // never mistaken for an entry of its own.
    if (x === 'R' || x === 'C') orig = parts[++i] || null;

    files.push({
      path,
      orig,
      index: x,
      work: y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
      untracked: x === '?',
      conflicted: x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')
    });
  }

  return { repo: true, branch, upstream, ahead, behind, detached, files };
}

module.exports = { parseStatusZ };
