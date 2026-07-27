const { execFile } = require('child_process');

const PROVIDERS = {
  claude: {
    id: 'claude', label: 'Claude', command: 'claude',
    args: resumeId => resumeId ? ['--resume', resumeId] : []
  },
  codex: {
    id: 'codex', label: 'Codex', command: 'codex',
    args: resumeId => resumeId ? ['resume', resumeId] : []
  }
};

function provider(id) { return PROVIDERS[id] || PROVIDERS.claude; }

function hasCommand(command, env) {
  return new Promise(resolve => execFile('/usr/bin/which', [command], { env }, (err, stdout) =>
    resolve({ available: !err, path: err ? null : stdout.trim() })));
}

async function availability(env) {
  const [claude, codex] = await Promise.all([
    hasCommand(PROVIDERS.claude.command, env), hasCommand(PROVIDERS.codex.command, env)
  ]);
  return { claude: claude.available, codex: codex.available, details: { claude, codex } };
}

module.exports = { PROVIDERS, provider, availability };
