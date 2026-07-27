const { ipc: ipcRenderer, webUtils } = window.clide;
const { Terminal } = window;
const { FitAddon } = window.FitAddon;
const MarkdownIt = window.markdownit;
const rendererInstance = `renderer:${crypto.randomUUID()}`;
const dispatchesInFlight = new Set();

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

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
const sessionStarts = new Map(); // stable task/session identity -> in-flight start
const terminalOwners = new Map(); // terminal key -> { session, terminal }
const order = [];
let activeKey = null;
let providerAvailability = { claude: true, codex: true };
let layoutMode = localStorage.getItem('clide-layout') || 'grid';
let workbenchMode = localStorage.getItem('clide-workbench') || 'terminal';
let explorerVisible = localStorage.getItem('clide-explorer-visible') !== 'false';
let inspectorVisible = localStorage.getItem('clide-inspector-visible') === 'true';
let environmentVisible = localStorage.getItem('clide-environment-visible') === 'true';
let inspectorMode = 'files';
let taskSnapshot = { tasks: {}, overlaps: [] };

const $ = id => document.getElementById(id);
const cur = () => sessions.get(activeKey) || null;

const terminalsEl = $('terminals');
const sessionTabs = $('session-tabs');

function createSessionTile(s) {
  const tile = document.createElement('section');
  tile.className = `agent-tile ${s.provider} ${s.role === 'orchestrator' ? 'orchestrator' : ''}`;
  tile.dataset.key = s.key;
  tile.draggable = true;
  tile.innerHTML = `
    <header class="branch-ribbon">
      <button class="tile-focus" type="button" title="Focus this agent">
        <span class="tile-provider">${s.role === 'orchestrator' ? 'O·' : ''}${s.provider === 'codex' ? 'C' : 'A'}</span>
        <span class="tile-task">${escapeHtml(s.title)}</span>
      </button>
      <span class="tile-state starting">starting</span>
      <span class="tile-meta"></span>
      <button class="tile-message" type="button" title="Send a safe queued message">Message</button>
      <button class="tile-shell" type="button" title="New shell in this worktree">+ Shell</button>
      <button class="tile-close" type="button" title="Close session">×</button>
    </header>
    <div class="tile-terminal-bar"><div class="tile-terminal-tabs" role="tablist" aria-label="Task terminals"></div></div>
    <div class="tile-terminals"></div>`;
  tile.querySelector('.tile-focus').onclick = () => switchSession(s.key);
  tile.querySelector('.tile-shell').onclick = () => { switchSession(s.key); startAuxTerminal(s); };
  tile.querySelector('.tile-close').onclick = () => closeSession(s.key);
  tile.querySelector('.tile-message').onclick = () => promptTaskMessage(s);
  tile.addEventListener('mousedown', () => { if (activeKey !== s.key) switchSession(s.key); });
  tile.addEventListener('dragstart', event => { event.dataTransfer.setData('application/x-clide-session', s.key); event.dataTransfer.effectAllowed = 'move'; });
  tile.addEventListener('dragover', event => { if ([...event.dataTransfer.types].includes('application/x-clide-session')) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } });
  tile.addEventListener('drop', event => {
    const from = event.dataTransfer.getData('application/x-clide-session');
    if (!from || from === s.key) return;
    event.preventDefault();
    const old = order.indexOf(from), next = order.indexOf(s.key);
    if (old < 0 || next < 0) return;
    order.splice(old, 1); order.splice(next, 0, from);
    for (const key of order) terminalsEl.appendChild(sessions.get(key).tileEl);
    syncTerminalVisibility(); renderSessionTabs(); saveState();
  });
  s.tileEl = tile;
  s.terminalTabsEl = tile.querySelector('.tile-terminal-tabs');
  s.terminalsEl = tile.querySelector('.tile-terminals');
  terminalsEl.appendChild(tile);
}

function activeTerminal(s = cur()) {
  if (!s) return null;
  return s.terminals.find(t => t.key === s.activeTerminalKey) || s.terminals[0] || null;
}

function agentTerminal(s = cur()) {
  return s ? s.terminals.find(t => t.kind === 'agent') || null : null;
}

function attachTerminal(s, { key, kind, title }) {
  const el = document.createElement('div');
  el.className = 'term';
  el.style.display = 'none';
  s.terminalsEl.appendChild(el);

  const term = new Terminal(TERM_OPTS);
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);

  const entry = { key, kind, title, term, fit, termEl: el, exited: false, exitCode: null };
  term.onData(data => ipcRenderer.send('session-input', { key, data }));
  if (kind === 'agent') term.onBell(() => notifyClaude(s));

  s.terminals.push(entry);
  s.activeTerminalKey = key;
  terminalOwners.set(key, { session: s, terminal: entry });
  return entry;
}

function syncTerminalVisibility() {
  const capacity = layoutMode === 'focus' || layoutMode === 'single' ? 1 :
    (layoutMode === 'two-cols' || layoutMode === 'two-rows' ? 2 : 4);
  const activeIndex = Math.max(0, order.indexOf(activeKey));
  const pageStart = Math.floor(activeIndex / capacity) * capacity;
  const visible = new Set(order.slice(pageStart, pageStart + capacity));
  terminalsEl.className = `layout-${layoutMode} visible-${visible.size}`;
  for (const s of sessions.values()) {
    s.tileEl.style.display = visible.has(s.key) ? 'flex' : 'none';
    s.tileEl.classList.toggle('active', s.key === activeKey);
    for (const t of s.terminals) {
      t.termEl.style.display = visible.has(s.key) && t.key === s.activeTerminalKey ? 'block' : 'none';
    }
  }
}

function selectTerminal(s, key) {
  if (!s || !s.terminals.some(t => t.key === key)) return;
  s.activeTerminalKey = key;
  syncTerminalVisibility();
  if (s.key === activeKey) {
    renderTerminalTabs(s);
    setTimeout(() => { fitAll(); const t = activeTerminal(s); if (t) t.term.focus(); }, 0);
  }
}

async function startAuxTerminal(s = cur(), title, persistentId, kind = 'shell') {
  if (!s) return null;
  const res = await ipcRenderer.invoke('terminal-start', { cwd: s.cwd, parentKey: s.key, persistentId, kind });
  if (!res || res.error) { toast((res && res.error) || 'Could not start shell', true); return null; }
  const shellNumber = s.terminals.filter(t => t.kind === 'shell').length + 1;
  const t = attachTerminal(s, {
    key: res.key,
    kind: res.kind || kind,
    title: title || `${res.shell || 'Shell'} ${shellNumber}`
  });
  t.persistentId = res.persistentId;
  selectTerminal(s, t.key);
  saveState();
  return t;
}

function closeTerminal(s, key) {
  if (!s) return;
  const i = s.terminals.findIndex(t => t.key === key);
  if (i < 0) return;
  const t = s.terminals[i];
  if (t.kind === 'agent') return;

  ipcRenderer.send('session-kill', { key: t.key });
  terminalOwners.delete(t.key);
  try { t.term.dispose(); } catch {}
  t.termEl.remove();
  s.terminals.splice(i, 1);
  if (s.activeTerminalKey === key) {
    const next = s.terminals[Math.max(0, i - 1)] || s.terminals[0];
    s.activeTerminalKey = next ? next.key : null;
  }
  syncTerminalVisibility();
  renderTerminalTabs(s);
  fitAll();
  saveState();
}

function renderTerminalTabs(s = cur()) {
  if (!s) return;
  const terminalTabs = s.terminalTabsEl;
  terminalTabs.innerHTML = '';

  for (const t of s.terminals) {
    const el = document.createElement('button');
    el.className = 'ttab' + (t.key === s.activeTerminalKey ? ' active' : '') +
      (t.kind === 'agent' ? ` agent ${s.provider}` : '') + (t.exited ? ' exited' : '');
    el.type = 'button';
    el.setAttribute('role', 'tab');
    el.setAttribute('aria-selected', t.key === s.activeTerminalKey ? 'true' : 'false');
    el.title = t.kind === 'agent'
      ? `${s.provider === 'codex' ? 'Codex' : 'Claude'} agent terminal`
      : `${t.title} · ${s.cwd}`;
    el.innerHTML =
      `<span class="ttype">${t.kind === 'agent' ? (s.provider === 'codex' ? 'C' : 'A') : '›_'}</span>` +
      `<span class="tname">${escapeHtml(t.title)}</span>` +
      (t.exited ? `<span class="texit" title="Exited${t.exitCode != null ? ` (${t.exitCode})` : ''}">●</span>` : '') +
      (t.kind === 'shell' ? '<span class="tclose" title="Close shell">×</span>' : '');
    el.onclick = () => selectTerminal(s, t.key);
    el.ondblclick = () => {
      if (t.kind !== 'shell') return;
      const name = prompt('Terminal name:', t.title);
      if (name && name.trim()) { t.title = name.trim().slice(0, 40); renderTerminalTabs(s); saveState(); }
    };
    const close = el.querySelector('.tclose');
    if (close) close.onclick = e => { e.stopPropagation(); closeTerminal(s, t.key); };
    terminalTabs.appendChild(el);
  }
}

async function startSession(options) {
  const orchestratorRoot = options.role === 'orchestrator' ? (options.workspaceRoot || options.cwd) : null;
  const identity = options.taskId ? `task:${options.taskId}` : (orchestratorRoot ? `orchestrator:${orchestratorRoot}` : (options.persistentId ? `session:${options.persistentId}` : null));
  if (identity) {
    const existing = [...sessions.values()].find(session => options.taskId ? session.taskId === options.taskId : (orchestratorRoot ? session.role === 'orchestrator' && (session.workspaceRoot === orchestratorRoot || session.cwd === orchestratorRoot) : session.persistentId === options.persistentId));
    if (existing) return existing;
    if (sessionStarts.has(identity)) return sessionStarts.get(identity);
  }
  const pending = startSessionInternal(options);
  if (identity) sessionStarts.set(identity, pending);
  try { return await pending; }
  finally { if (identity && sessionStarts.get(identity) === pending) sessionStarts.delete(identity); }
}

async function startSessionInternal({ cwd, resumeId, title, provider, taskId, persistentId, role, recoverOnly, initialPrompt, dispatchLeaseId, restoreTabs, restoreActive, restoreShells, restoreTerminal }) {
  let res = await ipcRenderer.invoke('session-start', { cwd, resumeId, provider: provider || 'claude', taskId, persistentId, role, recoverOnly });
  if (res && !res.error && !res.key) {
    const live = await ipcRenderer.invoke('sessions-list');
    const match = (live || []).find(item => taskId ? item.taskId === taskId : (persistentId ? item.persistentId === persistentId : (role === 'orchestrator' && item.role === 'orchestrator' && (item.workspaceRoot === cwd || item.cwd === cwd))));
    if (match) res = { ...res, ...match, recovered: true, reused: true };
  }
  if (!res || res.error) {
    const message = (res && res.error) || 'Could not start agent session';
    console.error('session-start failed', message);
    toast(message, true);
    return null;
  }
  const attached = sessions.get(res.key) || [...sessions.values()].find(session => res.taskId ? session.taskId === res.taskId : (res.role === 'orchestrator' && session.role === 'orchestrator' && session.workspaceRoot === res.workspaceRoot));
  if (attached) return attached;
  const s = {
    key: res.key, cwd: res.cwd, repo: res.repo,
    provider: res.provider || provider || 'claude', taskId: res.taskId || taskId || null,
    persistentId: res.persistentId, recovered: res.recovered,
    role: res.role || role || 'worker', workspaceRoot: res.workspaceRoot || cwd,
    title: title || (res.role === 'orchestrator' ? 'Repository Orchestrator' : res.repo), resumed: !!resumeId, resumeId: resumeId || null,
    viewerTabs: [], activeViewer: -1, fileList: null, savedOnce: false, unread: false,
    treeBuilt: false, navStack: [], navIndex: -1, closedTabs: [],
    terminals: [], activeTerminalKey: null
  };
  createSessionTile(s);
  attachTerminal(s, {
    key: res.key,
    kind: 'agent',
    title: s.provider === 'codex' ? 'Codex' : 'Claude'
  });

  sessions.set(s.key, s);
  if (s.role === 'orchestrator') { order.unshift(s.key); terminalsEl.prepend(s.tileEl); } else order.push(s.key);
  renderSessionTabs();
  switchSession(s.key);

  if (restoreTabs && restoreTabs.length) {
    for (const p of restoreTabs) { try { await openInSession(s.key, p); } catch {} }
    if (restoreActive) {
      const i = s.viewerTabs.findIndex(t => t.path === restoreActive);
      if (i >= 0) { s.activeViewer = i; if (s.key === activeKey) { renderTabbar(); renderViewer(); } }
    }
  }
  if (restoreShells && restoreShells.length) {
    for (const shell of restoreShells) await startAuxTerminal(s, shell.title, shell.persistentId, shell.kind);
  }
  if (restoreTerminal != null && s.terminals[restoreTerminal]) {
    selectTerminal(s, s.terminals[restoreTerminal].key);
  }
  if (initialPrompt && (!res.recovered || dispatchLeaseId)) {
    if (dispatchLeaseId) {
      const ready = await ipcRenderer.invoke('dispatch-wait-ready', { taskId, timeout: 45000 });
      if (!ready.ok) throw new Error(ready.error || 'Provider did not become ready.');
    }
    await deliverInitialPrompt(s, initialPrompt, taskId, dispatchLeaseId);
  }
  return s;
}

async function deliverInitialPrompt(session, prompt, taskId, dispatchLeaseId) {
  const body = String(prompt || '').trim(); if (!session || !body) return;
  if (taskId && dispatchLeaseId) {
    const sent = await ipcRenderer.invoke('dispatch-prompt-send', { taskId, sessionKey: session.key, leaseId: dispatchLeaseId, actor: rendererInstance, prompt: body });
    if (!sent.ok) throw new Error(sent.error || 'Prompt write was rejected.');
    const acknowledged = await ipcRenderer.invoke('dispatch-wait-prompt', { taskId, writeId: sent.writeId, timeout: 10000 });
    if (!acknowledged.ok) throw new Error(acknowledged.error || 'Prompt delivery could not be confirmed.');
  } else {
    await new Promise(resolve => setTimeout(resolve, 1000));
    ipcRenderer.send('session-input', { key: session.key, data: body + '\r' });
    if (taskId) await ipcRenderer.invoke('task-patch', { id: taskId, patch: { promptDeliveredAt: new Date().toISOString() } });
  }
}

function switchSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  activeKey = key;
  s.unread = false;
  syncTerminalVisibility();
  renderSessionTabs();
  renderTerminalTabs(s);
  buildTree(s);
  $('search').value = '';
  $('tree').style.display = 'block';
  $('results').style.display = 'none';
  renderTabbar();
  renderViewer();
  updateNav();
  if (panelMode === 'git') loadGit();
  setTimeout(() => { fitAll(); const t = activeTerminal(s); if (t) t.term.focus(); }, 0);
  pollStatus();
  renderTaskRail();
  refreshEnvironment();
}

function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  for (const t of s.terminals) {
    ipcRenderer.send('session-kill', { key: t.key });
    terminalOwners.delete(t.key);
    try { t.term.dispose(); } catch {}
    t.termEl.remove();
  }
  s.tileEl.remove();
  sessions.delete(key);
  const i = order.indexOf(key);
  if (i >= 0) order.splice(i, 1);
  if (activeKey === key) {
    if (order.length) switchSession(order[Math.max(0, i - 1)]);
    else { activeKey = null; renderSessionTabs(); renderTabbar(); renderViewer(); renderStatus(null); }
  } else {
    renderSessionTabs();
  }
  syncTerminalVisibility();
  renderTaskRail();
  saveState();
}

function renderSessionTabs() {
  sessionTabs.innerHTML = '';
  for (const key of order) {
    const s = sessions.get(key);
    const el = document.createElement('div');
    el.className = 'stab' + (key === activeKey ? ' active' : '');
    el.innerHTML =
      `${s.unread ? '<span class="sdot"></span>' : ''}` +
      `<span class="sprovider ${s.provider}">${s.provider === 'codex' ? 'C' : 'A'}</span>` +
      `<span class="srepo">${s.repo}</span>` +
      `<span class="stitle">${s.role === 'orchestrator' ? '◆ ' : ''}${s.resumed ? '↺ ' : ''}${escapeHtml(s.title)}</span>` +
      `<span class="sclose" title="Close">✕</span>`;
    el.onclick = () => switchSession(key);
    el.querySelector('.sclose').onclick = e => { e.stopPropagation(); closeSession(key); };
    sessionTabs.appendChild(el);
  }
  renderTaskRail();
}

/* pty + open routing */
ipcRenderer.on('pty-data', (_e, { key, data }) => {
  const owner = terminalOwners.get(key);
  if (owner) owner.terminal.term.write(data);
});
ipcRenderer.on('session-exit', (_e, { key, exitCode }) => {
  const owner = terminalOwners.get(key);
  if (!owner) return;
  const { session: s, terminal: t } = owner;
  t.exited = true;
  t.exitCode = exitCode;
  const label = t.kind === 'agent' ? s.provider : t.title;
  t.term.write(`\r\n\x1b[90m[${label} exited${exitCode != null ? ` · ${exitCode}` : ''}]\x1b[0m\r\n`);
  if (s.key === activeKey) renderTerminalTabs(s);
  renderTileRibbon(s);
});
ipcRenderer.on('open-file', (_e, { key, path: p }) => openInSession(key || activeKey, p));

async function openInSession(key, p) {
  const s = sessions.get(key) || cur();
  if (!s) return;
  try {
    const data = await ipcRenderer.invoke('read-file', p);
    addTab(s, data);
    if (s.key === activeKey) { renderTabbar(); renderViewer(); }
    else { s.unread = true; renderSessionTabs(); }
  } catch (err) {
    const t = activeTerminal(s) || agentTerminal(s);
    if (t) t.term.write(`\r\n[clide: cannot open ${p}: ${err.message}]\r\n`);
  }
}

/* ===================== terminal sizing / split ===================== */
function fitActive() {
  const t = activeTerminal(); if (!t) return;
  if (t.exited) return;
  try { t.fit.fit(); } catch {}
  ipcRenderer.send('session-resize', { key: t.key, cols: t.term.cols, rows: t.term.rows });
}
function fitAll() {
  for (const s of sessions.values()) {
    if (!s.tileEl || s.tileEl.style.display === 'none') continue;
    const t = activeTerminal(s); if (!t) continue;
    if (t.exited) continue;
    try { t.fit.fit(); } catch {}
    ipcRenderer.send('session-resize', { key: t.key, cols: t.term.cols, rows: t.term.rows });
  }
}
window.addEventListener('resize', fitAll);

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
    if (right > 260 && right < rect.width - 360) { $('right').style.flex = `0 0 ${right}px`; fitAll(); }
  } else {
    const width = rect.right - e.clientX;
    if (width > 200 && width < rect.width - 400) { explorer.style.flex = `0 0 ${width}px`; fitAll(); }
  }
});

/* ===================== explorer ===================== */
const tree = $('tree');
const results = $('results');
const explorer = $('explorer');
const explorerShow = $('explorer-show');
const searchInput = $('search');
let treeBuildVersion = 0;

$('explorer-toggle').onclick = () => setExplorer(false);
explorerShow.onclick = () => setExplorer(true);
function setExplorer(show, { persist = true } = {}) {
  const visible = Boolean(show);
  if (persist) {
    explorerVisible = visible;
    localStorage.setItem('clide-explorer-visible', String(explorerVisible));
  }
  explorer.style.display = visible ? 'flex' : 'none';
  $('divider-left').style.display = visible ? 'block' : 'none';
  explorerShow.style.display = visible ? 'none' : 'flex';
  if (workbenchMode !== 'terminal') $('inspector-toggle').classList.toggle('on', visible);
  fitActive();
}

function setEnvironmentVisible(show, { persist = true } = {}) {
  environmentVisible = Boolean(show);
  if (persist) localStorage.setItem('clide-environment-visible', String(environmentVisible));
  $('environment-sidebar').style.display = environmentVisible ? 'flex' : 'none';
  $('sidebar-toggle-top').classList.toggle('on', environmentVisible);
  $('sidebar-toggle-top').setAttribute('aria-pressed', String(environmentVisible));
  setTimeout(fitAll, 0);
}
$('sidebar-toggle-top').onclick = () => setEnvironmentVisible(!environmentVisible);

async function buildTree(s) {
  const version = ++treeBuildVersion;
  const root = await dirNode(s.cwd, 0, true);
  if (version !== treeBuildVersion || s !== cur()) return;
  tree.replaceChildren(root);
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

function addTab(s, data) {
  const i = s.viewerTabs.findIndex(t => t.path === data.path);
  if (i >= 0) { s.viewerTabs[i] = Object.assign(s.viewerTabs[i], data, { dirty: false }); s.activeViewer = i; pushNav(s, data.path); return; }
  s.viewerTabs.push({ ...data, dirty: false, mdMode: 'rendered', body: data.content });
  s.activeViewer = s.viewerTabs.length - 1;
  pushNav(s, data.path);
}
function closeTab(i) {
  const s = cur(); if (!s) return;
  const t = s.viewerTabs[i];
  if (t && t.kind !== 'diff') s.closedTabs.push(t.path);
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
    viewer.innerHTML = '<div class="empty">Files agents open appear here.<br>Click a file in the tree, or ask the active agent to open one.</div>';
    return;
  }
  const t = s.viewerTabs[s.activeViewer];
  updateNav();
  if (t.kind === 'welcome') return renderWelcome(s, t);
  if (t.kind === 'diff') return renderDiff(t);
  if (t.kind === 'image') return renderImage(t);
  if (t.kind === 'html') return renderHtml(s, t);
  if (t.kind === 'markdown') return renderMarkdown(s, t);
  if (t.kind === 'code') return renderCode(s, t);
  return renderText(s, t);
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
      code.textContent = t.body;
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
  const reload = btn('⟳', 'alt', () => setMode('preview'));
  reload.title = 'Reload';
  const copy = btn('Copy', 'primary', () => { navigator.clipboard.writeText(t.body); flash(copy); });
  const save = btn('Save ⌘S', 'alt', () => saveTab(s, t));
  const ext = btn('Reveal in Finder', 'alt', () => ipcRenderer.send('reveal', t.path));
  function setMode(m) {
    t.htmlMode = m;
    preview.classList.toggle('on', m === 'preview');
    source.classList.toggle('on', m === 'source');
    body.innerHTML = '';
    if (m === 'preview') {
      const frame = document.createElement('iframe');
      frame.className = 'wv';
      frame.setAttribute('sandbox', '');
      frame.srcdoc = t.body;
      body.appendChild(frame);
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

function renderDiff(t) {
  const pane = document.createElement('div'); pane.className = 'pane';
  const reveal = btn('Open file', 'alt', () => openInSession(activeKey, t.src || t.path));
  const lines = (t.body || '').split('\n');
  const firstHunk = lines.findIndex(line => line.startsWith('@@'));
  const header = firstHunk >= 0 ? lines.slice(0, firstHunk) : [];
  const hunks = [];
  for (let i = firstHunk; i >= 0 && i < lines.length;) {
    let end = i + 1; while (end < lines.length && !lines[end].startsWith('@@')) end++;
    hunks.push(lines.slice(i, end)); i = end;
  }
  const stageAll = btn(t.staged ? 'Unstage file' : 'Stage file', 'primary', async () => {
    const s = cur(); if (!s) return;
    await ipcRenderer.invoke(t.staged ? 'git-unstage' : 'git-stage', { cwd: s.cwd, file: t.src });
    closeTab(s.activeViewer); await loadGit();
  });
  pane.appendChild(toolbar([reveal, stageAll, spacer(), hint(hunks.length ? `${hunks.length} selectable hunks` : 'diff')]));
  const box = document.createElement('div'); box.className = 'diff';
  let hunkIndex = -1;
  for (const ln of lines) {
    const row = document.createElement('div');
    let cls = 'd-ctx';
    if (ln.startsWith('+') && !ln.startsWith('+++')) cls = 'd-add';
    else if (ln.startsWith('-') && !ln.startsWith('---')) cls = 'd-del';
    else if (ln.startsWith('@@')) {
      cls = 'd-hunk'; hunkIndex++;
      const action = document.createElement('button'); action.className = 'hunk-action'; action.textContent = t.staged ? 'Unstage hunk' : 'Stage hunk';
      const selected = hunkIndex;
      action.onclick = async event => {
        event.stopPropagation(); const s = cur(); if (!s) return;
        action.disabled = true;
        const patch = [...header, ...hunks[selected]].join('\n') + '\n';
        const result = await ipcRenderer.invoke('git-stage-patch', { cwd: s.cwd, patch, reverse: Boolean(t.staged) });
        toast(result.ok ? `${t.staged ? 'Unstaged' : 'Staged'} hunk ${selected + 1}` : (result.err || 'Hunk operation failed'), !result.ok);
        if (result.ok) { closeTab(s.activeViewer); await loadGit(); }
        else action.disabled = false;
      };
      row.appendChild(action);
    }
    else if (ln.startsWith('diff ') || ln.startsWith('index ') || ln.startsWith('+++') || ln.startsWith('---')) cls = 'd-meta';
    row.className = 'd-line ' + cls;
    row.prepend(document.createTextNode(ln || ' '));
    box.appendChild(row);
  }
  pane.appendChild(box);
  viewer.appendChild(pane);
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
    <p style="opacity:.7; margin:0 0 24px;">Run Claude Code or Codex in isolated worktrees, supervise them in a grid, and keep a shell beside every agent.</p>
    <h2 style="font-size:15px; margin:0 0 6px;">Optional: agentic-dev-os</h2>
    <p style="opacity:.8; margin:0 0 12px;">A bundled provider-neutral workflow — lifecycle skills
      (<code>/ticket-impact</code>, <code>/wrap</code>, <code>/goal</code>, …) plus a knowledge wiki.
      Installing copies the skills into both <code>~/.claude/skills</code> and <code>~/.agents/skills</code>.
      Skip it and Clide still works fully.</p>
    <div id="os-status" style="white-space:pre-wrap; font-family:monospace; font-size:12px; opacity:.75; margin:14px 0; max-height:180px; overflow:auto;"></div>
  `;
  const status = body.querySelector('#os-status');

  const install = btn('Install agentic-dev-os skills', 'primary', async () => {
    install.disabled = true; install.textContent = 'Installing…'; status.textContent = '';
    try {
      const r = await ipcRenderer.invoke('install-os');
      status.textContent = r.output || (r.ok ? 'Done.' : 'Failed.');
      install.textContent = r.ok ? 'Installed ✓ — restart agents to load them' : 'Retry install';
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
    await Promise.all(order.map(async key => {
      const st = await ipcRenderer.invoke('session-status', { key });
      const s = sessions.get(key);
      if (!s || !st) return;
      s.status = st;
      if (st.id) s.resumeId = st.id;
      renderTileRibbon(s);
    }));
    renderStatus(cur() && cur().status);
    if (panelMode === 'tasks') renderTaskRail();
    saveState();
  };
  tick();
  statusTimer = setInterval(tick, 2000);
}
function shortModel(m) {
  if (!m) return null;
  return m.replace(/^claude-/, '').replace(/-(\d{8})$/, '');
}
function renderStatus(st) {
  if (!st) { $('st-model').textContent = '—'; $('st-ctx').textContent = ''; $('st-repo').textContent = ''; $('st-branch').textContent = ''; return; }
  $('st-model').textContent = shortModel(st.model) || (st.provider === 'codex' ? 'codex' : 'claude');
  if (st.ctxPct != null) {
    const k = st.ctxTokens >= 1000 ? Math.round(st.ctxTokens / 1000) + 'k' : st.ctxTokens;
    const win = st.window >= 1000000 ? '1M' : Math.round(st.window / 1000) + 'k';
    $('st-ctx').innerHTML = `context <b>${st.ctxPct}%</b> <span class="st-dim">${k}/${win}</span>`;
  } else { $('st-ctx').textContent = 'context —'; }
  $('st-repo').textContent = st.repo;
  $('st-branch').innerHTML = st.branch ? `<svg viewBox="0 0 16 16" width="11" height="11" style="vertical-align:-1px"><path d="M5 3v10 M11 3a2 2 0 11-4 0 2 2 0 014 0z M5 5a2 2 0 100-4 2 2 0 000 4z M11 6c0 2-3 2-6 3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg> ${escapeHtml(st.branch)}` : '';
}

function renderTileRibbon(s) {
  if (!s || !s.tileEl) return;
  const st = s.status || {};
  const task = s.taskId && taskSnapshot.tasks ? taskSnapshot.tasks[s.taskId] : null;
  const state = st.state || (task && task.state) || 'running';
  const branch = st.branch || (task && task.branch) || 'no branch';
  const changed = st.changed || 0;
  const stateEl = s.tileEl.querySelector('.tile-state');
  stateEl.className = `tile-state ${state}`;
  stateEl.textContent = state;
  s.tileEl.querySelector('.tile-task').textContent = s.role === 'orchestrator' ? 'Repository Orchestrator' : ((task && (task.ticket ? `${task.ticket} · ${task.title}` : task.title)) || s.title);
  s.tileEl.querySelector('.tile-meta').textContent = s.role === 'orchestrator' ? `primary checkout · ${branch}` : `${branch} · ${changed} changed`;
  s.tileEl.classList.toggle('needs-attention', ['waiting', 'approval', 'blocked', 'done'].includes(state));
}

ipcRenderer.on('attention', (_event, payload) => {
  const s = [...sessions.values()].find(item => item.taskId === payload.taskId || item.key === payload.sessionKey);
  if (s) {
    s.status = { ...(s.status || {}), state: payload.state };
    s.unread = true;
    renderTileRibbon(s);
    renderSessionTabs();
  }
  refreshTaskSnapshot();
});

ipcRenderer.on('agent-event', () => refreshTaskSnapshot());

ipcRenderer.on('workspace-open', (_event, payload) => {
  if (payload && payload.cwd) startSession({ cwd: payload.cwd, provider: providerAvailability.claude ? 'claude' : 'codex', role: 'orchestrator', title: 'Repository Orchestrator', initialPrompt: 'Use $clide-orchestrate. Act as this repository orchestrator: keep the primary checkout stable, inspect Clide tasks, and dispatch implementation only to isolated workers.' });
});

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
function refreshGitAll() { if (panelMode === 'git') loadGit(); pollStatus(); refreshEnvironment(); }
async function openBranchMenu(anchor = $('st-branch'), direction = 'up') {
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
  showMenu(anchor, items, direction);
}
$('st-branch').style.cursor = 'pointer';
$('st-branch').title = 'Switch / create branch';
$('st-branch').onclick = () => openBranchMenu();

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
    const t = activeTerminal(s);
    if (!t) return;
    ipcRenderer.send('session-input', { key: t.key, data: paths.map(quotePath).join(' ') + ' ' });
    t.term.focus();
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
  const provider = providerAvailability.claude ? 'claude' : 'codex';
  if (cwd) { closeHistory(); startSession({ cwd, provider, role: 'ad-hoc' }); }
};
$('new-worktree').onclick = () => {
  const s = cur();
  if (!s) { toast('Open a Git repository first', true); return; }
  const items = [];
  if (providerAvailability.claude) {
    items.push({ label: 'Claude in new worktree…', onClick: () => createIsolatedTask(s, 'claude') });
  }
  if (providerAvailability.codex) {
    items.push({ label: 'Codex in new worktree…', onClick: () => createIsolatedTask(s, 'codex') });
  }
  if (!items.length) items.push({ label: 'No agent CLI found' });
  showMenu($('new-worktree'), items);
};
$('history-search').addEventListener('input', applyHistoryFilter);
$('repo-filter').addEventListener('change', applyHistoryFilter);

function slugTaskName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function createIsolatedTask(sourceSession, provider) {
  closeHistory();
  showTaskDialog(sourceSession);
  $('task-provider').value = provider;
}

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
  const nc = $('new-codex-here');
  if (s) {
    nh.style.display = ''; nc.style.display = '';
    nh.textContent = '+ Claude in ' + s.repo;
    nc.textContent = '+ Codex in ' + s.repo;
    nh.onclick = () => { closeHistory(); startSession({ cwd: s.cwd, provider: 'claude', role: 'ad-hoc' }); };
    nc.onclick = () => { closeHistory(); startSession({ cwd: s.cwd, provider: 'codex', role: 'ad-hoc' }); };
    nh.disabled = !providerAvailability.claude;
    nc.disabled = !providerAvailability.codex;
    nh.title = providerAvailability.claude ? 'Start Claude in this folder' : 'Claude CLI not found';
    nc.title = providerAvailability.codex ? 'Start Codex in this folder' : 'Codex CLI not found';
  } else {
    nh.style.display = 'none'; nc.style.display = 'none';
  }
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
    const provider = providerAvailability.claude ? 'claude' : 'codex';
    chip.title = `Fresh ${provider === 'claude' ? 'Claude' : 'Codex'} in ${cwd}`;
    chip.onclick = () => { closeHistory(); startSession({ cwd, provider, role: 'ad-hoc' }); };
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
    card.onclick = () => { closeHistory(); startSession({ cwd: h.cwd, resumeId: h.id, title: h.title, role: 'ad-hoc' }); };
    historyList.appendChild(card);
  }
}
window.addEventListener('keydown', e => { if (e.key === 'Escape' && overlay.style.display === 'flex') closeHistory(); });

/* ===================== tasks / layout / inspector ===================== */
function activeTask() {
  const s = cur();
  return s && s.taskId && taskSnapshot.tasks ? taskSnapshot.tasks[s.taskId] || null : null;
}

async function refreshTaskSnapshot() {
  try { taskSnapshot = await ipcRenderer.invoke('state-snapshot'); } catch { return; }
  renderTaskRail();
  for (const s of sessions.values()) renderTileRibbon(s);
  if (inspectorMode !== 'files') renderInspector();
  const attention = Object.values(taskSnapshot.tasks || {}).filter(t => ['waiting', 'approval', 'blocked', 'done'].includes(t.state) ||
    (t.dispatch && ['failed', 'blocked', 'waiting-dependencies', 'waiting-capacity'].includes(t.dispatch.stage)) ||
    (t.approvals || []).some(item => item.status === 'pending'));
  $('attention-count').textContent = String(attention.length);
  $('attention-toggle').classList.toggle('has-attention', attention.length > 0);
}

function renderTaskRail() {
  const list = $('task-list');
  if (!list) return;
  list.innerHTML = '';
  const durable = Object.values(taskSnapshot.tasks || {}).filter(task => task.state !== 'archived');
  const adHoc = [...sessions.values()].filter(s => !s.taskId).map(s => ({
    id: `session:${s.key}`, title: s.title, ticket: s.role === 'orchestrator' ? 'ORCHESTRATOR' : 'AD HOC', provider: s.provider, role: s.role,
    state: s.status && s.status.state || 'running', branch: s.status && s.status.branch || '', sessionKey: s.key
  }));
  const items = [...adHoc.filter(item => item.role === 'orchestrator'), ...durable, ...adHoc.filter(item => item.role !== 'orchestrator')];
  if (!items.length) { list.innerHTML = '<div class="no-results">Create an isolated task to begin.</div>'; return; }
  for (const task of items) {
    const session = task.sessionKey ? sessions.get(task.sessionKey) : [...sessions.values()].find(s => s.taskId === task.id);
    const state = task.blockedBy && task.blockedBy.length ? 'blocked' : (session && session.status ? session.status.state : task.state);
    const dispatchStage = task.dispatch && task.dispatch.stage;
    const overlaps = (taskSnapshot.overlaps || []).filter(item => item.taskIds.includes(task.id));
    const card = document.createElement('div');
    card.className = `task-card ${task.provider} ${task.role === 'orchestrator' ? 'orchestrator' : ''}` + (session && session.key === activeKey ? ' active' : '') +
      (['waiting', 'approval', 'blocked', 'done'].includes(state) || overlaps.length ? ' attention' : '');
    const changed = task.git && task.git.files ? task.git.files.length : (session && session.status ? session.status.changed : 0);
    card.innerHTML = `<div class="task-card-top"><span class="task-ticket">${escapeHtml(task.ticket || 'TASK')}</span>` +
      `<span class="task-state ${escapeHtml(state || 'draft')}">${escapeHtml(state || 'draft')}</span></div>` +
      `<div class="task-title">${escapeHtml(task.title)}</div>` +
      `<div class="task-branch">${escapeHtml(task.branch || 'shared checkout')} · ${changed || 0} changed${overlaps.length ? ` · ⚠ ${overlaps.some(item => item.severity === 'high') ? 'high ' : ''}overlap` : ''}${task.blockedBy && task.blockedBy.length ? ` · waits for ${task.blockedBy.length}` : ''}</div>` +
      (dispatchStage ? `<div class="task-runtime"><span class="dispatch-chip ${escapeHtml(dispatchStage)}">${escapeHtml(dispatchStage)}</span>${task.dev ? `<span class="dev-chip ${escapeHtml(task.dev.status)}">:${task.port} ${escapeHtml(task.dev.status)}</span>` : ''}</div>` : '');
    card.onclick = async () => {
      if (session) switchSession(session.key);
      else if (task.dispatch && task.dispatch.stage !== 'running') await processDurableDispatch(task.id);
      else if (task.worktree) await startSession({ cwd: task.worktree, provider: task.provider, title: task.title, taskId: task.id, persistentId: task.supervisorId || `worker-${task.id}`, initialPrompt: task.promptDeliveredAt ? '' : task.launchPrompt });
      else {
        showTaskDialog(cur(), task);
      }
    };
    list.appendChild(card);
  }
}

function setLayout(mode) {
  if (!['single', 'two-cols', 'two-rows', 'grid', 'focus'].includes(mode)) return;
  layoutMode = mode;
  localStorage.setItem('clide-layout', mode);
  document.querySelectorAll('#layout-controls button').forEach(button => button.classList.toggle('active', button.dataset.layout === mode));
  syncTerminalVisibility();
  setTimeout(fitAll, 0);
  const s = cur(); if (s) ipcRenderer.invoke('layout-set', { workspace: s.cwd, layout: mode }).catch(() => {});
}
document.querySelectorAll('#layout-controls button').forEach(button => button.onclick = () => setLayout(button.dataset.layout));
setLayout(layoutMode);

function showTaskDialog(source = cur(), draft = null) {
  if (!source) { toast('Open a repository first', true); return; }
  const taskOverlay = $('task-overlay');
  taskOverlay.dataset.sourceKey = source.key;
  taskOverlay.dataset.taskId = draft ? draft.id : '';
  $('task-ticket').value = draft && draft.ticket || '';
  $('task-title').value = draft && draft.title || '';
  $('task-prompt').value = draft && draft.launchPrompt || '';
  $('task-branch').value = draft && draft.branch || '';
  $('task-branch').dataset.edited = draft && draft.branch ? '1' : '0';
  $('task-base').value = draft && draft.baseRef || 'HEAD';
  $('task-setup').value = draft && draft.setupCommand || '';
  $('task-dev').value = draft && draft.devCommand || '';
  $('task-dependencies').value = draft && (draft.dependencies || []).join(', ') || '';
  $('task-provider').value = draft && draft.provider || (providerAvailability.claude ? 'claude' : 'codex');
  [...$('task-provider').options].forEach(option => { option.disabled = !providerAvailability[option.value]; });
  $('task-dialog-error').textContent = '';
  taskOverlay.style.display = 'flex';
  setTimeout(() => $('task-ticket').focus(), 0);
}
function closeTaskDialog() { $('task-overlay').style.display = 'none'; }
$('task-new').onclick = () => showTaskDialog();
$('workspace-new-task').onclick = () => showTaskDialog();
$('workspace-orchestrator').onclick = async () => {
  const current = cur();
  const root = current && (current.workspaceRoot || current.cwd);
  if (!root) return toast('Open a repository first', true);
  const existing = [...sessions.values()].find(session => session.role === 'orchestrator' && (session.workspaceRoot === root || session.cwd === root));
  if (existing) return switchSession(existing.key);
  const provider = current && current.provider && providerAvailability[current.provider] ? current.provider : (providerAvailability.claude ? 'claude' : 'codex');
  await startSession({ cwd: root, provider, role: 'orchestrator', title: 'Repository Orchestrator', initialPrompt: 'Use $clide-orchestrate. Act as this repository orchestrator: keep the primary checkout stable, inspect Clide tasks, and dispatch implementation only to isolated workers.' });
};
$('task-import').onclick = async () => {
  const source = cur(); if (!source) return;
  const raw = prompt('Paste a JSON array of tickets. Each item needs title; ticket and provider are optional.');
  if (!raw) return;
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) throw new Error('Expected a JSON array.');
    for (const item of items.slice(0, 50)) {
      if (!item || !item.title) continue;
      await ipcRenderer.invoke('task-upsert', {
        title: item.title, ticket: item.ticket || '', provider: item.provider,
        state: 'draft', repo: source.repo, repoRoot: source.cwd,
        branch: item.branch || `clide/${slugTaskName(`${item.ticket || ''} ${item.title}`)}`,
        baseRef: item.baseRef || 'HEAD', setupCommand: item.setupCommand,
        devCommand: item.devCommand, dependencies: item.dependencies
      });
    }
    await refreshTaskSnapshot(); toast('Tickets imported as drafts');
  } catch (error) { toast(error.message, true); }
};
$('workspace-backup').onclick = async () => {
  const importing = confirm('Choose OK to import a Clide backup.\nChoose Cancel to export the current workspace state.');
  try {
    const result = await ipcRenderer.invoke(importing ? 'workspace-import' : 'workspace-export');
    if (result && result.ok) { await refreshTaskSnapshot(); toast(`${importing ? 'Imported' : 'Exported'} ${result.tasks} tasks`); }
  } catch (error) { toast(error.message, true); }
};
$('task-metrics').onclick = async () => {
  const metrics = await ipcRenderer.invoke('telemetry-get');
  const lines = Object.entries(metrics.local.counters || {}).map(([name, value]) => `${name}: ${value}`).join('\n') || 'No local events recorded yet.';
  const toggle = confirm(`Private workflow metrics\n\n${lines}\n\nThese counters stay on this Mac and contain no prompts or source.\n\nSharing is currently ${metrics.share ? 'enabled' : 'disabled'} (no remote endpoint is configured).\nChoose OK to ${metrics.share ? 'disable' : 'enable'} the sharing preference, or Cancel to leave it unchanged.`);
  if (toggle) await ipcRenderer.invoke('telemetry-set', { share: !metrics.share });
};
$('app-update').onclick = async () => {
  const result = await ipcRenderer.invoke('update-check');
  if (result.development) toast(result.message);
  else if (!result.ok) toast(result.message || 'Update check failed', true);
};
ipcRenderer.on('update-state', async (_event, update) => {
  const button = $('app-update');
  if (update.state === 'checking') button.textContent = 'Checking…';
  else if (update.state === 'current') { button.textContent = 'Up to date'; toast(`Clide ${update.version} is current`); setTimeout(() => { button.textContent = 'Update'; }, 2500); }
  else if (update.state === 'available') {
    button.textContent = `Get ${update.version}`;
    if (confirm(`Clide ${update.version} is available. Download the signed update now?`)) await ipcRenderer.invoke('update-download');
  } else if (update.state === 'downloading') button.textContent = `${update.percent}%`;
  else if (update.state === 'downloaded') {
    button.textContent = 'Restart to update';
    if (confirm(`Clide ${update.version} is ready. Restart and install now?\n\nThe previous version (${update.previousVersion}) remains available from Releases for rollback.`)) await ipcRenderer.invoke('update-install');
  } else if (update.state === 'error') { button.textContent = 'Update'; toast(update.message || 'Update failed', true); }
});
$('task-cancel').onclick = closeTaskDialog;
$('task-overlay').onclick = event => { if (event.target === $('task-overlay')) closeTaskDialog(); };

function updateTaskBranch() {
  if ($('task-branch').dataset.edited === '1') return;
  const raw = `${$('task-ticket').value} ${$('task-title').value}`.trim();
  const slug = slugTaskName(raw);
  $('task-branch').value = slug ? `clide/${slug}` : '';
}
$('task-ticket').addEventListener('input', updateTaskBranch);
$('task-title').addEventListener('input', updateTaskBranch);
$('task-branch').addEventListener('input', () => { $('task-branch').dataset.edited = '1'; });

$('task-dialog').onsubmit = async event => {
  event.preventDefault();
  const source = sessions.get($('task-overlay').dataset.sourceKey) || cur();
  if (!source) return;
  const submit = $('task-dialog').querySelector('button[type="submit"]');
  submit.disabled = true; submit.textContent = 'Creating…';
  const payload = {
    cwd: source.cwd, taskId: $('task-overlay').dataset.taskId || undefined,
    ticket: $('task-ticket').value.trim(), taskName: $('task-title').value.trim(),
    provider: $('task-provider').value, branch: $('task-branch').value.trim(), baseRef: $('task-base').value.trim() || 'HEAD',
    setupCommand: $('task-setup').value.trim(), devCommand: $('task-dev').value.trim(),
    dependencies: $('task-dependencies').value.split(',').map(value => value.trim()).filter(Boolean),
    launchPrompt: $('task-prompt').value.trim(), createdBy: source.role === 'orchestrator' ? `orchestrator:${source.persistentId}` : 'user',
    dispatch: { stage: 'worktree-created', requestedAt: new Date().toISOString(), lastActor: 'user' }
  };
  try {
    const result = await ipcRenderer.invoke('git-worktree-create', payload);
    if (!result || !result.ok) throw new Error(result && (result.err || result.error) || 'Could not create worktree.');
    closeTaskDialog();
    await processDurableDispatch(result.task.id);
    await refreshTaskSnapshot();
    toast(`${result.branch} · port ${result.port}`);
  } catch (error) { $('task-dialog-error').textContent = error.message; }
  submit.disabled = false; submit.textContent = 'Create and launch';
};

async function processDurableDispatch(taskId) {
  if (!taskId || dispatchesInFlight.has(taskId)) return;
  dispatchesInFlight.add(taskId);
  let claim;
  try {
    claim = await ipcRenderer.invoke('dispatch-claim', { taskId, owner: rendererInstance });
    if (!claim || !claim.ok) return;
    if (claim.action === 'wait') { await refreshTaskSnapshot(); return; }
    if (claim.action === 'prompt-uncertain') throw new Error('A previous prompt write may have reached the provider but was not acknowledged. Review the terminal, then use Retry launch only if the prompt is absent.');
    let task = claim.task;
    if (claim.action === 'setup') {
      const setup = await ipcRenderer.invoke('setup-run', { taskId: task.id, command: task.setupCommand });
      if (!setup.ok) throw new Error(`Setup failed: ${(setup.err || setup.out || '').slice(-500)}`);
      const advanced = await ipcRenderer.invoke('dispatch-transition', {
        taskId: task.id, leaseId: claim.leaseId, expected: 'setup-running', to: 'launching',
        actor: rendererInstance, reason: 'Worktree setup completed', patch: { setupCompletedAt: new Date().toISOString() }
      });
      if (!advanced.ok) throw new Error(advanced.error || `Setup acknowledgement conflicted at ${advanced.stage || 'unknown stage'}.`);
      task = advanced.task;
    }

    let started = [...sessions.values()].find(session => session.taskId === task.id);
    if (started && task.dispatch.stage === 'launching') {
      const ready = await ipcRenderer.invoke('dispatch-session-ready', { taskId: task.id, sessionKey: started.key });
      if (!ready.ok) throw new Error(ready.error || 'Existing provider session could not confirm readiness.');
      task = ready.task;
    }
    if (!started) started = await startSession({
      cwd: task.worktree, provider: task.provider, title: task.title, taskId: task.id,
      persistentId: task.supervisorId || `worker-${task.id}`, role: 'worker',
      initialPrompt: task.launchPrompt, dispatchLeaseId: claim.leaseId
    });
    else if (task.dispatch.stage === 'provider-ready' && !task.dispatch.promptAcknowledgedAt) {
      await deliverInitialPrompt(started, task.launchPrompt, task.id, claim.leaseId);
    }
    if (!started) throw new Error('Provider worker did not attach.');

    const latest = await ipcRenderer.invoke('state-snapshot');
    const liveTask = latest.tasks[task.id];
    if (liveTask && liveTask.dispatch && liveTask.dispatch.stage === 'prompt-delivered') {
      const running = await ipcRenderer.invoke('dispatch-transition', {
        taskId: task.id, leaseId: claim.leaseId, expected: 'prompt-delivered', to: 'running',
        actor: rendererInstance, reason: 'Worker launch pipeline completed',
        patch: { runningAt: new Date().toISOString(), leaseId: '', leaseOwner: '', leaseExpiresAt: '' },
        taskPatch: { state: 'running' }
      });
      if (!running.ok) throw new Error(running.error || `Running acknowledgement conflicted at ${running.stage || 'unknown stage'}.`);
    }

    if (task.devCommand && !started.terminals.some(terminal => terminal.title === 'Dev server')) {
      const terminal = await startAuxTerminal(started, 'Dev server', undefined, 'dev');
      if (terminal) ipcRenderer.send('session-input', { key: terminal.key, data: `PORT=${task.port} ${task.devCommand}\r` });
    }
    await refreshTaskSnapshot(); toast(`Orchestrator launched ${task.ticket || task.title}`);
  } catch (error) {
    await ipcRenderer.invoke('dispatch-fail', { taskId, leaseId: claim && claim.leaseId, actor: rendererInstance, error: error.message, retry: !(claim && claim.action === 'prompt-uncertain') });
    await refreshTaskSnapshot(); toast(error.message, true);
  } finally {
    dispatchesInFlight.delete(taskId);
  }
}

async function recoverDurableDispatches() {
  const pending = await ipcRenderer.invoke('dispatch-pending', {});
  for (const item of pending || []) await processDurableDispatch(item.task.id);
}

ipcRenderer.on('orchestrator-dispatch', async (_event, result) => {
  await processDurableDispatch(result && (result.taskId || (result.task && result.task.id)));
});

async function promptTaskMessage(s) {
  if (!s) return;
  const body = prompt(`Message for ${s.title}:`);
  if (!body || !body.trim()) return;
  if (s.taskId) {
    await ipcRenderer.invoke('coord-publish', { taskId: s.taskId, kind: 'message', body: body.trim(), from: 'user' });
    await refreshTaskSnapshot();
    toast('Message queued in task coordination');
  } else {
    const t = activeTerminal(s);
    if (t && confirm('This ad-hoc session has no task inbox. Type the message into its active terminal?')) {
      ipcRenderer.send('session-input', { key: t.key, data: body.trim() + '\r' });
    }
  }
}

function setInspector(mode) {
  inspectorMode = mode;
  document.querySelectorAll('#inspector-tabs button').forEach(button => button.classList.toggle('active', button.dataset.inspector === mode));
  const files = mode === 'files';
  $('viewer-nav').style.display = files ? 'flex' : 'none';
  $('tabbar').style.display = files ? 'flex' : 'none';
  $('viewer').style.display = files ? 'flex' : 'none';
  $('inspector-panel').style.display = files ? 'none' : 'flex';
  if (!files) renderInspector();
}
document.querySelectorAll('#inspector-tabs button').forEach(button => button.onclick = () => setInspector(button.dataset.inspector));

function section(title, body) { return `<section class="inspector-section"><h3>${escapeHtml(title)}</h3>${body}</section>`; }
const DISPATCH_RUNWAY = ['worktree-created', 'setup-running', 'launching', 'provider-ready', 'prompt-delivered', 'running'];
function dispatchRunway(task) {
  if (!task.dispatch) return '<div class="inspector-item">This task uses the legacy manual launch path.</div>';
  const stage = task.dispatch.stage; const index = DISPATCH_RUNWAY.indexOf(stage);
  return `<div class="dispatch-runway">${DISPATCH_RUNWAY.map((name, step) => `<span class="${step < index ? 'passed' : step === index ? 'current' : ''}" title="${escapeHtml(name)}">${step + 1}<small>${escapeHtml(name.replaceAll('-', ' '))}</small></span>`).join('')}</div>` +
    (task.dispatch.lastError ? `<div class="inspector-item check-fail">${escapeHtml(task.dispatch.lastError)}<small>attempt ${task.dispatch.attempt} · retry ${escapeHtml(task.dispatch.nextRetryAt || 'manual')}</small></div>` : '');
}

function renderOrchestratorInbox(session) {
  const panel = $('inspector-panel'); const root = session.workspaceRoot || session.cwd;
  const workspace = taskSnapshot.workspaces && taskSnapshot.workspaces[root] || {}; const context = workspace.context || {};
  const tasks = Object.values(taskSnapshot.tasks || {}).filter(task => task.repoRoot === root && task.state !== 'archived');
  const inbox = tasks.filter(task => ['waiting', 'approval', 'blocked', 'done'].includes(task.state) || (task.dispatch && ['failed', 'waiting-dependencies', 'waiting-capacity'].includes(task.dispatch.stage)) || (task.approvals || []).some(item => item.status === 'pending'));
  const inboxBody = inbox.map(task => {
    const pending = (task.approvals || []).filter(item => item.status === 'pending').length;
    return `<div class="inbox-card"><b>${escapeHtml(task.ticket || task.title)}</b><span>${escapeHtml(task.dispatch && task.dispatch.stage || task.state)}</span><p>${escapeHtml(task.title)}</p><small>${pending ? `${pending} approval request${pending === 1 ? '' : 's'} · ` : ''}${escapeHtml(task.dev && task.dev.status || '')}</small><button data-focus-task="${escapeHtml(task.id)}">Open</button></div>`;
  }).join('') || '<div class="inspector-item check-pass">The fleet has no blockers or decisions waiting.</div>';
  const decisions = (context.decisions || []).slice(-8).reverse().map(item => `<div class="inspector-item">${escapeHtml(item.title)}<small>${escapeHtml(item.body)} · ${escapeHtml(item.at || '')}</small></div>`).join('') || '<div class="inspector-item">No repository decisions recorded.</div>';
  panel.innerHTML = section(`Orchestrator inbox · ${inbox.length}`, inboxBody) +
    section('Repository brief', `<form id="workspace-context-form" class="context-form"><label>Brief<textarea name="summary" rows="4" placeholder="What every worker needs to understand">${escapeHtml(context.summary || '')}</textarea></label><label>Constraints<textarea name="constraints" rows="3" placeholder="One constraint per line">${escapeHtml((context.constraints || []).join('\n'))}</textarea></label><label>Useful commands<textarea name="commands" rows="3" placeholder="One command per line">${escapeHtml((context.commands || []).join('\n'))}</textarea></label><label>Conventions<textarea name="conventions" rows="3" placeholder="One convention per line">${escapeHtml((context.conventions || []).join('\n'))}</textarea></label><div><button type="submit">Save brief</button><button id="record-decision" type="button">Record decision</button></div></form>`) + section('Recent decisions', decisions);
  panel.querySelectorAll('[data-focus-task]').forEach(button => button.onclick = () => {
    const task = taskSnapshot.tasks[button.dataset.focusTask]; const worker = [...sessions.values()].find(item => item.taskId === task.id);
    if (worker) switchSession(worker.key); else if (task.dispatch) processDurableDispatch(task.id); else setPanelMode('tasks');
  });
  $('workspace-context-form').onsubmit = async event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const lines = name => String(data.get(name) || '').split('\n').map(value => value.trim()).filter(Boolean);
    await ipcRenderer.invoke('workspace-context-set', { root, context: { summary: data.get('summary'), constraints: lines('constraints'), commands: lines('commands'), conventions: lines('conventions') } });
    await refreshTaskSnapshot(); toast('Repository brief saved');
  };
  $('record-decision').onclick = async () => {
    const title = prompt('Decision title:'); if (!title) return; const body = prompt('Decision and reason:'); if (!body) return;
    const decisions = [...(context.decisions || []), { id: crypto.randomUUID(), title, body, at: new Date().toISOString(), by: 'user' }];
    await ipcRenderer.invoke('workspace-context-set', { root, context: { decisions } }); await refreshTaskSnapshot(); toast('Decision recorded');
  };
}

function renderInspector() {
  const panel = $('inspector-panel');
  const task = activeTask();
  panel.innerHTML = '';
  if (!task) {
    const session = cur();
    if (session && session.role === 'orchestrator' && inspectorMode === 'messages') { renderOrchestratorInbox(session); return; }
    panel.innerHTML = '<div class="inspector-empty">This session is not attached to an isolated task.<br>Open Inbox on the orchestrator or create a task for worker details.</div>'; return;
  }
  if (inspectorMode === 'messages') {
    const findings = (task.findings || []).map(item => `<div class="inspector-item">${escapeHtml(item.body)}<small>${escapeHtml(item.level || 'info')} · ${escapeHtml(item.from || 'agent')} · ${escapeHtml(item.at || '')}</small></div>`).join('') || '<div class="inspector-item">No published findings.</div>';
    const messages = (task.messages || []).map(item => `<div class="inspector-item">${escapeHtml(item.body)}<small>${escapeHtml(item.from || 'agent')} · ${escapeHtml(item.at || '')}</small></div>`).join('') || '<div class="inspector-item">No queued messages.</div>';
    const agents = (task.childAgents || []).map(item => `<div class="inspector-item ${item.state === 'done' ? 'check-pass' : ''}">${escapeHtml(item.label || 'Child agent')}<small>${escapeHtml(item.provider || task.provider)} · ${escapeHtml(item.state || 'running')} · ${escapeHtml(item.event || '')}</small></div>`).join('') || '<div class="inspector-item">No child agents reported.</div>';
    const events = (task.events || []).slice(-20).reverse().map(item => `<div class="inspector-item">${escapeHtml(item.name)}<small>${escapeHtml(item.provider || task.provider)} · ${escapeHtml(item.state || '')} · ${escapeHtml(item.at || '')}</small></div>`).join('') || '<div class="inspector-item">Waiting for provider lifecycle events.</div>';
    const claims = (task.pathClaims || []).map(item => `<div class="inspector-item">${escapeHtml(item.path)}<small>${escapeHtml(item.note || 'claimed path')} · ${escapeHtml(item.at || '')}</small></div>`).join('') || '<div class="inspector-item">No paths claimed yet.</div>';
    const artifacts = (task.artifacts || []).map(item => `<div class="inspector-item">${escapeHtml(item.label || item.path)}<small>${escapeHtml(item.kind || 'file')} · ${escapeHtml(item.path || '')}</small></div>`).join('') || '<div class="inspector-item">No artifacts published yet.</div>';
    const dependencyItems = (task.dependencies || []).map(id => { const dependency = taskSnapshot.tasks[id]; return `<div class="inspector-item ${dependency && ['done','archived'].includes(dependency.state) ? 'check-pass' : 'check-fail'}">${escapeHtml(dependency ? dependency.title : id)}<small>${escapeHtml(dependency ? dependency.state : 'missing')}</small></div>`; }).join('') || '<div class="inspector-item">No task dependencies.</div>';
    const approvals = (task.approvals || []).slice().reverse().map(item => `<div class="inspector-item approval-item ${escapeHtml(item.status)}"><b>${escapeHtml(item.title)}</b><div>${escapeHtml(item.body)}</div>${item.command ? `<code>${escapeHtml(item.command)}</code>` : ''}<small>${escapeHtml(item.status)} · ${escapeHtml(item.requestedAt || '')}</small>${item.status === 'pending' ? `<div class="approval-actions"><button data-approval="${escapeHtml(item.id)}" data-approved="1">Approve</button><button data-approval="${escapeHtml(item.id)}" data-approved="0">Reject</button></div>` : ''}</div>`).join('') || '<div class="inspector-item">No approval requests.</div>';
    const audit = (task.audit || []).slice(-30).reverse().map(item => `<div class="audit-row"><span>${escapeHtml(item.type)}</span><small>${escapeHtml(item.actor)} · ${escapeHtml(item.at)}</small><p>${escapeHtml(item.reason || '')}</p></div>`).join('') || '<div class="inspector-item">No audited actions yet.</div>';
    const dev = task.dev ? `<div class="inspector-item dev-health ${escapeHtml(task.dev.status)}">${escapeHtml(task.dev.status)} · <a>${escapeHtml(task.dev.url || `http://127.0.0.1:${task.port}`)}</a><small>last checked ${escapeHtml(task.dev.lastCheckedAt || 'not yet')}</small></div>` : '<div class="inspector-item">No dev command configured.</div>';
    const controls = task.dispatch && task.dispatch.stage !== 'running' && task.dispatch.stage !== 'cancelled' ? `<div class="integration-actions"><button id="retry-dispatch">Retry launch</button><button id="cancel-dispatch">Cancel launch</button></div>` : '';
    panel.innerHTML = section('Dispatch runway', dispatchRunway(task) + controls) + section('Dev environment', dev) + section('Approvals', approvals) + section('Dependencies', dependencyItems) + section('Child agents', agents) + section('Path ownership', claims) + section('Artifacts', artifacts) + section('Provider events', events) + section('Published findings', findings) + section('Messages', messages) + section('Audit trail', audit) + section('Send message', '<form id="message-form" class="inspector-form"><input placeholder="Durable context update" /><button>Send</button></form>');
    if ($('retry-dispatch')) $('retry-dispatch').onclick = async () => { const result = await ipcRenderer.invoke('dispatch-retry', { taskId: task.id }); toast(result.ok ? 'Launch queued again' : result.error, !result.ok); await refreshTaskSnapshot(); };
    if ($('cancel-dispatch')) $('cancel-dispatch').onclick = async () => { if (!confirm('Cancel this worker launch? The branch and worktree are kept.')) return; await ipcRenderer.invoke('dispatch-cancel', { taskId: task.id }); await refreshTaskSnapshot(); };
    panel.querySelectorAll('[data-approval]').forEach(button => button.onclick = async () => { await ipcRenderer.invoke('approval-resolve', { taskId: task.id, approvalId: button.dataset.approval, approved: button.dataset.approved === '1' }); await refreshTaskSnapshot(); });
    $('message-form').onsubmit = async event => { event.preventDefault(); const input = event.currentTarget.querySelector('input'); if (!input.value.trim()) return; await ipcRenderer.invoke('coord-publish', { taskId: task.id, kind: 'message', body: input.value.trim(), from: 'user' }); await refreshTaskSnapshot(); };
  } else if (inspectorMode === 'checks') {
    const checks = (task.checks || []).slice().reverse().map(item => `<div class="inspector-item ${item.ok ? 'check-pass' : 'check-fail'}">${item.ok ? '✓' : '×'} ${escapeHtml(item.command || item.type)}<small>${escapeHtml(item.sha || '')} ${escapeHtml(item.at || '')}</small></div>`).join('') || '<div class="inspector-item">No checks recorded.</div>';
    panel.innerHTML = section('Checks at reviewed SHA', checks) + section('Run checks', '<form id="checks-form" class="inspector-form"><input value="npm test" placeholder="npm test, npm run lint" /><button>Run</button></form><div id="check-output"></div>');
    $('checks-form').onsubmit = async event => { event.preventDefault(); const input = event.currentTarget.querySelector('input'); const commands = input.value.split(',').map(v => v.trim()).filter(Boolean); $('check-output').textContent = 'Running…'; const result = await ipcRenderer.invoke('checks-run', { taskId: task.id, commands }); $('check-output').textContent = result.ok ? `Passed at ${result.sha}` : 'A check failed. Open its record above.'; await refreshTaskSnapshot(); };
  } else if (inspectorMode === 'integrate') {
    const overlaps = (taskSnapshot.overlaps || []).filter(item => item.taskIds.includes(task.id));
    const overlapBody = overlaps.length ? overlaps.map(item => `<div class="inspector-item check-fail">⚠ ${escapeHtml(item.path)}<small>${item.taskIds.map(escapeHtml).join(' ↔ ')}</small></div>`).join('') : '<div class="inspector-item check-pass">✓ No changed-file overlap with other tasks.</div>';
    panel.innerHTML = section('Conflict awareness', overlapBody) + section('Review queue', `<div class="inspector-item">${escapeHtml(task.branch)} → ${escapeHtml(task.baseRef || 'HEAD')}<small>${task.git && task.git.files ? task.git.files.length : 0} changed files · state ${escapeHtml(task.state)}</small></div><div id="integration-preview"></div><div class="integration-actions"><button id="preview-integration">Preview conflicts</button><button id="create-review">Independent AI review</button><button id="combined-test">Combined test worktree</button><button id="mark-ready">Mark done</button><button id="draft-pr">Draft PR in shell…</button><button id="integrate-task" class="primary">Merge into active checkout…</button><button id="cleanup-task">Archive worktree…</button></div>`);
    $('preview-integration').onclick = async () => { const result = await ipcRenderer.invoke('git-conflict-preview', { taskId: task.id, target: task.baseRef }); $('integration-preview').innerHTML = `<div class="inspector-item ${result.clean ? 'check-pass' : 'check-fail'}">${result.clean ? '✓ Clean merge preview' : `× ${result.conflicts.length} conflict markers`}<small>${escapeHtml(result.target || '')} ← ${escapeHtml(result.branch || '')}</small></div>`; };
    $('mark-ready').onclick = async () => { await ipcRenderer.invoke('task-patch', { id: task.id, patch: { state: 'done' } }); await refreshTaskSnapshot(); };
    $('create-review').onclick = async () => {
      const result = await ipcRenderer.invoke('review-task-create', { taskId: task.id });
      if (!result.ok) return toast(result.err || 'Could not create review task', true);
      const started = await startSession({ cwd: result.cwd, provider: result.provider, title: result.task.title, taskId: result.task.id });
      if (started && result.prompt) setTimeout(() => ipcRenderer.send('session-input', { key: started.key, data: result.prompt + '\r' }), 600);
      await refreshTaskSnapshot(); toast(`Review assigned to ${result.provider}`);
    };
    $('combined-test').onclick = async () => {
      const related = Object.values(taskSnapshot.tasks || {}).filter(item => item.repoRoot === task.repoRoot && item.id !== task.id && item.state === 'done' && !item.reviewOf && !(item.integrationOf || []).length);
      const ids = [task.id, ...related.map(item => item.id)];
      const provider = task.provider === 'claude' ? 'codex' : 'claude';
      const result = await ipcRenderer.invoke('integration-worktree-create', { taskIds: ids, provider, baseRef: task.baseRef });
      if (!result.ok && !result.blocked) return toast(result.err || 'Could not create integration worktree', true);
      const started = await startSession({ cwd: result.cwd, provider: result.task.provider, title: result.task.title, taskId: result.task.id });
      if (started && result.prompt) setTimeout(() => ipcRenderer.send('session-input', { key: started.key, data: result.prompt + '\r' }), 600);
      await refreshTaskSnapshot(); toast(result.blocked ? `Integration worktree has ${result.conflicts.length} conflict(s)` : `Combined ${result.merged.length} branches`, Boolean(result.blocked));
    };
    $('draft-pr').onclick = async () => {
      const s = cur(); if (!s || s.taskId !== task.id) return;
      const terminal = await startAuxTerminal(s, 'Draft PR');
      if (terminal) ipcRenderer.send('session-input', { key: terminal.key, data: `gh pr create --draft --fill --head ${quotePath(task.branch)}\r` });
    };
    $('integrate-task').onclick = async () => {
      if (!confirm(`Merge ${task.branch} into the currently checked-out branch at ${task.repoRoot}?\n\nClide requires a clean checkout and a clean conflict preview. It will not push.`)) return;
      const result = await ipcRenderer.invoke('git-integrate', { taskId: task.id, targetRoot: task.repoRoot });
      toast(result.ok ? 'Integrated successfully' : (result.err || 'Integration failed'), !result.ok); await refreshTaskSnapshot();
    };
    $('cleanup-task').onclick = async () => { if (!confirm(`Remove the clean worktree for ${task.title}? The branch is kept.`)) return; let result = await ipcRenderer.invoke('git-worktree-remove', { taskId: task.id }); if (result.needsConfirmation && confirm(result.err + '\n\nKeep the branch and remove only the worktree?')) result = await ipcRenderer.invoke('git-worktree-remove', { taskId: task.id, confirmUniqueCommits: true }); toast(result.ok ? 'Worktree archived; branch kept' : result.err, !result.ok); await refreshTaskSnapshot(); };
  }
}

$('attention-toggle').onclick = () => { setPanelMode('tasks'); setExplorer(true); };
$('inspector-toggle').onclick = () => setInspectorVisible(workbenchMode === 'terminal' ? $('right').style.display === 'none' : explorer.style.display === 'none');
$('task-doctor').onclick = async () => { const result = await ipcRenderer.invoke('doctor-run'); alert(`Clide doctor\n\nGit: ${result.git || 'missing'}\nClaude: ${result.providers.claude ? 'ready' : 'missing'}\nCodex: ${result.providers.codex ? 'ready' : 'missing'}\nnode-pty: ${result.nodePty ? 'ready' : 'missing'}\nDetached sessions: ${result.supervisor.screen ? 'ready' : 'missing'}\nClaude skills: ${result.skills.claude ? 'found' : 'not installed'}\nCodex skills: ${result.skills.codex ? 'found' : 'not installed'}\nShim: authenticated on ${result.shim.socket}`); };

setInterval(async () => { await refreshTaskSnapshot(); await recoverDurableDispatches(); }, 4000);

/* ===================== panel mode (files / git) ===================== */
let panelMode = 'tasks';
document.querySelectorAll('.ptab').forEach(t => { t.onclick = () => setPanelMode(t.dataset.mode); });
function setPanelMode(mode, { selectFirst = false } = {}) {
  panelMode = mode;
  document.querySelectorAll('.ptab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('files-pane').style.display = mode === 'files' ? 'flex' : 'none';
  $('tasks-pane').style.display = mode === 'tasks' ? 'flex' : 'none';
  $('git-pane').style.display = mode === 'git' ? 'flex' : 'none';
  if (mode === 'git') loadGit({ selectFirst });
  if (mode === 'tasks') renderTaskRail();
}
setPanelMode('tasks');

/* ===================== workbench shell ===================== */
const WORKBENCH_MODES = new Set(['review', 'terminal', 'files']);
const toolOverlay = $('tool-overlay');
let environmentRefresh = 0;

function setInspectorVisible(show) {
  if (workbenchMode === 'terminal') {
    inspectorVisible = Boolean(show);
    localStorage.setItem('clide-inspector-visible', String(inspectorVisible));
    $('right').style.display = inspectorVisible ? 'flex' : 'none';
    $('inspector-toggle').classList.toggle('on', inspectorVisible);
  } else {
    setExplorer(show);
  }
  setTimeout(fitAll, 0);
}

function setWorkbenchMode(mode, { persist = true } = {}) {
  if (!WORKBENCH_MODES.has(mode)) return;
  workbenchMode = mode;
  document.body.dataset.workbench = mode;
  if (persist) localStorage.setItem('clide-workbench', mode);
  document.querySelectorAll('.workbench-tab').forEach(button => {
    const active = button.dataset.workbench === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('terminal-focus').classList.toggle('on', mode === 'terminal');
  if (mode === 'review') {
    setPanelMode('git', { selectFirst: true });
    setInspector('files');
    $('right').style.display = 'flex';
    setExplorer(true, { persist: false });
  } else if (mode === 'files') {
    setPanelMode('files');
    setInspector('files');
    $('right').style.display = 'flex';
    setExplorer(true, { persist: false });
  } else {
    setPanelMode('tasks');
    $('right').style.display = inspectorVisible ? 'flex' : 'none';
    setExplorer(false, { persist: false });
  }
  $('inspector-toggle').classList.toggle('on', mode === 'terminal' ? inspectorVisible : explorer.style.display !== 'none');
  setEnvironmentVisible(environmentVisible, { persist: false });
  refreshEnvironment();
  if (persist) saveState();
  setTimeout(fitAll, 0);
}

function openToolLauncher() {
  toolOverlay.style.display = 'flex';
  const first = toolOverlay.querySelector('[data-open-tool]');
  if (first) setTimeout(() => first.focus(), 0);
}
function closeToolLauncher() { toolOverlay.style.display = 'none'; }

function pullRequestTitle(branch, commits) {
  if (commits && commits.length === 1) return commits[0];
  const leaf = String(branch || '').split('/').pop() || 'Update';
  return leaf.replace(/[-_]+/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

async function openPullRequestDialog() {
  const s = cur();
  if (!s) return toast('Open a repository first', true);
  const overlay = $('pr-overlay');
  const error = $('pr-dialog-error');
  error.className = '';
  error.textContent = 'Loading branch details…';
  $('pr-submit').disabled = true;
  $('pr-submit').textContent = 'Create pull request';
  overlay.dataset.sessionKey = s.key;
  overlay.style.display = 'flex';
  try {
    const preview = await ipcRenderer.invoke('git-pr-preview', { cwd: s.cwd });
    if (!preview.ok) throw new Error(preview.err || 'Pull request preview failed.');
    $('pr-head').textContent = preview.branch;
    $('pr-base').value = preview.base;
    $('pr-title').value = pullRequestTitle(preview.branch, preview.commits);
    $('pr-body').value = preview.commits.length
      ? `## Summary\n\n${preview.commits.slice(0, 8).map(commit => `- ${commit}`).join('\n')}\n\n## Verification\n\n- [ ] Add verification notes`
      : '';
    $('pr-summary').textContent =
      `${preview.commits.length} commit${preview.commits.length === 1 ? '' : 's'} · ${preview.files} changed file${preview.files === 1 ? '' : 's'} · +${preview.additions} −${preview.deletions}`;
    $('pr-submit').disabled = !preview.available || !preview.upstream;
    error.textContent = preview.available ? (preview.upstream ? `Published branch: ${preview.upstream}` : 'This branch has no upstream. Push it before creating the pull request.') : preview.ghError;
    error.className = preview.available && preview.upstream ? 'success' : '';
    setTimeout(() => $('pr-title').focus(), 0);
  } catch (errorValue) {
    error.textContent = errorValue.message;
    $('pr-submit').disabled = true;
  }
}

function closePullRequestDialog() {
  $('pr-overlay').style.display = 'none';
  $('pr-dialog-error').className = '';
}

async function refreshEnvironment() {
  const version = ++environmentRefresh;
  const s = cur();
  const repo = s && (s.repo || (s.status && s.status.repo)) || '';
  const branch = s && s.status && s.status.branch || '';
  $('workbench-repo').textContent = repo || 'No workspace';
  $('workbench-branch').textContent = branch ? `／ ${branch}` : '';
  $('environment-branch').textContent = branch || 'No branch';
  const task = activeTask();
  $('environment-local').textContent = task && task.dev && task.dev.status ? task.dev.status : 'ready';
  if (!s) {
    $('environment-diffstat').innerHTML = '<b>0</b>';
    return;
  }
  try {
    const summary = await ipcRenderer.invoke('git-diff-summary', { cwd: s.cwd });
    if (version !== environmentRefresh || s !== cur()) return;
    $('environment-branch').textContent = summary.branch || branch || 'No branch';
    $('workbench-branch').textContent = summary.branch ? `／ ${summary.branch}` : '';
    $('environment-diffstat').innerHTML =
      `<b>${summary.files || 0}</b><span>+${summary.additions || 0}</span><span class="deletions">−${summary.deletions || 0}</span>`;
  } catch {
    if (version === environmentRefresh) $('environment-diffstat').innerHTML = '<b>—</b>';
  }
}

document.querySelectorAll('.workbench-tab').forEach(button => {
  button.onclick = () => setWorkbenchMode(button.dataset.workbench);
});
document.querySelectorAll('[data-open-tool]').forEach(button => {
  button.onclick = () => { setWorkbenchMode(button.dataset.openTool); closeToolLauncher(); };
});
$('launcher-open').onclick = openToolLauncher;
$('tool-launcher-close').onclick = closeToolLauncher;
toolOverlay.onclick = event => { if (event.target === toolOverlay) closeToolLauncher(); };
$('terminal-focus').onclick = () => setWorkbenchMode('terminal');
$('environment-review').onclick = () => setWorkbenchMode('review');
$('environment-git-action').onclick = () => {
  setWorkbenchMode('review');
  setTimeout(() => $('git-message').focus(), 0);
};
$('environment-pr').onclick = openPullRequestDialog;
$('environment-branch-row').onclick = () => openBranchMenu($('environment-branch-row'), 'up');
$('environment-new-shell').onclick = () => startAuxTerminal();
$('environment-terminal').onclick = () => { setWorkbenchMode('terminal'); startAuxTerminal(); };
$('pr-cancel').onclick = closePullRequestDialog;
$('pr-overlay').onclick = event => { if (event.target === $('pr-overlay')) closePullRequestDialog(); };
$('pr-dialog').onsubmit = async event => {
  event.preventDefault();
  const s = sessions.get($('pr-overlay').dataset.sessionKey) || cur();
  if (!s) return;
  const title = $('pr-title').value.trim();
  const base = $('pr-base').value.trim();
  const body = $('pr-body').value.trim();
  const branch = $('pr-head').textContent;
  if (!title || !base) return;
  if (!confirm(`Create this GitHub pull request?\n\n${branch} → ${base}\n${title}\n\nClide will not push or merge any commits.`)) return;
  const submit = $('pr-submit');
  const error = $('pr-dialog-error');
  submit.disabled = true;
  submit.textContent = 'Creating…';
  error.className = '';
  error.textContent = 'Publishing pull request with GitHub CLI…';
  try {
    const result = await ipcRenderer.invoke('git-pr-create', { cwd: s.cwd, title, body, base });
    if (!result.ok) throw new Error(result.err || 'GitHub CLI could not create the pull request.');
    error.className = 'success';
    error.textContent = result.url ? `Created ${result.url}` : 'Pull request created.';
    submit.textContent = 'Created';
    if (result.url && confirm('Pull request created. Open it in your browser?')) ipcRenderer.send('open-external', result.url);
  } catch (errorValue) {
    error.textContent = errorValue.message;
    submit.disabled = false;
    submit.textContent = 'Create pull request';
  }
};

/* ===================== git panel ===================== */
const gitChanges = $('git-changes');
function basename(p) { return p.split('/').pop(); }
function dirpart(p) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(0, i) : ''; }
function statusClass(c) { return ({ M: 'mod', '?': 'new', A: 'add', D: 'del', R: 'ren', U: 'con' })[c] || 'mod'; }

async function loadGit({ selectFirst = false } = {}) {
  const s = cur(); if (!s) return;
  const st = await ipcRenderer.invoke('git-status', { cwd: s.cwd });
  if (!st || !st.repo) {
    $('git-branch').textContent = 'not a git repo'; $('git-aheadbehind').textContent = '';
    $('git-count').textContent = ''; gitChanges.innerHTML = '<div class="no-results">Not a git repository.</div>';
    refreshEnvironment();
    return;
  }
  $('git-branch').textContent = st.branch || 'HEAD';
  let ab = ''; if (st.ahead) ab += `↑${st.ahead}`; if (st.behind) ab += (ab ? ' ' : '') + `↓${st.behind}`;
  $('git-aheadbehind').textContent = ab;
  $('git-count').textContent = st.files.length ? ` ${st.files.length}` : '';
  gitChanges.innerHTML = '';
  if (!st.files.length) { gitChanges.innerHTML = '<div class="no-results">No changes.</div>'; refreshEnvironment(); return; }
  const staged = st.files.filter(f => f.staged);
  const unstaged = st.files.filter(f => f.unstaged);
  gitChanges.appendChild(gitZone('Staged', staged, true, s));
  gitChanges.appendChild(gitZone('Changes', unstaged, false, s));
  refreshEnvironment();
  if (selectFirst && !s.viewerTabs.some(tab => tab.kind === 'diff')) {
    const first = staged[0] || unstaged[0];
    if (first) await openDiff(s, first.path, Boolean(first.staged));
  }
}
function gitZone(label, files, isStaged, s) {
  const zone = document.createElement('div');
  zone.className = 'git-zone ' + (isStaged ? 'zone-staged' : 'zone-unstaged');
  const h = document.createElement('div'); h.className = 'git-group';
  h.textContent = `${label} · ${files.length}`;
  zone.appendChild(h);
  for (const f of files) {
    const code = isStaged ? f.index : (f.untracked ? '?' : f.work);
    const row = document.createElement('div');
    row.className = 'git-file ' + (isStaged ? 'staged' : 'unstaged');
    row.draggable = true;
    row.innerHTML =
      `<span class="g-status">${code === ' ' ? 'M' : code}</span>` +
      `<span class="g-name" title="${escapeHtml(f.path)}">${escapeHtml(basename(f.path))}</span>` +
      `<span class="g-dir">${escapeHtml(dirpart(f.path))}</span>` +
      `<span class="g-act" title="${isStaged ? 'Unstage' : 'Stage'}">${isStaged ? '−' : '+'}</span>`;
    row.onclick = e => { if (!e.target.closest('.g-act')) openDiff(s, f.path, isStaged); };
    row.querySelector('.g-act').onclick = async e => {
      e.stopPropagation();
      await ipcRenderer.invoke(isStaged ? 'git-unstage' : 'git-stage', { cwd: s.cwd, file: f.path });
      loadGit();
    };
    row.addEventListener('dragstart', ev => {
      ev.dataTransfer.setData('application/x-clide-git', f.path);
      ev.dataTransfer.setData('text/plain', s.cwd + '/' + f.path);
      ev.dataTransfer.effectAllowed = 'move';
    });
    zone.appendChild(row);
  }
  zone.addEventListener('dragover', ev => {
    if ([...ev.dataTransfer.types].includes('application/x-clide-git')) {
      ev.preventDefault(); ev.dataTransfer.dropEffect = 'move'; zone.classList.add('zone-drop');
    }
  });
  zone.addEventListener('dragleave', ev => { if (!zone.contains(ev.relatedTarget)) zone.classList.remove('zone-drop'); });
  zone.addEventListener('drop', async ev => {
    const file = ev.dataTransfer.getData('application/x-clide-git');
    if (!file) return;
    ev.preventDefault(); ev.stopPropagation(); zone.classList.remove('zone-drop');
    await ipcRenderer.invoke(isStaged ? 'git-stage' : 'git-unstage', { cwd: s.cwd, file });
    loadGit();
  });
  return zone;
}
async function openDiff(s, file, staged) {
  let diff = await ipcRenderer.invoke('git-diff', { cwd: s.cwd, file, staged });
  if (!diff || !diff.trim()) diff = await ipcRenderer.invoke('git-diff', { cwd: s.cwd, file, staged: !staged });
  const body = (diff && diff.trim()) ? diff : '(no textual diff — binary file or no line changes)';
  addTab(s, { path: `diff:${staged ? 'staged' : 'work'}:${file}`, name: basename(file), kind: 'diff', body, src: file, staged: Boolean(staged), ext: 'diff' });
  if (s.key === activeKey) { renderTabbar(); renderViewer(); }
}
$('git-refresh').onclick = loadGit;
$('git-commit').onclick = async () => {
  const s = cur(); if (!s) return;
  const msg = $('git-message').value.trim();
  if (!msg) { $('git-message').focus(); return; }
  const b = $('git-commit'); b.disabled = true;
  const st = await ipcRenderer.invoke('git-status', { cwd: s.cwd });
  const hasStaged = st.repo && st.files.some(f => f.staged);
  if (!hasStaged) { b.disabled = false; toast('Stage the exact files you want to commit first', true); return; }
  const r = await ipcRenderer.invoke('git-commit', { cwd: s.cwd, message: msg });
  b.disabled = false;
  if (r.ok) { $('git-message').value = ''; toast('Committed staged files'); }
  else toast((r.err.split('\n').find(Boolean)) || 'Commit failed', true);
  loadGit();
};
$('git-push').onclick = async () => {
  const s = cur(); if (!s) return;
  const b = $('git-push'); b.disabled = true; b.textContent = 'Pushing…';
  const r = await ipcRenderer.invoke('git-push', { cwd: s.cwd });
  b.disabled = false; b.textContent = 'Push';
  toast(r.ok ? 'Pushed' : ((r.err.split('\n').find(Boolean)) || 'Push failed'), !r.ok);
  loadGit();
};

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
function toggleEnvironment() { setEnvironmentVisible(!environmentVisible); }
let fontScale = 13;
function applyZoom() {
  for (const s of sessions.values()) for (const t of s.terminals) t.term.options.fontSize = fontScale;
  document.documentElement.style.setProperty('--editor-size', fontScale + 'px');
  fitActive();
}
function zoom(d) { fontScale = Math.max(9, Math.min(22, fontScale + d)); applyZoom(); }
function reopenClosed() { const s = cur(); if (s && s.closedTabs.length) openInSession(s.key, s.closedTabs.pop()); }
function cycleTerminal(dir) {
  const s = cur(); if (!s || s.terminals.length < 2) return;
  const i = s.terminals.findIndex(t => t.key === s.activeTerminalKey);
  const next = (i + dir + s.terminals.length) % s.terminals.length;
  selectTerminal(s, s.terminals[next].key);
}
function notifyClaude(s) {
  if (s.key === activeKey && document.hasFocus()) return;
  const provider = s.provider === 'codex' ? 'Codex' : 'Claude';
  try { new Notification(provider + ' · ' + s.repo, { body: 'Waiting for you', silent: false }); } catch {}
  s.unread = true; renderSessionTabs();
}
window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && toolOverlay.style.display === 'flex') { closeToolLauncher(); return; }
  if (e.key === 'Escape' && $('pr-overlay').style.display === 'flex') { closePullRequestDialog(); return; }
  if (e.key === 'Escape' && $('task-overlay').style.display === 'flex') { closeTaskDialog(); return; }
  if (e.ctrlKey && e.key === 'Tab') {
    e.preventDefault(); cycleTerminal(e.shiftKey ? -1 : 1); return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod) return;
  if (e.altKey && /^[1-3]$/.test(e.key)) {
    e.preventDefault();
    setWorkbenchMode(['review', 'terminal', 'files'][Number(e.key) - 1]);
  }
  else if (e.key === '\\') { e.preventDefault(); setLayout(layoutMode === 'focus' ? 'grid' : 'focus'); }
  else if (e.key.toLowerCase() === 'i') { e.preventDefault(); $('inspector-toggle').click(); }
  else if (e.shiftKey && /^[1-9]$/.test(e.key)) { const idx = +e.key - 1; const s = sessions.get(order[idx]); if (s) { e.preventDefault(); promptTaskMessage(s); } }
  else if (e.shiftKey && (e.key === 't' || e.key === 'T')) { e.preventDefault(); reopenClosed(); }
  else if (e.shiftKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); startAuxTerminal(); }
  else if (e.key === 't') { e.preventDefault(); openHistory(); }
  else if (e.key === 'p') { e.preventDefault(); setWorkbenchMode('files'); searchInput.focus(); searchInput.select(); }
  else if (e.key === 'b') { e.preventDefault(); toggleEnvironment(); }
  else if (e.key === 'k') {
    e.preventDefault();
    if (e.shiftKey) { const t = activeTerminal(); if (t) t.term.clear(); }
    else openToolLauncher();
  }
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
      return {
        cwd: s.cwd,
        provider: s.provider,
        taskId: s.taskId,
        role: s.role,
        workspaceRoot: s.workspaceRoot,
        persistentId: s.persistentId,
        resumeId: s.resumeId || null,
        title: s.title,
        tabs,
        active: act ? act.path : null,
        shells: s.terminals.filter(t => t.kind === 'shell' || t.kind === 'dev').map(t => ({ title: t.title, persistentId: t.persistentId, kind: t.kind })),
        activeTerminal: Math.max(0, s.terminals.findIndex(t => t.key === s.activeTerminalKey))
      };
    });
    const state = {
      sessions: data,
      active: order.indexOf(activeKey),
      layout: layoutMode,
      workbench: workbenchMode,
      explorerVisible,
      inspectorVisible,
      environmentVisible
    };
    localStorage.setItem('clide-state', JSON.stringify(state));
    ipcRenderer.invoke('view-state-set', state).catch(() => {});
  } catch {}
}
async function loadState() {
  try { return await ipcRenderer.invoke('view-state-get') || JSON.parse(localStorage.getItem('clide-state') || 'null'); }
  catch { try { return JSON.parse(localStorage.getItem('clide-state') || 'null'); } catch { return null; } }
}
window.addEventListener('beforeunload', saveState);

async function restoreLiveSessions() {
  let live = [];
  try { live = await ipcRenderer.invoke('sessions-list'); } catch { return; }
  for (const item of live || []) {
    const existing = [...sessions.values()].find(session => session.key === item.key || (item.taskId && session.taskId === item.taskId) || (item.role === 'orchestrator' && session.role === 'orchestrator' && session.workspaceRoot === item.workspaceRoot));
    if (existing) continue;
    await startSession({ cwd: item.cwd, provider: item.provider, taskId: item.taskId, persistentId: item.persistentId, role: item.role, workspaceRoot: item.workspaceRoot, title: item.role === 'orchestrator' ? 'Repository Orchestrator' : (taskSnapshot.tasks[item.taskId] && taskSnapshot.tasks[item.taskId].title), restoreShells: item.shells });
  }
  const durable = Object.values(taskSnapshot.tasks || {}).filter(task => task.dispatch && task.dispatch.stage === 'running' && task.supervisorId && task.worktree && task.state !== 'archived');
  for (const task of durable) {
    if ([...sessions.values()].some(session => session.taskId === task.id)) continue;
    await startSession({ cwd: task.worktree, provider: task.provider, taskId: task.id, persistentId: task.supervisorId, role: 'worker', recoverOnly: true, title: task.title });
  }
}

/* ===================== boot ===================== */
setWorkbenchMode(workbenchMode, { persist: false });
(async () => {
  try { providerAvailability = await ipcRenderer.invoke('provider-availability'); } catch {}
  await refreshTaskSnapshot();
  const initial = await ipcRenderer.invoke('initial-cwd');
  const saved = await loadState();
  if (saved && saved.sessions && saved.sessions.length) {
    const promotedRoots = new Set();
    for (const ss of saved.sessions) {
      let role = ss.role;
      if (!role && !ss.taskId && !promotedRoots.has(ss.cwd)) role = 'orchestrator';
      if (role === 'orchestrator') promotedRoots.add(ss.cwd);
      await startSession({
        cwd: ss.cwd,
        provider: ss.provider || 'claude',
        taskId: ss.taskId,
        role: role || 'worker',
        persistentId: ss.persistentId,
        resumeId: ss.resumeId,
        title: ss.title,
        restoreTabs: ss.tabs,
        restoreActive: ss.active,
        restoreShells: ss.shells,
        restoreTerminal: ss.activeTerminal
      });
    }
    await restoreLiveSessions();
    if (!initial.noStart && ![...sessions.values()].some(session => session.role === 'orchestrator' && (session.workspaceRoot === initial.cwd || session.cwd === initial.cwd))) {
      const preferred = initial.defaultProvider === 'codex' ? 'codex' : 'claude';
      const provider = providerAvailability[preferred] ? preferred : (providerAvailability.claude ? 'claude' : 'codex');
      await startSession({ cwd: initial.cwd, provider, role: 'orchestrator', title: 'Repository Orchestrator', initialPrompt: 'Use $clide-orchestrate. Act as this repository orchestrator: keep the primary checkout stable, inspect Clide tasks, and dispatch implementation only to isolated workers.' });
    }
    if (saved.layout) setLayout(saved.layout);
    if (WORKBENCH_MODES.has(saved.workbench)) workbenchMode = saved.workbench;
    if (typeof saved.explorerVisible === 'boolean') explorerVisible = saved.explorerVisible;
    if (typeof saved.inspectorVisible === 'boolean') inspectorVisible = saved.inspectorVisible;
    if (typeof saved.environmentVisible === 'boolean') environmentVisible = saved.environmentVisible;
    setWorkbenchMode(workbenchMode, { persist: false });
    if (saved.active >= 0 && order[saved.active]) switchSession(order[saved.active]);
    await recoverDurableDispatches();
    return;
  }
  const { cwd, explicit, noStart } = initial;
  await restoreLiveSessions();
  if (noStart) return;
  const preferred = initial.defaultProvider === 'codex' ? 'codex' : 'claude';
  const defaultProvider = providerAvailability[preferred] ? preferred : (providerAvailability.claude ? 'claude' : 'codex');
  if (![...sessions.values()].some(session => session.role === 'orchestrator' && (session.workspaceRoot === cwd || session.cwd === cwd))) await startSession({ cwd, provider: defaultProvider, role: 'orchestrator', title: 'Repository Orchestrator', initialPrompt: 'Use $clide-orchestrate. Act as this repository orchestrator: keep the primary checkout stable, inspect Clide tasks, and dispatch implementation only to isolated workers.' });
  await recoverDurableDispatches();
  // First launch → open the welcome tab (intro + one-click skills install + map).
  if (!localStorage.getItem('clide-welcomed')) {
    const s = cur();
    if (s) { addTab(s, { path: 'welcome:os', name: 'Welcome', kind: 'welcome' }); renderTabbar(); renderViewer(); }
    localStorage.setItem('clide-welcomed', '1');
  }
  if (!explicit) openHistory(); // Finder launch → let the user jump to a recent repo/chat
})();
