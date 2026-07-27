const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { StateStore } = require('../src/main/state-store');

test('Clide MCP exposes and updates durable task coordination', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-mcp-'));
  const stateFile = path.join(dir, 'state.db');
  const task = new StateStore(stateFile).upsertTask({ title: 'MCP task', provider: 'codex' });
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'clide_publish_finding', arguments: { body: 'Schema field is nullable.', level: 'warning' } } }
  ];
  const run = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'clide-mcp')], {
    input: messages.map(value => JSON.stringify(value)).join('\n') + '\n',
    encoding: 'utf8',
    env: { ...process.env, CLIDE_STATE_FILE: stateFile, CLIDE_TASK_ID: task.id }
  });
  assert.equal(run.status, 0, run.stderr);
  const responses = run.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(responses[0].result.serverInfo.name, 'clide');
  assert.ok(responses[1].result.tools.some(tool => tool.name === 'clide_send_message'));
  assert.ok(responses[1].result.tools.some(tool => tool.name === 'clide_claim_paths'));
  assert.ok(responses[1].result.tools.some(tool => tool.name === 'clide_publish_artifact'));
  assert.ok(responses[1].result.tools.some(tool => tool.name === 'clide_workspace_get'));
  assert.ok(responses[1].result.tools.some(tool => tool.name === 'clide_dispatch_task'));
  assert.equal(new StateStore(stateFile).state.tasks[task.id].findings[0].body, 'Schema field is nullable.');
});
