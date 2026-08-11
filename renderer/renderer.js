const { ipcRenderer, webUtils } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const MarkdownIt = require('markdown-it');

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
const hljs = require('highlight.js');
const { parseUnifiedDiff, pairRows, countChanges } = require('../lib/diff-parse');

const HLJS_THEMES = ['atom-one-dark', 'tokyo-night-dark', 'github-dark', 'nord', 'monokai', 'vs2015'];
let codeTheme = localStorage.getItem('clide-code-theme') || 'atom-one-dark';
function setCodeTheme(name) {
  codeTheme = name;
  localStorage.setItem('clide-code-theme', name);
  document.getElementById('hljs-theme').href = '../node_modules/highlight.js/styles/' + name + '.css';
}
setCodeTheme(codeTheme);
const EXT_LANG = {
  '.js': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.json': 'json', '.html': 'xml', '.css': 'css', '.sh': 'bash',
  '.yml': 'yaml', '.yaml': 'yaml', '.md': 'markdown'
};
function langFromExt(ext) { return EXT_LANG[ext] || null; }

const TERM_OPTS = {
  fontFamily: '"JetBrains Mono", "SF Mono", Menlo, monospace',
  fontSize: 13, lineHeight: 1.3, cursorBlink: true,
  theme: {
    background: '#1e1f22', foreground: '#dfe1e5', cursor: '#3574f0',
    selectionBackground: '#2e436e', black: '#1e1f22', red: '#e06c5b',
    green: '#5fb865', yellow: '#d6b85a', blue: '#3574f0', magenta: '#c678dd',
    cyan: '#56b6c2', white: '#dfe1e5', brightBlack: '#6f737a', brightRed: '#ff7a68',
    brightGreen: '#70cf78', brightYellow: '#e6c66a', brightBlue: '#5a8bff',
    brightMagenta: '#d68fee', brightCyan: '#66c6d2', brightWhite: '#ffffff'
  }
};

const ICON = {
  caret: '<svg class="caret" viewBox="0 0 16 16"><path d="M6 4 L10 8 L6 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="ficon folder" viewBox="0 0 16 16"><path d="M1.5 4.2c0-.6.4-1 1-1h3.3l1.2 1.3h6.3c.5 0 1 .4 1 1v6.1c0 .5-.5 1-1 1H2.5c-.6 0-1-.5-1-1z" fill="currentColor" opacity=".9"/></svg>',
  file: '<svg class="ficon file" viewBox="0 0 16 16"><path d="M4 2h5l3 3v9H4z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 2v3h3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>'
};

/* ===================== sessions ===================== */
const sessions = new Map(); // key -> session
const order = [];
let activeKey = null;

const $ = id => document.getElementById(id);
const cur = () => sessions.get(activeKey) || null;

const terminalsEl = $('terminals');
const sessionTabs = $('session-tabs');

async function startSession({ cwd, resumeId, title, restoreTabs, restoreActive }) {
  const res = await ipcRenderer.invoke('session-start', { cwd, resumeId });
  if (!res || res.error) { console.error('session-start failed', res && res.error); return; }
  const s = {
    key: res.key, cwd: res.cwd, repo: res.repo,
    title: title || res.repo, resumed: !!resumeId, resumeId: resumeId || null,
    viewerTabs: [], activeViewer: -1, fileList: null, savedOnce: false, unread: false,
    treeBuilt: false, navStack: [], navIndex: -1, closedTabs: []
  };
  // terminal
  const el = document.createElement('div');
  el.className = 'term'; el.style.display = 'none';
  terminalsEl.appendChild(el);
  const term = new Terminal(TERM_OPTS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(d => ipcRenderer.send('session-input', { key: s.key, data: d }));
  term.onBell(() => notifyClaude(s));
  s.term = term; s.fit = fit; s.termEl = el;

  sessions.set(s.key, s);
  order.push(s.key);
  renderSessionTabs();
  switchSession(s.key);

  if (restoreTabs && restoreTabs.length) {
    for (const p of restoreTabs) { try { await openInSession(s.key, p); } catch {} }
    if (restoreActive) {
      const i = s.viewerTabs.findIndex(t => t.path === restoreActive);
      if (i >= 0) { s.activeViewer = i; if (s.key === activeKey) { renderTabbar(); renderViewer(); } }
    }
  }
  return s;
}

function switchSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  activeKey = key;
  s.unread = false;
  Panes.show(key);
  renderSessionTabs();
  buildTree(s);
  $('search').value = '';
  $('tree').style.display = 'block';
  $('results').style.display = 'none';
  renderTabbar();
  renderViewer();
  updateNav();
  if (panelMode === 'git') loadGit();
  setTimeout(() => { fitActive(); s.term.focus(); }, 0);
  pollStatus();
}

function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  ipcRenderer.send('session-kill', { key });
  for (const t of s.viewerTabs) unrefWatch(t);
  s.term.dispose();
  s.termEl.remove();
  sessions.delete(key);
  const i = order.indexOf(key);
  if (i >= 0) order.splice(i, 1);
  Panes.remove(key);
  if (activeKey === key) {
    if (order.length) switchSession(order[Math.max(0, i - 1)]);
    else { activeKey = null; renderSessionTabs(); renderTabbar(); renderViewer(); renderStatus(null); }
  } else {
    renderSessionTabs();
  }
}

function renderSessionTabs() {
  sessionTabs.innerHTML = '';
  for (const key of order) {
    const s = sessions.get(key);
    const el = document.createElement('div');
    el.className = 'stab' + (key === activeKey ? ' active' : '');
    el.innerHTML =
      `${s.unread ? '<span class="sdot"></span>' : ''}` +
      `<span class="srepo">${s.repo}</span>` +
      `<span class="stitle">${s.resumed ? '↺ ' : ''}${escapeHtml(s.title)}</span>` +
      `<span class="sclose" title="Close">✕</span>`;
    el.onclick = () => switchSession(key);
    el.querySelector('.sclose').onclick = e => { e.stopPropagation(); closeSession(key); };
    sessionTabs.appendChild(el);
  }
}

/* pty + open routing */
ipcRenderer.on('pty-data', (_e, { key, data }) => { const s = sessions.get(key); if (s) s.term.write(data); });
ipcRenderer.on('session-exit', (_e, { key }) => { const s = sessions.get(key); if (s) s.term.write('\r\n\x1b[90m[claude exited — ⌘W to close tab]\x1b[0m\r\n'); });
ipcRenderer.on('open-file', (_e, { key, path: p }) => openInSession(key || activeKey, p));

/* Claude edits a file from the terminal while it sits open in the panel. Every
 * tab on that path takes the new content, unless it has unsaved edits, in which
 * case it is flagged and the user decides. */
ipcRenderer.on('file-changed', (_e, data) => {
  let touchedActive = false;
  for (const s of sessions.values()) {
    for (const t of s.viewerTabs) {
      if (t.path !== data.path || !watchable(t)) continue;
      if (t.dirty) { t.stale = true; t.diskBody = data.content; }
      else {
        Object.assign(t, data, { dirty: false, stale: false });
        t.body = data.content !== undefined ? data.content : t.body;
      }
      // Deliberately not marking the session unread: that dot means "Claude is
      // waiting for you", and a file changing on disk is not that.
      if (s.key === activeKey && s.viewerTabs[s.activeViewer] === t) touchedActive = true;
    }
  }
  renderTabbar();
  if (touchedActive) rerenderPreservingScroll();
});

// The viewer is rebuilt from scratch on every render, so an unattended reload
// would otherwise throw the reader back to the top of the file.
function rerenderPreservingScroll() {
  const scroller = viewer.querySelector('.code-view, .md-body, .editor, .diff, .text-body');
  const top = scroller ? scroller.scrollTop : 0;
  const left = scroller ? scroller.scrollLeft : 0;
  const cls = scroller ? scroller.className : null;
  renderViewer();
  if (!cls) return;
  const next = viewer.querySelector('.' + cls.split(' ').filter(Boolean).join('.'));
  if (next) { next.scrollTop = top; next.scrollLeft = left; }
}

// Offered when the file changed underneath unsaved edits.
function reloadFromDisk(t) {
  if (t.diskBody === undefined) return;
  t.body = t.diskBody;
  t.content = t.diskBody;
  t.dirty = false; t.stale = false; t.diskBody = undefined;
  renderTabbar(); renderViewer();
}
function keepMine(t) { t.stale = false; t.diskBody = undefined; renderTabbar(); renderViewer(); }

async function openInSession(key, p) {
  const s = sessions.get(key) || cur();
  if (!s) return;
  try {
    const data = await ipcRenderer.invoke('read-file', p);
    addTab(s, data);
    if (s.key === activeKey) { renderTabbar(); renderViewer(); }
    else { s.unread = true; renderSessionTabs(); }
  } catch (err) {
    s.term.write(`\r\n[clide: cannot open ${p}: ${err.message}]\r\n`);
  }
}

/* ===================== terminal sizing / split ===================== */
// Every session currently mounted in a pane needs fitting, not just the focused
// one, or the panes you aren't typing in keep the wrong cols/rows.
function fitActive() {
  for (const s of sessions.values()) {
    if (!s.termEl || !terminalsEl.contains(s.termEl)) continue;
    try { s.fit.fit(); } catch {}
    ipcRenderer.send('session-resize', { key: s.key, cols: s.term.cols, rows: s.term.rows });
  }
}
window.addEventListener('resize', fitActive);

const split = $('main');
let dragMode = null; // 'right' | 'left'
$('divider').addEventListener('mousedown', () => { dragMode = 'right'; document.body.style.userSelect = 'none'; });
$('divider-left').addEventListener('mousedown', () => { dragMode = 'left'; document.body.style.userSelect = 'none'; });
window.addEventListener('mouseup', () => { if (dragMode) { dragMode = null; document.body.style.userSelect = ''; fitActive(); } });
window.addEventListener('mousemove', e => {
  if (!dragMode) return;
  const rect = split.getBoundingClientRect();
  if (dragMode === 'right') {
    const right = rect.right - e.clientX;
    if (right > 260 && right < rect.width - 360) { $('right').style.flex = `0 0 ${right}px`; fitActive(); }
  } else {
    const left = e.clientX - rect.left;
    if (left > 160 && left < rect.width - 400) { explorer.style.flex = `0 0 ${left}px`; fitActive(); }
  }
});

/* ===================== explorer ===================== */
const tree = $('tree');
const results = $('results');
const explorer = $('explorer');
const explorerShow = $('explorer-show');
const searchInput = $('search');

$('explorer-toggle').onclick = () => setExplorer(false);
explorerShow.onclick = () => setExplorer(true);
function setExplorer(show) {
  explorer.style.display = show ? 'flex' : 'none';
  $('divider-left').style.display = show ? 'block' : 'none';
  explorerShow.style.display = show ? 'none' : 'flex';
  fitActive();
}

async function buildTree(s) {
  tree.innerHTML = '';
  tree.appendChild(await dirNode(s.cwd, 0, true));
}
async function dirNode(dirPath, depth, open) {
  const wrap = document.createElement('div');
  const children = document.createElement('div');
  children.style.display = open ? 'block' : 'none';
  let loaded = false;
  async function load() {
    if (loaded) return; loaded = true;
    const entries = await ipcRenderer.invoke('read-dir', dirPath);
    for (const e of entries) {
      if (e.dir) children.appendChild(await dirNode(e.path, depth + 1, false));
      else children.appendChild(fileNode(e, depth + 1));
    }
  }
  if (depth > 0) {
    const row = rowEl(dirPath.split('/').pop(), depth, true);
    row.onclick = async () => {
      const showing = children.style.display === 'block';
      if (!showing) { await load(); children.style.display = 'block'; row.classList.add('open'); }
      else { children.style.display = 'none'; row.classList.remove('open'); }
    };
    wrap.appendChild(row);
  } else { await load(); }
  wrap.appendChild(children);
  return wrap;
}
function fileNode(e, depth) {
  const row = rowEl(e.name, depth, false);
  row.onclick = () => openInSession(activeKey, e.path);
  row.draggable = true;
  row.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/plain', e.path); ev.dataTransfer.effectAllowed = 'copy'; });
  return row;
}
function rowEl(label, depth, isDir) {
  const row = document.createElement('div');
  row.className = 'row' + (isDir ? ' dir' : '');
  row.style.paddingLeft = (6 + depth * 13) + 'px';
  row.innerHTML = (isDir ? ICON.caret + ICON.folder : '<span class="caret-spacer"></span>' + ICON.file) +
    `<span class="label">${escapeHtml(label)}</span>`;
  return row;
}

/* fuzzy search (per session) */
let searchTimer = null;
function fuzzy(query, items) {
  const q = query.toLowerCase();
  const scored = [];
  for (const it of items) {
    const t = it.rel.toLowerCase();
    let qi = 0, ti = 0, start = -1, gaps = 0, last = -1;
    while (qi < q.length && ti < t.length) {
      if (q[qi] === t[ti]) {
        if (start < 0) start = ti;
        if (last >= 0 && ti - last > 1) gaps += ti - last;
        last = ti; qi++;
      }
      ti++;
    }
    if (qi === q.length) {
      const nameHit = it.name.toLowerCase().includes(q) ? -50 : 0;
      scored.push({ it, score: start + gaps + nameHit });
    }
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, 200).map(s => s.it);
}
async function runSearch(q) {
  const s = cur(); if (!s) return;
  if (!q) { tree.style.display = 'block'; results.style.display = 'none'; return; }
  if (!s.fileList) s.fileList = await ipcRenderer.invoke('list-files', s.cwd);
  const hits = fuzzy(q, s.fileList);
  tree.style.display = 'none';
  results.style.display = 'block';
  results.innerHTML = '';
  if (!hits.length) { results.innerHTML = '<div class="no-results">No files match</div>'; return; }
  for (const h of hits) {
    const row = document.createElement('div');
    row.className = 'row result';
    const dir = h.rel.includes('/') ? h.rel.slice(0, h.rel.lastIndexOf('/') + 1) : '';
    row.innerHTML = ICON.file +
      `<span class="label"><span class="rname">${escapeHtml(h.name)}</span>${dir ? `<span class="rdir">${escapeHtml(dir)}</span>` : ''}</span>`;
    row.onclick = () => openInSession(activeKey, h.path);
    row.draggable = true;
    row.addEventListener('dragstart', ev => { ev.dataTransfer.setData('text/plain', h.path); ev.dataTransfer.effectAllowed = 'copy'; });
    results.appendChild(row);
  }
}
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  searchTimer = setTimeout(() => runSearch(q), 110);
});
$('search-clear').onclick = () => { searchInput.value = ''; runSearch(''); searchInput.focus(); };
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Escape') { searchInput.value = ''; runSearch(''); }
  if (e.key === 'Enter') { const f = results.querySelector('.row.result'); if (f) f.click(); }
});

/* ===================== viewer tabs (per session) ===================== */
const tabbar = $('tabbar');
const viewer = $('viewer');

let navigating = false;
function pushNav(s, path) {
  if (navigating || !path) return;
  if (s.navStack[s.navIndex] === path) return;
  s.navStack = s.navStack.slice(0, s.navIndex + 1);
  s.navStack.push(path);
  s.navIndex = s.navStack.length - 1;
  if (s.navStack.length > 100) { s.navStack.shift(); s.navIndex--; }
  if (s === cur()) updateNav();
}

// Diff and welcome tabs are synthetic; only real files on disk get watched.
function watchable(t) { return t && t.path && t.kind !== 'diff' && t.kind !== 'welcome'; }
function refWatch(t) { if (watchable(t)) ipcRenderer.send('watch-file', t.path); }
function unrefWatch(t) { if (watchable(t)) ipcRenderer.send('unwatch-file', t.path); }

function addTab(s, data) {
  const i = s.viewerTabs.findIndex(t => t.path === data.path);
  if (i >= 0) { s.viewerTabs[i] = Object.assign(s.viewerTabs[i], data, { dirty: false, stale: false }); s.activeViewer = i; pushNav(s, data.path); return; }
  refWatch(data);
  // File tabs carry `content`; diff tabs build their text as `body` directly.
  // Defaulting to data.content unconditionally left every freshly opened diff blank.
  s.viewerTabs.push({ ...data, dirty: false, mdMode: 'rendered', body: data.body !== undefined ? data.body : data.content });
  s.activeViewer = s.viewerTabs.length - 1;
  pushNav(s, data.path);
}
function closeTab(i) {
  const s = cur(); if (!s) return;
  const t = s.viewerTabs[i];
  if (t && t.kind !== 'diff') s.closedTabs.push(t.path);
  unrefWatch(t);
  s.viewerTabs.splice(i, 1);
  if (s.activeViewer >= s.viewerTabs.length) s.activeViewer = s.viewerTabs.length - 1;
  renderTabbar(); renderViewer();
}
function selectTab(i) {
  const s = cur(); if (!s) return;
  s.activeViewer = i; pushNav(s, s.viewerTabs[i].path);
  renderTabbar(); renderViewer();
}

function renderTabbar() {
  tabbar.innerHTML = '';
  const s = cur(); if (!s) return;
  s.viewerTabs.forEach((t, i) => {
    const el = document.createElement('div');
    el.className = 'tab' + (i === s.activeViewer ? ' active' : '');
    el.innerHTML = `${t.dirty ? '<span class="dot">●</span>' : ''}<span class="name">${escapeHtml(t.name)}</span><span class="close">✕</span>`;
    el.onclick = () => selectTab(i);
    el.querySelector('.close').onclick = e => { e.stopPropagation(); closeTab(i); };
    tabbar.appendChild(el);
  });
}

function renderViewer() {
  const s = cur();
  viewer.innerHTML = '';
  if (!s || s.activeViewer < 0 || !s.viewerTabs[s.activeViewer]) {
    viewer.innerHTML = '<div class="empty">Files Claude opens appear here.<br>Click a file in the tree, or ask Claude to open one.</div>';
    return;
  }
  const t = s.viewerTabs[s.activeViewer];
  updateNav();
  if (t.kind === 'welcome') return renderWelcome(s, t);
  if (t.kind === 'diff') return renderDiff(t);
  if (t.kind === 'image') renderImage(t);
  else if (t.kind === 'html') renderHtml(s, t);
  else if (t.kind === 'markdown') renderMarkdown(s, t);
  else if (t.kind === 'code') renderCode(s, t);
  else renderText(s, t);
  if (t.stale) {
    const pane = viewer.querySelector('.pane');
    if (pane) pane.insertBefore(staleBar(t), pane.firstChild);
  }
}

// Shown only when the file changed on disk while this tab had unsaved edits.
// Without edits the tab just updates silently, which is the common case.
function staleBar(t) {
  const bar = document.createElement('div');
  bar.className = 'stale-bar';
  const msg = document.createElement('span');
  msg.className = 'stale-msg';
  msg.textContent = 'Changed on disk while you had unsaved edits.';
  const reload = btn('Load from disk', 'alt', () => reloadFromDisk(t));
  const keep = btn('Keep mine', 'alt', () => keepMine(t));
  bar.appendChild(msg); bar.appendChild(reload); bar.appendChild(keep);
  return bar;
}

function renderCode(s, t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const body = document.createElement('div');
  const view = btn('Highlighted', 'alt', () => setMode('view'));
  const edit = btn('Edit', 'alt', () => setMode('edit'));
  const copy = btn('Copy', 'primary', () => { navigator.clipboard.writeText(t.body); flash(copy); });
  const save = btn('Save ⌘S', 'alt', () => saveTab(s, t));
  const sel = document.createElement('select');
  sel.className = 'theme-select'; sel.title = 'Code theme';
  sel.innerHTML = HLJS_THEMES.map(n => `<option value="${n}">${n}</option>`).join('');
  sel.value = codeTheme;
  sel.onchange = () => setCodeTheme(sel.value);
  function setMode(m) {
    t.codeMode = m;
    view.classList.toggle('on', m === 'view');
    edit.classList.toggle('on', m === 'edit');
    body.innerHTML = '';
    if (m === 'edit') {
      const ta = document.createElement('textarea'); ta.className = 'editor'; ta.value = t.body; ta.spellcheck = false;
      ta.oninput = () => { t.body = ta.value; markDirty(t); }; body.appendChild(ta);
    } else {
      const pre = document.createElement('pre'); pre.className = 'code-view';
      const code = document.createElement('code'); code.className = 'hljs';
      const lang = langFromExt(t.ext);
      try {
        code.innerHTML = (lang && hljs.getLanguage(lang))
          ? hljs.highlight(t.body, { language: lang }).value
          : hljs.highlightAuto(t.body).value;
      } catch { code.textContent = t.body; }
      pre.appendChild(code); body.appendChild(pre);
    }
  }
  pane.appendChild(toolbar([view, edit, copy, save, spacer(), sel]));
  body.style.cssText = 'flex:1; display:flex; flex-direction:column; overflow:hidden;';
  pane.appendChild(body);
  viewer.appendChild(pane);
  setMode(t.codeMode || 'view');
}

function renderHtml(s, t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const body = document.createElement('div');
  const preview = btn('Preview', 'alt', () => setMode('preview'));
  const source = btn('Source', 'alt', () => setMode('source'));
  const reload = btn('⟳', 'alt', () => { const wv = body.querySelector('webview'); if (wv) wv.reload(); });
  reload.title = 'Reload';
  const copy = btn('Copy', 'primary', () => { navigator.clipboard.writeText(t.body); flash(copy); });
  const save = btn('Save ⌘S', 'alt', () => saveTab(s, t));
  const ext = btn('Open in browser', 'alt', () => ipcRenderer.send('open-external', 'file://' + t.path));
  function setMode(m) {
    t.htmlMode = m;
    preview.classList.toggle('on', m === 'preview');
    source.classList.toggle('on', m === 'source');
    body.innerHTML = '';
    if (m === 'preview') {
      const wv = document.createElement('webview');
      wv.className = 'wv';
      wv.setAttribute('src', 'file://' + t.path);
      wv.setAttribute('allowpopups', 'true');
      body.appendChild(wv);
    } else {
      const ta = document.createElement('textarea'); ta.className = 'editor'; ta.value = t.body; ta.spellcheck = false;
      ta.oninput = () => { t.body = ta.value; markDirty(t); }; body.appendChild(ta);
    }
  }
  pane.appendChild(toolbar([preview, source, reload, copy, save, spacer(), ext]));
  body.style.cssText = 'flex:1; display:flex; flex-direction:column; overflow:hidden;';
  pane.appendChild(body);
  viewer.appendChild(pane);
  setMode(t.htmlMode || 'preview');
}

let diffMode = 'split'; // 'split' | 'unified', remembered across tabs

function renderDiff(t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const reveal = btn('Open file', 'alt', () => openInSession(activeKey, t.src || t.path));
  const toggle = btn(diffMode === 'split' ? 'Unified' : 'Side by side', 'alt', () => {
    diffMode = diffMode === 'split' ? 'unified' : 'split';
    renderViewer();
  });

  let parsed;
  try { parsed = parseUnifiedDiff(t.body || ''); }
  catch { parsed = { files: [] }; }
  const { added, removed } = countChanges(parsed);
  const stat = hint(`+${added} −${removed}`);
  stat.className = 'hint diff-stat';

  pane.appendChild(toolbar([reveal, toggle, spacer(), stat]));

  const box = document.createElement('div');
  box.className = diffMode === 'split' ? 'diff diff-split' : 'diff';

  const lang = langFromExt(extOf(t.src || t.path));
  const files = parsed.files.filter(f => f.hunks.length || f.binary);
  if (!files.length) {
    const empty = document.createElement('div');
    empty.className = 'd-line d-meta';
    empty.textContent = (t.body || '').trim() ? t.body : '(no textual diff)';
    box.appendChild(empty);
  } else if (diffMode === 'split') {
    for (const f of files) renderSplitFile(box, f, lang);
  } else {
    for (const f of files) renderUnifiedFile(box, f, lang);
  }

  pane.appendChild(box);
  viewer.appendChild(pane);
}

// EXT_LANG is keyed with the leading dot ('.js'), so keep it.
function extOf(p) { const b = String(p || '').split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; }

// Highlighting one line at a time loses multi-line context (block comments,
// template literals), which is the accepted trade for aligned rows.
function hl(text, lang) {
  if (!text) return '';
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(text, { language: lang }).value;
  } catch {}
  return escapeHtml(text);
}

function hunkHeader(box, h) {
  const head = document.createElement('div');
  head.className = 'd-hunkbar';
  head.textContent = `@@ −${h.oldStart} +${h.newStart} @@${h.heading ? '  ' + h.heading : ''}`;
  box.appendChild(head);
}

function renderSplitFile(box, f, lang) {
  if (f.newPath !== f.oldPath || f.hunks.length) {
    const title = document.createElement('div');
    title.className = 'd-filebar';
    title.textContent = f.oldPath && f.newPath && f.oldPath !== f.newPath
      ? `${f.oldPath} → ${f.newPath}`
      : (f.newPath || f.oldPath || '');
    box.appendChild(title);
  }
  if (f.binary) {
    const b = document.createElement('div');
    b.className = 'd-line d-meta';
    b.textContent = '(binary file)';
    box.appendChild(b);
    return;
  }
  for (const h of f.hunks) {
    hunkHeader(box, h);
    for (const p of pairRows(h.rows)) {
      const row = document.createElement('div');
      row.className = 'd-row';
      row.innerHTML =
        `<span class="d-num">${p.left ? p.left.oldNo : ''}</span>` +
        `<span class="d-side ${p.left ? (p.kind === 'ctx' ? 'd-ctx' : 'd-del') : 'd-blank'}">${p.left ? hl(p.left.text, lang) : ''}</span>` +
        `<span class="d-num">${p.right ? p.right.newNo : ''}</span>` +
        `<span class="d-side ${p.right ? (p.kind === 'ctx' ? 'd-ctx' : 'd-add') : 'd-blank'}">${p.right ? hl(p.right.text, lang) : ''}</span>`;
      box.appendChild(row);
    }
  }
}

function renderUnifiedFile(box, f, lang) {
  const title = document.createElement('div');
  title.className = 'd-filebar';
  title.textContent = f.newPath || f.oldPath || '';
  box.appendChild(title);
  if (f.binary) {
    const b = document.createElement('div');
    b.className = 'd-line d-meta'; b.textContent = '(binary file)';
    box.appendChild(b);
    return;
  }
  for (const h of f.hunks) {
    hunkHeader(box, h);
    for (const r of h.rows) {
      const row = document.createElement('div');
      row.className = 'd-row d-row-unified';
      const cls = r.type === 'add' ? 'd-add' : r.type === 'del' ? 'd-del' : 'd-ctx';
      const sign = r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' ';
      row.innerHTML =
        `<span class="d-num">${r.oldNo || ''}</span>` +
        `<span class="d-num">${r.newNo || ''}</span>` +
        `<span class="d-side ${cls}"><span class="d-sign">${sign}</span>${hl(r.text, lang)}</span>`;
      box.appendChild(row);
    }
  }
}

function toolbar(children) { const b = document.createElement('div'); b.className = 'toolbar'; children.forEach(c => b.appendChild(c)); return b; }
function btn(label, cls, onClick) { const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = onClick; return b; }
function spacer() { const s = document.createElement('div'); s.className = 'spacer'; return s; }
function hint(txt) { const h = document.createElement('span'); h.className = 'hint'; h.textContent = txt; return h; }
function markDirty(t) { if (!t.dirty) { t.dirty = true; renderTabbar(); } }

async function saveTab(s, t) {
  if (!s.savedOnce) {
    if (!confirm(`Save edits back to:\n${t.path}\n\nThis overwrites the file on disk.`)) return;
    s.savedOnce = true;
  }
  await ipcRenderer.invoke('save-file', { path: t.path, content: t.body });
  t.dirty = false; renderTabbar();
}

function renderText(s, t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const ta = document.createElement('textarea'); ta.className = 'editor'; ta.value = t.body; ta.spellcheck = false;
  ta.oninput = () => { t.body = ta.value; markDirty(t); };
  const copy = btn('Copy', 'primary', () => { navigator.clipboard.writeText(t.body); flash(copy); });
  const save = btn('Save ⌘S', 'alt', () => saveTab(s, t));
  pane.appendChild(toolbar([copy, save, spacer(), hint(t.ext || 'text')]));
  pane.appendChild(ta);
  viewer.appendChild(pane);
}

function renderWelcome(s, t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const body = document.createElement('div');
  body.style.cssText = 'flex:1; overflow:auto; padding:32px 40px; max-width:720px; line-height:1.55;';
  body.innerHTML = `
    <h1 style="margin:0 0 4px; font-size:22px;">Welcome to Clide</h1>
    <p style="opacity:.7; margin:0 0 24px;">A terminal running <code>claude</code> on the left, typed file viewers on the right.</p>
    <h2 style="font-size:15px; margin:0 0 6px;">Optional: agentic-dev-os</h2>
    <p style="opacity:.8; margin:0 0 12px;">A bundled Claude Code workflow — lifecycle skills
      (<code>/ticket-impact</code>, <code>/wrap</code>, <code>/goal</code>, …) plus a knowledge wiki.
      Installing copies the skills into <code>~/.claude/skills</code> so they're available in every
      Claude session. Skip it and Clide still works fully.</p>
    <div id="os-status" style="white-space:pre-wrap; font-family:monospace; font-size:12px; opacity:.75; margin:14px 0; max-height:180px; overflow:auto;"></div>
  `;
  const status = body.querySelector('#os-status');

  const install = btn('Install agentic-dev-os skills', 'primary', async () => {
    install.disabled = true; install.textContent = 'Installing…'; status.textContent = '';
    try {
      const r = await ipcRenderer.invoke('install-os');
      status.textContent = r.output || (r.ok ? 'Done.' : 'Failed.');
      install.textContent = r.ok ? 'Installed ✓ — restart Claude to load them' : 'Retry install';
      install.disabled = !r.ok;
    } catch (e) { status.textContent = String(e.message || e); install.textContent = 'Retry install'; install.disabled = false; }
  });
  const map = btn('Open the map', 'alt', async () => {
    const wp = await ipcRenderer.invoke('welcome-file');
    if (wp) openInSession(activeKey, wp);
  });
  const skip = btn('Skip', 'alt', () => { const i = s.viewerTabs.indexOf(t); if (i >= 0) closeTab(i); });

  pane.appendChild(toolbar([install, map, spacer(), skip]));
  pane.appendChild(body);
  viewer.appendChild(pane);
}

function renderMarkdown(s, t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const body = document.createElement('div');
  const rendered = btn('Rendered', 'alt', () => setMode('rendered'));
  const raw = btn('Raw', 'alt', () => setMode('raw'));
  const copy = btn('Copy', 'primary', () => {
    if (t.mdMode === 'rendered') ipcRenderer.send('copy-html', { html: md.render(t.body), text: t.body });
    else navigator.clipboard.writeText(t.body);
    flash(copy);
  });
  const save = btn('Save ⌘S', 'alt', () => saveTab(s, t));
  function setMode(m) {
    t.mdMode = m;
    rendered.classList.toggle('on', m === 'rendered');
    raw.classList.toggle('on', m === 'raw');
    copy.textContent = m === 'rendered' ? 'Copy rich' : 'Copy raw';
    body.innerHTML = '';
    if (m === 'rendered') {
      const div = document.createElement('div'); div.className = 'rendered'; div.innerHTML = md.render(t.body); body.appendChild(div);
      injectRevealButtons(div);
    } else {
      const ta = document.createElement('textarea'); ta.className = 'editor'; ta.value = t.body; ta.spellcheck = false;
      ta.oninput = () => { t.body = ta.value; markDirty(t); }; body.appendChild(ta);
    }
  }
  pane.appendChild(toolbar([rendered, raw, copy, save, spacer(), hint('.md')]));
  body.style.cssText = 'flex:1; display:flex; flex-direction:column; overflow:hidden;';
  pane.appendChild(body);
  viewer.appendChild(pane);
  setMode(t.mdMode);
}

const REVEALABLE_EXT = /^\/.+\.(png|jpe?g|gif|webp|svg)$/i;
function injectRevealButtons(container) {
  container.querySelectorAll('code').forEach((code) => {
    const p = code.textContent.trim();
    if (!REVEALABLE_EXT.test(p)) return;
    const icon = document.createElement('span');
    icon.textContent = '📁';
    icon.title = 'Reveal in Finder — ' + p;
    icon.style.cssText = 'cursor:pointer; opacity:.6; margin-left:4px; font-size:0.9em;';
    icon.onmouseenter = () => { icon.style.opacity = '1'; };
    icon.onmouseleave = () => { icon.style.opacity = '.6'; };
    icon.onclick = (e) => { e.preventDefault(); e.stopPropagation(); ipcRenderer.send('reveal', p); };
    code.after(icon);
  });
}

function renderImage(t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const copy = btn('Copy image', 'primary', () => { ipcRenderer.send('copy-image', t.path); flash(copy); });
  const reveal = btn('Reveal in Finder', 'alt', () => ipcRenderer.send('reveal', t.path));
  pane.appendChild(toolbar([copy, reveal, spacer(), hint(t.ext)]));
  const wrap = document.createElement('div'); wrap.className = 'imgwrap';
  const img = document.createElement('img'); img.src = t.dataUrl; wrap.appendChild(img);
  pane.appendChild(wrap);
  viewer.appendChild(pane);
}
function flash(b) { const old = b.textContent; b.textContent = 'Copied ✓'; setTimeout(() => (b.textContent = old), 1000); }

window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    const s = cur(); if (!s) return;
    const t = s.viewerTabs[s.activeViewer];
    if (t && t.kind !== 'image') saveTab(s, t);
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'w') {
    const s = cur(); if (!s) return;
    if (s.viewerTabs.length) { e.preventDefault(); closeTab(s.activeViewer); }
  }
});

/* ===================== status bar ===================== */
let statusTimer = null;
function pollStatus() {
  clearInterval(statusTimer);
  const tick = async () => {
    if (!activeKey) { renderStatus(null); return; }
    const st = await ipcRenderer.invoke('session-status', { key: activeKey });
    const s = sessions.get(activeKey);
    if (s && st && st.id) s.resumeId = st.id;
    renderStatus(st);
    saveState();
  };
  tick();
  statusTimer = setInterval(tick, 3000);
}
function shortModel(m) {
  if (!m) return 'claude';
  return m.replace(/^claude-/, '').replace(/-(\d{8})$/, '');
}
function renderStatus(st) {
  if (!st) { $('st-model').textContent = '—'; $('st-ctx').textContent = ''; $('st-repo').textContent = ''; $('st-branch').textContent = ''; return; }
  $('st-model').textContent = shortModel(st.model);
  if (st.ctxPct != null) {
    const k = st.ctxTokens >= 1000 ? Math.round(st.ctxTokens / 1000) + 'k' : st.ctxTokens;
    const win = st.window >= 1000000 ? '1M' : Math.round(st.window / 1000) + 'k';
    $('st-ctx').innerHTML = `context <b>${st.ctxPct}%</b> <span class="st-dim">${k}/${win}</span>`;
  } else { $('st-ctx').textContent = 'context —'; }
  $('st-repo').textContent = st.repo;
  $('st-branch').innerHTML = st.branch ? `<svg viewBox="0 0 16 16" width="11" height="11" style="vertical-align:-1px"><path d="M5 3v10 M11 3a2 2 0 11-4 0 2 2 0 014 0z M5 5a2 2 0 100-4 2 2 0 000 4z M11 6c0 2-3 2-6 3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> ${escapeHtml(st.branch)}` : '';
}

/* ===================== floating menu + branch switcher ===================== */
function closeMenu() {
  const e = $('floating-menu'); if (e) e.remove();
  window.removeEventListener('mousedown', closeMenuOnce, true);
}
function closeMenuOnce(e) { if (!e.target.closest('#floating-menu')) closeMenu(); }
function showMenu(anchor, items, dir) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.id = 'floating-menu';
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'menu-item' + (it.active ? ' active' : '') + (it.sep ? ' sep' : '');
    el.textContent = it.label;
    if (it.onClick) el.onclick = () => { closeMenu(); it.onClick(); };
    else el.style.opacity = '.5';
    m.appendChild(el);
  }
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 240) + 'px';
  if (dir === 'up') m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  else m.style.top = (r.bottom + 6) + 'px';
  setTimeout(() => window.addEventListener('mousedown', closeMenuOnce, true), 0);
}
function refreshGitAll() { if (panelMode === 'git') loadGit(); pollStatus(); }
async function openBranchMenu() {
  const s = cur(); if (!s) return;
  const data = await ipcRenderer.invoke('git-branches', { cwd: s.cwd });
  if (!data || !data.branches.length) { toast('Not a git repo', true); return; }
  const items = [{
    label: '＋ New branch…',
    onClick: async () => {
      const name = prompt('New branch name:');
      if (!name || !name.trim()) return;
      const r = await ipcRenderer.invoke('git-create-branch', { cwd: s.cwd, name: name.trim() });
      toast(r.ok ? 'On ' + name.trim() : (r.err.split('\n').find(Boolean) || 'Failed'), !r.ok);
      refreshGitAll();
    }
  }];
  for (const b of data.branches) {
    items.push({
      label: (b === data.current ? '✓ ' : '   ') + b,
      active: b === data.current,
      onClick: b === data.current ? null : async () => {
        const r = await ipcRenderer.invoke('git-checkout', { cwd: s.cwd, branch: b });
        toast(r.ok ? 'Switched to ' + b : (r.err.split('\n').find(Boolean) || 'Checkout failed'), !r.ok);
        refreshGitAll();
      }
    });
  }
  showMenu($('st-branch'), items, 'up');
}
$('st-branch').style.cursor = 'pointer';
$('st-branch').title = 'Switch / create branch';
$('st-branch').onclick = openBranchMenu;

/* ===================== drag & drop file paths into terminal ===================== */
function quotePath(p) { return /[^\w@%+=:,./-]/.test(p) ? "'" + p.replace(/'/g, `'\\''`) + "'" : p; }
const termWrap = $('terminals');
termWrap.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; termWrap.classList.add('drop'); });
termWrap.addEventListener('dragleave', e => { if (e.target === termWrap) termWrap.classList.remove('drop'); });
termWrap.addEventListener('drop', e => {
  e.preventDefault(); termWrap.classList.remove('drop');
  const s = cur(); if (!s) return;
  const paths = [];
  if (e.dataTransfer.files && e.dataTransfer.files.length) for (const f of e.dataTransfer.files) {
    let fp = ''; try { fp = webUtils.getPathForFile(f); } catch {} if (fp) paths.push(fp);
  }
  if (!paths.length) { const txt = e.dataTransfer.getData('text/plain'); if (txt) paths.push(txt); }
  if (paths.length) {
    ipcRenderer.send('session-input', { key: s.key, data: paths.map(quotePath).join(' ') + ' ' });
    s.term.focus();
  }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => e.preventDefault());

/* ===================== history overlay ===================== */
const overlay = $('history-overlay');
const historyList = $('history-list');
let historyData = [];
let _now = 0;

$('new-session').onclick = openHistory;
$('history-close').onclick = closeHistory;
overlay.onclick = e => { if (e.target === overlay) closeHistory(); };
$('history-new').onclick = async () => {
  const cwd = await ipcRenderer.invoke('pick-folder');
  if (cwd) { closeHistory(); startSession({ cwd }); }
};
$('history-search').addEventListener('input', applyHistoryFilter);
$('repo-filter').addEventListener('change', applyHistoryFilter);

function closeHistory() { overlay.style.display = 'none'; }
function timeAgo(ms) {
  const diff = (_now - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return Math.floor(diff / 86400) + 'd ago';
}
function shortPath(p) { return p.replace(/^\/Users\/[^/]+/, '~'); }

async function openHistory() {
  overlay.style.display = 'flex';
  historyList.innerHTML = '<div class="h-loading">Loading…</div>';
  _now = Date.now();
  const s = cur();
  const nh = $('new-here');
  if (s) { nh.style.display = ''; nh.textContent = '+ New chat in ' + s.repo; nh.onclick = () => { closeHistory(); startSession({ cwd: s.cwd }); }; }
  else nh.style.display = 'none';
  historyData = await ipcRenderer.invoke('list-history');
  buildRepoFilter();
  buildRecentRepos();
  applyHistoryFilter();
  $('history-search').focus();
}
function buildRepoFilter() {
  const sel = $('repo-filter');
  const repos = [...new Set(historyData.map(h => h.repo))].sort();
  sel.innerHTML = '<option value="">All repos</option>' + repos.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('');
}
function buildRecentRepos() {
  const seen = new Map();
  for (const h of historyData) if (!seen.has(h.repo)) seen.set(h.repo, h.cwd);
  const wrap = $('recent-repos');
  wrap.innerHTML = '<span class="rr-label">New chat in</span>';
  let n = 0;
  for (const [repo, cwd] of seen) {
    if (n++ >= 12) break;
    const chip = document.createElement('span');
    chip.className = 'rr-chip';
    chip.textContent = repo;
    chip.title = 'Fresh Claude in ' + cwd;
    chip.onclick = () => { closeHistory(); startSession({ cwd }); };
    wrap.appendChild(chip);
  }
}
function applyHistoryFilter() {
  const q = $('history-search').value.trim().toLowerCase();
  const repo = $('repo-filter').value;
  let list = historyData;
  if (repo) list = list.filter(h => h.repo === repo);
  if (q) list = list.filter(h => (h.title + ' ' + (h.recap || '') + ' ' + h.repo).toLowerCase().includes(q));
  renderHistoryList(list);
}
function renderHistoryList(list) {
  historyList.innerHTML = '';
  if (!list.length) { historyList.innerHTML = '<div class="h-loading">No matching chats.</div>'; return; }
  for (const h of list) {
    const card = document.createElement('div');
    card.className = 'h-card';
    card.innerHTML =
      `<div class="h-top"><span class="h-title">${escapeHtml(h.title)}</span><span class="h-repo">${escapeHtml(h.repo)}</span></div>` +
      (h.recap ? `<div class="h-recap">${escapeHtml(h.recap)}</div>` : '<div class="h-recap dim">No recap</div>') +
      `<div class="h-meta">${timeAgo(h.mtime)} · ${escapeHtml(shortPath(h.cwd))}</div>`;
    card.onclick = () => { closeHistory(); startSession({ cwd: h.cwd, resumeId: h.id, title: h.title }); };
    historyList.appendChild(card);
  }
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display === 'flex') closeHistory(); });

/* ===================== panel mode (files / git) ===================== */
let panelMode = 'files';
document.querySelectorAll('.ptab').forEach(t => { t.onclick = () => setPanelMode(t.dataset.mode); });
function setPanelMode(mode) {
  panelMode = mode;
  document.querySelectorAll('.ptab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('files-pane').style.display = mode === 'files' ? 'flex' : 'none';
  $('git-pane').style.display = mode === 'git' ? 'flex' : 'none';
  $('log-pane').style.display = mode === 'log' ? 'flex' : 'none';
  if (mode === 'git') loadGit();
  if (mode === 'log') loadLog();
}


/* ===================== viewer nav (back / forward / undo / redo) ===================== */
$('nav-back').onclick = () => navGo(-1);
$('nav-fwd').onclick = () => navGo(1);
$('nav-undo').onclick = () => doEdit('undo');
$('nav-redo').onclick = () => doEdit('redo');
function navGo(dir) {
  const s = cur(); if (!s) return;
  let i = s.navIndex + dir;
  while (i >= 0 && i < s.navStack.length) {
    const ti = s.viewerTabs.findIndex(t => t.path === s.navStack[i]);
    if (ti >= 0) { s.navIndex = i; navigating = true; s.activeViewer = ti; renderTabbar(); renderViewer(); navigating = false; updateNav(); return; }
    i += dir;
  }
}
function updateNav() {
  const s = cur();
  const has = arr => s && arr.some(p => s.viewerTabs.find(t => t.path === p));
  $('nav-back').classList.toggle('disabled', !(s && has(s.navStack.slice(0, s.navIndex))));
  $('nav-fwd').classList.toggle('disabled', !(s && has(s.navStack.slice(s.navIndex + 1))));
  const t = s && s.viewerTabs[s.activeViewer];
  $('nav-path').textContent = t ? shortPath(t.src || t.path) : '';
}
function doEdit(cmd) {
  let el = document.activeElement;
  if (!el || el.tagName !== 'TEXTAREA') el = viewer.querySelector('textarea.editor');
  if (el) { el.focus(); document.execCommand(cmd); }
}

/* ===================== keyboard / zoom / notify ===================== */
function toggleExplorer() { setExplorer(explorer.style.display === 'none'); }
let fontScale = 13;
function applyZoom() {
  for (const s of sessions.values()) s.term.options.fontSize = fontScale;
  document.documentElement.style.setProperty('--editor-size', fontScale + 'px');
  fitActive();
}
function zoom(d) { fontScale = Math.max(9, Math.min(22, fontScale + d)); applyZoom(); }
function reopenClosed() { const s = cur(); if (s && s.closedTabs.length) openInSession(s.key, s.closedTabs.pop()); }
function notifyClaude(s) {
  if (s.key === activeKey && document.hasFocus()) return;
  try { new Notification('Claude · ' + s.repo, { body: 'Waiting for you', silent: false }); } catch {}
  s.unread = true; renderSessionTabs();
}
window.addEventListener('keydown', e => {
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.shiftKey && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); Panes.splitDown(); }
  else if (e.key === 'd') { e.preventDefault(); Panes.splitRight(); }
  else if (e.shiftKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); reopenClosed(); }
  else if (e.key === 't') { e.preventDefault(); openHistory(); }
  else if (e.key === 'p') { e.preventDefault(); setPanelMode('files'); if (explorer.style.display === 'none') toggleExplorer(); searchInput.focus(); searchInput.select(); }
  else if (e.key === 'b') { e.preventDefault(); toggleExplorer(); }
  else if (e.key === 'k') { e.preventDefault(); const s = cur(); if (s) s.term.clear(); }
  else if (e.key === '[') { e.preventDefault(); navGo(-1); }
  else if (e.key === ']') { e.preventDefault(); navGo(1); }
  else if (e.key === '=' || e.key === '+') { e.preventDefault(); zoom(1); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoom(-1); }
  else if (e.key === '0') { e.preventDefault(); fontScale = 13; applyZoom(); }
  else if (/^[1-9]$/.test(e.key)) { const idx = +e.key - 1; if (order[idx]) { e.preventDefault(); switchSession(order[idx]); } }
});

/* ===================== toast ===================== */
function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 220); }, 2600);
}

/* ===================== util ===================== */
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

/* ===================== session persistence ===================== */
function saveState() {
  try {
    const data = order.map(k => {
      const s = sessions.get(k);
      const tabs = s.viewerTabs.filter(t => t.kind !== 'diff' && t.kind !== 'welcome').map(t => t.path);
      const act = s.viewerTabs[s.activeViewer];
      return { cwd: s.cwd, resumeId: s.resumeId || null, title: s.title, tabs, active: act ? act.path : null };
    });
    localStorage.setItem('clide-state', JSON.stringify({ sessions: data, active: order.indexOf(activeKey) }));
  } catch {}
}
function loadState() { try { return JSON.parse(localStorage.getItem('clide-state') || 'null'); } catch { return null; } }
window.addEventListener('beforeunload', saveState);

/* ===================== boot ===================== */
(async () => {
  const saved = loadState();
  if (saved && saved.sessions && saved.sessions.length) {
    for (const ss of saved.sessions) {
      await startSession({ cwd: ss.cwd, resumeId: ss.resumeId, title: ss.title, restoreTabs: ss.tabs, restoreActive: ss.active });
    }
    if (saved.active >= 0 && order[saved.active]) switchSession(order[saved.active]);
    return;
  }
  const { cwd, explicit } = await ipcRenderer.invoke('initial-cwd');
  await startSession({ cwd });
  // First launch → open the welcome tab (intro + one-click skills install + map).
  if (!localStorage.getItem('clide-welcomed')) {
    const s = cur();
    if (s) { addTab(s, { path: 'welcome:os', name: 'Welcome', kind: 'welcome' }); renderTabbar(); renderViewer(); }
    localStorage.setItem('clide-welcomed', '1');
  }
  if (!explicit) openHistory(); // Finder launch → let the user jump to a recent repo/chat
})();
