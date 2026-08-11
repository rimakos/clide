/* ===================== log / history panel =====================
 * Loaded after renderer.js. Relies on its globals: $, cur, toast, addTab,
 * escapeHtml, renderTabbar, renderViewer, activeKey, ipcRenderer.
 *
 * Commit list with a branch graph. Clicking a commit expands the files it
 * touched; clicking a file opens that commit's diff in the viewer, rendered by
 * the same side-by-side viewer the working-tree diffs use.
 */
'use strict';

(function () {

const { layoutGraph, parseLog } = require('../lib/git-graph');

const ROW_H = 26;          // must match .log-row height in style.css
const LANE_W = 12;
const LANE_COLORS = ['#3574f0', '#5fb865', '#d6b85a', '#c678dd', '#56b6c2', '#e06c5b'];

const listEl = $('log-list');
let expanded = null;       // sha whose file list is open
let rows = [];

function laneColor(i) { return LANE_COLORS[i % LANE_COLORS.length]; }
function laneX(i) { return 8 + i * LANE_W; }

async function loadLog() {
  const s = cur(); if (!s) return;
  const all = $('log-all').checked;
  const res = await ipcRenderer.invoke('git-log', { cwd: s.cwd, limit: 300, all });
  if (!res || res.error) {
    listEl.innerHTML = `<div class="git-error">${escapeHtml((res && res.error) || 'Not a git repository.')}</div>`;
    return;
  }
  rows = layoutGraph(parseLog(res.out));
  render();
}

function render() {
  listEl.innerHTML = '';
  if (!rows.length) { listEl.innerHTML = '<div class="no-results">No commits.</div>'; return; }
  const maxLanes = rows.reduce((m, r) => Math.max(m, r.width), 1);
  const gutter = laneX(maxLanes - 1) + 10;

  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'log-row' + (expanded === r.hash ? ' open' : '');
    row.appendChild(graphCell(r, gutter));

    const meta = document.createElement('div');
    meta.className = 'log-meta';
    meta.innerHTML =
      `<span class="log-sha">${escapeHtml(r.short)}</span>` +
      refChips(r.refs) +
      `<span class="log-subject">${escapeHtml(r.subject)}</span>` +
      `<span class="log-author">${escapeHtml(r.author)}</span>` +
      `<span class="log-date">${escapeHtml(r.date)}</span>`;
    row.appendChild(meta);
    row.onclick = () => toggle(r.hash);
    listEl.appendChild(row);

    if (expanded === r.hash) {
      const files = document.createElement('div');
      files.className = 'log-files';
      files.textContent = 'Loading…';
      files.style.paddingLeft = gutter + 'px';
      listEl.appendChild(files);
      fillFiles(files, r);
    }
  }
}

// Three or more decorations squeeze the subject out of a narrow panel, so show
// the two most useful and count the rest.
function refChips(refs) {
  if (!refs || !refs.length) return '';
  const rank = r => (r.startsWith('HEAD') ? 0 : r.startsWith('tag: ') ? 1 : r.includes('/') ? 3 : 2);
  const sorted = refs.slice().sort((a, b) => rank(a) - rank(b));
  const shown = sorted.slice(0, 2);
  const extra = sorted.length - shown.length;
  return shown.map(ref => {
    const head = ref.startsWith('HEAD');
    const remote = ref.startsWith('origin/') || ref.includes('/');
    const cls = head ? 'ref-head' : (ref.startsWith('tag: ') ? 'ref-tag' : (remote ? 'ref-remote' : 'ref-local'));
    return `<span class="log-ref ${cls}">${escapeHtml(ref.replace(/^tag: /, ''))}</span>`;
  }).join('') + (extra > 0 ? `<span class="log-ref ref-more" title="${escapeHtml(sorted.join(', '))}">+${extra}</span>` : '');
}

// One SVG per row: vertical/diagonal segments for every lane crossing this row,
// plus the commit's own dot. Merges get a hollow dot.
function graphCell(r, gutter) {
  const cell = document.createElement('div');
  cell.className = 'log-graph';
  cell.style.flex = `0 0 ${gutter}px`;

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', gutter);
  svg.setAttribute('height', ROW_H);

  for (const l of r.links) {
    const x1 = laneX(l.from), x2 = laneX(l.to);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', x1 === x2
      ? `M${x1} 0 L${x1} ${ROW_H}`
      : `M${x1} 0 C${x1} ${ROW_H / 2}, ${x2} ${ROW_H / 2}, ${x2} ${ROW_H}`);
    p.setAttribute('stroke', laneColor(l.to));
    p.setAttribute('stroke-width', '1.6');
    p.setAttribute('fill', 'none');
    svg.appendChild(p);
  }

  const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  dot.setAttribute('cx', laneX(r.lane));
  dot.setAttribute('cy', ROW_H / 2);
  dot.setAttribute('r', r.merge ? 4 : 3.5);
  dot.setAttribute('fill', r.merge ? 'var(--panel)' : laneColor(r.lane));
  dot.setAttribute('stroke', laneColor(r.lane));
  dot.setAttribute('stroke-width', '1.8');
  svg.appendChild(dot);

  cell.appendChild(svg);
  return cell;
}

function toggle(sha) {
  expanded = expanded === sha ? null : sha;
  render();
}

async function fillFiles(host, r) {
  const s = cur(); if (!s) return;
  const res = await ipcRenderer.invoke('git-commit-files', { cwd: s.cwd, sha: r.hash });
  const files = (res && res.files) || [];
  host.innerHTML = '';
  if (!files.length) {
    host.innerHTML = '<div class="log-nofiles">No file changes in this commit.</div>';
    return;
  }
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'log-file';
    row.innerHTML =
      `<span class="g-status g-${statusClassOf(f.status)}">${escapeHtml(f.status)}</span>` +
      `<span class="g-name" title="${escapeHtml(f.path)}">${escapeHtml(f.path.split('/').pop())}</span>` +
      `<span class="g-dir">${escapeHtml(f.orig ? '← ' + f.orig : dirOf(f.path))}</span>`;
    row.onclick = e => { e.stopPropagation(); openCommitDiff(s, r, f.path); };
    host.appendChild(row);
  }
}
function dirOf(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; }
function statusClassOf(c) { return ({ M: 'mod', A: 'add', D: 'del', R: 'ren', C: 'ren' })[c] || 'mod'; }

async function openCommitDiff(s, r, file) {
  const body = await ipcRenderer.invoke('git-commit-diff', { cwd: s.cwd, sha: r.hash, file });
  addTab(s, {
    path: `diff:${r.short}:${file}`,
    name: `${file.split('/').pop()} @ ${r.short}`,
    kind: 'diff',
    body: (body && body.trim()) ? body : '(no textual diff)',
    src: file,
    ext: 'diff'
  });
  if (s.key === activeKey) { renderTabbar(); renderViewer(); }
}

$('log-refresh').onclick = loadLog;
$('log-all').onchange = loadLog;

window.loadLog = loadLog;

})();
