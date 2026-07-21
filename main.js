const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, dialog, Notification } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync, execFile, spawn } = require('child_process');
const { StateStore } = require('./src/main/state-store');
const { autoUpdater } = require('electron-updater');
const { provider, availability } = require('./src/main/providers');
const { changedPathMap } = require('./src/main/overlap');
const supervisor = require('./src/main/process-supervisor');
const { text, taskSlug, isWithin, validHttpUrl } = require('./src/shared/validation');

const EXPLICIT_CWD = Boolean(process.env.CLIDE_CWD);
let CWD = process.env.CLIDE_CWD || process.cwd();
if (!CWD || CWD === '/') CWD = os.homedir();
CWD = path.resolve(CWD);

const SHIM_DIR = path.join(__dirname, 'shim');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
const CLIDE_HOME = path.resolve(process.env.CLIDE_DATA_DIR || path.join(os.homedir(), '.clide'));
const STATE_FILE = path.join(CLIDE_HOME, 'state.db');
const store = new StateStore(STATE_FILE, { legacyFile: path.join(CLIDE_HOME, 'state.json') });
const allowedRoots = new Set([CWD]);
for (const root of Object.keys(store.state.workspaces || {})) allowedRoots.add(path.resolve(root));
for (const task of Object.values(store.state.tasks || {})) {
  if (task.repoRoot) allowedRoots.add(path.resolve(task.repoRoot));
  if (task.worktree) allowedRoots.add(path.resolve(task.worktree));
}
const sessions = new Map();
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const CODE_EXT = new Set(['.js', '.ts', '.tsx', '.jsx', '.py', '.json', '.html', '.css', '.sh', '.yml', '.yaml', '.toml', '.rs', '.go']);
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const MAX_TEXT = 5 * 1024 * 1024;
const MAX_IMAGE = 15 * 1024 * 1024;

let win = null;
let seq = 0;
let terminalSeq = 0;
const SHIM_SOCKET = path.join(CLIDE_HOME, 'open.sock');
const shimSecret = store.state.settings.shimSecret || crypto.randomBytes(24).toString('hex');
if (!store.state.settings.shimSecret) store.setSetting('shimSecret', shimSecret);
let shuttingDown = false;

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowPrerelease = store.state.settings.updateChannel === 'beta';
autoUpdater.on('checking-for-update', () => send('update-state', { state: 'checking' }));
autoUpdater.on('update-available', info => send('update-state', { state: 'available', version: info.version }));
autoUpdater.on('update-not-available', info => send('update-state', { state: 'current', version: info.version }));
autoUpdater.on('download-progress', progress => send('update-state', { state: 'downloading', percent: Math.round(progress.percent || 0) }));
autoUpdater.on('update-downloaded', info => {
  store.setSetting('previousVersion', app.getVersion());
  send('update-state', { state: 'downloaded', version: info.version, previousVersion: app.getVersion() });
});
autoUpdater.on('error', error => send('update-state', { state: 'error', message: text(error.message, 500) }));

const hasLock = app.requestSingleInstanceLock({ cwd: CWD });
if (!hasLock) app.quit();

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function logCrash(kind, details = {}) {
  try {
    fs.mkdirSync(CLIDE_HOME, { recursive: true });
    const safe = {
      at: new Date().toISOString(), kind,
      reason: text(details.reason, 200), exitCode: details.exitCode,
      serviceName: text(details.serviceName, 120), type: text(details.type, 80)
    };
    fs.appendFileSync(path.join(CLIDE_HOME, 'crashes.jsonl'), `${JSON.stringify(safe)}\n`, { mode: 0o600 });
  } catch {}
}

function recordMetric(name, amount = 1) {
  const current = store.state.settings.metrics || { since: new Date().toISOString(), counters: {} };
  current.counters[name] = (current.counters[name] || 0) + amount;
  current.updatedAt = new Date().toISOString();
  store.setSetting('metrics', current);
}

function createWindow() {
  if (win) { win.show(); win.focus(); return win; }
  win = new BrowserWindow({
    width: 1600,
    height: 980,
    minWidth: 900,
    minHeight: 620,
    title: 'Clide',
    backgroundColor: '#15171a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (validHttpUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', (_event, details) => logCrash('renderer', details));
  win.on('closed', () => { win = null; });
  return win;
}

app.on('second-instance', (_event, _argv, cwd, additionalData) => {
  const requested = path.resolve(additionalData && additionalData.cwd ? additionalData.cwd : cwd || CWD);
  allowedRoots.add(requested);
  CWD = requested;
  createWindow();
  send('workspace-open', { cwd: requested });
});

function loginPath() {
  if (loginPath.cached) return loginPath.cached;
  try {
    const command = process.env.SHELL || '/bin/zsh';
    const detected = execFileSyncSafe(command, ['-lic', 'printf %s "$PATH"'], 5000) || process.env.PATH || '';
    loginPath.cached = process.env.CLIDE_PROVIDER_PATH ? `${process.env.CLIDE_PROVIDER_PATH}:${detected}` : detected;
  } catch { loginPath.cached = process.env.PATH || ''; }
  return loginPath.cached;
}

function execFileSyncSafe(command, args, timeout) {
  try { return require('child_process').execFileSync(command, args, { timeout, encoding: 'utf8' }).trim(); }
  catch { return ''; }
}

function cleanEnv(extra = {}) {
  const env = { ...process.env, PATH: loginPath(), ...extra };
  for (const key of Object.keys(env)) if (key.startsWith('npm_') || key === 'NODE_OPTIONS') delete env[key];
  return env;
}

function ptyEnv(key, parentKey, taskId, stableSession, stableTerminal, providerId = '', role = 'worker', workspaceRoot = '') {
  return cleanEnv({
    PATH: `${SHIM_DIR}:${loginPath()}`,
    CLIDE_SOCKET: SHIM_SOCKET,
    CLIDE_SECRET: shimSecret,
    CLIDE_SESSION: stableSession || parentKey || key,
    CLIDE_TERMINAL: stableTerminal || key,
    CLIDE_TASK_ID: taskId || '',
    CLIDE_PROVIDER: providerId,
    CLIDE_ROLE: role,
    CLIDE_WORKSPACE_ROOT: workspaceRoot,
    CLIDE_STATE_FILE: STATE_FILE,
    CLIDE_MCP_COMMAND: `${process.execPath} ${path.join(__dirname, 'bin', 'clide-mcp')}`
  });
}

async function providerArgs(adapter, resumeId, taskId, role = 'worker', workspaceRoot = '') {
  const args = adapter.args(text(resumeId, 200));
  if (!taskId && role !== 'orchestrator') return args;
  const server = path.join(__dirname, 'bin', 'clide-mcp');
  const hook = path.join(__dirname, 'bin', 'clide-hook');
  if (adapter.id === 'claude') {
    const runtimeDir = path.join(CLIDE_HOME, 'runtime');
    await fsp.mkdir(runtimeDir, { recursive: true });
    const scope = taskSlug(taskId || `orchestrator-${crypto.createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 10)}`);
    const config = path.join(runtimeDir, `${scope}.mcp.json`);
    await fsp.writeFile(config, JSON.stringify({ mcpServers: { clide: { type: 'stdio', command: 'node', args: [server] } } }, null, 2), { mode: 0o600 });
    args.push('--mcp-config', config);
    const settings = path.join(runtimeDir, `${scope}.settings.json`);
    const handler = { type: 'command', command: hook, timeout: 5 };
    const hookEvents = ['SessionStart', 'PermissionRequest', 'Notification', 'SubagentStart', 'SubagentStop', 'TaskCreated', 'TaskCompleted', 'Stop', 'StopFailure', 'TeammateIdle'];
    const hooks = Object.fromEntries(hookEvents.map(name => [name, [{ hooks: [handler] }]]));
    await fsp.writeFile(settings, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
    args.push('--settings', settings);
  } else {
    args.push('-c', 'mcp_servers.clide.command="node"');
    args.push('-c', `mcp_servers.clide.args=${JSON.stringify([server])}`);
    args.push('-c', `notify=${JSON.stringify([hook])}`);
  }
  return args;
}

function runFile(command, args, options = {}) {
  return new Promise(resolve => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env || cleanEnv(),
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 12 * 1024 * 1024
    }, (err, stdout, stderr) => resolve({
      ok: !err,
      out: stdout || '',
      err: stderr || (err ? err.message : ''),
      code: err && Number.isInteger(err.code) ? err.code : (err ? 1 : 0)
    }));
  });
}

function runFileInput(command, args, input, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env || cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', settled = false;
    const done = (ok, code = 0) => { if (settled) return; settled = true; resolve({ ok, out, err, code }); };
    const timer = setTimeout(() => { child.kill(); err += '\nCommand timed out.'; done(false, 1); }, options.timeout || 30000);
    child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => { clearTimeout(timer); err += error.message; done(false, 1); });
    child.on('close', code => { clearTimeout(timer); done(code === 0, code || 0); });
    child.stdin.end(input);
  });
}

function runGit(cwd, args, options) { return runFile('git', args, { cwd, ...options }); }

async function canonicalRepoRoot(cwd) {
  const top = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) return path.resolve(cwd);
  const root = top.out.trim();
  const common = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) return path.resolve(root);
  const commonDir = common.out.trim();
  return path.resolve(path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir);
}

function liveRoot(value) {
  const resolved = path.resolve(String(value || ''));
  for (const session of sessions.values()) if (session.kind === 'agent' && path.resolve(session.cwd) === resolved) return resolved;
  return null;
}

function grantedRoot(value) {
  const resolved = path.resolve(String(value || ''));
  for (const root of allowedRoots) if (path.resolve(root) === resolved) return resolved;
  return liveRoot(resolved);
}

function requireRoot(value, { live = false } = {}) {
  const root = live ? liveRoot(value) : grantedRoot(value);
  if (!root) throw new Error('Workspace access was not granted for this path.');
  return root;
}

function rootForPath(candidate) {
  const resolved = path.resolve(String(candidate || ''));
  const roots = [...allowedRoots, ...[...sessions.values()].filter(s => s.kind === 'agent').map(s => s.cwd)];
  return roots.find(root => isWithin(root, resolved)) || null;
}

function requirePath(candidate, { write = false } = {}) {
  const resolved = path.resolve(String(candidate || ''));
  const root = rootForPath(resolved);
  const welcome = path.join(__dirname, 'agentic-dev-os', 'docs');
  if (!root && !(isWithin(welcome, resolved) && !write)) throw new Error('Path is outside the active workspace.');
  return resolved;
}

function projectDir(cwd) { return path.join(PROJECTS, cwd.replace(/\//g, '-')); }
async function listJsonl(dir) {
  try { return (await fsp.readdir(dir)).filter(file => file.endsWith('.jsonl')); }
  catch { return []; }
}

function stripAnsi(value) { return String(value).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''); }
function inferState(output) {
  const value = stripAnsi(output).toLowerCase().slice(-4000);
  if (/permission|approve|allow this|do you want to proceed/.test(value)) return 'approval';
  if (/waiting for|need your input|please choose|confirm/.test(value)) return 'waiting';
  if (/blocked|cannot continue|fatal:|error:/.test(value)) return 'blocked';
  return 'running';
}

function eventName(event = {}) {
  return text(event.hook_event_name || event.type || event.event || event.name, 80);
}

function eventState(name, event = {}) {
  const lower = name.toLowerCase();
  if (lower.includes('permission') || lower.includes('approval') || event.notification_type === 'permission_prompt') return 'approval';
  if (lower.includes('failure') || lower.includes('error')) return 'blocked';
  if (lower.includes('idle') || lower === 'stop' || lower.includes('turn-complete') || lower === 'notification') return 'waiting';
  if (lower === 'taskcompleted') return 'done';
  if (lower.includes('start')) return 'running';
  return null;
}

function ingestAgentEvent(payload = {}) {
  if (payload.secret !== shimSecret) throw new Error('forbidden');
  const task = store.state.tasks[text(payload.taskId, 80)];
  if (!task) throw new Error('task not found');
  const raw = payload.event && typeof payload.event === 'object' ? payload.event : {};
  const name = eventName(raw) || 'provider-event';
  const at = new Date().toISOString();
  const state = eventState(name, raw);
  const patch = {};
  if (state) patch.state = state;
  if (/subagent|teammate|taskcreated|taskcompleted/i.test(name)) {
    const id = text(raw.agent_id || raw.task_id || raw.teammate_id || raw.id || `${name}-${Date.now()}`, 160);
    const children = [...(task.childAgents || [])];
    const index = children.findIndex(item => item.id === id);
    const completed = /stop|complete|idle/i.test(name);
    const entry = {
      id, provider: text(payload.provider, 20) || task.provider,
      label: text(raw.agent_type || raw.task_subject || raw.description || raw.name, 160) || 'Child agent',
      state: completed ? 'done' : 'running', event: name, updatedAt: at
    };
    if (index >= 0) children[index] = { ...children[index], ...entry }; else children.push(entry);
    patch.childAgents = children.slice(-200);
  }
  const eventEntry = { id: crypto.randomUUID(), name, provider: text(payload.provider, 20) || task.provider, at, state: state || task.state };
  patch.events = [...(task.events || []), eventEntry].slice(-300);
  const updated = store.patchTask(task.id, patch);
  send('agent-event', { taskId: task.id, event: eventEntry, childAgents: updated.childAgents });
  if (state && ['approval', 'waiting', 'blocked', 'done'].includes(state)) {
    send('attention', { taskId: task.id, state, event: eventEntry });
    if (Notification.isSupported()) new Notification({ title: `Clide · ${state}`, body: task.title }).show();
  }
  return updated;
}

function wirePty(key, proc) {
  proc.onData(data => {
    const item = sessions.get(key);
    if (item) {
      item.lastOutput = (item.lastOutput + data).slice(-8000);
      if (item.kind === 'agent') {
        const next = inferState(item.lastOutput);
        if (next !== item.state) {
          item.state = next;
          if (item.taskId) { try { store.patchTask(item.taskId, { state: next }); } catch {} }
          if (next === 'approval' || next === 'waiting' || next === 'blocked') {
            send('attention', { taskId: item.taskId, sessionKey: key, state: next });
            if (Notification.isSupported()) new Notification({ title: `Clide · ${next}`, body: path.basename(item.cwd) }).show();
          }
        }
      }
    }
    send('pty-data', { key, data });
  });
  proc.onExit(({ exitCode, signal }) => {
    const item = sessions.get(key);
    if (item && item.kind === 'agent' && item.taskId && !shuttingDown && !item.explicitClose) {
      item.state = exitCode === 0 ? 'done' : 'exited';
      try { store.patchTask(item.taskId, { state: item.state }); } catch {}
      send('attention', { taskId: item.taskId, sessionKey: key, state: item.state });
    }
    send('session-exit', { key, exitCode, signal });
  });
}

ipcMain.handle('initial-cwd', () => ({ cwd: CWD, explicit: EXPLICIT_CWD, noStart: process.env.CLIDE_E2E_NO_INITIAL_SESSION === '1', defaultProvider: process.env.CLIDE_DEFAULT_PROVIDER === 'codex' ? 'codex' : 'claude' }));
ipcMain.handle('welcome-file', () => {
  const file = path.join(__dirname, 'agentic-dev-os', 'docs', 'visualiser.html');
  return fs.existsSync(file) ? file : null;
});
ipcMain.handle('install-os', () => runFile('/bin/bash', [path.join(__dirname, 'bin', 'setup-os')], { timeout: 60000 })
  .then(result => ({ ok: result.ok, output: `${result.out}${result.err}`.trim() })));
ipcMain.handle('provider-availability', () => availability(cleanEnv()));

ipcMain.handle('session-start', async (_event, payload = {}) => {
  const cwd = requireRoot(payload.cwd);
  const role = payload.role === 'orchestrator' ? 'orchestrator' : (payload.role === 'ad-hoc' ? 'ad-hoc' : 'worker');
  const workspaceRoot = await canonicalRepoRoot(cwd);
  allowedRoots.add(workspaceRoot);
  if (role === 'orchestrator') {
    const duplicate = [...sessions.values()].find(item => item.role === 'orchestrator' && item.workspaceRoot === workspaceRoot);
    if (duplicate) return { error: 'This repository already has an active orchestrator session.', existingKey: duplicate.key };
  }
  const requestedTask = payload.taskId && store.state.tasks[payload.taskId];
  if (requestedTask && !payload.ignoreDependencies) {
    const blockedBy = (requestedTask.dependencies || []).filter(id => {
      const dependency = store.state.tasks[id];
      return dependency && !['done', 'archived'].includes(dependency.state);
    });
    if (blockedBy.length) return { error: `Task is waiting for ${blockedBy.map(id => store.state.tasks[id].title).join(', ')}.` };
  }
  store.upsertWorkspace(cwd, { repo: path.basename(cwd) });
  const adapter = provider(payload.provider);
  const key = `S${++seq}`;
  const preFiles = adapter.id === 'claude' ? new Set(await listJsonl(projectDir(cwd))) : new Set();
  const persistentId = text(payload.persistentId, 120) || `${payload.taskId || adapter.id}-${crypto.randomUUID()}`;
  let proc, supervised;
  try {
    const env = ptyEnv(key, null, payload.taskId, persistentId, persistentId, adapter.id, role, workspaceRoot);
    supervised = await supervisor.start({ id: persistentId, command: adapter.command, args: await providerArgs(adapter, payload.resumeId, payload.taskId, role, workspaceRoot), cwd, env });
    proc = supervisor.attach(supervised.name, { cwd, env, cols: 120, rows: 32 });
  } catch (error) { return { error: error.message }; }
  sessions.set(key, {
    pty: proc, cwd, kind: 'agent', parentKey: null, provider: adapter.id,
    taskId: text(payload.taskId, 80) || null, transcriptId: text(payload.resumeId, 200) || null,
    preFiles, lastOutput: '', state: supervised.recovered ? 'running' : 'starting', startedAt: Date.now(),
    persistentId, supervisorName: supervised.name, recovered: supervised.recovered, role, workspaceRoot
  });
  wirePty(key, proc);
  recordMetric(`sessions.${adapter.id}`);
  if (payload.taskId) {
    try { store.patchTask(payload.taskId, { state: 'running', worktree: cwd, provider: adapter.id, supervisorId: persistentId }); } catch {}
  }
  if (role === 'orchestrator') store.upsertWorkspace(workspaceRoot, { repo: path.basename(workspaceRoot), orchestrator: { provider: adapter.id, persistentId, updatedAt: new Date().toISOString() } });
  return { key, cwd, repo: path.basename(cwd), provider: adapter.id, taskId: payload.taskId || null, persistentId, recovered: supervised.recovered, role, workspaceRoot };
});

ipcMain.handle('terminal-start', async (_event, payload = {}) => {
  const owner = sessions.get(payload.parentKey);
  if (!owner || owner.kind !== 'agent') return { error: 'Owning agent session is not running.' };
  if (path.resolve(payload.cwd) !== path.resolve(owner.cwd)) return { error: 'Shell must use its task worktree.' };
  const key = `T${++terminalSeq}`;
  const shellPath = process.env.SHELL || '/bin/zsh';
  const persistentId = text(payload.persistentId, 120) || `shell-${owner.taskId || owner.persistentId}-${crypto.randomUUID()}`;
  let proc, supervised;
  try {
    const env = ptyEnv(key, owner.key, owner.taskId, owner.persistentId, persistentId, 'shell', owner.role, owner.workspaceRoot);
    supervised = await supervisor.start({ id: persistentId, command: shellPath, args: ['-l'], cwd: owner.cwd, env });
    proc = supervisor.attach(supervised.name, { cwd: owner.cwd, env, cols: 120, rows: 32 });
  } catch (error) { return { error: error.message }; }
  sessions.set(key, { pty: proc, cwd: owner.cwd, kind: 'shell', parentKey: payload.parentKey, taskId: owner.taskId, lastOutput: '', persistentId, supervisorName: supervised.name, recovered: supervised.recovered });
  wirePty(key, proc);
  return { key, cwd: owner.cwd, shell: path.basename(shellPath), persistentId, recovered: supervised.recovered };
});

ipcMain.on('session-input', (_event, payload = {}) => {
  const item = sessions.get(payload.key);
  if (item && typeof payload.data === 'string' && payload.data.length <= 1024 * 1024) item.pty.write(payload.data);
});
ipcMain.on('session-resize', (_event, payload = {}) => {
  const item = sessions.get(payload.key);
  const cols = Math.max(2, Math.min(500, Number(payload.cols) || 0));
  const rows = Math.max(1, Math.min(300, Number(payload.rows) || 0));
  if (item && cols && rows) item.pty.resize(cols, rows);
});
ipcMain.on('session-kill', (_event, payload = {}) => {
  const item = sessions.get(payload.key);
  if (!item) return;
  item.explicitClose = true;
  supervisor.terminate(item.supervisorName).catch(() => {});
  try { item.pty.kill(); } catch {}
  sessions.delete(payload.key);
});

ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (result.canceled) return null;
  const root = path.resolve(result.filePaths[0]);
  allowedRoots.add(root);
  return root;
});

async function readChunk(file, bytes, fromEnd) {
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    const len = Math.min(bytes, stat.size);
    const buffer = Buffer.alloc(len);
    await handle.read(buffer, 0, len, fromEnd ? stat.size - len : 0);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}
function lineObjs(value) {
  return value.split('\n').flatMap(line => { try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; } });
}
function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(block => block && block.type === 'text').map(block => block.text).join(' ');
  return '';
}
function firstUserText(items) {
  for (const item of items) if (item.type === 'user' && item.message && item.message.role === 'user') {
    const value = contentText(item.message.content).trim();
    if (value && !value.startsWith('<') && value.length > 1) return value;
  }
  return null;
}
function firstCwd(items) { for (const item of items) if (item.cwd) return item.cwd; return null; }
function lastAssistantText(items) {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === 'assistant' && items[i].message) {
    const value = contentText(items[i].message.content).trim(); if (value) return value;
  }
  return null;
}
function lastUsage(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const message = items[i].type === 'assistant' && items[i].message;
    if (message && message.usage) {
      const usage = message.usage;
      return { tokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0), model: message.model || null };
    }
  }
  return { tokens: null, model: null };
}

ipcMain.handle('list-history', async () => {
  let dirs = [];
  try { dirs = await fsp.readdir(PROJECTS); } catch { return []; }
  const out = [];
  for (const dir of dirs) {
    const directory = path.join(PROJECTS, dir);
    for (const file of await listJsonl(directory)) {
      const full = path.join(directory, file);
      let stat;
      try { stat = await fsp.stat(full); } catch { continue; }
      if (stat.size < 200) continue;
      const head = lineObjs(await readChunk(full, 64 * 1024, false));
      const tail = lineObjs(await readChunk(full, 96 * 1024, true));
      const cwd = firstCwd(head);
      if (!cwd || !fs.existsSync(cwd)) continue;
      allowedRoots.add(path.resolve(cwd));
      const recap = lastAssistantText(tail);
      out.push({ id: file.replace('.jsonl', ''), cwd, repo: path.basename(cwd), title: (firstUserText(head) || path.basename(cwd)).slice(0, 90), recap: recap ? recap.slice(0, 200) : null, mtime: stat.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 80);
});

async function resolveTranscript(item) {
  if (!item || item.kind !== 'agent' || item.provider !== 'claude') return null;
  if (item.transcriptId) return item.transcriptId;
  const dir = projectDir(item.cwd);
  const all = await listJsonl(dir);
  const fresh = all.filter(file => !item.preFiles.has(file));
  const candidates = await Promise.all((fresh.length ? fresh : all).map(async file => {
    try { return { file, mtime: (await fsp.stat(path.join(dir, file))).mtimeMs }; } catch { return { file, mtime: 0 }; }
  }));
  const pick = candidates.sort((a, b) => b.mtime - a.mtime)[0];
  if (pick) item.transcriptId = pick.file.replace('.jsonl', '');
  return item.transcriptId;
}

ipcMain.handle('session-status', async (_event, payload = {}) => {
  const item = sessions.get(payload.key);
  if (!item || item.kind !== 'agent') return null;
  let model = null;
  let tokens = null;
  const transcriptId = await resolveTranscript(item);
  if (transcriptId && item.provider === 'claude') {
    try {
      const usage = lastUsage(lineObjs(await readChunk(path.join(projectDir(item.cwd), `${transcriptId}.jsonl`), 200 * 1024, true)));
      model = usage.model; tokens = usage.tokens;
    } catch {}
  }
  const branch = (await runGit(item.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || null;
  const status = await gitStatus(item.cwd);
  const windowSize = model && /1m/i.test(model) ? 1000000 : 200000;
  return {
    provider: item.provider, repo: path.basename(item.cwd), branch, id: transcriptId,
    model, ctxTokens: tokens, ctxPct: tokens == null ? null : Math.min(100, Math.round(tokens / windowSize * 100)),
    window: windowSize, state: item.state, taskId: item.taskId, changed: status.files ? status.files.length : 0,
    elapsedMs: Date.now() - item.startedAt, persistentId: item.persistentId, recovered: item.recovered
  };
});

async function gitStatus(cwd) {
  const result = await runGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (!result.ok && /not a git repository/i.test(result.err)) return { repo: false, files: [] };
  let branch = null, ahead = 0, behind = 0;
  const files = [];
  for (const line of result.out.split('\n').filter(Boolean)) {
    if (line.startsWith('## ')) {
      branch = line.slice(3).split('...')[0].split(' ')[0];
      const a = /ahead (\d+)/.exec(line); const b = /behind (\d+)/.exec(line);
      ahead = a ? Number(a[1]) : 0; behind = b ? Number(b[1]) : 0; continue;
    }
    const index = line[0], work = line[1];
    let file = line.slice(3);
    if (file.includes(' -> ')) file = file.split(' -> ')[1];
    file = file.replace(/^"|"$/g, '');
    files.push({ path: file, index, work, staged: index !== ' ' && index !== '?', unstaged: work !== ' ' || index === '?', untracked: index === '?' });
  }
  return { repo: result.ok, branch, ahead, behind, files };
}

ipcMain.handle('git-status', (_event, payload = {}) => gitStatus(requireRoot(payload.cwd)));
ipcMain.handle('git-diff', async (_event, payload = {}) => {
  const cwd = requireRoot(payload.cwd);
  const file = text(payload.file, 4096);
  if (!isWithin(cwd, path.join(cwd, file))) throw new Error('Invalid diff path.');
  const args = ['diff']; if (payload.staged) args.push('--cached'); args.push('--', file);
  const result = await runGit(cwd, args);
  if (result.out.trim()) return result.out;
  return (await runGit(cwd, ['diff', '--no-index', '--', '/dev/null', file])).out || '';
});
ipcMain.handle('git-branches', async (_event, payload = {}) => {
  const cwd = requireRoot(payload.cwd);
  const result = await runGit(cwd, ['branch', '--format=%(refname:short)']);
  const current = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  return { current, branches: result.out.split('\n').map(value => value.trim()).filter(Boolean) };
});
ipcMain.handle('git-checkout', (_event, payload = {}) => runGit(requireRoot(payload.cwd), ['checkout', text(payload.branch, 240)]));
ipcMain.handle('git-create-branch', async (_event, payload = {}) => {
  const cwd = requireRoot(payload.cwd);
  const name = text(payload.name, 240);
  const valid = await runGit(cwd, ['check-ref-format', '--branch', name]);
  return valid.ok ? runGit(cwd, ['checkout', '-b', name]) : valid;
});
ipcMain.handle('git-stage', (_event, payload = {}) => runGit(requireRoot(payload.cwd), ['add', '--', text(payload.file, 4096)]));
ipcMain.handle('git-stage-patch', (_event, payload = {}) => {
  const cwd = requireRoot(payload.cwd);
  const patch = String(payload.patch || '');
  if (!patch.startsWith('diff --git ') || Buffer.byteLength(patch) > 2 * 1024 * 1024) return { ok: false, err: 'Invalid or oversized patch.' };
  const args = ['apply', '--cached', '--unidiff-zero']; if (payload.reverse) args.push('--reverse'); args.push('-');
  return runFileInput('git', args, patch, { cwd });
});
ipcMain.handle('git-unstage', (_event, payload = {}) => runGit(requireRoot(payload.cwd), ['restore', '--staged', '--', text(payload.file, 4096)]));
ipcMain.handle('git-commit', (_event, payload = {}) => runGit(requireRoot(payload.cwd), ['commit', '-m', text(payload.message, 1000)]));
ipcMain.handle('git-push', (_event, payload = {}) => runGit(requireRoot(payload.cwd), ['push']));
ipcMain.handle('git-log-summary', (_event, payload = {}) => runGit(requireRoot(payload.cwd), ['log', '--oneline', '--decorate', '-20']));

function allocatePort() {
  const used = new Set(Object.values(store.state.tasks).map(task => task.port).filter(Number.isInteger));
  for (let port = 4100; port < 5000; port++) if (!used.has(port)) return port;
  return null;
}

async function copyWorktreeIncludes(source, target) {
  const config = path.join(source, '.worktreeinclude');
  let patterns;
  try { patterns = (await fsp.readFile(config, 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#')); }
  catch { return []; }
  const copied = [];
  for (const rel of patterns) {
    if (rel.includes('*') || rel.includes('?') || path.isAbsolute(rel) || rel.split(path.sep).includes('..')) continue;
    const from = path.join(source, rel), to = path.join(target, rel);
    if (!isWithin(source, from) || !isWithin(target, to) || !fs.existsSync(from)) continue;
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.cp(from, to, { recursive: true, force: false, errorOnExist: false });
    copied.push(rel);
  }
  return copied;
}

async function createWorktree(payload = {}) {
  store.load();
  const cwd = requireRoot(payload.cwd);
  const rootResult = await runGit(cwd, ['rev-parse', '--show-toplevel']);
  if (!rootResult.ok) return { ok: false, err: rootResult.err || 'Not a Git repository.' };
  const root = rootResult.out.trim();
  const commonResult = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = commonResult.ok ? commonResult.out.trim() : path.join(root, '.git');
  const canonicalRepo = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir;
  const slug = taskSlug(payload.taskName || payload.title);
  if (!slug) return { ok: false, err: 'Enter a task name.' };
  const branch = text(payload.branch, 240) || `clide/${slug}`;
  const valid = await runGit(root, ['check-ref-format', '--branch', branch]);
  if (!valid.ok) return { ok: false, err: valid.err || 'Invalid branch name.' };
  const existing = Object.values(store.state.tasks).find(task => task.id !== payload.taskId && task.branch === branch && task.state !== 'archived');
  if (existing) return { ok: false, err: `Branch is already owned by “${existing.title}”.` };
  const repoName = path.basename(canonicalRepo);
  const repoId = `${repoName}-${crypto.createHash('sha1').update(canonicalRepo).digest('hex').slice(0, 8)}`;
  const target = path.join(CLIDE_HOME, 'worktrees', repoId, slug);
  if (fs.existsSync(target)) return { ok: false, err: `Worktree already exists: ${target}` };
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const baseRef = text(payload.baseRef, 240) || 'HEAD';
  const created = await runGit(root, ['worktree', 'add', '-b', branch, target, baseRef], { timeout: 120000 });
  if (!created.ok) return { ok: false, err: created.err || 'Could not create worktree.' };
  allowedRoots.add(target);
  const copied = await copyWorktreeIncludes(root, target);
  const task = store.upsertTask({
    id: payload.taskId, title: payload.taskName || payload.title, ticket: payload.ticket,
    provider: payload.provider, state: 'draft', repo: repoName, repoRoot: canonicalRepo,
    worktree: target, branch, baseRef, setupCommand: payload.setupCommand,
    devCommand: payload.devCommand, port: allocatePort(), dependencies: payload.dependencies,
    launchPrompt: payload.launchPrompt, createdBy: payload.createdBy, dispatchKey: payload.dispatchKey,
    pathClaims: Array.isArray(payload.pathClaims) ? payload.pathClaims.map(value => ({ id: crypto.randomUUID(), path: text(value, 4096), note: 'Declared at dispatch', from: payload.createdBy || 'user', at: new Date().toISOString() })).filter(item => item.path) : []
  });
  store.upsertWorkspace(canonicalRepo, { repo: repoName });
  recordMetric('worktrees.created');
  return { ok: true, cwd: target, repo: repoName, branch, baseRef, task, copied, port: task.port };
}

ipcMain.handle('git-worktree-create', async (_event, payload = {}) => createWorktree(payload));

async function dispatchFromOrchestrator(envelope = {}) {
  if (envelope.secret !== shimSecret) throw new Error('forbidden');
  const owner = [...sessions.values()].find(item => item.persistentId === envelope.session && item.role === 'orchestrator');
  if (!owner) throw new Error('Active orchestrator session not found.');
  const requestedRoot = await canonicalRepoRoot(envelope.workspaceRoot || owner.workspaceRoot);
  if (requestedRoot !== owner.workspaceRoot) throw new Error('Orchestrator commands are restricted to their repository.');
  const input = envelope.command && typeof envelope.command === 'object' ? envelope.command : {};
  if (input.type !== 'dispatch-task') throw new Error('Unsupported orchestrator command.');
  store.load();
  const dispatchKey = text(input.dispatchKey || input.ticket, 160);
  const existing = dispatchKey && Object.values(store.state.tasks).find(task => task.repoRoot === requestedRoot && task.dispatchKey === dispatchKey && task.state !== 'archived');
  if (existing) return { ok: true, existing: true, task: existing, cwd: existing.worktree, port: existing.port, launched: [...sessions.values()].some(item => item.taskId === existing.id) };
  const providerId = input.provider === 'codex' ? 'codex' : 'claude';
  const providers = await availability(cleanEnv());
  if (!providers[providerId]) throw new Error(`${providerId === 'codex' ? 'Codex' : 'Claude'} is not available on the login-shell PATH.`);
  const result = await createWorktree({
    cwd: requestedRoot, taskName: input.title, ticket: input.ticket, provider: providerId,
    branch: input.branch, baseRef: input.baseRef || 'HEAD', setupCommand: input.setupCommand,
    devCommand: input.devCommand, dependencies: input.dependencies, launchPrompt: input.prompt,
    pathClaims: input.pathClaims, dispatchKey, createdBy: `orchestrator:${owner.persistentId}`
  });
  if (!result.ok) return result;
  store.load();
  const blockedBy = (result.task.dependencies || []).filter(id => store.state.tasks[id] && !['done', 'archived'].includes(store.state.tasks[id].state));
  const launch = blockedBy.length === 0;
  if (launch) send('orchestrator-dispatch', { ...result, prompt: result.task.launchPrompt, provider: providerId, orchestratorKey: owner.key });
  recordMetric('orchestrator.dispatched');
  return { ...result, launched: launch, blockedBy };
}

ipcMain.handle('git-worktree-list', async (_event, payload = {}) => {
  const cwd = requireRoot(payload.cwd);
  const result = await runGit(cwd, ['worktree', 'list', '--porcelain']);
  const items = [];
  let item = null;
  for (const line of result.out.split('\n')) {
    if (line.startsWith('worktree ')) { item = { path: line.slice(9) }; items.push(item); }
    else if (item && line.startsWith('HEAD ')) item.head = line.slice(5);
    else if (item && line.startsWith('branch ')) item.branch = line.slice(7).replace('refs/heads/', '');
    else if (item && line === 'bare') item.bare = true;
  }
  return { ok: result.ok, items, err: result.err };
});

ipcMain.handle('review-task-create', async (_event, payload = {}) => {
  const source = store.state.tasks[text(payload.taskId, 80)];
  if (!source || !source.repoRoot || !source.branch) return { ok: false, err: 'Source task is not reviewable.' };
  const stamp = Date.now().toString(36);
  const branch = `clide/review-${taskSlug(source.ticket || source.title)}-${stamp}`;
  const target = path.join(CLIDE_HOME, 'worktrees', `${source.repo}-${crypto.createHash('sha1').update(source.repoRoot).digest('hex').slice(0, 8)}`, `review-${taskSlug(source.title)}-${stamp}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const created = await runGit(source.repoRoot, ['worktree', 'add', '-b', branch, target, source.branch], { timeout: 120000 });
  if (!created.ok) return created;
  allowedRoots.add(target);
  const reviewer = source.provider === 'claude' ? 'codex' : 'claude';
  const prompt = `Review task ${source.ticket || source.title} on branch ${source.branch}. Inspect the diff against ${source.baseRef}, run appropriate checks, and publish findings through Clide. Do not implement fixes unless the user asks.`;
  const task = store.upsertTask({
    title: `Review · ${source.title}`, ticket: source.ticket, provider: reviewer, state: 'draft', repo: source.repo,
    repoRoot: source.repoRoot, worktree: target, branch, baseRef: source.branch, reviewOf: source.id,
    dependencies: [], launchPrompt: prompt, port: allocatePort()
  });
  return { ok: true, task, cwd: target, provider: reviewer, prompt };
});

ipcMain.handle('integration-worktree-create', async (_event, payload = {}) => {
  const ids = Array.isArray(payload.taskIds) ? payload.taskIds.map(id => text(id, 80)).filter(Boolean) : [];
  const tasks = ids.map(id => store.state.tasks[id]).filter(Boolean);
  if (!tasks.length) return { ok: false, err: 'Choose at least one task.' };
  const repoRoot = tasks[0].repoRoot;
  if (tasks.some(task => task.repoRoot !== repoRoot)) return { ok: false, err: 'Combined testing requires tasks from one repository.' };
  const stamp = Date.now().toString(36);
  const branch = `clide/integration-${stamp}`;
  const target = path.join(CLIDE_HOME, 'worktrees', `${tasks[0].repo}-${crypto.createHash('sha1').update(repoRoot).digest('hex').slice(0, 8)}`, `integration-${stamp}`);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const baseRef = text(payload.baseRef, 240) || tasks[0].baseRef || 'HEAD';
  const created = await runGit(repoRoot, ['worktree', 'add', '-b', branch, target, baseRef], { timeout: 120000 });
  if (!created.ok) return created;
  allowedRoots.add(target);
  const merged = [];
  for (const task of tasks) {
    const result = await runGit(target, ['merge', '--no-ff', task.branch, '-m', `Combine ${task.ticket || task.title}`], { timeout: 120000 });
    if (!result.ok) {
      const conflicts = (await runGit(target, ['diff', '--name-only', '--diff-filter=U'])).out.split('\n').filter(Boolean);
      const integration = store.upsertTask({ title: `Integration conflict · ${tasks.map(item => item.ticket || item.title).join(' + ')}`, provider: payload.provider, state: 'blocked', repo: tasks[0].repo, repoRoot, worktree: target, branch, baseRef, integrationOf: ids, findings: [{ id: crypto.randomUUID(), body: `Merge conflict while adding ${task.branch}: ${conflicts.join(', ')}`, level: 'blocking', from: 'clide', at: new Date().toISOString() }] });
      return { ok: false, blocked: true, err: result.err || 'Merge conflict', conflicts, task: integration, cwd: target };
    }
    merged.push(task.branch);
  }
  const prompt = `Validate the combined integration branch containing: ${merged.join(', ')}. Run end-to-end checks and report cross-feature regressions through Clide.`;
  const integration = store.upsertTask({ title: `Integration · ${tasks.map(item => item.ticket || item.title).join(' + ')}`, provider: payload.provider, state: 'draft', repo: tasks[0].repo, repoRoot, worktree: target, branch, baseRef, integrationOf: ids, launchPrompt: prompt, port: allocatePort() });
  return { ok: true, task: integration, cwd: target, provider: integration.provider, prompt, merged };
});

ipcMain.handle('git-worktree-remove', async (_event, payload = {}) => {
  const task = store.state.tasks[payload.taskId];
  if (!task) return { ok: false, err: 'Task not found.' };
  if ([...sessions.values()].some(item => item.taskId === task.id)) return { ok: false, err: 'Close the task session before removing its worktree.' };
  const status = await gitStatus(task.worktree);
  if (status.files.length) return { ok: false, err: 'Worktree has uncommitted or untracked files.' };
  const unique = await runGit(task.worktree, ['rev-list', '--count', `${task.baseRef || 'HEAD'}..HEAD`]);
  if (Number(unique.out.trim()) > 0 && !payload.confirmUniqueCommits) return { ok: false, needsConfirmation: true, err: `Branch has ${unique.out.trim()} unique commit(s). Confirm keeping the branch before cleanup.` };
  const result = await runGit(task.repoRoot, ['worktree', 'remove', task.worktree]);
  if (result.ok) store.patchTask(task.id, { state: 'archived', worktree: '' });
  return result;
});

ipcMain.handle('git-conflict-preview', async (_event, payload = {}) => {
  const task = store.state.tasks[payload.taskId];
  if (!task) return { ok: false, err: 'Task not found.' };
  const target = text(payload.target, 240) || task.baseRef || 'HEAD';
  const branch = task.branch;
  const base = await runGit(task.repoRoot, ['merge-base', target, branch]);
  if (!base.ok) return base;
  const tree = await runGit(task.repoRoot, ['merge-tree', base.out.trim(), target, branch]);
  const conflicts = tree.out.split('\n').filter(line => /^<{7}|^>{7}|changed in both|added in both|removed in/.test(line));
  return { ok: true, target, branch, conflicts, clean: conflicts.length === 0, preview: tree.out.slice(0, 500000) };
});

ipcMain.handle('git-integrate', async (_event, payload = {}) => {
  const task = store.state.tasks[payload.taskId];
  if (!task) return { ok: false, err: 'Task not found.' };
  const targetRoot = requireRoot(payload.targetRoot);
  const targetStatus = await gitStatus(targetRoot);
  if (!targetStatus.repo || targetStatus.files.length) return { ok: false, err: 'Integration checkout must be a clean Git worktree.' };
  const current = (await runGit(targetRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  const expectedTarget = text(payload.targetBranch, 240) || current;
  if (current !== expectedTarget) return { ok: false, err: `Integration checkout is on ${current}, not ${expectedTarget}.` };
  const preview = await (async () => {
    const base = await runGit(task.repoRoot, ['merge-base', current, task.branch]);
    if (!base.ok) return { clean: false, err: base.err };
    const tree = await runGit(task.repoRoot, ['merge-tree', base.out.trim(), current, task.branch]);
    return { clean: !/^<{7}|^>{7}|changed in both|added in both|removed in/m.test(tree.out), err: '' };
  })();
  if (!preview.clean) return { ok: false, err: preview.err || 'Conflict preview is not clean. Resolve or update the task branch first.' };
  const result = await runGit(targetRoot, ['merge', '--no-ff', task.branch, '-m', `Integrate ${task.ticket || task.title}`], { timeout: 120000 });
  if (result.ok) store.patchTask(task.id, { state: 'archived' });
  return result;
});

ipcMain.handle('setup-run', async (_event, payload = {}) => {
  const task = store.state.tasks[payload.taskId];
  if (!task || !task.worktree) return { ok: false, err: 'Task worktree not found.' };
  const command = text(payload.command || task.setupCommand, 1000);
  if (!command) return { ok: true, skipped: true, out: 'No setup command configured.' };
  const result = await runFile(process.env.SHELL || '/bin/zsh', ['-lc', command], { cwd: task.worktree, timeout: 15 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
  store.patchTask(task.id, { checks: [...task.checks, { type: 'setup', command, ok: result.ok, output: `${result.out}${result.err}`.slice(-20000), at: new Date().toISOString() }] });
  return result;
});

ipcMain.handle('checks-run', async (_event, payload = {}) => {
  const task = store.state.tasks[payload.taskId];
  if (!task || !task.worktree) return { ok: false, err: 'Task worktree not found.' };
  const commands = Array.isArray(payload.commands) ? payload.commands.map(command => text(command, 1000)).filter(Boolean) : [];
  const results = [];
  for (const command of commands.slice(0, 10)) {
    const result = await runFile(process.env.SHELL || '/bin/zsh', ['-lc', command], { cwd: task.worktree, timeout: 15 * 60 * 1000, maxBuffer: 20 * 1024 * 1024 });
    results.push({ command, ok: result.ok, output: `${result.out}${result.err}`.slice(-50000), at: new Date().toISOString() });
    if (!result.ok) break;
  }
  const sha = (await runGit(task.worktree, ['rev-parse', 'HEAD'])).out.trim();
  store.patchTask(task.id, { checks: [...task.checks, ...results.map(item => ({ ...item, type: 'check', sha }))] });
  recordMetric(results.every(item => item.ok) ? 'checks.passed' : 'checks.failed');
  return { ok: results.every(item => item.ok), sha, results };
});

async function walkFiles(root) {
  const skip = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build', '.next', '.cache']);
  const out = [];
  async function walk(dir) {
    if (out.length >= 12000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push({ name: entry.name, path: full, rel: path.relative(root, full) });
    }
  }
  await walk(root);
  return out;
}

ipcMain.handle('list-files', (_event, cwd) => walkFiles(requireRoot(cwd, { live: true })));
ipcMain.handle('read-dir', async (_event, dir) => {
  const safe = requirePath(dir);
  const skip = new Set(['node_modules', '.git', '.DS_Store']);
  const entries = await fsp.readdir(safe, { withFileTypes: true });
  return entries.filter(entry => !skip.has(entry.name)).map(entry => ({ name: entry.name, path: path.join(safe, entry.name), dir: entry.isDirectory() }))
    .sort((a, b) => a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1);
});
ipcMain.handle('read-file', async (_event, file) => {
  const safe = requirePath(file);
  const stat = await fsp.stat(safe);
  const ext = path.extname(safe).toLowerCase();
  const image = IMG_EXT.has(ext);
  if (stat.size > (image ? MAX_IMAGE : MAX_TEXT)) throw new Error(`File is too large to preview (${Math.ceil(stat.size / 1024 / 1024)} MB).`);
  if (image) {
    const buffer = await fsp.readFile(safe);
    return { path: safe, name: path.basename(safe), ext, kind: 'image', dataUrl: `data:${MIME[ext] || 'application/octet-stream'};base64,${buffer.toString('base64')}` };
  }
  const content = await fsp.readFile(safe, 'utf8');
  const kind = ext === '.html' || ext === '.htm' ? 'html' : ext === '.md' ? 'markdown' : CODE_EXT.has(ext) ? 'code' : 'text';
  return { path: safe, name: path.basename(safe), ext, kind, content };
});
ipcMain.handle('save-file', async (_event, payload = {}) => {
  const safe = requirePath(payload.path, { write: true });
  const content = String(payload.content || '');
  if (Buffer.byteLength(content) > MAX_TEXT) throw new Error('File is too large to save from Clide.');
  await fsp.writeFile(safe, content, 'utf8'); return true;
});
ipcMain.on('copy-image', (_event, file) => clipboard.writeImage(nativeImage.createFromPath(requirePath(file))));
ipcMain.on('copy-html', (_event, payload = {}) => clipboard.write({ html: String(payload.html || ''), text: String(payload.text || '') }));
ipcMain.on('reveal', (_event, file) => shell.showItemInFolder(requirePath(file)));
ipcMain.on('open-external', (_event, value) => { if (validHttpUrl(value)) shell.openExternal(value); });

ipcMain.handle('state-snapshot', async () => {
  const snapshot = store.snapshot();
  const taskStatuses = await Promise.all(Object.values(snapshot.tasks).map(async task => {
    const status = task.worktree && fs.existsSync(task.worktree) ? await gitStatus(task.worktree) : { files: [] };
    task.git = status;
    return { taskId: task.id, files: status.files || [] };
  }));
  const claims = new Map();
  for (const task of Object.values(snapshot.tasks)) for (const claim of task.pathClaims || []) {
    const key = claim.path; if (!claims.has(key)) claims.set(key, []); claims.get(key).push(task.id);
  }
  const claimOverlaps = [...claims].filter(([, ids]) => new Set(ids).size > 1).map(([path, ids]) => ({ path, taskIds: [...new Set(ids)], source: 'claim' }));
  for (const task of Object.values(snapshot.tasks)) task.blockedBy = (task.dependencies || []).filter(id => snapshot.tasks[id] && !['done', 'archived'].includes(snapshot.tasks[id].state));
  return { ...snapshot, overlaps: [...changedPathMap(taskStatuses), ...claimOverlaps], stateFile: STATE_FILE };
});
ipcMain.handle('task-upsert', (_event, payload) => store.upsertTask(payload));
ipcMain.handle('task-patch', (_event, payload = {}) => store.patchTask(text(payload.id, 80), payload.patch || {}));
ipcMain.handle('task-remove', (_event, payload = {}) => store.removeTask(text(payload.id, 80)));
ipcMain.handle('layout-set', (_event, payload = {}) => store.setLayout(text(payload.workspace, 4096), text(payload.layout, 40)));
ipcMain.handle('view-state-get', () => store.state.settings.rendererState || null);
ipcMain.handle('view-state-set', (_event, payload) => store.setSetting('rendererState', payload));
ipcMain.handle('workspace-forget', (_event, payload = {}) => {
  const root = path.resolve(String(payload.root || ''));
  if ([...sessions.values()].some(item => path.resolve(item.cwd) === root)) throw new Error('Close the workspace session first.');
  if (Object.values(store.state.tasks).some(task => task.state !== 'archived' && (task.repoRoot === root || task.worktree === root))) throw new Error('Archive active tasks before forgetting this workspace.');
  allowedRoots.delete(root);
  return store.removeWorkspace(root);
});
ipcMain.handle('workspace-export', async () => {
  const result = await dialog.showSaveDialog(win, { title: 'Export Clide workspace state', defaultPath: `clide-workspace-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  const snapshot = store.snapshot();
  const safeSettings = { metrics: snapshot.settings.metrics || null, telemetryShare: Boolean(snapshot.settings.telemetryShare) };
  const bundle = { format: 'clide-workspace', version: 1, exportedAt: new Date().toISOString(), workspaces: snapshot.workspaces, tasks: snapshot.tasks, layouts: snapshot.layoutByWorkspace, settings: safeSettings };
  await fsp.writeFile(result.filePath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
  return { ok: true, file: result.filePath, tasks: Object.keys(bundle.tasks).length };
});
ipcMain.handle('workspace-import', async () => {
  const result = await dialog.showOpenDialog(win, { title: 'Import Clide workspace state', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  const bundle = JSON.parse(await fsp.readFile(result.filePaths[0], 'utf8'));
  if (bundle.format !== 'clide-workspace' || bundle.version !== 1 || !bundle.tasks || !bundle.workspaces) throw new Error('This is not a supported Clide export.');
  for (const [root, value] of Object.entries(bundle.workspaces)) { store.upsertWorkspace(root, value); allowedRoots.add(path.resolve(root)); }
  for (const task of Object.values(bundle.tasks)) { const imported = store.upsertTask(task); if (imported.repoRoot) allowedRoots.add(path.resolve(imported.repoRoot)); if (imported.worktree) allowedRoots.add(path.resolve(imported.worktree)); }
  for (const [workspace, layout] of Object.entries(bundle.layouts || {})) store.setLayout(workspace, layout);
  recordMetric('workspace.imported');
  return { ok: true, file: result.filePaths[0], tasks: Object.keys(bundle.tasks).length };
});
ipcMain.handle('telemetry-get', () => ({ local: store.state.settings.metrics || { counters: {} }, share: Boolean(store.state.settings.telemetryShare), note: 'Metrics stay on this Mac. Sharing is not connected to a remote endpoint.' }));
ipcMain.handle('telemetry-set', (_event, payload = {}) => ({ share: store.setSetting('telemetryShare', Boolean(payload.share)) }));
ipcMain.handle('telemetry-reset', () => store.setSetting('metrics', { since: new Date().toISOString(), counters: {}, updatedAt: new Date().toISOString() }));
ipcMain.handle('update-check', async () => {
  if (!app.isPackaged) return { ok: false, development: true, version: app.getVersion(), message: 'Update checks run in signed packaged builds.' };
  try { await autoUpdater.checkForUpdates(); return { ok: true, version: app.getVersion() }; }
  catch (error) { return { ok: false, message: error.message }; }
});
ipcMain.handle('update-download', async () => { await autoUpdater.downloadUpdate(); return { ok: true }; });
ipcMain.handle('update-install', () => { setImmediate(() => autoUpdater.quitAndInstall(false, true)); return { ok: true }; });
ipcMain.handle('update-channel-set', (_event, payload = {}) => {
  const channel = payload.channel === 'beta' ? 'beta' : 'stable'; store.setSetting('updateChannel', channel); autoUpdater.allowPrerelease = channel === 'beta'; return channel;
});
ipcMain.handle('update-rollback-info', () => ({ currentVersion: app.getVersion(), previousVersion: store.state.settings.previousVersion || null, releasesUrl: 'https://github.com/rimakos/clide/releases' }));
ipcMain.handle('coord-publish', (_event, payload = {}) => {
  const task = store.state.tasks[text(payload.taskId, 80)];
  if (!task) throw new Error('Task not found.');
  const kind = payload.kind === 'finding' ? 'findings' : 'messages';
  const entry = { id: crypto.randomUUID(), body: text(payload.body, 8000), from: text(payload.from, 80) || 'user', at: new Date().toISOString(), level: text(payload.level, 20) || 'info' };
  const updated = store.patchTask(task.id, { [kind]: [...task[kind], entry] });
  send('attention', { taskId: task.id, state: kind === 'findings' ? 'finding' : 'message', entry });
  return updated;
});
ipcMain.handle('doctor-run', async () => {
  const providers = await availability(cleanEnv());
  const git = await runFile('git', ['--version']);
  const nodePty = (() => { try { require.resolve('node-pty'); return true; } catch { return false; } })();
  const skills = { claude: fs.existsSync(path.join(os.homedir(), '.claude', 'skills')), codex: fs.existsSync(path.join(os.homedir(), '.agents', 'skills')) };
  return { ok: git.ok && nodePty && (providers.claude || providers.codex), providers, git: git.out.trim(), nodePty, skills, stateFile: STATE_FILE, shim: { socket: SHIM_SOCKET, authenticated: true }, supervisor: { screen: fs.existsSync(supervisor.SCREEN) } };
});

const shimServer = http.createServer((request, response) => {
  if (request.method !== 'POST' || !['/open', '/event', '/command'].includes(request.url)) { response.statusCode = 404; response.end(); return; }
  let body = '';
  request.on('data', chunk => {
    body += chunk;
    if (body.length > 256 * 1024) request.destroy();
  });
  request.on('end', async () => {
    if (request.url === '/command') {
      try {
        const result = await dispatchFromOrchestrator(JSON.parse(body || '{}'));
        response.setHeader('content-type', 'application/json'); response.statusCode = result.ok === false ? 409 : 200; response.end(JSON.stringify(result));
      } catch (error) {
        response.statusCode = error.message === 'forbidden' ? 403 : 400; response.end(JSON.stringify({ ok: false, err: error.message }));
      }
      return;
    }
    if (request.url === '/event') {
      try {
        ingestAgentEvent(JSON.parse(body || '{}'));
        response.statusCode = 200; response.end('ok');
      } catch (error) {
        response.statusCode = error.message === 'forbidden' ? 403 : 400; response.end(error.message);
      }
      return;
    }
    const params = new URLSearchParams(body);
    const key = params.get('session');
    const item = sessions.get(key) || [...sessions.values()].find(value => value.persistentId === key);
    const file = params.get('path');
    if (params.get('secret') !== shimSecret || !item || !file || !isWithin(item.cwd, file)) {
      response.statusCode = 403; response.end('forbidden'); return;
    }
    send('open-file', { key, path: path.resolve(file) });
    response.statusCode = 200; response.end('ok');
  });
});
shimServer.on('error', error => console.error('shim server error:', error.message));

async function start() {
  await fsp.mkdir(CLIDE_HOME, { recursive: true });
  try { await fsp.unlink(SHIM_SOCKET); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await new Promise((resolve, reject) => {
    shimServer.listen(SHIM_SOCKET, resolve);
    shimServer.once('error', reject);
  });
  createWindow();
  if (app.isPackaged && store.state.settings.autoUpdate !== false) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 12000);
}

app.whenReady().then(start);
app.on('activate', createWindow);
app.on('before-quit', () => {
  shuttingDown = true;
  for (const item of sessions.values()) {
    supervisor.detachSync(item.supervisorName);
    try { item.pty.kill(); } catch {}
  }
  store.close();
  try { shimServer.close(); } catch {}
  try { fs.unlinkSync(SHIM_SOCKET); } catch {}
});
app.on('child-process-gone', (_event, details) => logCrash('child-process', details));
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
