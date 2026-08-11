'use strict';

/**
 * Parse a unified diff into files → hunks → rows, then optionally pair those
 * rows into aligned left/right columns for a side-by-side view.
 *
 * Row types: 'ctx' (unchanged), 'del', 'add'.
 */
/**
 * git quotes any path that isn't plain ASCII in diff headers, the same way it
 * does in `status` without -z: `+++ "b/caf\303\251.js"`. There is no -z for
 * diff headers, so undo it here. Octal escapes are bytes, so they are collected
 * and decoded as UTF-8 together rather than one at a time.
 */
function unquotePath(p) {
  if (!p || p[0] !== '"' || p[p.length - 1] !== '"') return p;
  const body = p.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...Buffer.from(body[i], 'utf8')); continue; }
    const n = body[i + 1];
    const oct = /^[0-7]{3}$/.test(body.substr(i + 1, 3)) ? body.substr(i + 1, 3) : null;
    if (oct) { bytes.push(parseInt(oct, 8)); i += 3; continue; }
    const simple = { n: 10, t: 9, r: 13, '"': 34, '\\': 92 }[n];
    if (simple !== undefined) { bytes.push(simple); i += 1; continue; }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

function stripPrefix(p, side) {
  const unq = unquotePath(p);
  if (unq === '/dev/null') return null;
  return unq.replace(side === 'old' ? /^a\// : /^b\//, '');
}

function parseUnifiedDiff(text) {
  const lines = String(text || '').split('\n');
  const files = [];
  let file = null, hunk = null, oldNo = 0, newNo = 0;

  const startFile = (oldPath, newPath) => {
    file = { oldPath, newPath, hunks: [], binary: false };
    files.push(file);
    hunk = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (ln.startsWith('diff --git ')) {
      // `diff --git a/x b/y`. Paths with spaces make this ambiguous, so prefer
      // the ---/+++ headers below and treat this only as a file boundary.
      const m = /^diff --git a\/(.*) b\/(.*)$/.exec(ln);
      startFile(m ? unquotePath(m[1]) : null, m ? unquotePath(m[2]) : null);
      continue;
    }
    if (ln.startsWith('Binary files ') || ln.startsWith('GIT binary patch')) {
      if (!file) startFile(null, null);
      file.binary = true;
      continue;
    }
    if (ln.startsWith('--- ')) {
      if (!file) startFile(null, null);
      file.oldPath = stripPrefix(ln.slice(4), 'old');
      continue;
    }
    if (ln.startsWith('+++ ')) {
      if (!file) startFile(null, null);
      file.newPath = stripPrefix(ln.slice(4), 'new');
      continue;
    }

    const hm = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(ln);
    if (hm) {
      if (!file) startFile(null, null);
      oldNo = +hm[1];
      newNo = +hm[3];
      hunk = { oldStart: oldNo, newStart: newNo, heading: (hm[5] || '').trim(), rows: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;              // index/mode/similarity lines between files
    if (ln.startsWith('\\')) continue; // "\ No newline at end of file"

    const c = ln[0];
    const body = ln.slice(1);
    if (c === '+') hunk.rows.push({ type: 'add', oldNo: null, newNo: newNo++, text: body });
    else if (c === '-') hunk.rows.push({ type: 'del', oldNo: oldNo++, newNo: null, text: body });
    // git writes an empty context line as a single space, so a truly empty line
    // is the trailing element of the final split and not content.
    else if (c === ' ') hunk.rows.push({ type: 'ctx', oldNo: oldNo++, newNo: newNo++, text: body });
  }

  return { files };
}

/**
 * Turn a hunk's rows into aligned pairs. Consecutive deletions and additions are
 * buffered and matched by index, so a modified line shows its old and new form
 * on the same row; leftovers pair against an empty cell.
 */
function pairRows(rows) {
  const out = [];
  let dels = [], adds = [];

  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) {
      const l = dels[i] || null;
      const r = adds[i] || null;
      out.push({
        left: l,
        right: r,
        // A del paired with an add is a modification, which is worth showing
        // differently from a pure insertion or deletion.
        kind: l && r ? 'mod' : (l ? 'del' : 'add')
      });
    }
    dels = []; adds = [];
  };

  for (const r of rows) {
    if (r.type === 'del') dels.push(r);
    else if (r.type === 'add') adds.push(r);
    else { flush(); out.push({ left: r, right: r, kind: 'ctx' }); }
  }
  flush();
  return out;
}

function countChanges(parsed) {
  let added = 0, removed = 0;
  for (const f of parsed.files) {
    for (const h of f.hunks) {
      for (const r of h.rows) {
        if (r.type === 'add') added++;
        else if (r.type === 'del') removed++;
      }
    }
  }
  return { added, removed };
}

module.exports = { parseUnifiedDiff, pairRows, countChanges };
