import { randomUUID } from 'node:crypto';
import { utcInstant } from './dates.js';

const RETRY_DELAYS_MS = [10_000, 30_000, 120_000];
const MAX_ATTEMPTS = 5;

function invalid(message) {
  return new Error(`INVALID_ARGS ${message}`);
}

function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw invalid('time must be a valid RFC3339 value');
  return date.toISOString();
}

function toNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    itemId: row.item_id,
    itemVersion: row.item_version,
    kind: row.kind,
    dueAt: row.due_at,
    scheduledAt: row.scheduled_at,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    acceptedAt: row.accepted_at,
    deliveredAt: row.delivered_at,
    canceledAt: row.canceled_at,
    cancelReason: row.cancel_reason,
    channel: row.channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deliveryDetail(error) {
  return String(error?.message ?? error ?? 'channel send failed').slice(0, 500);
}

export function createScheduler({
  store,
  channel,
  now = () => new Date(),
  setInterval: setTimer = globalThis.setInterval,
  clearInterval: clearTimer = globalThis.clearInterval,
  intervalMs = 15_000,
} = {}) {
  if (!store?.db) throw invalid('store is required');
  if (!channel || typeof channel.send !== 'function') throw invalid('channel is required');
  let timer = null;
  let running = null;

  function scheduleForItem(item, dueAt, kind = 'due') {
    if (!item || typeof item !== 'object') throw invalid('item is required');
    const itemId = item.itemId ?? item.id;
    const version = item.version ?? item.item_version;
    if (typeof itemId !== 'string' || itemId.length === 0) throw invalid('itemId must be non-empty');
    if (!Number.isInteger(version) || version < 1) throw invalid('item version must be positive');
    if (typeof kind !== 'string' || kind.length === 0) throw invalid('kind must be non-empty');
    const scheduledAt = utcInstant(dueAt);
    const at = iso(now());
    const notificationId = randomUUID();
    store.db.prepare(`INSERT OR IGNORE INTO notifications
      (id, owner_id, item_id, item_version, kind, due_at, scheduled_at, status,
       attempts, next_attempt_at, channel, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`).run(
      notificationId, item.owner_id ?? store.ownerId, itemId, version, kind,
      scheduledAt, scheduledAt, scheduledAt, channel.name, at, at,
    );
    return toNotification(store.db.prepare(`SELECT * FROM notifications
      WHERE owner_id = ? AND item_id = ? AND item_version = ? AND kind = ?`)
      .get(item.owner_id ?? store.ownerId, itemId, version, kind));
  }

  function cancelForItem(itemId, reason = 'item_changed') {
    if (typeof itemId !== 'string' || itemId.length === 0) throw invalid('itemId must be non-empty');
    const at = iso(now());
    const count = store.db.prepare(`UPDATE notifications SET status = 'canceled', canceled_at = ?,
      cancel_reason = ?, updated_at = ? WHERE owner_id = ? AND item_id = ?
      AND status IN ('queued', 'retry', 'submitting')`).run(at, String(reason), at, store.ownerId, itemId).changes;
    if (count > 0) {
      store.recordAudit('nightdesk.reminder_canceled', itemId, at, { count, reason: String(reason) });
    }
    return count;
  }

  function recoverSubmitting() {
    const at = iso(now());
    const rows = store.db.prepare(`SELECT id, item_id FROM notifications
      WHERE owner_id = ? AND status = 'submitting'`).all(store.ownerId);
    if (rows.length === 0) return 0;
    store.transaction(() => {
      store.db.prepare(`UPDATE notifications SET status = 'unknown', next_attempt_at = NULL, updated_at = ?
        WHERE owner_id = ? AND status = 'submitting'`).run(at, store.ownerId);
      for (const row of rows) {
        store.recordAudit('nightdesk.reminder_unknown', row.item_id, at, { notificationId: row.id });
      }
    });
    return rows.length;
  }

  async function tick() {
    if (running) return running;
    running = (async () => {
      const at = iso(now());
      const rows = store.db.prepare(`SELECT * FROM notifications WHERE owner_id = ?
        AND status IN ('queued', 'retry') AND next_attempt_at <= ?
        ORDER BY next_attempt_at, created_at, id`).all(store.ownerId, at);
      const summary = { processed: 0, accepted: 0, retry: 0, failed: 0 };
      for (const row of rows) {
        const attempt = row.attempts + 1;
        const claimed = store.db.prepare(`UPDATE notifications SET status = 'submitting', attempts = ?, updated_at = ?
          WHERE id = ? AND owner_id = ? AND status IN ('queued', 'retry') AND attempts = ?`)
          .run(attempt, at, row.id, store.ownerId, row.attempts).changes;
        if (claimed !== 1) continue;
        const item = store.ownedItem(row.item_id);
        let result;
        try {
          if (!item || !item.confirmed || item.completion !== 'unconfirmed' || item.time_status === 'canceled') {
            cancelForItem(row.item_id, 'item_inactive');
            continue;
          }
          const text = `[NightDesk] ${item.title} · 截止 ${row.due_at}`;
          result = await channel.send({ text, itemId: row.item_id, dueAt: row.due_at, kind: row.kind });
          if (result?.ok !== true) throw Object.assign(new Error(result?.error ?? 'channel did not accept message'), { result });
        } catch (cause) {
          result = cause?.result ?? { ok: false, error: deliveryDetail(cause) };
        }
        const finishedAt = iso(now());
        const accepted = result?.ok === true;
        const failed = !accepted && attempt >= MAX_ATTEMPTS;
        const nextAttemptAt = !accepted && !failed
          ? new Date(new Date(finishedAt).getTime() + RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)]).toISOString()
          : null;
        const status = accepted ? 'accepted' : failed ? 'failed' : 'retry';
        const current = store.db.prepare('SELECT status FROM notifications WHERE id = ? AND owner_id = ?')
          .get(row.id, store.ownerId);
        const errorDetail = accepted
          ? result.detail ?? null
          : String(result?.errorDetail ?? result?.error ?? 'channel send failed').slice(0, 500);
        store.transaction(() => {
          if (current?.status === 'submitting') {
            store.db.prepare(`UPDATE notifications SET status = ?, next_attempt_at = ?,
              accepted_at = ?, canceled_at = NULL, cancel_reason = NULL, updated_at = ? WHERE id = ? AND status = 'submitting'`)
              .run(status, nextAttemptAt, accepted ? finishedAt : null, finishedAt, row.id);
          }
          store.db.prepare(`INSERT INTO deliveries
            (id, notification_id, attempt, channel, status, http_status, channel_message_id,
             error_detail, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(randomUUID(), row.id, attempt, channel.name, status, result?.httpStatus ?? null,
              result?.channelMessageId ?? null, errorDetail, at, finishedAt);
          if (accepted && current?.status === 'canceled') {
            store.recordAudit('nightdesk.delivery_after_cancel', row.item_id, finishedAt, {
              notificationId: row.id,
              attempt,
            });
          }
          if (failed && current?.status === 'submitting') {
            store.recordAudit('nightdesk.reminder_failed', row.item_id, finishedAt, { notificationId: row.id, attempts: attempt });
          }
        });
        summary.processed += 1;
        summary[status] += 1;
      }
      return summary;
    })().finally(() => { running = null; });
    return running;
  }

  function start() {
    recoverSubmitting();
    if (timer === null) timer = setTimer(() => { void tick(); }, intervalMs);
    return scheduler;
  }

  function stop() {
    if (timer !== null) clearTimer(timer);
    timer = null;
  }

  function whenIdle() {
    return running ?? Promise.resolve();
  }

  const scheduler = { start, stop, tick, whenIdle, scheduleForItem, cancelForItem };
  return scheduler;
}
