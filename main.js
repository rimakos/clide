const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, dialog } = require('electron');
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile } = require('child_process');

const PORT = parseInt(process.env.CLIDE_PORT || '8771', 10);
const EXPLICIT_CWD = !!process.env.CLIDE_CWD;
let CWD = process.env.CLIDE_CWD || process.cwd();
if (CWD === '/' || CWD === '') CWD = os.homedir();
const SHIM_DIR = path.join(__dirname, 'shim');
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');

const IMG_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];
const CODE_EXT = ['.js', '.ts', '.tsx', '.jsx', '.py', '.json', '.html', '.css', '.sh', '.yml', '.yaml'];
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'
};

let win = null;
const sessions = new Map(); // key -> { pty, cwd, transcriptId, preFiles }
let seq = 0;

/* ---------------- window ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1500, height: 940,
    title: 'Clide',
    backgroundColor: '#1e1f22',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, webviewTag: true }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, msg, line, src) =>
    console.log(`[renderer:${level}] ${msg} (${src}:${line})`));
  win.on('closed', () => { win = null; });
}

/* ---------------- sessions / PTYs ---------------- */
function projectDir(cwd) { return path.join(PROJECTS, cwd.replace(/\//g, '-')); }

function listJsonl(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return []; }
}

ipcMain.handle('initial-cwd', () => ({ cwd: CWD, explicit: EXPLICIT_CWD }));

// The bundled agentic-dev-os map — shown as the first tab on a fresh launch.
ipcMain.handle('welcome-file', () => {
  const p = path.join(__dirname, 'agentic-dev-os', 'docs', 'visualiser.html');
  return fs.existsSync(p) ? p : null;
});

ipcMain.handle('session-start', (_e, { cwd, resumeId }) => {
  const key = 'S' + (++seq);
  const shellPath = process.env.SHELL || '/bin/zsh';
  const env = Object.assign({}, process.env, {
    PATH: SHIM_DIR + ':' + (process.env.PATH || ''),
    CLIDE_PORT: String(PORT),
    CLIDE_SESSION: key
  });
  for (const k of Object.keys(env)) {
    if (k.startsWith('npm_') || k === 'NODE_OPTIONS') delete env[k];
  }
  const claudeCmd = resumeId ? `claude --resume ${resumeId}` : 'claude';
  // Re-prepend the shim inside the interactive shell so it survives profile PATH rebuilds
  // (a Finder-launched app has a minimal PATH; the login shell fixes it, we re-assert after).
  const cmd = `export PATH="${SHIM_DIR}:$PATH"; ${claudeCmd}`;
  const preFiles = new Set(listJsonl(projectDir(cwd)));
  let proc;
  try {
    proc = pty.spawn(shellPath, ['-lic', cmd], { name: 'xterm-256color', cols: 120, rows: 32, cwd, env });
  } catch (err) {
    return { error: err.message };
  }
  const s = { pty: proc, cwd, transcriptId: resumeId || null, preFiles };
  sessions.set(key, s);
  proc.onData(d => win && win.webContents.send('pty-data', { key, data: d }));
  proc.onExit(() => win && win.webContents.send('session-exit', { key }));
  return { key, cwd, repo: path.basename(cwd) };
});

ipcMain.on('session-input', (_e, { key, data }) => { const s = sessions.get(key); if (s) s.pty.write(data); });
ipcMain.on('session-resize', (_e, { key, cols, rows }) => {
  const s = sessions.get(key); if (s && cols > 0 && rows > 0) s.pty.resize(cols, rows);
});
ipcMain.on('session-kill', (_e, { key }) => {
  const s = sessions.get(key); if (s) { try { s.pty.kill(); } catch {} sessions.delete(key); }
});

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

/* ---------------- transcript parsing ---------------- */
function readChunk(fp, bytes, fromEnd) {
  const fd = fs.openSync(fp, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const pos = fromEnd ? size - len : 0;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, pos);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function lineObjs(text) {
  const out = [];
  for (const ln of text.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch {}
  }
  return out;
}
function contentText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter(b => b && b.type === 'text').map(b => b.text).join(' ');
  return '';
}
function firstUserText(objs) {
  for (const o of objs) {
    if (o.type === 'user' && o.message && o.message.role === 'user') {
      const t = contentText(o.message.content).trim();
      if (t && !t.startsWith('<') && t.length > 1) return t;
    }
  }
  return null;
}
function firstCwd(objs) { for (const o of objs) if (o.cwd) return o.cwd; return null; }
function lastAssistantText(objs) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type === 'assistant' && o.message) {
      const t = contentText(o.message.content).trim();
      if (t) return t;
    }
  }
  return null;
}
function lastUsage(objs) {
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o.type === 'assistant' && o.message && o.message.usage) {
      const u = o.message.usage;
      const tokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      return { tokens, model: o.message.model || null };
    }
  }
  return { tokens: null, model: null };
}

ipcMain.handle('list-history', async () => {
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
  const out = [];
  for (const d of dirs) {
    const dp = path.join(PROJECTS, d);
    for (const f of listJsonl(dp)) {
      const fp = path.join(dp, f);
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      if (st.size < 200) continue;
      const head = lineObjs(readChunk(fp, 64 * 1024, false));
      const tail = lineObjs(readChunk(fp, 96 * 1024, true));
      const cwd = firstCwd(head) || d.replace(/-/g, '/');
      const title = firstUserText(head) || path.basename(cwd);
      const recap = lastAssistantText(tail);
      out.push({
        id: f.replace('.jsonl', ''),
        cwd,
        repo: path.basename(cwd),
        title: title.slice(0, 90),
        recap: recap ? recap.slice(0, 200) : null,
        mtime: st.mtimeMs
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, 80);
});

function modelWindow(m) { if (!m) return 200000; return /1m/i.test(m) ? 1000000 : 200000; }
function gitBranch(cwd) {
  try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
function resolveTranscript(s) {
  if (s.transcriptId) return s.transcriptId;
  const dir = projectDir(s.cwd);
  const all = listJsonl(dir);
  const fresh = all.filter(f => !s.preFiles.has(f));
  const pool = fresh.length ? fresh : all;
  const pick = pool
    .map(f => ({ f, m: (() => { try { return fs.statSync(path.join(dir, f)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.m - a.m)[0];
  if (pick) { s.transcriptId = pick.f.replace('.jsonl', ''); return s.transcriptId; }
  return null;
}

ipcMain.handle('session-status', async (_e, { key }) => {
  const s = sessions.get(key);
  if (!s) return null;
  let model = null, tokens = null;
  const tid = resolveTranscript(s);
  if (tid) {
    const fp = path.join(projectDir(s.cwd), tid + '.jsonl');
    try {
      const tail = lineObjs(readChunk(fp, 200 * 1024, true));
      const u = lastUsage(tail);
      model = u.model; tokens = u.tokens;
    } catch {}
  }
  const win0 = modelWindow(model);
  return {
    repo: path.basename(s.cwd),
    branch: gitBranch(s.cwd),
    id: tid,
    model,
    ctxTokens: tokens,
    ctxPct: tokens != null ? Math.min(100, Math.round((tokens / win0) * 100)) : null,
    window: win0
  };
});

/* ---------------- git ---------------- */
// A Finder-launched app has a minimal PATH, so git hooks (husky → npm/node) fail.
// Resolve the user's real login-shell PATH once and use it for all git calls.
let LOGIN_PATH = null;
function loginPath() {
  if (LOGIN_PATH) return LOGIN_PATH;
  try {
    const sh = process.env.SHELL || '/bin/zsh';
    LOGIN_PATH = execSync(`${sh} -lic 'echo -n $PATH'`, { timeout: 5000 }).toString().trim() || process.env.PATH;
  } catch { LOGIN_PATH = process.env.PATH || ''; }
  return LOGIN_PATH;
}
function gitEnv() {
  const env = Object.assign({}, process.env, { PATH: loginPath() });
  for (const k of Object.keys(env)) if (k.startsWith('npm_') || k === 'NODE_OPTIONS') delete env[k];
  return env;
}
function runGit(cwd, args) {
  return new Promise(resolve => {
    execFile('git', args, { cwd, env: gitEnv(), maxBuffer: 12 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: stdout || '', err: stderr || (err ? err.message : '') });
    });
  });
}

ipcMain.handle('git-status', async (_e, { cwd }) => {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
  if (!r.ok && /not a git repository/i.test(r.err)) return { repo: false };
  const lines = r.out.split('\n').filter(Boolean);
  let branch = null, ahead = 0, behind = 0;
  const files = [];
  for (const ln of lines) {
    if (ln.startsWith('## ')) {
      const head = ln.slice(3);
      branch = head.split('...')[0].split(' ')[0];
      const a = /ahead (\d+)/.exec(ln); const b = /behind (\d+)/.exec(ln);
      ahead = a ? +a[1] : 0; behind = b ? +b[1] : 0;
      continue;
    }
    const x = ln[0], y = ln[1];
    let p = ln.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    p = p.replace(/^"|"$/g, '');
    files.push({
      path: p, index: x, work: y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' || x === '?',
      untracked: x === '?'
    });
  }
  return { repo: true, branch, ahead, behind, files };
});

ipcMain.handle('git-diff', async (_e, { cwd, file, staged }) => {
  const args = ['diff'];
  if (staged) args.push('--cached');
  args.push('--', file);
  const r = await runGit(cwd, args);
  if (r.out.trim()) return r.out;
  const r2 = await runGit(cwd, ['diff', '--no-index', '--', '/dev/null', file]);
  return r2.out || r.out;
});

ipcMain.handle('git-branches', async (_e, { cwd }) => {
  const r = await runGit(cwd, ['branch', '--format=%(refname:short)']);
  const cur = (await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim();
  return { current: cur, branches: r.out.split('\n').map(s => s.trim()).filter(Boolean) };
});
ipcMain.handle('git-checkout', (_e, { cwd, branch }) => runGit(cwd, ['checkout', branch]));
ipcMain.handle('git-create-branch', (_e, { cwd, name }) => runGit(cwd, ['checkout', '-b', name]));

ipcMain.handle('git-stage', (_e, { cwd, file }) => runGit(cwd, ['add', '--', file]));
ipcMain.handle('git-unstage', (_e, { cwd, file }) => runGit(cwd, ['restore', '--staged', '--', file]));
ipcMain.handle('git-stage-all', (_e, { cwd }) => runGit(cwd, ['add', '-A']));
ipcMain.handle('git-commit', (_e, { cwd, message }) => runGit(cwd, ['commit', '-m', message]));
ipcMain.handle('git-push', (_e, { cwd }) => runGit(cwd, ['push']));

/* ---------------- file viewers ---------------- */
ipcMain.handle('list-files', async (_e, cwd) => {
  const skip = new Set(['node_modules', '.git', '.DS_Store', 'dist', 'build', '.next', '.cache']);
  const out = [];
  const walk = dir => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (out.length < 12000) walk(full); }
      else out.push({ name: e.name, path: full, rel: path.relative(cwd, full) });
    }
  };
  walk(cwd);
  return out;
});

ipcMain.handle('read-dir', async (_e, dir) => {
  const skip = new Set(['node_modules', '.git', '.DS_Store']);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(d => !skip.has(d.name))
    .map(d => ({ name: d.name, path: path.join(dir, d.name), dir: d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
});

ipcMain.handle('read-file', async (_e, p) => {
  const ext = path.extname(p).toLowerCase();
  const name = path.basename(p);
  if (IMG_EXT.includes(ext)) {
    const buf = fs.readFileSync(p);
    const mime = MIME[ext] || 'application/octet-stream';
    return { path: p, name, ext, kind: 'image', dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const content = fs.readFileSync(p, 'utf8');
  let kind = 'text';
  if (ext === '.html' || ext === '.htm') kind = 'html';
  else if (ext === '.md') kind = 'markdown';
  else if (CODE_EXT.includes(ext)) kind = 'code';
  return { path: p, name, ext, kind, content };
});

ipcMain.handle('save-file', async (_e, { path: p, content }) => { fs.writeFileSync(p, content, 'utf8'); return true; });
ipcMain.on('copy-image', (_e, p) => clipboard.writeImage(nativeImage.createFromPath(p)));
ipcMain.on('copy-html', (_e, { html, text }) => clipboard.write({ html, text }));
ipcMain.on('reveal', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('open-external', (_e, url) => shell.openExternal(url));

/* ---------------- shim server ---------------- */
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/open') {
    let body = '';
    req.on('data', c => (body += c));
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const p = params.get('path');
      const key = params.get('session');
      if (p && win) win.webContents.send('open-file', { key, path: p });
      res.statusCode = 200; res.end('ok');
    });
  } else { res.statusCode = 404; res.end(); }
});
server.on('error', e => console.error('shim server error:', e.message));
server.listen(PORT, '127.0.0.1');

app.whenReady().then(createWindow);
app.on('activate', () => { if (!win) createWindow(); });
app.on('window-all-closed', () => {
  for (const s of sessions.values()) { try { s.pty.kill(); } catch {} }
  app.quit();
});
