const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

test('provider hook forwards authenticated lifecycle payloads over the local socket', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clide-hook-'));
  const capture = path.join(dir, 'payload.json');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'clide-hook')], {
    env: { ...process.env, CLIDE_HOOK_CAPTURE_FILE: capture, CLIDE_SECRET: 'secret', CLIDE_TASK_ID: 'task-1', CLIDE_PROVIDER: 'claude' }, stdio: ['pipe', 'ignore', 'pipe']
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'agent-1' }));
  await new Promise((resolve, reject) => { child.on('exit', code => code === 0 ? resolve() : reject(new Error(`hook exited ${code}`))); child.on('error', reject); });
  const received = JSON.parse(fs.readFileSync(capture, 'utf8'));
  assert.equal(received.secret, 'secret'); assert.equal(received.taskId, 'task-1');
  assert.equal(received.event.hook_event_name, 'SubagentStart');
});
