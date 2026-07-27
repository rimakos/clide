const DISPATCH_STAGES = Object.freeze([
  'requested',
  'worktree-created',
  'waiting-dependencies',
  'waiting-capacity',
  'setup-running',
  'launching',
  'provider-ready',
  'prompt-delivered',
  'running',
  'blocked',
  'failed',
  'cancelled'
]);

const STAGES = new Set(DISPATCH_STAGES);
const TERMINAL_STAGES = new Set(['running', 'cancelled']);
const RECOVERABLE_STAGES = new Set([
  'requested', 'worktree-created', 'waiting-dependencies', 'waiting-capacity', 'setup-running',
  'launching', 'provider-ready', 'prompt-delivered', 'blocked', 'failed'
]);

const ALLOWED = Object.freeze({
  requested: new Set(['worktree-created', 'waiting-dependencies', 'waiting-capacity', 'failed', 'cancelled']),
  'worktree-created': new Set(['waiting-dependencies', 'waiting-capacity', 'setup-running', 'launching', 'failed', 'cancelled']),
  'waiting-dependencies': new Set(['waiting-capacity', 'setup-running', 'launching', 'failed', 'cancelled']),
  'waiting-capacity': new Set(['waiting-dependencies', 'setup-running', 'launching', 'failed', 'cancelled']),
  'setup-running': new Set(['launching', 'failed', 'cancelled']),
  launching: new Set(['provider-ready', 'failed', 'cancelled']),
  'provider-ready': new Set(['prompt-delivered', 'failed', 'cancelled']),
  'prompt-delivered': new Set(['running', 'failed', 'cancelled']),
  running: new Set(['failed', 'cancelled']),
  blocked: new Set(['waiting-dependencies', 'setup-running', 'launching', 'failed', 'cancelled']),
  failed: new Set(['waiting-dependencies', 'setup-running', 'launching', 'cancelled']),
  cancelled: new Set()
});

function iso(value, fallback = '') {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function normalizeDispatch(input) {
  if (!input || typeof input !== 'object') return null;
  const now = new Date().toISOString();
  const stage = STAGES.has(input.stage) ? input.stage : 'requested';
  return {
    stage,
    revision: Math.max(0, Number(input.revision) || 0),
    attempt: Math.max(0, Number(input.attempt) || 0),
    requestedAt: iso(input.requestedAt, now),
    updatedAt: iso(input.updatedAt, now),
    leaseId: String(input.leaseId || '').slice(0, 160),
    leaseOwner: String(input.leaseOwner || '').slice(0, 160),
    leaseExpiresAt: iso(input.leaseExpiresAt),
    setupCompletedAt: iso(input.setupCompletedAt),
    launchedAt: iso(input.launchedAt),
    readyAt: iso(input.readyAt),
    promptWriteId: String(input.promptWriteId || '').slice(0, 160),
    promptWrittenAt: iso(input.promptWrittenAt),
    promptAcknowledgedAt: iso(input.promptAcknowledgedAt),
    runningAt: iso(input.runningAt),
    nextRetryAt: iso(input.nextRetryAt),
    retryDisabled: Boolean(input.retryDisabled),
    lastError: String(input.lastError || '').slice(0, 4000),
    lastActor: String(input.lastActor || '').slice(0, 160)
  };
}

function canTransition(from, to) {
  return from === to || Boolean(ALLOWED[from] && ALLOWED[from].has(to));
}

function assertTransition(from, to) {
  if (!STAGES.has(to)) throw new Error(`Unknown dispatch stage: ${to}`);
  if (!canTransition(from, to)) throw new Error(`Invalid dispatch transition: ${from} → ${to}`);
}

function leaseExpired(dispatch, now = Date.now()) {
  if (!dispatch || !dispatch.leaseId || !dispatch.leaseExpiresAt) return true;
  return new Date(dispatch.leaseExpiresAt).getTime() <= now;
}

function isRecoverable(dispatch) {
  return Boolean(dispatch && RECOVERABLE_STAGES.has(dispatch.stage));
}

module.exports = {
  DISPATCH_STAGES,
  TERMINAL_STAGES,
  RECOVERABLE_STAGES,
  normalizeDispatch,
  canTransition,
  assertTransition,
  leaseExpired,
  isRecoverable
};
