#!/usr/bin/env node
const crypto = require('crypto');
const supervisor = require('../src/main/process-supervisor');

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function main() {
  const id = `smoke-${crypto.randomUUID()}`;
  const started = await supervisor.start({ id, command: process.env.SHELL || '/bin/zsh', args: ['-l'], cwd: process.cwd(), env: process.env });
  let first = '';
  const one = supervisor.attach(started.name, { cwd: process.cwd(), env: process.env });
  one.onData(value => { first += value; });
  await wait(350);
  one.write('export CLIDE_PERSIST_TEST=alive\r');
  await wait(150);
  supervisor.detachSync(started.name);
  one.kill();
  await wait(300);
  if (!(await supervisor.exists(started.name))) throw new Error('Persistent session ended when the first attachment closed.');
  let second = '';
  const two = supervisor.attach(started.name, { cwd: process.cwd(), env: process.env });
  two.onData(value => { second += value; });
  await wait(350);
  two.write('echo CLIDE_PERSIST_TEST=$CLIDE_PERSIST_TEST\r');
  await wait(500);
  await supervisor.terminate(started.name);
  try { two.kill(); } catch {}
  if (!second.includes('CLIDE_PERSIST_TEST=alive')) throw new Error(`Reattached shell did not preserve state: ${second.slice(-500)}`);
  console.log(JSON.stringify({ ok: true, session: started.name, detached: true, reattached: true, preservedShellState: true }));
}

main().catch(async error => { console.error(error.stack || error.message); process.exit(1); });
