#!/usr/bin/env node
const port = Number(process.argv[2] || 9333);

async function connect() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(item => item.title === 'Clide');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id); pending.delete(message.id);
    message.error ? item.reject(new Error(message.error.message)) : item.resolve(message.result);
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const evaluate = expression => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, {
      reject,
      resolve(result) {
        if (result.exceptionDetails) reject(new Error(result.exceptionDetails.text));
        else resolve(result.result.value);
      }
    });
    socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
  return { socket, evaluate };
}

async function waitFor(check, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const value = await check(); if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for worktree workflow.');
}

async function main() {
  const { socket, evaluate } = await connect();
  const suffix = Date.now().toString(36);
  const title = `E2E worktree ${suffix}`;
  const branch = `clide/e2e-${suffix}`;
  await evaluate(`(() => {
    document.getElementById('workspace-new-task').click();
    const set = (id, value) => { const el = document.getElementById(id); el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('task-ticket', 'E2E-1'); set('task-title', ${JSON.stringify(title)});
    set('task-branch', ${JSON.stringify(branch)}); set('task-base', 'HEAD'); set('task-setup', 'npm test');
    document.getElementById('task-dialog').requestSubmit();
  })()`);
  await waitFor(() => evaluate(`getComputedStyle(document.getElementById('task-overlay')).display === 'none'`), 60000);
  const task = await waitFor(async () => {
    const value = await evaluate(`window.clide.ipc.invoke('state-snapshot').then(s => Object.values(s.tasks).find(t => t.title === ${JSON.stringify(title)}) || null)`);
    return value;
  });
  if (!task.worktree || task.branch !== branch) throw new Error('Task/worktree metadata is incomplete.');
  if (!task.checks.some(check => check.type === 'setup' && check.ok)) throw new Error('Setup profile did not pass.');
  const before = await evaluate(`document.querySelectorAll('.tile-terminal-tabs .ttab').length`);
  await evaluate(`document.querySelector('.agent-tile.active .tile-shell').click()`);
  await waitFor(async () => (await evaluate(`document.querySelectorAll('.tile-terminal-tabs .ttab').length`)) > before);
  await evaluate(`document.querySelector('.agent-tile.active .tile-close').click()`);
  const cleanup = await evaluate(`window.clide.ipc.invoke('git-worktree-remove', { taskId: ${JSON.stringify(task.id)} })`);
  if (!cleanup.ok) throw new Error(cleanup.err || 'Worktree cleanup failed.');
  await evaluate(`window.clide.ipc.invoke('task-remove', { id: ${JSON.stringify(task.id)} })`);
  console.log(JSON.stringify({ ok: true, title, branch, worktree: task.worktree, setup: 'passed', auxiliaryShell: 'passed', cleanup: 'passed' }, null, 2));
  socket.close(); setTimeout(() => process.exit(0), 25);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
