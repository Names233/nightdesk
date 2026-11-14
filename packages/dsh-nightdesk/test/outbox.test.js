import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightDeskStore } from '../src/store.js';
import { consumeOutbox } from '../src/outbox.js';

function setup(t) {
  const store = new NightDeskStore({ dataDir: mkdtempSync(join(tmpdir(), 'nightdesk-outbox-')), ownerId: 'outbox' });
  t.after(() => store.close());
  return store;
}

function event(store, item) {
  store.confirm({ itemId: item.itemId, expectedVersion: item.version });
  return store.db.prepare("SELECT * FROM outbox WHERE type = 'item.confirmed' ORDER BY created_at DESC, id DESC LIMIT 1").get();
}

test('outbox consumes events in order and persists each event-handler cursor', async (t) => {
  const store = setup(t);
  const first = event(store, store.capture({ text: '第一项' }).candidates[0]);
  const second = event(store, store.capture({ text: '第二项' }).candidates[0]);
  const seen = [];
  const result = await consumeOutbox({ store, handlers: { test: (payload) => seen.push(payload.itemId) } });
  assert.deepEqual(result, { processed: 2, skipped: 0, failed: 0 });
  assert.deepEqual(seen, [JSON.parse(first.payload_json).itemId, JSON.parse(second.payload_json).itemId]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox_event_handler').get().count, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE status = 'processed'").get().count, 2);
});

test('outbox replay skips the same handler but allows a distinct handler', async (t) => {
  const store = setup(t);
  event(store, store.capture({ text: '待办' }).candidates[0]);
  let calls = 0;
  assert.deepEqual(await consumeOutbox({ store, handlers: { notifications: () => { calls += 1; } } }), { processed: 1, skipped: 0, failed: 0 });
  store.db.prepare("UPDATE outbox SET status = 'pending'").run();
  assert.deepEqual(await consumeOutbox({ store, handlers: { notifications: () => { calls += 1; }, audit: () => {} } }), { processed: 1, skipped: 1, failed: 0 });
  assert.equal(calls, 1);
});

test('one throwing handler does not block following events or other handlers', async (t) => {
  const store = setup(t);
  event(store, store.capture({ text: '失败项' }).candidates[0]);
  event(store, store.capture({ text: '后续项' }).candidates[0]);
  const seen = [];
  const result = await consumeOutbox({ store, handlers: {
    bad: () => { throw new Error('simulated failure'); },
    good: (payload) => seen.push(payload.itemId),
  } });
  assert.deepEqual(result, { processed: 2, skipped: 0, failed: 2 });
  assert.equal(seen.length, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'nightdesk.outbox_handler_failed'").get().count, 2);
});

test('outbox consumption resumes after reopening without replaying cursor rows', async (t) => {
  const store = setup(t);
  event(store, store.capture({ text: '重启恢复' }).candidates[0]);
  let calls = 0;
  await consumeOutbox({ store, handlers: { notifications: () => { calls += 1; } } });
  store.db.prepare("UPDATE outbox SET status = 'pending'").run();
  const dataDir = store.dataDir;
  store.close();
  const reopened = new NightDeskStore({ dataDir, ownerId: 'outbox' });
  t.after(() => reopened.close());
  const result = await consumeOutbox({ store: reopened, handlers: { notifications: () => { calls += 1; } } });
  assert.deepEqual(result, { processed: 0, skipped: 1, failed: 0 });
  assert.equal(calls, 1);
});

test('outbox arguments and limit are validated', async (t) => {
  const store = setup(t);
  await assert.rejects(consumeOutbox({ store, handlers: {}, limit: 0 }), /INVALID_ARGS.*limit/);
  await assert.rejects(consumeOutbox({ store, handlers: null }), /INVALID_ARGS.*handlers/);
});

test('a handler crash leaves its cursor absent and retries the event', async (t) => {
  const store = setup(t);
  event(store, store.capture({ text: '崩溃重试' }).candidates[0]);
  let shouldFail = true;
  assert.deepEqual(await consumeOutbox({ store, handlers: {
    crash: () => {
      if (shouldFail) throw new Error('crashed before cursor');
    },
  }}), { processed: 0, skipped: 0, failed: 1 });
  const pending = store.db.prepare('SELECT status, attempts, available_at FROM outbox').get();
  assert.equal(pending.status, 'retry');
  assert.equal(pending.attempts, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox_event_handler').get().count, 0);
  assert.ok(new Date(pending.available_at).getTime() >= Date.now() + 59_000);
  shouldFail = false;
  store.db.prepare("UPDATE outbox SET available_at = datetime('now') || '.000Z'").run();
  assert.deepEqual(await consumeOutbox({ store, handlers: {
    crash: () => {},
  }}), { processed: 1, skipped: 0, failed: 0 });
  assert.equal(store.db.prepare("SELECT status FROM outbox").get().status, 'processed');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM outbox_event_handler').get().count, 1);
});
