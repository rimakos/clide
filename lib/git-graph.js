'use strict';

/**
 * Assign commits to graph lanes, the way a git log graph draws them.
 *
 * Input is commits in `git log` order (newest first), each `{ hash, parents }`.
 * Output adds, per commit:
 *   lane        the column its dot sits in
 *   lanesBefore hashes each lane is waiting for as the row is entered
 *   lanesAfter  the same after the commit is resolved into its parents
 *   links       {from, to} lane pairs to draw between this row and the next
 *   width       lanes in play on this row, for sizing the gutter
 *
 * A lane is "waiting for" a hash: when that commit appears, it occupies the lane
 * and hands the lane on to its first parent. Extra parents (a merge) claim free
 * lanes, which is what makes a merge fan out.
 */
function layoutGraph(commits) {
  const lanes = [];          // lane index -> hash that lane is waiting for
  const rows = [];

  const firstFree = () => {
    const i = lanes.indexOf(null);
    return i >= 0 ? i : lanes.length;
  };

  for (const c of commits) {
    const parents = c.parents || [];
    const lanesBefore = lanes.slice();

    // The lane already reserved for this commit, or a new one if it is a tip.
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) { lane = firstFree(); lanes[lane] = c.hash; }

    // Any other lane waiting for the same hash collapses into this one.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === c.hash) lanes[i] = null;
    }

    if (parents.length === 0) {
      lanes[lane] = null;
    } else {
      // The first parent continues in this lane, keeping mainline straight.
      lanes[lane] = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const existing = lanes.indexOf(parents[p]);
        if (existing >= 0) continue;   // that parent is already tracked
        lanes[firstFree()] = parents[p];
      }
    }

    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    const lanesAfter = lanes.slice();

    // Draw a segment for every lane that survives, plus one per parent branch.
    const links = [];
    for (let i = 0; i < lanesBefore.length; i++) {
      const h = lanesBefore[i];
      if (!h || h === c.hash) continue;
      const to = lanesAfter.indexOf(h);
      if (to >= 0) links.push({ from: i, to });
    }
    for (const p of parents) {
      const to = lanesAfter.indexOf(p);
      if (to >= 0) links.push({ from: lane, to });
    }

    rows.push({
      ...c,
      lane,
      lanesBefore,
      lanesAfter,
      links,
      width: Math.max(lanesBefore.length, lanesAfter.length, lane + 1),
      merge: parents.length > 1
    });
  }

  return rows;
}

/** Parse the NUL/US separated `git log` output main.js asks for. */
function parseLog(out) {
  return String(out || '').split('\n').filter(Boolean).map(ln => {
    const [hash, short, parents, subject, author, date, refs] = ln.split('\x1f');
    return {
      hash,
      short,
      parents: (parents || '').split(' ').filter(Boolean),
      subject: subject || '',
      author: author || '',
      date: date || '',
      refs: (refs || '').split(', ').map(s => s.trim()).filter(Boolean)
    };
  });
}

module.exports = { layoutGraph, parseLog };
