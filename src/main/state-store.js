const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeTask } = require('../shared/validation');
const { assertTransition, normalizeDispatch } = require('../shared/dispatch-lifecycle');

const CURRENT_VERSION = 3;
const EMPTY = { version: CURRENT_VERSION, workspaces: {}, tasks: {}, layoutByWorkspace: {}, settings: {} };

function parse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

class StateStore {
  constructor(file, options = {}) {
    this.file = file;
    this.legacyFile = options.legacyFile || (file.endsWith('.db') ? file.replace(/\.db$/, '.json') : null);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(file), 0o700);
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.migrate();
    this.state = this.readAll();
    this.importLegacyIfEmpty();
    for (const suffix of ['', '-wal', '-shm']) { const candidate = `${file}${suffix}`; if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600); }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (root TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS layouts (workspace TEXT PRIMARY KEY, layout TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
    const version = row ? Number(row.value) : 0;
    if (version < 1) this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','1')").run();
    if (version < 2) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(json_extract(data, '$.updatedAt'));");
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version','2')").run();
    }
    if (version < 3) {
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_dispatch_stage ON tasks(json_extract(data, '$.dispatch.stage'));");
      this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(CURRENT_VERSION));
    }
  }

  readAll() {
    const state = structuredClone(EMPTY);
    for (const row of this.db.prepare('SELECT root,data FROM workspaces').all()) state.workspaces[row.root] = parse(row.data, {});
    for (const row of this.db.prepare('SELECT id,data FROM tasks').all()) state.tasks[row.id] = parse(row.data, {});
    for (const row of this.db.prepare('SELECT workspace,layout FROM layouts').all()) state.layoutByWorkspace[row.workspace] = row.layout;
    for (const row of this.db.prepare('SELECT key,value FROM settings').all()) state.settings[row.key] = parse(row.value, row.value);
    return state;
  }

  importLegacyIfEmpty() {
    if (Object.keys(this.state.tasks).length || Object.keys(this.state.workspaces).length || !this.legacyFile) return;
    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(this.legacyFile, 'utf8')); } catch { return; }
    this.state = { ...structuredClone(EMPTY), ...legacy, version: CURRENT_VERSION };
    this.flush();
    this.setSetting('legacyMigration', { from: this.legacyFile, at: new Date().toISOString(), schema: CURRENT_VERSION });
  }

  load() { this.state = this.readAll(); return this.snapshot(); }
  snapshot() { this.state = this.readAll(); return structuredClone(this.state); }

  flush() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DELETE FROM workspaces; DELETE FROM tasks; DELETE FROM layouts; DELETE FROM settings;');
      const workspace = this.db.prepare('INSERT INTO workspaces(root,data) VALUES(?,?)');
      const task = this.db.prepare('INSERT INTO tasks(id,data) VALUES(?,?)');
      const layout = this.db.prepare('INSERT INTO layouts(workspace,layout) VALUES(?,?)');
      const setting = this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)');
      for (const [root, value] of Object.entries(this.state.workspaces)) workspace.run(root, JSON.stringify(value));
      for (const [id, value] of Object.entries(this.state.tasks)) task.run(id, JSON.stringify(value));
      for (const [key, value] of Object.entries(this.state.layoutByWorkspace)) layout.run(key, value);
      for (const [key, value] of Object.entries(this.state.settings)) setting.run(key, JSON.stringify(value));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  upsertWorkspace(root, patch = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM workspaces WHERE root=?').get(root);
      const current = row ? parse(row.data, {}) : { root, createdAt: new Date().toISOString() };
      const value = { ...current, ...patch, root, updatedAt: new Date().toISOString() };
      this.db.prepare('INSERT OR REPLACE INTO workspaces(root,data) VALUES(?,?)').run(root, JSON.stringify(value));
      this.db.exec('COMMIT'); this.state.workspaces[root] = value; return structuredClone(value);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  removeWorkspace(root) {
    const row = this.db.prepare('SELECT data FROM workspaces WHERE root=?').get(root);
    const previous = row ? parse(row.data, null) : null;
    this.db.prepare('DELETE FROM workspaces WHERE root=?').run(root); delete this.state.workspaces[root]; return previous;
  }

  upsertTask(input) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = input.id ? this.db.prepare('SELECT data FROM tasks WHERE id=?').get(input.id) : null;
      const previous = row ? parse(row.data, {}) : {};
      const task = normalizeTask({ ...previous, ...input, createdAt: previous.createdAt || input.createdAt });
      this.db.prepare('INSERT OR REPLACE INTO tasks(id,data) VALUES(?,?)').run(task.id, JSON.stringify(task));
      this.db.exec('COMMIT'); this.state.tasks[task.id] = task; return structuredClone(task);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  patchTask(id, patch) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
      if (!row) throw new Error('Task not found.');
      const previous = parse(row.data, {});
      const task = normalizeTask({ ...previous, ...patch, id, createdAt: previous.createdAt });
      this.db.prepare('INSERT OR REPLACE INTO tasks(id,data) VALUES(?,?)').run(id, JSON.stringify(task));
      this.db.exec('COMMIT'); this.state.tasks[id] = task; return structuredClone(task);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  appendTaskAudit(id, entry = {}, patch = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
      if (!row) throw new Error('Task not found.');
      const previous = parse(row.data, {}); const at = entry.at || new Date().toISOString();
      const audit = [...(previous.audit || []), {
        id: entry.id || `audit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        type: String(entry.type || 'event').slice(0, 80), actor: String(entry.actor || 'clide').slice(0, 160),
        reason: String(entry.reason || '').slice(0, 1000), at
      }].slice(-500);
      const task = normalizeTask({ ...previous, ...patch, id, audit, createdAt: previous.createdAt });
      this.db.prepare('INSERT OR REPLACE INTO tasks(id,data) VALUES(?,?)').run(id, JSON.stringify(task));
      this.db.exec('COMMIT'); this.state.tasks[id] = task; return structuredClone(task);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }

  transitionDispatch(id, transition = {}) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id);
      if (!row) throw new Error('Task not found.');
      const previous = parse(row.data, {});
      const current = normalizeDispatch(previous.dispatch);
      if (!current) throw new Error('Task has no durable dispatch.');
      const expected = Array.isArray(transition.expected) ? transition.expected : [transition.expected].filter(Boolean);
      if (expected.length && !expected.includes(current.stage)) {
        this.db.exec('ROLLBACK');
        return { ok: false, conflict: true, stage: current.stage, task: normalizeTask(previous) };
      }
      const to = transition.to || current.stage;
      assertTransition(current.stage, to);
      const at = new Date().toISOString();
      const dispatch = normalizeDispatch({
        ...current,
        ...(transition.patch || {}),
        stage: to,
        revision: current.revision + 1,
        updatedAt: at,
        lastActor: transition.actor || 'clide'
      });
      const audit = [...(previous.audit || []), {
        id: transition.eventId || `dispatch-${id}-${dispatch.revision}`,
        type: 'dispatch-transition',
        from: current.stage,
        to,
        actor: dispatch.lastActor,
        reason: String(transition.reason || '').slice(0, 1000),
        at
      }].slice(-500);
      const task = normalizeTask({ ...previous, ...(transition.taskPatch || {}), id, dispatch, audit, createdAt: previous.createdAt });
      this.db.prepare('INSERT OR REPLACE INTO tasks(id,data) VALUES(?,?)').run(id, JSON.stringify(task));
      this.db.exec('COMMIT');
      this.state.tasks[id] = task;
      return { ok: true, task: structuredClone(task), dispatch: structuredClone(dispatch) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  removeTask(id) {
    const row = this.db.prepare('SELECT data FROM tasks WHERE id=?').get(id); if (!row) return null;
    const task = parse(row.data, null); this.db.prepare('DELETE FROM tasks WHERE id=?').run(id); delete this.state.tasks[id]; return structuredClone(task);
  }

  listTasks(workspace) {
    this.state = this.readAll();
    return Object.values(this.state.tasks)
      .filter(task => !workspace || task.repoRoot === workspace || task.worktree === workspace)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(value => structuredClone(value));
  }

  setLayout(workspace, layout) {
    this.db.prepare('INSERT OR REPLACE INTO layouts(workspace,layout) VALUES(?,?)').run(workspace, layout);
    this.state.layoutByWorkspace[workspace] = layout; return layout;
  }

  setSetting(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key, JSON.stringify(value));
    this.state.settings[key] = value; return value;
  }

  close() { try { this.db.close(); } catch {} }
}

module.exports = { StateStore, EMPTY, CURRENT_VERSION };
