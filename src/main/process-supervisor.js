const { execFile } = require('child_process');
const { execFileSync } = require('child_process');

const SCREEN = '/usr/bin/screen';

// Idempotent: an already-prefixed id normalizes back to itself.
function safeId(value) {
  const body = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').replace(/^clide-/, '');
  return `clide-${body.slice(0, 54)}`;
}

function run(args, options = {}) {
  return new Promise(resolve => execFile(SCREEN, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout || 10000,
    maxBuffer: 1024 * 1024
  }, (error, stdout, stderr) => resolve({ ok: !error, out: stdout || '', err: stderr || (error ? error.message : '') })));
}

async function list() {
  const result = await run(['-ls']);
  const names = new Set();
  for (const line of `${result.out}\n${result.err}`.split('\n')) {
    const match = /\d+\.(clide-[a-z0-9_-]+)/.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

async function exists(id) { return (await list()).has(safeId(id)); }

async function start({ id, command, args = [], cwd, env }) {
  const name = safeId(id);
  const recovered = await exists(name);
  if (!recovered) {
    const created = await run(['-dmS', name, command, ...args], { cwd, env });
    if (!created.ok) throw new Error(created.err || `Could not start persistent session ${name}.`);
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  return { name, recovered };
}

// Required lazily so the pure helpers stay importable without the native build.
function attach(name, { cwd, env, cols = 120, rows = 32 } = {}) {
  const pty = require('node-pty');
  return pty.spawn(SCREEN, ['-x', name], { name: 'xterm-256color', cols, rows, cwd, env });
}

async function terminate(name) {
  if (!name) return { ok: true };
  const result = await run(['-S', name, '-X', 'quit']);
  return result.ok || /No screen session found/i.test(result.err) ? { ok: true, out: result.out, err: '' } : result;
}

async function detach(name) {
  if (!name) return { ok: true };
  const result = await run(['-S', name, '-X', 'detach']);
  return result.ok || /No screen session found/i.test(result.err) ? { ok: true } : result;
}

function detachSync(name) {
  if (!name) return true;
  try { execFileSync(SCREEN, ['-S', name, '-X', 'detach'], { stdio: 'ignore', timeout: 3000 }); return true; }
  catch { return false; }
}

module.exports = { SCREEN, safeId, list, exists, start, attach, terminate, detach, detachSync };
