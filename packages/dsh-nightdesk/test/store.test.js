import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightDeskStore } from '../src/store.js';

function temporaryStore(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-store-'));
  const store = new NightDeskStore({ dataDir, ownerId: 'test-owner' });
  t.after(() => store.close());
  return { store, dataDir };
}

test('capture, confirm and items retain evidence and versions', (t) => {
  const { store } = temporaryStore(t);
  const captured = store.capture({ text: '周五交作业。\n记得买牛奶', idempotencyKey: 'first' });
  assert.equal(captured.candidates.length, 2);
  assert.equal(captured.candidates[0].needsConfirmation, true);
  assert.equal(captured.candidates[1].timeStatus, 'unknown');
  const item = store.confirm({ itemId: captured.candidates[0].itemId, expectedVersion: 1 });
  assert.equal(item.confirmed, true);
  assert.equal(item.version, 2);
  const listed = store.items({ view: 'all' });
  assert.equal(listed.items.length, 2);
  assert.equal(listed.items.find(({ itemId }) => itemId === item.itemId).confirmed, true);
  const observation = store.db.prepare('SELECT raw_text, content_hash FROM observations WHERE id = ?').get(captured.observationId);
  assert.equal(observation.raw_text, '周五交作业。\n记得买牛奶');
  assert.match(observation.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM item_versions').get().count, 3);
  assert.equal(store.db.prepare("SELECT type, status FROM outbox").get().type, 'item.confirmed');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 1);
});

test('confirm and complete use compare-and-swap versions', (t) => {
  const { store } = temporaryStore(t);
  const item = store.capture({ text: '明天提交材料' }).candidates[0];
  assert.throws(() => store.confirm({ itemId: item.itemId, expectedVersion: 99 }), /VERSION_CONFLICT.*currentVersion 1/);
  store.confirm({ itemId: item.itemId, expectedVersion: 1 });
  assert.throws(() => store.complete({ itemId: item.itemId, expectedVersion: 1 }), /VERSION_CONFLICT.*currentVersion 2/);
  const complete = store.complete({ itemId: item.itemId, expectedVersion: 2 });
  assert.equal(complete.completion, 'manual_complete');
  assert.equal(complete.version, 3);
  assert.equal(store.items({ view: 'pending' }).items.length, 0);
  assert.deepEqual(store.db.prepare('SELECT type FROM outbox ORDER BY created_at, id').all().map(({ type }) => type).sort(), ['item.completed', 'item.confirmed']);
});

test('capture idempotency returns the original response and rejects another body', (t) => {
  const { store } = temporaryStore(t);
  const first = store.capture({ text: '今天核对', sourceLabel: 'manual', idempotencyKey: 'same-key' });
  assert.deepEqual(store.capture({ text: '今天核对', idempotencyKey: 'same-key', sourceLabel: 'manual' }), first);
  assert.throws(() => store.capture({ text: '明天核对', idempotencyKey: 'same-key' }), /IDEMPOTENCY_CONFLICT/);
  assert.equal(store.health().counts.observations, 1);
  assert.equal(store.health().counts.items, 1);
});

test('business update, version, audit and outbox roll back together', (t) => {
  const { store } = temporaryStore(t);
  const item = store.capture({ text: '今晚交作业' }).candidates[0];
  const original = store.recordEvent.bind(store);
  store.recordEvent = (...args) => {
    original(...args);
    throw new Error('simulated crash after outbox insert');
  };
  assert.throws(() => store.confirm({ itemId: item.itemId, expectedVersion: 1 }), /simulated crash/);
  assert.equal(store.ownedItem(item.itemId).version, 1);
  assert.equal(store.ownedItem(item.itemId).confirmed, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM item_versions').get().count, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM audit_events').get().count, 0);
});

test('today uses the Shanghai calendar for stored dueAt instants', (t) => {
  const { store } = temporaryStore(t);
  const item = store.capture({ text: '核对时间边界' }).candidates[0];
  const nowUtc = new Date().toISOString();
  const nextLocalDay = store.confirm({
    itemId: item.itemId,
    expectedVersion: 1,
    dueAt: new Date(new Date(nowUtc).getTime() + 24 * 60 * 60 * 1000).toISOString(),
    timeStatus: 'resolved',
  });
  const result = store.items({ view: 'today' });
  assert.equal(result.items.some(({ itemId }) => itemId === nextLocalDay.itemId), false);
});

test('WAL and committed records survive reopening the database', (t) => {
  const { store, dataDir } = temporaryStore(t);
  const item = store.capture({ text: '2026-11-20 交付', idempotencyKey: 'persist' }).candidates[0];
  store.confirm({ itemId: item.itemId, expectedVersion: 1 });
  assert.equal(existsSync(join(dataDir, 'nightdesk.db-wal')), true);
  store.close();
  const reopened = new NightDeskStore({ dataDir, ownerId: 'test-owner' });
  t.after(() => reopened.close());
  assert.equal(reopened.ownedItem(item.itemId).confirmed, 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM outbox').get().count, 1);
  assert.equal(reopened.health().schemaVersion, 3);
});

test('confirm and remind reject date-only values without a timezone', (t) => {
  const { store } = temporaryStore(t);
  const item = store.capture({ text: '2026-11-20 交付' }).candidates[0];
  assert.throws(() => store.confirm({ itemId: item.itemId, expectedVersion: 1, dueAt: '2026-11-15' }), /INVALID_ARGS.*dueAt/);
  store.confirm({ itemId: item.itemId, expectedVersion: 1, dueAt: '2026-11-20T00:00:00Z', timeStatus: 'resolved' });
  store.onReminderRequested = () => null;
  assert.throws(() => store.remind({ itemId: item.itemId, dueAt: '2026-11-15' }), /INVALID_ARGS.*dueAt/);
});

test('remind keeps the scheduler-unavailable guard when no callback is installed', (t) => {
  const { store } = temporaryStore(t);
  const item = store.capture({ text: '2026-11-20 交付' }).candidates[0];
  store.confirm({ itemId: item.itemId, expectedVersion: 1, dueAt: '2026-11-20T00:00:00Z', timeStatus: 'resolved' });
  assert.throws(() => store.remind({ itemId: item.itemId }), /INVALID_ARGS scheduler is unavailable/);
});

test('migration backfills a confirmed instant item reminder exactly once', (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-migration-'));
  const legacy = new DatabaseSync(join(dataDir, 'nightdesk.db'));
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    CREATE TABLE items (
      id TEXT PRIMARY KEY, owner_id TEXT, observation_id TEXT, title TEXT, due_at TEXT,
      due_date TEXT, time_zone TEXT, precision TEXT, time_status TEXT, completion TEXT,
      confirmed INTEGER, version INTEGER, created_at TEXT, updated_at TEXT
    );
  `);
  legacy.prepare(`INSERT INTO items
    (id, owner_id, observation_id, title, due_at, due_date, time_zone, precision,
     time_status, completion, confirmed, version, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'legacy-item', 'legacy-owner', 'legacy-observation', '既有事项', '2026-11-20T00:00:00.000Z',
    '2026-11-20', 'Asia/Shanghai', 'instant', 'resolved', 'unconfirmed', 1, 4,
    '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z',
  );
  legacy.close();
  const store = new NightDeskStore({ dataDir, ownerId: 'legacy-owner' });
  t.after(() => store.close());
  const reminder = store.db.prepare('SELECT * FROM notifications WHERE item_id = ?').get('legacy-item');
  assert.equal(reminder.item_version, 4);
  assert.equal(reminder.kind, 'due');
  assert.equal(reminder.status, 'queued');
  assert.equal(reminder.scheduled_at, '2026-11-20T00:00:00.000Z');
  store.migrate();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE item_id = ?').get('legacy-item').count, 1);
});
