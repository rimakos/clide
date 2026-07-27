const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = new Set([
  'initial-cwd', 'welcome-file', 'install-os', 'provider-availability', 'session-start',
  'sessions-list',
  'terminal-start', 'pick-folder', 'list-history', 'session-status', 'git-status', 'git-diff-summary',
  'git-pr-preview', 'git-pr-create',
  'git-diff', 'git-branches', 'git-checkout', 'git-create-branch', 'git-stage', 'git-stage-patch',
  'git-unstage', 'git-commit', 'git-push', 'git-worktree-create', 'git-worktree-list',
  'git-worktree-remove', 'git-conflict-preview', 'git-log-summary', 'list-files',
  'git-integrate', 'review-task-create', 'integration-worktree-create',
  'read-dir', 'read-file', 'save-file', 'state-snapshot', 'task-upsert', 'task-patch',
  'task-remove', 'layout-set', 'coord-publish', 'checks-run', 'setup-run', 'doctor-run',
  'dispatch-pending', 'dispatch-claim', 'dispatch-transition', 'dispatch-wait-ready', 'dispatch-session-ready', 'dispatch-prompt-send', 'dispatch-wait-prompt', 'dispatch-fail', 'dispatch-retry', 'dispatch-cancel',
  'workspace-context-get', 'workspace-context-set', 'approval-resolve',
  'view-state-get', 'view-state-set', 'workspace-forget', 'workspace-export', 'workspace-import',
  'telemetry-get', 'telemetry-set', 'telemetry-reset'
  , 'update-check', 'update-download', 'update-install', 'update-channel-set', 'update-rollback-info'
]);
const SEND = new Set(['session-input', 'session-resize', 'session-kill', 'copy-image', 'copy-html', 'reveal', 'open-external']);
const EVENTS = new Set(['pty-data', 'session-exit', 'open-file', 'attention', 'agent-event', 'orchestrator-dispatch', 'dispatch-ready', 'dispatch-prompt-ack', 'dev-health', 'workspace-open', 'update-state']);

const api = {
  ipc: {
    invoke(channel, payload) {
      if (!INVOKE.has(channel)) return Promise.reject(new Error(`IPC channel is not allowed: ${channel}`));
      return ipcRenderer.invoke(channel, payload);
    },
    send(channel, payload) {
      if (!SEND.has(channel)) throw new Error(`IPC channel is not allowed: ${channel}`);
      ipcRenderer.send(channel, payload);
    },
    on(channel, listener) {
      if (!EVENTS.has(channel)) throw new Error(`IPC event is not allowed: ${channel}`);
      const wrapped = (_event, payload) => listener(null, payload);
      ipcRenderer.on(channel, wrapped);
      return () => ipcRenderer.removeListener(channel, wrapped);
    }
  },
  webUtils: {
    getPathForFile(file) { return webUtils.getPathForFile(file); }
  },
  platform: process.platform
};

contextBridge.exposeInMainWorld('clide', api);
