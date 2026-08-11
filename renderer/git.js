/* ===================== git panel (JetBrains-style commit window) =====================
 * Loaded after renderer.js and relies on its globals: $, cur, toast, addTab,
 * escapeHtml, renderTabbar, renderViewer, activeKey, ipcRenderer, pollStatus.
 *
 * The checkboxes are the commit, not the index. Checking a file marks it for
 * inclusion; main.js stages the checked set at commit time and leaves the rest
 * of the index alone. That is how Rider behaves, and it is why the old
 * Staged/Changes split and its drag-and-drop are gone.
 */
'use strict';

// Wrapped so nothing leaks into the global scope. A classic <script> shares one
// realm with renderer.js, and a bare `function buildTree` here silently replaced
// the file explorer's own buildTree, breaking the Files panel.
(function () {

const gitChanges = $('git-changes');

// Per-repo UI state, kept across refreshes so a poll doesn't reset your picks.
const gitState = new Map(); // cwd -> { unchecked:Set<path>, collapsed:Set<dir>, amend:bool }
function gstate(cwd) {
  if (!gitState.has(cwd)) gitState.set(cwd, { unchecked: new Set(), collapsed: new Set(), amend: false });
  return gitState.get(cwd);
}

function basename(p) { return p.split('/').pop(); }
function dirpart(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; }
function statusLetter(f) {
  if (f.conflicted) return 'U';
  if (f.untracked) return 'A';
  const c = f.staged ? f.index : f.work;
  return c === ' ' ? 'M' : c;
}
function statusClass(c) { return ({ M: 'mod', A: 'add', D: 'del', R: 'ren', U: 'con' })[c] || 'mod'; }

/* ---------- folder tree, with single-child directories compacted ---------- */
function buildTree(files) {
  const root = { name: '', children: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    parts.pop();
    let node = root;
    for (const p of parts) {
      if (!node.children.has(p)) node.children.set(p, { name: p, children: new Map(), files: [] });
      node = node.children.get(p);
    }
    node.files.push(f);
  }
  compact(root);
  return root;
}
// `src` holding only `deep` holding only files renders as `src/deep`, like
// IntelliJ's compacted middle packages.
function compact(node) {
  for (const child of node.children.values()) {
    compact(child);
    while (child.files.length === 0 && child.children.size === 1) {
      const only = child.children.values().next().value;
      child.name = child.name + '/' + only.name;
      child.children = only.children;
      child.files = only.files;
    }
  }
}

/* ---------- render ---------- */
async function loadGit() {
  const s = cur(); if (!s) return;
  const st = await ipcRenderer.invoke('git-status', { cwd: s.cwd });

  if (!st || !st.repo) {
    setHead('not a git repo', '');
    gitChanges.innerHTML = '<div class="no-results">Not a git repository.</div>';
    $('git-count').textContent = '';
    return;
  }
  if (st.error) {
    setHead('git error', '');
    gitChanges.innerHTML = `<div class="git-error">${escapeHtml(st.error)}</div>`;
    $('git-count').textContent = '';
    return;
  }

  const g = gstate(s.cwd);
  setHead(st.detached ? `HEAD (detached)` : (st.branch || 'HEAD'),
          [st.ahead ? `↑${st.ahead}` : '', st.behind ? `↓${st.behind}` : ''].filter(Boolean).join(' '));
  $('git-count').textContent = st.files.length ? ` ${st.files.length}` : '';

  // Drop remembered unchecks for paths that no longer exist, so a path that
  // comes back later isn't silently excluded.
  const live = new Set(st.files.map(f => f.path));
  for (const p of [...g.unchecked]) if (!live.has(p)) g.unchecked.delete(p);

  gitChanges.innerHTML = '';
  if (!st.files.length) {
    gitChanges.innerHTML = '<div class="no-results">No changes.</div>';
    updateCommitEnabled(0, st.files.length);
    return;
  }

  const conflicts = st.files.filter(f => f.conflicted).length;
  const head = document.createElement('div');
  head.className = 'git-group';
  const allChecked = st.files.every(f => !g.unchecked.has(f.path));
  head.innerHTML =
    `<input type="checkbox" class="g-check g-check-all" ${allChecked ? 'checked' : ''} title="Select all">` +
    `<span class="g-group-label">Changes · ${st.files.length}</span>` +
    (conflicts ? `<span class="g-conflicts">${conflicts} conflicted</span>` : '');
  head.querySelector('.g-check-all').onchange = ev => {
    if (ev.target.checked) g.unchecked.clear();
    else st.files.forEach(f => g.unchecked.add(f.path));
    loadGit();
  };
  gitChanges.appendChild(head);

  const tree = buildTree(st.files);
  renderNode(tree, gitChanges, '', 0, s, g);
  updateCommitEnabled(st.files.length - g.unchecked.size, st.files.length);
}

function setHead(branch, aheadBehind) {
  $('git-branch').textContent = branch;
  $('git-aheadbehind').textContent = aheadBehind;
}

function renderNode(node, host, prefix, depth, s, g) {
  for (const child of [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = prefix + child.name;
    const collapsed = g.collapsed.has(key);
    const row = document.createElement('div');
    row.className = 'git-dir';
    row.style.paddingLeft = (6 + depth * 12) + 'px';
    row.innerHTML = `<span class="g-twisty">${collapsed ? '▸' : '▾'}</span>` +
                    `<span class="g-dirname">${escapeHtml(child.name)}</span>`;
    row.onclick = () => {
      if (collapsed) g.collapsed.delete(key); else g.collapsed.add(key);
      loadGit();
    };
    host.appendChild(row);
    if (!collapsed) renderNode(child, host, key + '/', depth + 1, s, g);
  }
  for (const f of node.files.slice().sort((a, b) => a.path.localeCompare(b.path))) {
    host.appendChild(fileRow(f, depth, s, g));
  }
}

function fileRow(f, depth, s, g) {
  const letter = statusLetter(f);
  const row = document.createElement('div');
  row.className = 'git-file' + (f.conflicted ? ' conflicted' : '');
  row.style.paddingLeft = (6 + depth * 12) + 'px';
  row.innerHTML =
    `<input type="checkbox" class="g-check" ${g.unchecked.has(f.path) ? '' : 'checked'}>` +
    `<span class="g-status g-${statusClass(letter)}">${letter}</span>` +
    `<span class="g-name" title="${escapeHtml(f.path)}">${escapeHtml(basename(f.path))}</span>` +
    (f.orig ? `<span class="g-dir">← ${escapeHtml(f.orig)}</span>` : '');
  row.querySelector('.g-check').onchange = ev => {
    ev.stopPropagation();
    if (ev.target.checked) g.unchecked.delete(f.path); else g.unchecked.add(f.path);
    const total = gitChanges.querySelectorAll('.git-file').length;
    updateCommitEnabled(total - g.unchecked.size, total);
    const all = gitChanges.querySelector('.g-check-all');
    if (all) all.checked = g.unchecked.size === 0;
  };
  row.onclick = e => { if (!e.target.closest('.g-check')) openDiff(s, f.path, f.staged); };
  return row;
}

function updateCommitEnabled(selected, total) {
  const btn = $('git-commit'), both = $('git-commit-push');
  const amend = $('git-amend') && $('git-amend').checked;
  const off = selected === 0 && !amend;
  if (btn) { btn.disabled = off; btn.textContent = selected && selected !== total ? `Commit (${selected})` : 'Commit'; }
  if (both) both.disabled = off;
}

function checkedPaths() {
  const s = cur(); if (!s) return [];
  const g = gstate(s.cwd);
  return [...gitChanges.querySelectorAll('.git-file')]
    .map(r => r.querySelector('.g-name').getAttribute('title'))
    .filter(p => p && !g.unchecked.has(p));
}

async function openDiff(s, file, staged) {
  let diff = await ipcRenderer.invoke('git-diff', { cwd: s.cwd, file, staged });
  if (!diff || !diff.trim()) diff = await ipcRenderer.invoke('git-diff', { cwd: s.cwd, file, staged: !staged });
  const body = (diff && diff.trim()) ? diff : '(no textual diff — binary file or no line changes)';
  addTab(s, { path: 'diff:' + file, name: basename(file), kind: 'diff', body, src: file, ext: 'diff' });
  if (s.key === activeKey) { renderTabbar(); renderViewer(); }
}

/* ---------- actions ---------- */
async function doCommit(thenPush) {
  const s = cur(); if (!s) return false;
  const g = gstate(s.cwd);
  const msg = $('git-message').value.trim();
  if (!msg) { $('git-message').focus(); return false; }
  const paths = checkedPaths();
  const amend = $('git-amend').checked;
  if (!paths.length && !amend) { toast('Nothing selected to commit', true); return false; }

  const btns = [$('git-commit'), $('git-commit-push')];
  btns.forEach(b => b && (b.disabled = true));
  const r = await ipcRenderer.invoke('git-commit', { cwd: s.cwd, message: msg, paths, amend });
  btns.forEach(b => b && (b.disabled = false));

  if (!r.ok) {
    toast(firstErrLine(r.err) || 'Commit failed', true);
    loadGit();
    return false;
  }
  $('git-message').value = '';
  $('git-amend').checked = false;
  g.amend = false;
  g.unchecked.clear();
  toast(amend ? 'Amended' : `Committed ${paths.length} file${paths.length === 1 ? '' : 's'}`);
  if (thenPush) return doPush();
  loadGit();
  return true;
}

async function doPush() {
  const s = cur(); if (!s) return false;
  const el = $('git-push');
  el.classList.add('busy');
  const r = await ipcRenderer.invoke('git-push', { cwd: s.cwd });
  el.classList.remove('busy');
  toast(r.ok ? 'Pushed' : (firstErrLine(r.err) || 'Push failed'), !r.ok);
  loadGit();
  return r.ok;
}

/* ---------- push dialog: show what would leave before it leaves ---------- */
const pushOverlay = $('push-overlay');
let pushResolve = null;

async function confirmPush() {
  const s = cur(); if (!s) return false;
  const info = await ipcRenderer.invoke('git-outgoing', { cwd: s.cwd });
  const commits = (info && info.commits) || [];
  if (!commits.length) { toast('Nothing to push', true); return false; }

  $('push-title').textContent = info.upstream
    ? `Push ${commits.length} commit${commits.length === 1 ? '' : 's'} to ${info.upstream}`
    : `Push ${commits.length} commit${commits.length === 1 ? '' : 's'} and create the remote branch`;
  const list = $('push-list');
  list.innerHTML = '';
  for (const c of commits) {
    const row = document.createElement('div');
    row.className = 'push-commit';
    row.innerHTML =
      `<span class="pc-sha">${escapeHtml(c.sha)}</span>` +
      `<span class="pc-subject">${escapeHtml(c.subject || '')}</span>` +
      `<span class="pc-meta">${escapeHtml(c.author || '')} · ${escapeHtml(c.date || '')}</span>`;
    list.appendChild(row);
  }
  pushOverlay.style.display = 'flex';

  const ok = await new Promise(res => { pushResolve = res; });
  closePush();
  if (!ok) return false;
  return doPush();
}

function closePush() {
  pushOverlay.style.display = 'none';
  if (pushResolve) { const r = pushResolve; pushResolve = null; r(false); }
}
$('push-close').onclick = closePush;
$('push-cancel').onclick = closePush;
$('push-confirm').onclick = () => { if (pushResolve) { const r = pushResolve; pushResolve = null; r(true); } };
pushOverlay.onclick = e => { if (e.target === pushOverlay) closePush(); };
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && pushOverlay.style.display === 'flex') closePush();
});

/* ---------- update project ---------- */
async function doUpdate() {
  const s = cur(); if (!s) return;
  const el = $('git-update');
  el.classList.add('busy');
  const r = await ipcRenderer.invoke('git-pull', { cwd: s.cwd });
  el.classList.remove('busy');
  if (r.ok) {
    const line = firstOutLine(r.out);
    toast(/up to date/i.test(r.out) ? 'Already up to date' : (line || 'Updated'));
  } else {
    toast(firstErrLine(r.err) || 'Update failed', true);
  }
  loadGit();
}
function firstOutLine(out) {
  const lines = String(out || '').split('\n').map(s => s.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

/* ---------- background fetch ----------
 * ahead/behind comes from the last fetched remote ref, so without this "behind"
 * is permanently 0. Failures stay silent: being offline is not an error worth a
 * toast every few minutes.
 */
const FETCH_INTERVAL_MS = 3 * 60 * 1000;
let fetching = false;
async function backgroundFetch() {
  const s = cur();
  if (!s || fetching || !navigator.onLine) return;
  fetching = true;
  try {
    const r = await ipcRenderer.invoke('git-fetch', { cwd: s.cwd });
    if (r && r.ok) loadGit();
  } catch {} finally {
    fetching = false;
  }
}
setInterval(backgroundFetch, FETCH_INTERVAL_MS);
// One fetch shortly after launch so the first ahead/behind shown is real.
setTimeout(backgroundFetch, 4000);

function firstErrLine(err) {
  const lines = String(err || '').split('\n').map(s => s.trim()).filter(Boolean);
  // git leads with progress noise on failure too; prefer the line that says why.
  return lines.find(l => /^(fatal|error|hint):/i.test(l)) || lines[0] || '';
}

/* ---------- wiring ---------- */
$('git-refresh').onclick = loadGit;
$('git-update').onclick = doUpdate;
$('git-commit').onclick = () => doCommit(false);
$('git-commit-push').onclick = () => doCommit(true);
$('git-push').onclick = confirmPush;
$('git-amend').onchange = async ev => {
  const s = cur(); if (!s) return;
  gstate(s.cwd).amend = ev.target.checked;
  if (ev.target.checked && !$('git-message').value.trim()) {
    const last = await ipcRenderer.invoke('git-last-message', { cwd: s.cwd });
    if (last) $('git-message').value = last;
  }
  const total = gitChanges.querySelectorAll('.git-file').length;
  updateCommitEnabled(total - gstate(s.cwd).unchecked.size, total);
};

// renderer.js calls loadGit() from three places; this is the only export.
window.loadGit = loadGit;

})();
