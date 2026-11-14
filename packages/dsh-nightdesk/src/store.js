import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractDeadline, isShanghaiDate, shanghaiDate, TIME_ZONE, utcInstant } from './dates.js';

export const SCHEMA_VERSION = 5;
const COMPLETIONS = new Set(['manual_complete', 'source_complete', 'conflicted']);
const REMINDER_STATUSES = new Set(['queued', 'retry', 'submitting', 'accepted', 'failed', 'canceled', 'unknown']);

function error(code, message) {
  return new Error(`${code} ${message}`);
}

function requireObject(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw error('INVALID_ARGS', 'arguments must be an object');
  }
}

function requiredString(args, field) {
  if (typeof args[field] !== 'string' || args[field].length === 0) {
    throw error('INVALID_ARGS', `${field} must be a non-empty string`);
  }
}

function optionalString(args, field) {
  if (args[field] !== undefined && typeof args[field] !== 'string') {
    throw error('INVALID_ARGS', `${field} must be a string`);
  }
}

function requiredVersion(args) {
  if (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 1) {
    throw error('INVALID_ARGS', 'expectedVersion must be a positive integer');
  }
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toItem(row) {
  if (!row) return null;
  return {
    itemId: row.id,
    observationId: row.observation_id,
    title: row.title,
    dueDate: row.due_date,
    dueAt: row.due_at,
    timeZone: row.time_zone,
    precision: row.precision,
    timeStatus: row.time_status,
    completion: row.completion,
    confirmed: Boolean(row.confirmed),
    needsConfirmation: !row.confirmed,
    version: row.version,
    matchedText: row.matched_text ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function maskExternalId(value) {
  const text = String(value ?? '');
  if (text.length <= 7) return `${text.slice(0, 3)}***`;
  return `${text.slice(0, 3)}***${text.slice(-4)}`;
}

function toBinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    channel: row.channel,
    appId: row.app_id,
    externalId: maskExternalId(row.external_id),
    displayName: row.display_name,
    boundAt: row.bound_at,
    lastVerifiedAt: row.last_verified_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProbe(row) {
  if (!row) return null;
  let capabilities = [];
  try { capabilities = JSON.parse(row.capabilities); } catch { capabilities = []; }
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    capabilities,
    hostVersion: row.host_version,
    pluginVersion: row.plugin_version,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function toWatchedSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    sessionId: row.session_id,
    label: row.label,
    addedAt: row.added_at,
    lastReadAt: row.last_read_at,
    lastSeq: row.last_seq,
    lastEventAt: row.last_event_at,
    lastEventType: row.last_event_type,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function splitSegments(text) {
  const segments = text.split(/[\r\n。！？!?；;]+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return segments.length > 0 ? segments : [text];
}

export class NightDeskStore {
  constructor(options = {}) {
    this.dataDir = options.dataDir ?? process.env.NIGHTDESK_DATA_DIR ?? join(homedir(), '.dsh', 'nightdesk-data');
    this.dbPath = join(this.dataDir, 'nightdesk.db');
    this.ownerId = options.ownerId ?? process.env.NIGHTDESK_OWNER ?? 'local';
    this.closed = false;
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    try {
      this.migrate();
    } catch (cause) {
      this.close();
      throw cause;
    }
  }

  migrate() {
    this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get()) {
        const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
        if (version !== undefined && !['1', '2', '3', '4', '5'].includes(version)) {
          throw error('INVALID_ARGS', `schema_version unsupported: ${version}`);
        }
      }
      // Version 1 used this name for an index, not a consumer cursor table.
      if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'outbox_event_handler'").get()) {
        this.db.exec('DROP INDEX outbox_event_handler');
      }
      this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
      INSERT INTO meta(key, value) VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;
      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        source_id TEXT,
        source_label TEXT,
        raw_text TEXT,
        content_hash TEXT,
        occurred_at TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        owner_id TEXT,
        observation_id TEXT,
        title TEXT,
        due_at TEXT,
        due_date TEXT,
        time_zone TEXT,
        precision TEXT,
        time_status TEXT,
        completion TEXT,
        confirmed INTEGER,
        version INTEGER,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS item_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id TEXT,
        version INTEGER,
        snapshot_json TEXT,
        changed_at TEXT,
        reason TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY,
        event_id TEXT,
        handler_id TEXT,
        type TEXT,
        payload_json TEXT,
        status TEXT,
        attempts INTEGER,
        available_at TEXT,
        created_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_event_dedupe
        ON outbox(event_id, handler_id);
      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        at TEXT,
        actor TEXT,
        action TEXT,
        item_id TEXT,
        detail_json TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        scope TEXT,
        request_hash TEXT,
        response_json TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, item_id TEXT NOT NULL,
        item_version INTEGER NOT NULL, kind TEXT NOT NULL,
        due_at TEXT NOT NULL, scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT, accepted_at TEXT, delivered_at TEXT,
        canceled_at TEXT, cancel_reason TEXT, channel TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS notifications_unique
        ON notifications(owner_id, item_id, item_version, kind);
      CREATE INDEX IF NOT EXISTS notifications_due
        ON notifications(status, next_attempt_at, scheduled_at);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY, notification_id TEXT NOT NULL, attempt INTEGER NOT NULL,
        channel TEXT NOT NULL, status TEXT NOT NULL, http_status INTEGER,
        channel_message_id TEXT, error_detail TEXT, started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS deliveries_notification_attempt
        ON deliveries(notification_id, attempt);
      CREATE TABLE IF NOT EXISTS outbox_event_handler (
        event_id TEXT NOT NULL, handler_id TEXT NOT NULL,
        processed_at TEXT NOT NULL,
        PRIMARY KEY(event_id, handler_id)
      );
      CREATE TABLE IF NOT EXISTS channel_bindings (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, channel TEXT NOT NULL,
        app_id TEXT, external_id TEXT NOT NULL, display_name TEXT,
        bound_at TEXT NOT NULL, last_verified_at TEXT, last_error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS channel_bindings_unique
        ON channel_bindings(owner_id, channel, app_id, external_id);
      CREATE TABLE IF NOT EXISTS probes (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, kind TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT,
        status TEXT NOT NULL,
        capabilities TEXT NOT NULL,
        host_version TEXT, plugin_version TEXT,
        notes TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS probes_owner_kind_started
        ON probes(owner_id, kind, started_at DESC);
      CREATE TABLE IF NOT EXISTS watched_sessions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
        label TEXT, added_at TEXT NOT NULL, last_read_at TEXT, last_seq INTEGER,
        last_event_at TEXT, last_event_type TEXT,
        status TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS watched_sessions_unique
        ON watched_sessions(owner_id, session_id);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        inputs_json TEXT NOT NULL,
        allowed_tools_json TEXT NOT NULL,
        scope TEXT,
        completion_rule TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        budget_json TEXT NOT NULL,
        goal_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_attempts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        goal_version INTEGER NOT NULL,
        input_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1,
        draft_text TEXT,
        resources_json TEXT,
        submitted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (task_id, attempt_no)
      );
      CREATE TABLE IF NOT EXISTS task_reviews (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        round INTEGER NOT NULL,
        verdict TEXT NOT NULL,
        structure_ok INTEGER NOT NULL,
        evidence_ok INTEGER NOT NULL,
        content_ok INTEGER NOT NULL,
        findings_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_artifacts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS task_attempts_current ON task_attempts(task_id, is_current);
      UPDATE meta SET value = '5' WHERE key = 'schema_version' AND value IN ('1', '2', '3', '4', '5');
    `);
    const migrationAt = new Date().toISOString();
    const legacyItems = this.db.prepare(`SELECT i.* FROM items i
      WHERE i.owner_id IS NOT NULL AND i.confirmed = 1 AND i.completion = 'unconfirmed'
        AND i.time_status NOT IN ('canceled', 'unknown', 'ambiguous') AND i.due_at IS NOT NULL`).all();
    const backfill = this.db.prepare(`INSERT OR IGNORE INTO notifications
      (id, owner_id, item_id, item_version, kind, due_at, scheduled_at, status,
       attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'due', ?, ?, 'queued', 0, ?, ?, ?)`);
    for (const item of legacyItems) {
      backfill.run(randomUUID(), item.owner_id, item.id, item.version, item.due_at,
        item.due_at, item.due_at, migrationAt, migrationAt);
    }
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
    if (Number(row.value) !== SCHEMA_VERSION) {
      throw error('INVALID_ARGS', `schema_version unsupported: ${row.value}`);
    }
    });
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.db.exec('COMMIT');
      return value;
    } catch (cause) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // Preserve the original business error if rollback itself fails.
      }
      throw cause;
    }
  }

  health() {
    return {
      ok: true,
      pluginVersion: '0.1.0',
      schemaVersion: SCHEMA_VERSION,
      dataDir: this.dataDir,
      dbPath: this.dbPath,
      timeZone: TIME_ZONE,
      nowUtc: new Date().toISOString(),
      counts: {
        observations: this.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE owner_id = ?').get(this.ownerId).count,
        items: this.db.prepare('SELECT COUNT(*) AS count FROM items WHERE owner_id = ?').get(this.ownerId).count,
        outboxPending: this.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'pending'").get().count,
      },
      readOnly: false,
    };
  }

  capture(args) {
    requireObject(args);
    requiredString(args, 'text');
    optionalString(args, 'sourceLabel');
    optionalString(args, 'sourceId');
    optionalString(args, 'occurredAt');
    optionalString(args, 'idempotencyKey');
    if (args.occurredAt !== undefined && (typeof args.occurredAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(args.occurredAt)
      || Number.isNaN(new Date(args.occurredAt).getTime()))) {
      throw error('INVALID_ARGS', 'occurredAt must be RFC3339');
    }
    const requestHash = hash(canonical({ ...args, idempotencyKey: undefined }));
    if (args.idempotencyKey) {
      const replay = this.db.prepare('SELECT request_hash, response_json FROM idempotency WHERE key = ? AND scope = ?')
        .get(args.idempotencyKey, `capture:${this.ownerId}`);
      if (replay) {
        if (replay.request_hash !== requestHash) {
          throw error('IDEMPOTENCY_CONFLICT', 'idempotencyKey was used with a different body');
        }
        return JSON.parse(replay.response_json);
      }
    }
    return this.transaction(() => {
      if (args.idempotencyKey) {
        const replay = this.db.prepare('SELECT request_hash, response_json FROM idempotency WHERE key = ? AND scope = ?')
          .get(args.idempotencyKey, `capture:${this.ownerId}`);
        if (replay) {
          if (replay.request_hash !== requestHash) throw error('IDEMPOTENCY_CONFLICT', 'idempotencyKey was used with a different body');
          return JSON.parse(replay.response_json);
        }
      }
      const createdAt = new Date().toISOString();
      const observationId = randomUUID();
      this.db.prepare(`INSERT INTO observations
        (id, owner_id, source_id, source_label, raw_text, content_hash, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        observationId,
        this.ownerId,
        args.sourceId ?? null,
        args.sourceLabel ?? 'manual',
        args.text,
        hash(args.text),
        args.occurredAt ? new Date(args.occurredAt).toISOString() : createdAt,
        createdAt,
      );
      const candidates = splitSegments(args.text).map((title) => {
        const deadline = extractDeadline(title, createdAt);
        const itemId = randomUUID();
        const item = {
          id: itemId,
          owner_id: this.ownerId,
          observation_id: observationId,
          title,
          due_at: null,
          due_date: deadline.dueDate,
          time_zone: TIME_ZONE,
          precision: deadline.precision,
          time_status: deadline.timeStatus,
          completion: 'unconfirmed',
          confirmed: 0,
          version: 1,
          matched_text: deadline.matchedText,
          created_at: createdAt,
          updated_at: createdAt,
        };
        this.insertItem(item, createdAt, 'capture');
        return {
          itemId,
          title,
          dueDate: deadline.dueDate,
          dueAt: deadline.dueAt,
          timeStatus: deadline.timeStatus,
          precision: deadline.precision,
          matchedText: deadline.matchedText,
          needsConfirmation: true,
          version: 1,
        };
      });
      const response = {
        observationId,
        candidates,
        totals: { observations: 1, candidates: candidates.length },
      };
      if (args.idempotencyKey) {
        this.db.prepare('INSERT INTO idempotency(key, scope, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(args.idempotencyKey, `capture:${this.ownerId}`, requestHash, JSON.stringify(response), createdAt);
      }
      return response;
    });
  }

  insertItem(item, at, reason) {
    this.db.prepare(`INSERT INTO items
      (id, owner_id, observation_id, title, due_at, due_date, time_zone, precision,
       time_status, completion, confirmed, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      item.id, item.owner_id, item.observation_id, item.title, item.due_at, item.due_date,
      item.time_zone, item.precision, item.time_status, item.completion, item.confirmed,
      item.version, item.created_at, item.updated_at,
    );
    // matchedText is response metadata, kept in version snapshots rather than changing the specified table.
    this.appendVersion(item, at, reason);
  }

  appendVersion(item, at, reason) {
    this.db.prepare('INSERT INTO item_versions(item_id, version, snapshot_json, changed_at, reason) VALUES (?, ?, ?, ?, ?)')
      .run(item.id, item.version, JSON.stringify(item), at, reason);
  }

  items(args = {}) {
    requireObject(args);
    const view = args.view ?? 'today';
    const includeUnconfirmed = args.includeUnconfirmed ?? true;
    const limit = args.limit ?? 50;
    if (!['today', 'pending', 'all'].includes(view)) throw error('INVALID_ARGS', 'view must be today, pending, or all');
    if (typeof includeUnconfirmed !== 'boolean') throw error('INVALID_ARGS', 'includeUnconfirmed must be a boolean');
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw error('INVALID_ARGS', 'limit must be an integer from 1 to 100');
    const asOfUtc = new Date().toISOString();
    const today = shanghaiDate(asOfUtc);
    const clauses = ['owner_id = ?'];
    const params = [this.ownerId];
    if (view === 'today') {
      clauses.push('(due_date = ? OR substr(due_at, 1, 10) = ?)');
      params.push(today, today);
    }
    if (view === 'pending') clauses.push("completion = 'unconfirmed'");
    if (!includeUnconfirmed) clauses.push('confirmed = 1');
    const where = clauses.join(' AND ');
    const items = this.db.prepare(`SELECT * FROM items WHERE ${where} ORDER BY due_date IS NULL, due_date, created_at`)
      .all(...params).filter((row) => view !== 'today' || row.due_date === today || isShanghaiDate(row.due_at, today))
      .slice(0, limit).map(toItem);
    return {
      view,
      asOfUtc,
      readScope: { timeZone: TIME_ZONE, limit },
      items,
      counts: { returned: items.length, today: this.db.prepare('SELECT * FROM items WHERE owner_id = ? AND (due_date = ? OR due_at IS NOT NULL)')
        .all(this.ownerId, today).filter((row) => row.due_date === today || isShanghaiDate(row.due_at, today)).length },
    };
  }

  reminders(args = {}) {
    requireObject(args);
    optionalString(args, 'status');
    const status = args.status ?? null;
    const limit = args.limit ?? 50;
    if (status !== null && !REMINDER_STATUSES.has(status)) {
      throw error('INVALID_ARGS', 'status is not a supported notification state');
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw error('INVALID_ARGS', 'limit must be an integer from 1 to 100');
    }
    const notifications = this.db.prepare(`SELECT * FROM notifications WHERE owner_id = ?
      ${status === null ? '' : 'AND status = ?'}
      ORDER BY scheduled_at, created_at, id LIMIT ?`)
      .all(...(status === null ? [this.ownerId, limit] : [this.ownerId, status, limit]));
    return {
      notifications: notifications.map((row) => ({
        id: row.id,
        itemId: row.item_id,
        itemVersion: row.item_version,
        kind: row.kind,
        dueAt: row.due_at,
        scheduledAt: row.scheduled_at,
        nextAttemptAt: row.next_attempt_at,
        status: row.status,
        attempts: row.attempts,
        acceptedAt: row.accepted_at,
        deliveredAt: row.delivered_at,
        canceledAt: row.canceled_at,
        cancelReason: row.cancel_reason,
        channel: row.channel,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      count: notifications.length,
    };
  }

  remind(args = {}) {
    requireObject(args);
    requiredString(args, 'itemId');
    optionalString(args, 'kind');
    if (args.dueAt !== undefined) utcInstant(args.dueAt);
    if (args.kind !== undefined && args.kind.length === 0) throw error('INVALID_ARGS', 'kind must be non-empty');
    if (typeof this.onReminderRequested !== 'function') throw error('INVALID_ARGS', 'scheduler is unavailable');
    return this.transaction(() => {
      const item = this.ownedItem(args.itemId);
      if (!item) throw error('INVALID_ARGS', 'itemId not found');
      if (!item.confirmed || item.completion !== 'unconfirmed' || item.time_status === 'canceled') {
        throw error('INVALID_ARGS', 'item must be confirmed, uncompleted and not canceled');
      }
      const dueAt = args.dueAt ?? item.due_at;
      if (dueAt === null) throw error('INVALID_ARGS', 'dueAt is required when the item has no instant deadline');
      return this.onReminderRequested(item, utcInstant(dueAt), args.kind ?? 'due');
    });
  }

  recordAudit(action, itemId, at, detail = {}) {
    this.db.prepare('INSERT INTO audit_events(id, at, actor, action, item_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), at, this.ownerId, action, itemId, JSON.stringify(detail));
  }

  ownedItem(itemId) {
    return this.db.prepare('SELECT * FROM items WHERE id = ? AND owner_id = ?').get(itemId, this.ownerId);
  }

  listItemsForOverview(args = {}) {
    requireObject(args);
    const ownerId = args.ownerId ?? this.ownerId;
    requiredString({ ownerId }, 'ownerId');
    return this.db.prepare(`SELECT * FROM items WHERE owner_id = ?
      ORDER BY updated_at, id`).all(ownerId).map(toItem);
  }

  confirm(args) {
    requireObject(args);
    requiredString(args, 'itemId');
    requiredVersion(args);
    for (const field of ['dueDate', 'dueAt', 'title']) optionalString(args, field);
    if (args.timeStatus !== undefined && !['resolved', 'unknown', 'ambiguous'].includes(args.timeStatus)) {
      throw error('INVALID_ARGS', 'timeStatus must be resolved, unknown, or ambiguous');
    }
    if (args.dueDate !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(args.dueDate)
      || shanghaiDate(`${args.dueDate}T00:00:00+08:00`) !== args.dueDate)) {
      throw error('INVALID_ARGS', 'dueDate must be a valid YYYY-MM-DD');
    }
    if (args.dueAt !== undefined) utcInstant(args.dueAt);
    if (args.title !== undefined && args.title.length === 0) throw error('INVALID_ARGS', 'title must be non-empty');
    const current = this.ownedItem(args.itemId);
    if (!current || current.version !== args.expectedVersion) {
      throw error('VERSION_CONFLICT', `itemId ${args.itemId}; currentVersion ${current?.version ?? 'not-found'}`);
    }
    const at = new Date().toISOString();
    const dueAt = args.dueAt === undefined ? current.due_at : utcInstant(args.dueAt);
    const dueDate = args.dueDate ?? (args.dueAt !== undefined ? shanghaiDate(dueAt) : current.due_date);
    const timeStatus = args.timeStatus ?? current.time_status;
    const precision = args.dueAt !== undefined ? 'instant' : args.dueDate !== undefined ? 'day' : current.precision;
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE items SET title = ?, due_at = ?, due_date = ?, precision = ?,
        time_status = ?, confirmed = 1, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND owner_id = ?`)
        .run(args.title ?? current.title, dueAt, dueDate, precision, timeStatus, at, args.itemId, args.expectedVersion, this.ownerId);
      if (changed.changes !== 1) {
        const latest = this.ownedItem(args.itemId);
        throw error('VERSION_CONFLICT', `itemId ${args.itemId}; currentVersion ${latest?.version ?? 'not-found'}`);
      }
      const updated = this.ownedItem(args.itemId);
      this.appendVersion(updated, at, 'confirm');
      this.recordEvent('nightdesk.confirm', 'item.confirmed', updated, at);
      this.onItemChanged?.(updated, updated.due_at, 'due');
      return toItem(updated);
    });
  }

  complete(args) {
    requireObject(args);
    requiredString(args, 'itemId');
    requiredVersion(args);
    const completion = args.completion ?? 'manual_complete';
    if (!COMPLETIONS.has(completion)) throw error('INVALID_ARGS', 'completion is not a supported completion state');
    const current = this.ownedItem(args.itemId);
    if (!current || current.version !== args.expectedVersion) {
      throw error('VERSION_CONFLICT', `itemId ${args.itemId}; currentVersion ${current?.version ?? 'not-found'}`);
    }
    if (current.time_status === 'canceled') throw error('INVALID_ARGS', 'itemId is canceled and cannot be completed');
    const at = new Date().toISOString();
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE items SET completion = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND owner_id = ?`).run(completion, at, args.itemId, args.expectedVersion, this.ownerId);
      if (changed.changes !== 1) {
        const latest = this.ownedItem(args.itemId);
        throw error('VERSION_CONFLICT', `itemId ${args.itemId}; currentVersion ${latest?.version ?? 'not-found'}`);
      }
      const updated = this.ownedItem(args.itemId);
      this.appendVersion(updated, at, 'complete');
      this.recordEvent('nightdesk.complete', 'item.completed', updated, at);
      this.onItemChanged?.(updated, null, 'due');
      return toItem(updated);
    });
  }

  recordEvent(action, type, item, at) {
    this.db.prepare('INSERT INTO audit_events(id, at, actor, action, item_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), at, this.ownerId, action, item.id, JSON.stringify({ version: item.version }));
    const eventId = randomUUID();
    this.db.prepare(`INSERT INTO outbox(id, event_id, handler_id, type, payload_json, status, attempts, available_at, created_at)
      VALUES (?, ?, NULL, ?, ?, 'pending', 0, ?, ?)`).run(
      randomUUID(), eventId, type, JSON.stringify({ itemId: item.id, version: item.version }), at, at,
    );
  }

  recordProbe(record) {
    requireObject(record);
    requiredString(record, 'kind');
    requiredString(record, 'startedAt');
    requiredString(record, 'status');
    if (!['pass', 'partial', 'fail'].includes(record.status)) throw error('INVALID_ARGS', 'probe status is unsupported');
    if (!Array.isArray(record.capabilities)) throw error('INVALID_ARGS', 'probe capabilities must be an array');
    const createdAt = record.createdAt ?? new Date().toISOString();
    const row = {
      id: record.id ?? randomUUID(),
      ownerId: this.ownerId,
      kind: record.kind,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt ?? null,
      status: record.status,
      capabilities: JSON.stringify(record.capabilities),
      hostVersion: record.hostVersion ?? null,
      pluginVersion: record.pluginVersion ?? null,
      notes: record.notes ?? null,
      createdAt,
    };
    this.db.prepare(`INSERT INTO probes
      (id, owner_id, kind, started_at, finished_at, status, capabilities,
       host_version, plugin_version, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.id, row.ownerId, row.kind, row.startedAt, row.finishedAt, row.status,
      row.capabilities, row.hostVersion, row.pluginVersion, row.notes, row.createdAt,
    );
    return toProbe(this.db.prepare('SELECT * FROM probes WHERE id = ? AND owner_id = ?').get(row.id, this.ownerId));
  }

  latestProbe(kind) {
    if (kind !== undefined && (typeof kind !== 'string' || kind.length === 0)) throw error('INVALID_ARGS', 'kind must be a non-empty string');
    const row = this.db.prepare(`SELECT * FROM probes WHERE owner_id = ?
      ${kind === undefined ? '' : 'AND kind = ?'}
      ORDER BY started_at DESC, created_at DESC, id DESC LIMIT 1`)
      .get(...(kind === undefined ? [this.ownerId] : [this.ownerId, kind]));
    return toProbe(row);
  }

  listProbes(args = {}) {
    requireObject(args);
    optionalString(args, 'kind');
    if (args.kind !== undefined && args.kind.length === 0) throw error('INVALID_ARGS', 'kind must be a non-empty string');
    const limit = args.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw error('INVALID_ARGS', 'limit must be an integer from 1 to 100');
    }
    return this.db.prepare(`SELECT * FROM probes WHERE owner_id = ?
      ${args.kind === undefined ? '' : 'AND kind = ?'}
      ORDER BY started_at DESC, created_at DESC, id DESC LIMIT ?`)
      .all(...(args.kind === undefined ? [this.ownerId, limit] : [this.ownerId, args.kind, limit]))
      .map(toProbe);
  }

  bindChannel(args = {}) {
    requireObject(args);
    requiredString(args, 'channel');
    requiredString(args, 'appId');
    requiredString(args, 'externalId');
    optionalString(args, 'displayName');
    const at = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`INSERT INTO channel_bindings
      (id, owner_id, channel, app_id, external_id, display_name, bound_at,
       last_verified_at, last_error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(owner_id, channel, app_id, external_id) DO UPDATE SET
        display_name = excluded.display_name, updated_at = excluded.updated_at`).run(
      id, this.ownerId, args.channel, args.appId, args.externalId, args.displayName ?? null,
      at, at, at,
    );
    return toBinding(this.db.prepare(`SELECT * FROM channel_bindings
      WHERE owner_id = ? AND channel = ? AND app_id = ? AND external_id = ?`)
      .get(this.ownerId, args.channel, args.appId, args.externalId));
  }

  channelBindings() {
    return this.db.prepare(`SELECT * FROM channel_bindings WHERE owner_id = ?
      ORDER BY bound_at DESC, created_at DESC, id DESC`).all(this.ownerId).map(toBinding);
  }

  findChannelBinding({ channel, appId, externalId } = {}) {
    return this.db.prepare(`SELECT * FROM channel_bindings
      WHERE owner_id = ? AND channel = ? AND app_id = ?
      ${externalId === undefined ? '' : 'AND external_id = ?'}
      ORDER BY bound_at DESC, created_at DESC, id DESC LIMIT 1`)
      .get(...(externalId === undefined
        ? [this.ownerId, channel, appId]
        : [this.ownerId, channel, appId, externalId])) ?? null;
  }

  verifyBinding(id, at = new Date().toISOString()) {
    requiredString({ id }, 'id');
    requiredString({ at }, 'at');
    this.db.prepare(`UPDATE channel_bindings SET last_verified_at = ?, last_error = NULL,
      updated_at = ? WHERE id = ? AND owner_id = ?`).run(at, at, id, this.ownerId);
    return toBinding(this.db.prepare('SELECT * FROM channel_bindings WHERE id = ? AND owner_id = ?').get(id, this.ownerId));
  }

  watchSession(args = {}) {
    requireObject(args);
    const ownerId = args.ownerId ?? this.ownerId;
    requiredString({ ownerId }, 'ownerId');
    requiredString(args, 'sessionId');
    optionalString(args, 'label');
    const at = args.at ?? new Date().toISOString();
    requiredString({ at }, 'at');
    this.db.prepare(`INSERT INTO watched_sessions
      (id, owner_id, session_id, label, added_at, last_read_at, last_seq,
       last_event_at, last_event_type, status, error, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      ON CONFLICT(owner_id, session_id) DO UPDATE SET
        label = excluded.label, updated_at = excluded.updated_at`).run(
      randomUUID(), ownerId, args.sessionId, args.label ?? null, at, at, at,
    );
    return toWatchedSession(this.db.prepare(`SELECT * FROM watched_sessions
      WHERE owner_id = ? AND session_id = ?`).get(ownerId, args.sessionId));
  }

  unwatchSession(args = {}) {
    requireObject(args);
    const ownerId = args.ownerId ?? this.ownerId;
    requiredString({ ownerId }, 'ownerId');
    requiredString(args, 'sessionId');
    const result = this.db.prepare('DELETE FROM watched_sessions WHERE owner_id = ? AND session_id = ?')
      .run(ownerId, args.sessionId);
    return { removed: result.changes === 1 };
  }

  listWatchedSessions(args = {}) {
    requireObject(args);
    const ownerId = args.ownerId ?? this.ownerId;
    requiredString({ ownerId }, 'ownerId');
    return this.db.prepare(`SELECT * FROM watched_sessions WHERE owner_id = ?
      ORDER BY added_at, created_at, id`).all(ownerId).map(toWatchedSession);
  }

  updateWatchedSession(args = {}) {
    requireObject(args);
    const ownerId = args.ownerId ?? this.ownerId;
    requiredString({ ownerId }, 'ownerId');
    requiredString(args, 'sessionId');
    requiredString(args, 'lastReadAt');
    if (args.lastSeq !== null && args.lastSeq !== undefined && !Number.isInteger(args.lastSeq)) {
      throw error('INVALID_ARGS', 'lastSeq must be an integer or null');
    }
    for (const field of ['lastEventAt', 'lastEventType', 'status', 'error']) {
      if (args[field] !== undefined && args[field] !== null && typeof args[field] !== 'string') {
        throw error('INVALID_ARGS', `${field} must be a string or null`);
      }
    }
    const updatedAt = args.updatedAt ?? args.lastReadAt;
    requiredString({ updatedAt }, 'updatedAt');
    const changed = this.db.prepare(`UPDATE watched_sessions SET
      last_read_at = ?, last_seq = ?, last_event_at = ?, last_event_type = ?,
      status = ?, error = ?, updated_at = ?
      WHERE owner_id = ? AND session_id = ?`).run(
      args.lastReadAt,
      args.lastSeq ?? null,
      args.lastEventAt ?? null,
      args.lastEventType ?? null,
      args.status ?? null,
      args.error ?? null,
      updatedAt,
      ownerId,
      args.sessionId,
    );
    if (changed.changes !== 1) return null;
    return toWatchedSession(this.db.prepare(`SELECT * FROM watched_sessions
      WHERE owner_id = ? AND session_id = ?`).get(ownerId, args.sessionId));
  }
}
