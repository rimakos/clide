const path = require('path');
const { normalizeDispatch } = require('./dispatch-lifecycle');

const TASK_STATES = new Set([
  'draft', 'starting', 'running', 'waiting', 'approval', 'blocked', 'done', 'exited', 'archived'
]);

function text(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function taskSlug(value) {
  return text(value, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function normalizeTask(input = {}) {
  const now = new Date().toISOString();
  const id = text(input.id, 80) || `task-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const title = text(input.title || input.taskName, 160);
  if (!title) throw new Error('Task title is required.');
  const provider = input.provider === 'codex' ? 'codex' : 'claude';
  const state = TASK_STATES.has(input.state) ? input.state : 'draft';
  return {
    id,
    title,
    ticket: text(input.ticket, 48),
    provider,
    state,
    repo: text(input.repo, 120),
    repoRoot: text(input.repoRoot || input.sourceRoot, 4096),
    worktree: text(input.worktree || input.cwd, 4096),
    branch: text(input.branch, 240),
    baseRef: text(input.baseRef, 240) || 'HEAD',
    setupCommand: text(input.setupCommand, 1000),
    devCommand: text(input.devCommand, 1000),
    supervisorId: text(input.supervisorId, 120),
    lastSessionId: text(input.lastSessionId, 240),
    port: Number.isInteger(input.port) ? input.port : null,
    dependencies: Array.isArray(input.dependencies) ? input.dependencies.map(v => text(v, 80)).filter(Boolean) : [],
    findings: Array.isArray(input.findings) ? input.findings.slice(-100) : [],
    messages: Array.isArray(input.messages) ? input.messages.slice(-200) : [],
    checks: Array.isArray(input.checks) ? input.checks.slice(-50) : [],
    artifacts: Array.isArray(input.artifacts) ? input.artifacts.slice(-200) : [],
    pathClaims: Array.isArray(input.pathClaims) ? input.pathClaims.slice(-200) : [],
    childAgents: Array.isArray(input.childAgents) ? input.childAgents.slice(-200) : [],
    events: Array.isArray(input.events) ? input.events.slice(-300) : [],
    reviewOf: text(input.reviewOf, 80),
    integrationOf: Array.isArray(input.integrationOf) ? input.integrationOf.map(v => text(v, 80)).filter(Boolean) : [],
    launchPrompt: text(input.launchPrompt, 8000),
    createdBy: text(input.createdBy, 80),
    dispatchKey: text(input.dispatchKey, 160),
    promptDeliveredAt: text(input.promptDeliveredAt, 40),
    dispatch: normalizeDispatch(input.dispatch),
    dev: input.dev && typeof input.dev === 'object' ? {
      status: text(input.dev.status, 40) || 'idle',
      terminalId: text(input.dev.terminalId, 160),
      startedAt: text(input.dev.startedAt, 40),
      healthyAt: text(input.dev.healthyAt, 40),
      lastCheckedAt: text(input.dev.lastCheckedAt, 40),
      lastError: text(input.dev.lastError, 1000),
      url: text(input.dev.url, 500)
    } : null,
    contextSnapshot: text(input.contextSnapshot, 12000),
    approvals: Array.isArray(input.approvals) ? input.approvals.slice(-100) : [],
    audit: Array.isArray(input.audit) ? input.audit.slice(-500) : [],
    createdAt: input.createdAt || now,
    updatedAt: now
  };
}

function isWithin(root, candidate) {
  if (!root || !candidate) return false;
  const r = path.resolve(root);
  const c = path.resolve(candidate);
  const rel = path.relative(r, c);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}

function validHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch { return false; }
}

module.exports = { TASK_STATES, text, taskSlug, normalizeTask, isWithin, validHttpUrl };
