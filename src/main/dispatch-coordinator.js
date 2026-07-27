const crypto = require('crypto');
const { canTransition, isRecoverable, leaseExpired } = require('../shared/dispatch-lifecycle');

class DispatchCoordinator {
  constructor(store, options = {}) {
    this.store = store;
    this.leaseMs = options.leaseMs || 45_000;
  }

  blockedBy(task, tasks) {
    return (task.dependencies || []).filter(id => tasks[id] && !['done', 'archived'].includes(tasks[id].state));
  }

  resolveDependencies(refs, workspaceRoot) {
    const tasks = Object.values(this.store.snapshot().tasks).filter(task => task.repoRoot === workspaceRoot);
    return (refs || []).map(ref => {
      const value = String(ref || '').trim();
      const match = tasks.find(task => task.id === value || task.ticket === value || task.dispatchKey === value);
      if (!match) throw new Error(`Dependency not found in this repository: ${value}`);
      return match.id;
    }).filter((value, index, all) => value && all.indexOf(value) === index);
  }

  assertNoCycle(taskId, dependencies) {
    const tasks = this.store.snapshot().tasks;
    const graph = new Map(Object.values(tasks).map(task => [task.id, task.dependencies || []]));
    graph.set(taskId, dependencies || []);
    const visiting = new Set(); const visited = new Set();
    const visit = id => {
      if (visiting.has(id)) throw new Error(`Dependency cycle detected at ${tasks[id] ? tasks[id].title : id}.`);
      if (visited.has(id)) return;
      visiting.add(id);
      for (const dependency of graph.get(id) || []) visit(dependency);
      visiting.delete(id); visited.add(id);
    };
    visit(taskId);
    return true;
  }

  capacity(task, tasks) {
    const configured = Number(this.store.state.settings.maxConcurrentWorkers);
    const limit = Number.isInteger(configured) && configured > 0 ? Math.min(configured, 20) : 5;
    const active = Object.values(tasks).filter(item => item.id !== task.id && item.repoRoot === task.repoRoot && item.dispatch &&
      !['done', 'archived', 'exited'].includes(item.state) &&
      ['setup-running', 'launching', 'provider-ready', 'prompt-delivered', 'running'].includes(item.dispatch.stage)).length;
    return { active, limit, available: active < limit };
  }

  pending(workspaceRoot) {
    const snapshot = this.store.snapshot();
    const now = Date.now();
    return Object.values(snapshot.tasks)
      .filter(task => task.dispatch && isRecoverable(task.dispatch))
      .filter(task => !task.dispatch.retryDisabled)
      .filter(task => !workspaceRoot || task.repoRoot === workspaceRoot)
      .filter(task => !task.dispatch.nextRetryAt || new Date(task.dispatch.nextRetryAt).getTime() <= now)
      .sort((a, b) => String(a.dispatch.requestedAt).localeCompare(String(b.dispatch.requestedAt)))
      .map(task => ({ task, blockedBy: this.blockedBy(task, snapshot.tasks) }));
  }

  claim(taskId, owner) {
    const snapshot = this.store.snapshot();
    const task = snapshot.tasks[taskId];
    if (!task || !task.dispatch) return { ok: false, error: 'Durable dispatch not found.' };
    if (!isRecoverable(task.dispatch)) return { ok: false, terminal: true, stage: task.dispatch.stage, task };
    if (!leaseExpired(task.dispatch) && task.dispatch.leaseId && task.dispatch.leaseOwner !== owner) {
      return { ok: false, busy: true, stage: task.dispatch.stage, leaseExpiresAt: task.dispatch.leaseExpiresAt };
    }

    const blockedBy = this.blockedBy(task, snapshot.tasks);
    const capacity = this.capacity(task, snapshot.tasks);
    let to = task.dispatch.stage;
    let action;
    if (blockedBy.length) {
      if (to === 'waiting-dependencies') return { ok: true, action: 'wait', leaseId: task.dispatch.leaseId, blockedBy, capacity, task };
      if (canTransition(to, 'waiting-dependencies')) to = 'waiting-dependencies';
      action = 'wait';
    } else if (!capacity.available) {
      if (to === 'waiting-capacity') return { ok: true, action: 'wait', leaseId: task.dispatch.leaseId, blockedBy, capacity, task };
      if (canTransition(to, 'waiting-capacity')) to = 'waiting-capacity';
      action = 'wait';
    } else if (task.dispatch.stage === 'provider-ready') action = task.dispatch.promptWriteId && !task.dispatch.promptAcknowledgedAt ? 'prompt-uncertain' : 'prompt';
    else if (task.dispatch.stage === 'prompt-delivered') action = 'finalize';
    else if (task.dispatch.stage === 'setup-running') action = 'setup';
    else if (task.dispatch.stage === 'launching') action = 'launch';
    else if (task.setupCommand && !task.dispatch.setupCompletedAt) {
      to = 'setup-running'; action = 'setup';
    } else {
      to = 'launching'; action = 'launch';
    }

    if (to === task.dispatch.stage && task.dispatch.leaseId && task.dispatch.leaseOwner === owner && !leaseExpired(task.dispatch)) {
      return { ok: true, action, leaseId: task.dispatch.leaseId, blockedBy, capacity, task };
    }

    const leaseId = crypto.randomUUID();
    const result = this.store.transitionDispatch(task.id, {
      expected: task.dispatch.stage,
      to,
      actor: owner,
      reason: action === 'wait' ? (blockedBy.length ? `Waiting for ${blockedBy.join(', ')}` : `Waiting for worker capacity (${capacity.active}/${capacity.limit})`) : `Claimed durable ${action} action`,
      patch: {
        leaseId,
        leaseOwner: owner,
        leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString(),
        attempt: task.dispatch.attempt + (action === 'wait' ? 0 : 1),
        nextRetryAt: '', retryDisabled: false,
        lastError: ''
      },
      taskPatch: action === 'wait' ? { state: 'waiting' } : { state: 'starting' }
    });
    if (!result.ok) return result;
    return { ok: true, action, leaseId, blockedBy, capacity, task: result.task };
  }

  transition(taskId, input = {}) {
    const snapshot = this.store.snapshot();
    const task = snapshot.tasks[taskId];
    if (!task || !task.dispatch) return { ok: false, error: 'Durable dispatch not found.' };
    if (input.leaseId && task.dispatch.leaseId && input.leaseId !== task.dispatch.leaseId) {
      return { ok: false, conflict: true, stage: task.dispatch.stage, error: 'Dispatch lease changed.' };
    }
    const patch = { ...(input.patch || {}) };
    if (!Object.hasOwn(patch, 'leaseExpiresAt') && (patch.leaseId || task.dispatch.leaseId)) {
      patch.leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    }
    return this.store.transitionDispatch(taskId, {
      expected: input.expected,
      to: input.to,
      actor: input.actor || 'renderer',
      reason: input.reason,
      patch,
      taskPatch: input.taskPatch
    });
  }

  fail(taskId, input = {}) {
    const task = this.store.snapshot().tasks[taskId];
    if (!task || !task.dispatch) return { ok: false, error: 'Durable dispatch not found.' };
    if (input.leaseId && task.dispatch.leaseId && input.leaseId !== task.dispatch.leaseId) {
      return { ok: false, conflict: true, stage: task.dispatch.stage, error: 'Dispatch lease changed.' };
    }
    const attempt = Math.max(1, task.dispatch.attempt || 1);
    const retryMs = Math.min(60_000, 2 ** Math.min(attempt, 6) * 1000);
    const retryDisabled = input.retry === false || attempt >= 5;
    return this.store.transitionDispatch(taskId, {
      expected: task.dispatch.stage,
      to: 'failed',
      actor: input.actor || 'renderer',
      reason: input.error || 'Dispatch failed',
      patch: {
        leaseId: '', leaseOwner: '', leaseExpiresAt: '',
        lastError: input.error || 'Dispatch failed',
        nextRetryAt: retryDisabled ? '' : new Date(Date.now() + retryMs).toISOString(), retryDisabled
      },
      taskPatch: { state: 'blocked' }
    });
  }

  retry(taskId, actor = 'user') {
    const task = this.store.snapshot().tasks[taskId];
    if (!task || !task.dispatch) return { ok: false, error: 'Durable dispatch not found.' };
    if (!['failed', 'blocked', 'waiting-dependencies', 'waiting-capacity'].includes(task.dispatch.stage)) return { ok: false, error: `Cannot retry ${task.dispatch.stage}.` };
    const blockedBy = this.blockedBy(task, this.store.state.tasks);
    const to = blockedBy.length ? 'waiting-dependencies' : (task.setupCommand && !task.dispatch.setupCompletedAt ? 'setup-running' : 'launching');
    return this.store.transitionDispatch(taskId, {
      expected: task.dispatch.stage, to, actor, reason: 'Manual retry',
      patch: { leaseId: '', leaseOwner: '', leaseExpiresAt: '', nextRetryAt: '', retryDisabled: false, lastError: '', promptWriteId: '', promptWrittenAt: '' },
      taskPatch: { state: blockedBy.length ? 'waiting' : 'starting' }
    });
  }

  cancel(taskId, actor = 'user') {
    const task = this.store.snapshot().tasks[taskId];
    if (!task || !task.dispatch) return { ok: false, error: 'Durable dispatch not found.' };
    if (task.dispatch.stage === 'cancelled') return { ok: true, task };
    return this.store.transitionDispatch(taskId, {
      expected: task.dispatch.stage, to: 'cancelled', actor, reason: 'Cancelled by operator',
      patch: { leaseId: '', leaseOwner: '', leaseExpiresAt: '', nextRetryAt: '' }, taskPatch: { state: 'blocked' }
    });
  }

  releaseLeases(ownerPrefix = 'renderer:') {
    const released = [];
    for (const task of Object.values(this.store.snapshot().tasks)) {
      if (!task.dispatch || !task.dispatch.leaseId || !task.dispatch.leaseOwner.startsWith(ownerPrefix)) continue;
      const result = this.store.transitionDispatch(task.id, {
        expected: task.dispatch.stage, to: task.dispatch.stage, actor: 'main:renderer-recovery',
        reason: `Released abandoned lease from ${task.dispatch.leaseOwner}`,
        patch: { leaseId: '', leaseOwner: '', leaseExpiresAt: '' }
      });
      if (result.ok) released.push(result.task);
    }
    return released;
  }
}

module.exports = { DispatchCoordinator };
