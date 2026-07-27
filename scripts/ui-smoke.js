#!/usr/bin/env node
const port = Number(process.argv[2] || 9333);

async function main() {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json();
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
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out opening the DevTools socket.')), 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(); };
    socket.onerror = error => { clearTimeout(timer); reject(error); };
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out waiting for ${method}.`));
    }, 10000);
    pending.set(requestId, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
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
    workbenchTabs: document.querySelectorAll('.workbench-tab').length,
    workbench: document.body.dataset.workbench,
    paneControls: document.querySelectorAll('#pane-controls button').length,
    environmentCard: getComputedStyle(document.getElementById('environment-card')).display,
    environmentSidebar: getComputedStyle(document.getElementById('environment-sidebar')).display,
    environmentParent: document.getElementById('environment-card').parentElement.id,
    pullRequestAction: Boolean(document.getElementById('environment-pr')),
    pullRequestDialogHidden: getComputedStyle(document.getElementById('pr-overlay')).display === 'none',
    toolLauncherHidden: getComputedStyle(document.getElementById('tool-overlay')).display === 'none',
    dialogHidden: getComputedStyle(document.getElementById('task-overlay')).display === 'none'
  }))()`);
  console.log(JSON.stringify(report, null, 2));

  await evaluate(`document.getElementById('workspace-new-task').click()`);
  const dialog = await evaluate(`getComputedStyle(document.getElementById('task-overlay')).display`);
  if (dialog !== 'flex') throw new Error('New task dialog did not open.');
  await evaluate(`document.getElementById('task-cancel').click()`);
  const environmentPane = await evaluate(`(() => {
    const pane = document.getElementById('environment-sidebar');
    if (getComputedStyle(pane).display === 'none') document.getElementById('sidebar-toggle-top').click();
    return { display: getComputedStyle(pane).display, pressed: document.getElementById('sidebar-toggle-top').getAttribute('aria-pressed') };
  })()`);
  if (environmentPane.display !== 'flex' || environmentPane.pressed !== 'true') throw new Error('Environment pane did not open from the first pane control.');
  await evaluate(`document.getElementById('sidebar-toggle-top').click()`);
  await evaluate(`document.getElementById('launcher-open').click()`);
  const launcher = await evaluate(`getComputedStyle(document.getElementById('tool-overlay')).display`);
  if (launcher !== 'flex') throw new Error('Tool launcher did not open.');
  await evaluate(`document.querySelector('[data-open-tool="files"]').click()`);
  const filesMode = await evaluate(`(() => {
    const explorer = document.getElementById('explorer');
    const viewer = document.getElementById('right');
    return { mode: document.body.dataset.workbench, terminals: getComputedStyle(document.getElementById('terminal-column')).display, files: getComputedStyle(document.getElementById('files-pane')).display, navigatorRight: explorer.getBoundingClientRect().left >= viewer.getBoundingClientRect().right - 2 };
  })()`);
  if (filesMode.mode !== 'files' || filesMode.terminals !== 'none' || filesMode.files !== 'flex' || !filesMode.navigatorRight) throw new Error('Files workbench did not activate with its navigator on the right.');
  await evaluate(`document.querySelector('[data-workbench="review"]').click()`);
  const reviewMode = await evaluate(`({ mode: document.body.dataset.workbench, git: getComputedStyle(document.getElementById('git-pane')).display })`);
  if (reviewMode.mode !== 'review' || reviewMode.git !== 'flex') throw new Error('Review workbench did not activate.');
  await evaluate(`document.querySelector('[data-workbench="terminal"]').click()`);
  const terminalMode = await evaluate(`({ mode: document.body.dataset.workbench, navigator: getComputedStyle(document.getElementById('explorer')).display })`);
  if (terminalMode.mode !== 'terminal' || terminalMode.navigator !== 'none') throw new Error('Terminal workbench still duplicates the file navigator.');
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
  if (!report.tiles || !report.inspectorTabs) throw new Error('Flight-deck UI is incomplete.');
  if (report.workbenchTabs !== 3 || report.paneControls !== 3 || report.environmentCard === 'none' || report.environmentParent !== 'environment-sidebar' || !report.pullRequestAction || !report.pullRequestDialogHidden || !report.toolLauncherHidden) throw new Error('Workbench shell is incomplete.');
  socket.close();
  setTimeout(() => process.exit(0), 25);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
