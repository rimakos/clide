const { app, BrowserWindow, ipcMain, clipboard, shell, nativeImage, dialog } = require('electron');
const pty = require('node-pty');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, execFile } = require('child_process');
const { parseStatusZ } = require('./lib/git-status');

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

// Install the bundled agentic-dev-os skills into ~/.claude/skills (opt-in, from the
// welcome tab's button). Runs bin/setup-os and returns its output.
ipcMain.handle('install-os', () => new Promise((resolve) => {
  const script = path.join(__dirname, 'bin', 'setup-os');
  if (!fs.existsSync(script)) return resolve({ ok: false, output: 'setup-os not found' });
  execFile('/bin/bash', [script], { timeout: 60000 }, (err, stdout, stderr) => {
    resolve({ ok: !err, output: ((stdout || '') + (stderr || '')).trim() });
  });
}));

ipcMain.handle('session-start', (_e, { cwd, resumeId }) => {
  const key = 'S' + (++seq);
  const shellPath = process.env.SHELL || '/bin/zsh';
  const env = Object.assign({}, process.env, {
    PATH: SHIM_DIR + ':' + (process.env.PATH || ''),
    CLIDE_PORT: String(PORT),
    CLIDE_SESSION: key,
    CLIDE_HOME: __dirname
  });
  for (const k of Object.keys(env)) {
    if (k.startsWith('npm_') || k === 'NODE_OPTIONS') delete env[k];
  }
  // Session-scoped settings (the panel-hint hook). Nothing is installed into ~/.claude.
  const settings = path.join(__dirname, 'claude', 'settings.json');
  const flags = fs.existsSync(settings) ? `--settings ${JSON.stringify(settings)}` : '';
  const claudeCmd = `claude ${flags}${resumeId ? ` --resume ${resumeId}` : ''}`.trim();
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
function firstLine(s) { return String(s || '').split('\n').map(x => x.trim()).find(Boolean) || ''; }

// `readOnly` adds GIT_OPTIONAL_LOCKS=0 so status polling never contends with the
// terminal's own git over index.lock.
function runGit(cwd, args, readOnly) {
  return new Promise(resolve => {
    const env = gitEnv();
    // No terminal is attached, so a credential prompt would block forever. Fail fast instead.
    env.GIT_TERMINAL_PROMPT = '0';
    if (readOnly) env.GIT_OPTIONAL_LOCKS = '0';
    execFile('git', args, { cwd, env, maxBuffer: 12 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        out: stdout || '',
        err: stderr || (err ? err.message : '')
      });
    });
  });
}

ipcMain.handle('git-status', async (_e, { cwd }) => {
  const r = await runGit(cwd, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'], true);
  if (!r.ok) {
    if (/not a git repository/i.test(r.err)) return { repo: false };
    // Anything else is a real failure. Say so instead of rendering an empty,
    // healthy-looking panel over a broken repo.
    return { repo: true, error: firstLine(r.err) || `git exited ${r.code}`, files: [] };
  }
  return parseStatusZ(r.out);
});

ipcMain.handle('git-diff', async (_e, { cwd, file, staged }) => {
  // core.quotePath=false keeps non-ASCII paths raw in the ---/+++ headers.
  // There is no -z for diff headers, so the parser still unquotes defensively.
  const base = ['-c', 'core.quotePath=false', 'diff'];
  const args = base.slice();
  if (staged) args.push('--cached');
  args.push('--', file);
  const r = await runGit(cwd, args, true);
  if (r.out.trim()) return r.out;
  const r2 = await runGit(cwd, base.concat(['--no-index', '--', '/dev/null', file]), true);
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

// Message of the commit being amended, so the box can be prefilled.
ipcMain.handle('git-last-message', async (_e, { cwd }) => {
  const r = await runGit(cwd, ['log', '-1', '--pretty=%B'], true);
  return r.ok ? r.out.replace(/\n+$/, '') : '';
});

// JetBrains semantics: the checkboxes are the commit, not the index. Stage any
// checked path that git doesn't track yet (`commit --only` won't pick those up),
// then commit exactly the checked set and leave the rest of the index alone.
ipcMain.handle('git-commit', async (_e, { cwd, message, paths, amend }) => {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length && !amend) return { ok: false, code: 1, out: '', err: 'Nothing selected to commit.' };

  if (list.length) {
    const add = await runGit(cwd, ['add', '--', ...list]);
    if (!add.ok) return add;
  }
  const args = ['commit'];
  if (amend) args.push('--amend');
  args.push('-m', message);
  if (list.length) args.push('--only', '--', ...list);
  return runGit(cwd, args);
});

/* ---------------- log / history ---------------- */
// %D carries the ref decorations (HEAD -> main, tags, remotes) so the log can
// label branch tips without a second call.
ipcMain.handle('git-log', async (_e, { cwd, limit, all }) => {
  const args = ['-c', 'core.quotePath=false', 'log',
    `--max-count=${Math.min(Math.max(parseInt(limit, 10) || 200, 1), 2000)}`,
    '--date=short', '--pretty=format:%H\x1f%h\x1f%P\x1f%s\x1f%an\x1f%ad\x1f%D'];
  if (all) args.push('--all');
  const r = await runGit(cwd, args, true);
  if (!r.ok) return { error: firstLine(r.err) || 'log failed', out: '' };
  return { out: r.out };
});

// Files touched by one commit. A merge needs -m --first-parent or git prints
// nothing at all for it.
ipcMain.handle('git-commit-files', async (_e, { cwd, sha }) => {
  const r = await runGit(cwd, ['-c', 'core.quotePath=false', 'show', '--name-status',
    '-m', '--first-parent', '--pretty=format:', '-z', sha], true);
  if (!r.ok) return { files: [], error: firstLine(r.err) };
  // -z gives `STATUS\0path\0`, and renames add a second path field.
  const parts = r.out.split('\0').filter(s => s !== '');
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const st = parts[i];
    if (!/^[A-Z]\d*$/.test(st)) continue;
    const code = st[0];
    const p = parts[++i];
    if (p === undefined) break;
    const entry = { status: code, path: p, orig: null };
    if (code === 'R' || code === 'C') { entry.orig = p; entry.path = parts[++i] || p; }
    files.push(entry);
  }
  return { files };
});

ipcMain.handle('git-commit-diff', async (_e, { cwd, sha, file }) => {
  const args = ['-c', 'core.quotePath=false', 'show', '-m', '--first-parent',
    '--pretty=format:', sha];
  if (file) args.push('--', file);
  const r = await runGit(cwd, args, true);
  return r.ok ? r.out : '';
});

// Without this, ahead/behind is read from a remote ref nothing ever updates, so
// "behind" sits at 0 forever. Failures are the caller's to ignore: being offline
// is normal and must not surface as an error.
ipcMain.handle('git-fetch', (_e, { cwd }) => runGit(cwd, ['fetch', '--prune', '--quiet']));

ipcMain.handle('git-pull', async (_e, { cwd }) => {
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true);
  if (!up.ok || !up.out.trim()) {
    return { ok: false, code: 1, out: '', err: 'This branch has no upstream to pull from.' };
  }
  return runGit(cwd, ['pull', '--rebase']);
});

// Commits that a push would send. Empty upstream means the branch is new, so
// everything not on the default remote head is outgoing.
ipcMain.handle('git-outgoing', async (_e, { cwd }) => {
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true);
  const upstream = up.ok ? up.out.trim() : '';
  const range = upstream ? `${upstream}..HEAD` : 'HEAD';
  const args = ['log', range, '--max-count=50', '--date=relative',
    '--pretty=format:%h\x1f%s\x1f%an\x1f%ad'];
  if (!upstream) args.push('--not', '--remotes');
  const r = await runGit(cwd, args, true);
  if (!r.ok) return { upstream, commits: [], error: firstLine(r.err) };
  const commits = r.out.split('\n').filter(Boolean).map(ln => {
    const [sha, subject, author, date] = ln.split('\x1f');
    return { sha, subject, author, date };
  });
  return { upstream, commits };
});

// A bare `git push` fails on every freshly created branch. Resolve the upstream
// first and set it on the fly when there isn't one.
ipcMain.handle('git-push', async (_e, { cwd }) => {
  const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], true);
  if (up.ok && up.out.trim()) return runGit(cwd, ['push']);

  const remotes = await runGit(cwd, ['remote'], true);
  const remote = remotes.out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!remote.length) {
    return { ok: false, code: 1, out: '', err: 'No remote configured. Add one with: git remote add origin <url>' };
  }
  const target = remote.includes('origin') ? 'origin' : remote[0];
  return runGit(cwd, ['push', '-u', target, 'HEAD']);
});

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

function readFilePayload(p) {
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
}

ipcMain.handle('read-file', async (_e, p) => readFilePayload(p));

ipcMain.handle('save-file', async (_e, { path: p, content }) => {
  // Remember what we wrote so the watcher can tell our own save apart from an
  // edit Claude made, and not bounce the tab back at the user.
  selfWrites.set(p, content);
  fs.writeFileSync(p, content, 'utf8');
  return true;
});

/* ---------------- open-file watching ----------------
 * Claude edits files from the terminal while they sit open in the side panel.
 * Every path with a tab on it is watched, and a change re-reads and pushes the
 * new content to the renderer.
 *
 * watchFile (stat polling) rather than fs.watch: tools frequently write by
 * replacing the inode, which silently kills an fs.watch handle, and the polling
 * cost for the handful of files that are actually open is irrelevant.
 */
const watched = new Map();      // path -> { refs, listener }
const selfWrites = new Map();   // path -> content Clide just wrote
const WATCH_INTERVAL = 400;

function emitChange(p) {
  let payload;
  try { payload = readFilePayload(p); }
  catch { return; }             // deleted or unreadable: leave the tab alone

  // Our own save round-tripping back through the watcher is not a change.
  if (selfWrites.has(p)) {
    const mine = selfWrites.get(p);
    if (payload.content === mine) { selfWrites.delete(p); return; }
    selfWrites.delete(p);
  }
  if (win) win.webContents.send('file-changed', payload);
}

ipcMain.on('watch-file', (_e, p) => {
  if (!p) return;
  const entry = watched.get(p);
  if (entry) { entry.refs++; return; }
  const listener = (curr, prev) => {
    // mtime alone misses same-second rewrites, so size counts too.
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    if (curr.mtimeMs === 0) return;   // file went away
    emitChange(p);
  };
  try { fs.watchFile(p, { interval: WATCH_INTERVAL }, listener); }
  catch { return; }
  watched.set(p, { refs: 1, listener });
});

ipcMain.on('unwatch-file', (_e, p) => {
  const entry = watched.get(p);
  if (!entry) return;
  if (--entry.refs > 0) return;
  try { fs.unwatchFile(p, entry.listener); } catch {}
  watched.delete(p);
  selfWrites.delete(p);
});
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
