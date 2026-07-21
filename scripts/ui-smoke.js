#!/usr/bin/env node
const port = Number(process.argv[2] || 9333);

async function main() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = pages.find(item => item.type === 'page' && item.title === 'Clide');
  if (!page) throw new Error('Clide page not found.');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  };
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception && response.exceptionDetails.exception.description || response.exceptionDetails.text);
    return response.result.value;
  };

  const report = await evaluate(`(() => ({
    title: document.title,
    privilegedRequire: typeof require,
    privilegedProcess: typeof process,
    terminalGlobal: typeof Terminal,
    fitAddonGlobal: typeof FitAddon,
    fitAddonKeys: typeof FitAddon === 'object' ? Object.keys(FitAddon) : [],
    tiles: document.querySelectorAll('.agent-tile').length,
    terminalTabs: document.querySelectorAll('.tile-terminal-tabs .ttab').length,
    layout: document.getElementById('terminals').className,
    taskRail: getComputedStyle(document.getElementById('tasks-pane')).display,
    inspectorTabs: document.querySelectorAll('#inspector-tabs button').length,
    dialogHidden: getComputedStyle(document.getElementById('task-overlay')).display === 'none'
  }))()`);
  console.log(JSON.stringify(report, null, 2));

  await evaluate(`document.getElementById('workspace-new-task').click()`);
  const dialog = await evaluate(`getComputedStyle(document.getElementById('task-overlay')).display`);
  if (dialog !== 'flex') throw new Error('New task dialog did not open.');
  await evaluate(`document.getElementById('task-cancel').click()`);
  await evaluate(`document.querySelector('[data-layout="single"]').click()`);
  const single = await evaluate(`document.getElementById('terminals').className`);
  if (!single.startsWith('layout-single')) throw new Error('Single-pane layout did not activate.');
  await evaluate(`document.querySelector('[data-layout="grid"]').click()`);

  if (process.argv.includes('--cleanup-fixture')) {
    const root = await evaluate(`(() => {
      const tile = [...document.querySelectorAll('.agent-tile')].find(el => el.querySelector('.tile-task').textContent.startsWith('clide-e2e.'));
      if (!tile) return null;
      const key = tile.dataset.key;
      const tab = [...document.querySelectorAll('.stab')].find(el => el.textContent.includes('clide-e2e.'));
      const cwd = [...document.querySelectorAll('.task-card')].find(el => el.textContent.includes('clide-e2e.'));
      tile.querySelector('.tile-close').click();
      return ${JSON.stringify('/tmp/clide-e2e.3sx4wx')};
    })()`);
    if (root) await evaluate(`window.clide.ipc.invoke('workspace-forget', { root: ${JSON.stringify('/tmp/clide-e2e.3sx4wx')} })`);
  }

  if (report.privilegedRequire !== 'undefined' || report.privilegedProcess !== 'undefined') throw new Error('Renderer still has Node privileges.');
  if (!report.tiles || !report.inspectorTabs || report.taskRail !== 'flex') throw new Error('Flight-deck UI is incomplete.');
  socket.close();
  setTimeout(() => process.exit(0), 25);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
