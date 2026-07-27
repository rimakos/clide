#!/usr/bin/env node
const { spawn, spawnSync, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { StateStore } = require('../src/main/state-store');

const project = path.resolve(__dirname, '..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-orchestrator-'));
const source = path.join(fixture, 'repo'); const data = path.join(fixture, 'data');
const profile = path.join(fixture, 'profile'); const mockBin = path.join(fixture, 'bin');
const port = 9700 + Math.floor(Math.random() * 200);
let inspectPage = null;
for (const dir of [source, data, profile, mockBin]) fs.mkdirSync(dir);
for (const provider of ['claude', 'codex']) {
  const file = path.join(mockBin, provider);
  fs.writeFileSync(file, `#!/bin/sh\nprintf 'MOCK_READY ${provider}\\n'\nwhile IFS= read -r line; do printf 'MOCK_INPUT ${provider}: %s\\n' "$line"; done\n`);
  fs.chmodSync(file, 0o755);
}
const git = args => execFileSync('git', args, { cwd: source, stdio: 'pipe' });
git(['init', '-b', 'main']); git(['config', 'user.email', 'clide@example.invalid']); git(['config', 'user.name', 'Clide E2E']);
fs.writeFileSync(path.join(source, 'README.md'), '# orchestrator fixture\n'); git(['add', 'README.md']); git(['commit', '-m', 'fixture']);

const child = spawn(path.join(project, 'node_modules', '.bin', 'electron'), ['.', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`], {
  cwd: project, env: { ...process.env, CLIDE_CWD: source, CLIDE_DATA_DIR: data, CLIDE_PROVIDER_PATH: mockBin, CLIDE_DEFAULT_PROVIDER: 'codex' }, stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 30000) {
  const start = Date.now(); while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await delay(200); }
  throw new Error(`Timed out waiting for ${label}. ${stderr.slice(-800)}`);
}
async function main() {
  const page = await waitFor(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.title === 'Clide'); } catch { return null; } }, 'Electron page');
  const socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let seq = 0; const pending = new Map(); socket.onmessage = event => { const message = JSON.parse(event.data); if (!pending.has(message.id)) return; const item = pending.get(message.id); pending.delete(message.id); message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result); };
  const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = expression => command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then(result => result.exceptionDetails ? Promise.reject(new Error(result.exceptionDetails.text)) : result.result.value);
  inspectPage = evaluate;
  await waitFor(() => evaluate(`Boolean(document.querySelector('.agent-tile.orchestrator'))`), 'orchestrator tile');
  const stateFile = path.join(data, 'state.db');
  const workspace = await waitFor(() => evaluate(`window.clide.ipc.invoke('state-snapshot').then(state => { const workspace = Object.values(state.workspaces).find(value => value.orchestrator); return workspace && workspace.orchestrator; })`), 'orchestrator persistence');
  const db = new StateStore(stateFile); const secret = db.state.settings.shimSecret; db.close();
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clide_dispatch_task', arguments: { ticket: 'ORCH-1', title: 'Build orchestrated feature', prompt: 'Implement the isolated orchestrator fixture and report checks through Clide.', provider: 'claude', branch: 'clide/orch-1', baseRef: 'main', pathClaims: ['src/feature.js'], dispatchKey: 'ORCH-1' } } }
  ];
  const runMcp = () => spawnSync(process.execPath, [path.join(project, 'bin', 'clide-mcp')], {
    input: messages.map(message => JSON.stringify(message)).join('\n') + '\n', encoding: 'utf8', timeout: 120000,
    env: { ...process.env, CLIDE_STATE_FILE: stateFile, CLIDE_WORKSPACE_ROOT: source, CLIDE_SOCKET: path.join(data, 'open.sock'), CLIDE_SECRET: secret, CLIDE_SESSION: workspace.persistentId, CLIDE_ROLE: 'orchestrator' }
  });
  const first = runMcp(); if (first.status !== 0) throw new Error(first.stderr || 'MCP dispatch failed');
  const responses = first.stdout.trim().split('\n').map(JSON.parse);
  if (responses[2].result.isError) throw new Error(`MCP dispatch error: ${responses[2].result.content[0].text}`);
  const dispatch = JSON.parse(responses[2].result.content[0].text);
  if (!dispatch.ok || dispatch.task.provider !== 'claude') throw new Error('Structured dispatch returned the wrong worker.');
  await command('Page.reload', { ignoreCache: true });
  await delay(300);
  await waitFor(() => evaluate(`document.readyState === 'complete'`), 'renderer recovery');
  await waitFor(() => evaluate(`document.querySelectorAll('.agent-tile.orchestrator').length === 1 && document.querySelectorAll('.agent-tile.claude:not(.orchestrator)').length === 1`), 'one orchestrator and one worker tile');
  await waitFor(() => evaluate(`document.body.innerText.includes('ORCH-1')`), 'worker identity');
  await waitFor(() => evaluate(`document.querySelectorAll('.agent-tile.claude:not(.orchestrator)').length === 1`), 'Claude worker');
  await waitFor(() => evaluate(`window.clide.ipc.invoke('state-snapshot').then(state => { const task = state.tasks[${JSON.stringify(dispatch.task.id)}]; return task && task.dispatch && task.dispatch.stage === 'running' && Boolean(task.dispatch.promptAcknowledgedAt); })`), 'worker prompt acknowledgement');
  await command('Page.reload', { ignoreCache: true });
  await delay(300);
  await waitFor(() => evaluate(`document.readyState === 'complete' && document.querySelectorAll('.agent-tile.orchestrator').length === 1 && document.querySelectorAll('.agent-tile.claude:not(.orchestrator)').length === 1`), 'running worker reattach');
  if (!await evaluate(`document.querySelectorAll('.agent-tile.claude:not(.orchestrator)').length === 1`)) throw new Error('Renderer recovery did not preserve exactly one worker tile.');
  const second = runMcp(); const secondResponses = second.stdout.trim().split('\n').map(JSON.parse); const retry = JSON.parse(secondResponses[2].result.content[0].text);
  if (!retry.existing) throw new Error('Dispatch retry was not idempotent.');
  const snapshot = await evaluate(`window.clide.ipc.invoke('state-snapshot')`);
  if (Object.keys(snapshot.tasks).length !== 1 || snapshot.tasks[dispatch.task.id].createdBy.indexOf('orchestrator:') !== 0) throw new Error('Orchestrator task metadata is incomplete.');
  const durable = snapshot.tasks[dispatch.task.id];
  if (durable.dispatch.stage !== 'running' || !durable.dispatch.readyAt || !durable.dispatch.promptAcknowledgedAt || durable.audit.length < 4) throw new Error('Durable dispatch did not record readiness, prompt acknowledgement, and audit transitions.');
  if ((fs.statSync(path.join(data, 'open.sock')).mode & 0o777) !== 0o600) throw new Error('Clide socket permissions are not private.');
  await evaluate(`(() => { const tile = document.querySelector('.agent-tile:not(.orchestrator)'); tile.querySelector('.tile-close').click(); })()`);
  await delay(300);
  const removed = await evaluate(`window.clide.ipc.invoke('git-worktree-remove', { taskId: ${JSON.stringify(dispatch.task.id)} })`);
  if (!removed.ok) throw new Error(removed.err || 'Worker cleanup failed');
  await evaluate(`window.clide.ipc.invoke('task-remove', { id: ${JSON.stringify(dispatch.task.id)} })`);
  await evaluate(`document.querySelector('.agent-tile.orchestrator').querySelector('.tile-close').click()`);
  await delay(300);
  console.log(JSON.stringify({ ok: true, orchestrator: workspace.provider, worker: 'claude', pinned: true, dispatch: true, promptDelivered: true, idempotent: true, repositoryScoped: true, rendererRecovery: true, exactlyOneWorker: true, privateSocket: true }));
  socket.close(); child.kill('SIGTERM');
}
main().catch(async error => {
  console.error(error.stack || error.message);
  try { if (inspectPage) console.error('Renderer tile snapshot:', JSON.stringify(await inspectPage(`window.clide.ipc.invoke('sessions-list').then(live => ({ ready: document.readyState, live, saved: JSON.parse(localStorage.getItem('clide-state') || 'null'), tiles: [...document.querySelectorAll('.agent-tile')].map(tile => ({ key: tile.dataset.key, classes: tile.className, text: tile.innerText.slice(0, 180) })) }))`), null, 2)); } catch {}
  try {
    const failed = new StateStore(path.join(data, 'state.db'));
    console.error('Durable dispatch snapshot:', JSON.stringify(Object.values(failed.state.tasks).map(task => ({ id: task.id, state: task.state, dispatch: task.dispatch, promptDeliveredAt: task.promptDeliveredAt, supervisorId: task.supervisorId, audit: task.audit })), null, 2));
    failed.close();
  } catch {}
  child.kill('SIGTERM'); process.exitCode = 1;
});
child.on('exit', () => { try { fs.rmSync(fixture, { recursive: true, force: true }); } catch {} });
