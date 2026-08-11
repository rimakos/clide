/* ===================== terminal panes (recursive splits, max 4) =====================
 * Loaded after renderer.js. Relies on its globals: sessions, activeKey, cur,
 * terminalsEl, toast, startSession, fitActive, ipcRenderer.
 *
 * Sessions already existed as top tabs and only the active one was displayed.
 * This turns #terminals into a layout tree so up to four of them are on screen
 * at once. Each leaf reparents that session's existing termEl, so xterm
 * instances and their scrollback survive every relayout.
 *
 *   leaf   { type:'leaf',  key }
 *   split  { type:'split', dir:'h'|'v', a, b, ratio }
 *
 * dir is 'h'/'v' rather than 'row'/'col' because style.css already owns a .row
 * utility class (height:24px, align-items:center) for file tree rows, and a
 * .tsplit.row collapsed every pane to 24px tall.
 */
'use strict';

(function () {

const MAX_PANES = 4;
let layout = null;      // root node, null until the first session exists
let splitting = null;   // 'h' | 'v' while a split is awaiting its new session
let parking = null;     // offscreen home for sessions not currently in a pane

function park() {
  if (!parking) {
    parking = document.createElement('div');
    parking.id = 'term-parking';
    document.body.appendChild(parking);
  }
  return parking;
}

/* ---------- tree helpers ---------- */
function leafNodes(node, out) {
  out = out || [];
  if (!node) return out;
  if (node.type === 'leaf') out.push(node);
  else { leafNodes(node.a, out); leafNodes(node.b, out); }
  return out;
}
function findLeaf(key) { return leafNodes(layout).find(n => n.key === key) || null; }
function findParent(node, target) {
  if (!node || node.type === 'leaf') return null;
  if (node.a === target || node.b === target) return node;
  return findParent(node.a, target) || findParent(node.b, target);
}
function paneCount() { return leafNodes(layout).length; }

/* ---------- render ---------- */
function render() {
  // Park every terminal first so reparenting is order-independent, then rebuild.
  const home = park();
  for (const s of sessions.values()) {
    if (s.termEl && s.termEl.parentNode !== home) home.appendChild(s.termEl);
  }
  terminalsEl.innerHTML = '';
  if (!layout) return;

  // A leaf whose session died is dropped rather than rendered empty.
  for (const l of leafNodes(layout)) if (!sessions.has(l.key)) remove(l.key, true);
  if (!layout) return;

  terminalsEl.appendChild(build(layout));
  fitActive();
}

function build(node) {
  if (node.type === 'leaf') {
    const box = document.createElement('div');
    box.className = 'tpane' + (node.key === activeKey ? ' focused' : '');
    const s = sessions.get(node.key);
    if (s) {
      s.termEl.style.display = 'block';
      box.appendChild(s.termEl);
    }
    box.addEventListener('mousedown', () => {
      if (node.key !== activeKey) switchSession(node.key);
    });
    return box;
  }

  const wrap = document.createElement('div');
  wrap.className = 'tsplit tsplit-' + node.dir;
  const a = build(node.a), b = build(node.b);
  a.style.flex = `${node.ratio} 1 0`;
  b.style.flex = `${1 - node.ratio} 1 0`;
  const div = document.createElement('div');
  div.className = 'tdivider tdivider-' + node.dir;
  div.addEventListener('mousedown', e => startDrag(e, node, wrap));
  wrap.appendChild(a); wrap.appendChild(div); wrap.appendChild(b);
  return wrap;
}

/* ---------- divider drag ---------- */
function startDrag(ev, node, wrap) {
  ev.preventDefault();
  ev.stopPropagation();
  const rect = wrap.getBoundingClientRect();
  const horizontal = node.dir === 'h';
  document.body.style.userSelect = 'none';
  document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';

  const move = e => {
    const pos = horizontal ? (e.clientX - rect.left) / rect.width
                           : (e.clientY - rect.top) / rect.height;
    // Keep both halves usable; a terminal narrower than this is unreadable.
    node.ratio = Math.min(0.85, Math.max(0.15, pos));
    const [a, , b] = wrap.children;
    a.style.flex = `${node.ratio} 1 0`;
    b.style.flex = `${1 - node.ratio} 1 0`;
    fitActive();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    fitActive();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/* ---------- public operations ---------- */

// Called by switchSession. If the session is already on screen we just focus it;
// otherwise it takes over the focused pane, unless a split is in flight.
function show(key) {
  if (!layout) { layout = { type: 'leaf', key }; render(); return; }

  const existing = findLeaf(key);
  if (existing) { render(); return; }

  const target = findLeaf(activeKey) || leafNodes(layout)[0];
  if (splitting && target && paneCount() < MAX_PANES) {
    // Convert the focused leaf into a split in place: no parent lookup needed.
    const moved = { type: 'leaf', key: target.key };
    delete target.key;
    target.type = 'split';
    target.dir = splitting;
    target.a = moved;
    target.b = { type: 'leaf', key };
    target.ratio = 0.5;
  } else if (target) {
    target.key = key;
  } else {
    layout = { type: 'leaf', key };
  }
  render();
}

// Drop a session's leaf and promote its sibling into the parent's place.
function remove(key, skipRender) {
  const l = findLeaf(key);
  if (!l) return;
  const parent = findParent(layout, l);
  if (!parent) { layout = null; if (!skipRender) render(); return; }
  const sibling = parent.a === l ? parent.b : parent.a;
  for (const k of Object.keys(parent)) delete parent[k];
  Object.assign(parent, sibling);
  if (!skipRender) render();
}

async function splitPane(dir) {
  const s = cur();
  if (!s) return;
  if (paneCount() >= MAX_PANES) { toast(`Maximum ${MAX_PANES} terminals`, true); return; }
  splitting = dir;
  try {
    await startSession({ cwd: s.cwd });
  } finally {
    splitting = null;
  }
}

window.Panes = {
  show,
  remove,
  splitRight: () => splitPane('h'),
  splitDown: () => splitPane('v'),
  count: paneCount,
  max: MAX_PANES
};

})();
