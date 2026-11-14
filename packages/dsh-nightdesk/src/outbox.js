const RETRY_DELAYS_MS = [60_000, 300_000, 900_000, 3_600_000];

function requireArguments(store, handlers, limit) {
  if (!store?.db) throw new Error('INVALID_ARGS store is required');
  if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers)) {
    throw new Error('INVALID_ARGS handlers must be an object');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('INVALID_ARGS limit must be an integer from 1 to 1000');
  }
}

function retryAt(now, attempts) {
  const delay = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
  return new Date(new Date(now).getTime() + delay).toISOString();
}

/** Consume each event independently; a cursor is recorded only after its handler succeeds. */
export async function consumeOutbox({ store, handlers, limit = 100 } = {}) {
  requireArguments(store, handlers, limit);
  const entries = Object.entries(handlers).filter(([, handler]) => typeof handler === 'function');
  if (entries.length === 0) return { processed: 0, skipped: 0, failed: 0 };
  const events = store.db.prepare(`SELECT * FROM outbox
    WHERE status IN ('pending', 'retry') AND available_at <= ?
    ORDER BY created_at ASC, id ASC LIMIT ?`).all(new Date().toISOString(), limit);
  let processed = 0;
  let skipped = 0;
  let failed = 0;
  const cursor = store.db.prepare(`INSERT OR IGNORE INTO outbox_event_handler
    (event_id, handler_id, processed_at) VALUES (?, ?, ?)`);
  for (const event of events) {
    const payload = JSON.parse(event.payload_json);
    for (const [handlerId, handler] of entries) {
      const existing = store.db.prepare(
        'SELECT 1 FROM outbox_event_handler WHERE event_id = ? AND handler_id = ?',
      ).get(event.event_id, handlerId);
      if (existing) {
        skipped += 1;
        continue;
      }
      try {
        await handler(payload, event);
        const processedAt = new Date().toISOString();
        store.transaction(() => {
          cursor.run(event.event_id, handlerId, processedAt);
          if (entries.every(([candidateId]) => store.db.prepare(
            'SELECT 1 FROM outbox_event_handler WHERE event_id = ? AND handler_id = ?',
          ).get(event.event_id, candidateId))) {
            store.db.prepare("UPDATE outbox SET status = 'processed' WHERE id = ?").run(event.id);
          }
        });
        processed += 1;
      } catch (cause) {
        failed += 1;
        const at = new Date().toISOString();
        store.transaction(() => {
          const attempts = event.attempts + 1;
          store.db.prepare(`UPDATE outbox SET status = 'retry', attempts = ?, available_at = ? WHERE id = ?`)
            .run(attempts, retryAt(at, attempts), event.id);
          store.recordAudit('nightdesk.outbox_handler_failed', payload.itemId ?? null, at, {
            eventId: event.event_id,
            handlerId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
        event.attempts += 1;
      }
    }
    if (entries.every(([handlerId]) => store.db.prepare(
      'SELECT 1 FROM outbox_event_handler WHERE event_id = ? AND handler_id = ?',
    ).get(event.event_id, handlerId))) {
      store.db.prepare("UPDATE outbox SET status = 'processed' WHERE id = ?").run(event.id);
    }
  }
  return { processed, skipped, failed };
}
