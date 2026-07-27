#!/usr/bin/env node
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-five-'));
const source = path.join(fixture, 'repo');
const data = path.join(fixture, 'data');
const profile = path.join(fixture, 'profile');
const port = 9400 + Math.floor(Math.random() * 300);
fs.mkdirSync(source); fs.mkdirSync(data); fs.mkdirSync(profile);
const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
git(['init', '-b', 'main']); git(['config', 'user.email', 'clide@example.invalid']); git(['config', 'user.name', 'Clide E2E']);
fs.writeFileSync(path.join(source, 'README.md'), Array.from({ length: 24 }, (_, index) => `fixture line ${index + 1}`).join('\n') + '\n'); git(['add', 'README.md']); git(['commit', '-m', 'fixture']);

const electron = path.join(repo, 'node_modules', '.bin', 'electron');
const child = spawn(electron, ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  cwd: repo, env: { ...process.env, CLIDE_CWD: source, CLIDE_DATA_DIR: data, CLIDE_E2E_NO_INITIAL_SESSION: '1' }, stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function page() {
  for (let i = 0; i < 120; i++) {
    try { const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const found = pages.find(item => item.title === 'Clide'); if (found) return found; } catch {}
    await delay(250);
  }
  throw new Error(`Electron did not start. ${stderr.slice(-1000)}`);
}
async function main() {
  const target = await page(); const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map();
  socket.onmessage = event => { const message = JSON.parse(event.data); if (!pending.has(message.id)) return; const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); };
  const evaluate = expression => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve: result => result.exceptionDetails ? reject(new Error(result.exceptionDetails.text)) : resolve(result.result.value), reject }); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
  const created = [];
  for (let i = 1; i <= 5; i++) {
    const result = await evaluate(`window.clide.ipc.invoke('git-worktree-create', ${JSON.stringify({ cwd: source, taskName: `Parallel ticket ${i}`, ticket: `E2E-${i}`, branch: `clide/e2e-${i}`, provider: i % 2 ? 'claude' : 'codex', baseRef: 'main' })})`);
    if (!result.ok) throw new Error(result.err || `Task ${i} failed`); created.push(result);
  }
  const uniquePaths = new Set(created.map(item => item.cwd)); const uniquePorts = new Set(created.map(item => item.port));
  if (uniquePaths.size !== 5 || uniquePorts.size !== 5) throw new Error('Worktrees or ports were not isolated.');
  const snapshot = await evaluate(`window.clide.ipc.invoke('state-snapshot')`);
  if (Object.keys(snapshot.tasks).length !== 5) throw new Error('Five durable tasks were not persisted.');
  const hunkRoot = created[0].cwd; const readme = path.join(hunkRoot, 'README.md');
  const changed = fs.readFileSync(readme, 'utf8').replace('fixture line 2', 'changed line 2').replace('fixture line 22', 'changed line 22');
  fs.writeFileSync(readme, changed);
  const summary = await evaluate(`window.clide.ipc.invoke('git-diff-summary', { cwd: ${JSON.stringify(hunkRoot)} })`);
  if (summary.files !== 1 || summary.additions < 2 || summary.deletions < 2) throw new Error(`Diff summary was incomplete: ${JSON.stringify(summary)}`);
  const prPreview = await evaluate(`window.clide.ipc.invoke('git-pr-preview', { cwd: ${JSON.stringify(hunkRoot)}, base: 'main' })`);
  if (!prPreview.ok || prPreview.branch !== 'clide/e2e-1' || prPreview.base !== 'main') throw new Error(`Pull request preview was incomplete: ${JSON.stringify(prPreview)}`);
  const blockedPr = await evaluate(`window.clide.ipc.invoke('git-pr-create', { cwd: ${JSON.stringify(hunkRoot)}, base: 'main', title: 'Guarded test pull request', body: '' })`);
  if (blockedPr.ok || !/never pushes implicitly/i.test(blockedPr.err || '')) throw new Error(`Unpublished branch was not guarded: ${JSON.stringify(blockedPr)}`);
  const diff = await evaluate(`window.clide.ipc.invoke('git-diff', { cwd: ${JSON.stringify(hunkRoot)}, file: 'README.md', staged: false })`);
  const lines = diff.split('\n'); const first = lines.findIndex(line => line.startsWith('@@')); const second = lines.findIndex((line, index) => index > first && line.startsWith('@@'));
  if (first < 0 || second < 0) throw new Error('Fixture did not create two review hunks.');
  const patch = [...lines.slice(0, first), ...lines.slice(first, second)].join('\n') + '\n';
  const staged = await evaluate(`window.clide.ipc.invoke('git-stage-patch', { cwd: ${JSON.stringify(hunkRoot)}, patch: ${JSON.stringify(patch)}, reverse: false })`);
  if (!staged.ok) throw new Error(staged.err || 'Hunk staging failed.');
  const hunkStatus = execFileSync('git', ['status', '--porcelain=v1'], { cwd: hunkRoot, encoding: 'utf8' });
  if (!/^MM README\.md/m.test(hunkStatus)) throw new Error(`Expected separately staged and unstaged hunks, got ${hunkStatus}`);
  execFileSync('git', ['restore', '--staged', 'README.md'], { cwd: hunkRoot }); execFileSync('git', ['restore', 'README.md'], { cwd: hunkRoot });
  for (const item of created) {
    const removed = await evaluate(`window.clide.ipc.invoke('git-worktree-remove', { taskId: ${JSON.stringify(item.task.id)} })`);
    if (!removed.ok) throw new Error(removed.err || 'Cleanup failed');
    await evaluate(`window.clide.ipc.invoke('task-remove', { id: ${JSON.stringify(item.task.id)} })`);
  }
  console.log(JSON.stringify({ ok: true, worktrees: uniquePaths.size, ports: uniquePorts.size, providers: created.map(item => item.task.provider), durableTasks: 5, hunkStaging: true, diffSummary: true, prPreview: true, prPublishGuard: true }));
  socket.close(); child.kill('SIGTERM');
}

main().catch(error => { console.error(error.stack || error.message); child.kill('SIGTERM'); process.exitCode = 1; });
child.on('exit', () => { try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {} });
