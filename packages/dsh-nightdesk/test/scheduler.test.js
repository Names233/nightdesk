import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightDeskStore } from '../src/store.js';
import { createScheduler } from '../src/scheduler.js';

function fixture(t, send = async () => ({ ok: true, channelMessageId: 'test-1' })) {
  const store = new NightDeskStore({ dataDir: mkdtempSync(join(tmpdir(), 'nightdesk-scheduler-')), ownerId: 'test' });
  const channel = { name: 'test', send };
  let current = new Date('2026-11-14T00:00:00.000Z');
  const scheduler = createScheduler({ store, channel, now: () => current });
  store.onReminderRequested = (requested, dueAt, kind) =>
    scheduler.scheduleForItem({ ...requested, dueAt, due_at: dueAt }, dueAt, kind ?? 'due');
  store.onItemChanged = (changed, dueAt, kind) => {
    scheduler.cancelForItem(changed.itemId ?? changed.id, 'item_changed');
    if (dueAt && changed.confirmed && changed.completion === 'unconfirmed' && changed.time_status !== 'canceled') {
      return scheduler.scheduleForItem(changed, dueAt, kind);
    }
    return null;
  };
  const advance = (ms) => { current = new Date(current.getTime() + ms); };
  const item = store.capture({ text: '2026-11-20 交付' }).candidates[0];
  t.after(() => store.close());
  return { store, channel, scheduler, advance, item };
}

function confirmed(store, item, dueAt = '2026-11-14T00:00:00.000Z') {
  return store.confirm({ itemId: item.itemId, expectedVersion: item.version, dueAt, timeStatus: 'resolved' });
}

function notification(store) {
  return store.db.prepare('SELECT * FROM notifications ORDER BY created_at DESC, id DESC LIMIT 1').get();
}

test('D06 migration creates notification, delivery and consumer cursor tables', (t) => {
  const { store } = fixture(t);
  assert.equal(store.health().schemaVersion, 5);
  for (const table of ['notifications', 'deliveries', 'outbox_event_handler']) {
    assert.equal(store.db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table).type, 'table');
  }
  assert.equal(store.db.prepare("SELECT type FROM sqlite_master WHERE name = 'outbox_event_dedupe'").get().type, 'index');
});

test('confirm schedules once and channel acceptance never marks device delivery', async (t) => {
  const { store, scheduler, item } = fixture(t);
  const value = confirmed(store, item);
  assert.equal(notification(store).status, 'queued');
  const result = await scheduler.tick();
  assert.deepEqual(result, { processed: 1, accepted: 1, retry: 0, failed: 0 });
  const accepted = notification(store);
  assert.equal(accepted.status, 'accepted');
  assert.match(accepted.accepted_at, /Z$/);
  assert.equal(accepted.delivered_at, null);
  assert.equal(store.db.prepare('SELECT status, http_status FROM deliveries').get().status, 'accepted');
  await scheduler.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
});

test('rescheduling cancels the old version and preserves one idempotent replacement', async (t) => {
  const { store, scheduler, item, advance } = fixture(t);
  confirmed(store, item, '2026-11-20T00:00:00.000Z');
  const old = notification(store);
  const moved = store.confirm({ itemId: item.itemId, expectedVersion: 2, dueAt: '2026-11-21T00:00:00.000Z' });
  scheduler.scheduleForItem(moved, moved.dueAt);
  assert.equal(store.db.prepare('SELECT status FROM notifications WHERE id = ?').get(old.id).status, 'canceled');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE item_id = ?').get(item.itemId).count, 2);
  advance(7 * 24 * 60 * 60 * 1000);
  const result = await scheduler.tick();
  assert.equal(result.accepted, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
});

test('complete and canceled item states prevent pending sends', async (t) => {
  const { store, scheduler, item } = fixture(t);
  confirmed(store, item);
  store.complete({ itemId: item.itemId, expectedVersion: 2 });
  assert.equal(notification(store).status, 'canceled');
  assert.equal((await scheduler.tick()).processed, 0);
  const second = store.capture({ text: '另一件事' }).candidates[0];
  confirmed(store, second);
  store.db.prepare("UPDATE items SET time_status = 'canceled' WHERE id = ?").run(second.itemId);
  await scheduler.tick();
  assert.equal(store.db.prepare('SELECT status FROM notifications WHERE item_id = ?').get(second.itemId).status, 'canceled');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 0);
});

test('failed sends retry at 10s, 30s and 2min, then fail after five attempts', async (t) => {
  const { store, scheduler, item, advance } = fixture(t, async () => ({ ok: false, error: 'offline' }));
  confirmed(store, item);
  for (const [attempt, delay] of [10_000, 30_000, 120_000, 120_000].entries()) {
    assert.equal((await scheduler.tick()).retry, 1);
    const row = notification(store);
    assert.equal(row.attempts, attempt + 1);
    assert.equal(new Date(row.next_attempt_at).getTime() - new Date(row.updated_at).getTime(), delay);
    advance(delay);
  }
  assert.equal((await scheduler.tick()).failed, 1);
  assert.equal(notification(store).status, 'failed');
  assert.equal(store.db.prepare("SELECT action FROM audit_events WHERE action = 'nightdesk.reminder_failed'").get().action, 'nightdesk.reminder_failed');
  advance(120_000);
  assert.equal((await scheduler.tick()).processed, 0);
});

test('restart replays pending work without duplicating accepted reminders', async (t) => {
  const { store, scheduler, item } = fixture(t);
  confirmed(store, item);
  const id = notification(store).id;
  store.close();
  const reopened = new NightDeskStore({ dataDir: store.dataDir, ownerId: 'test' });
  const sends = [];
  const recovered = createScheduler({ store: reopened, channel: { name: 'test', send: async (message) => { sends.push(message); return { ok: true }; } }, now: () => new Date('2026-11-14T00:00:00.000Z') });
  const candidate = reopened.ownedItem(item.itemId);
  recovered.scheduleForItem(candidate, candidate.due_at);
  await recovered.tick();
  await recovered.tick();
  assert.equal(sends.length, 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE id = ?').get(id).count, 1);
  assert.equal(reopened.db.prepare('SELECT COUNT(*) AS count FROM deliveries').get().count, 1);
  reopened.close();
});

test('start and stop own exactly one interval and tick serializes overlapping calls', async (t) => {
  const timers = [];
  const cleared = [];
  const store = new NightDeskStore({ dataDir: mkdtempSync(join(tmpdir(), 'nightdesk-timer-')) });
  t.after(() => store.close());
  const scheduler = createScheduler({
    store,
    channel: { name: 'test', send: async () => ({ ok: true }) },
    setInterval: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearInterval: (timer) => cleared.push(timer),
  });
  scheduler.start().start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15_000);
  const pendingTick = scheduler.tick();
  assert.equal(await scheduler.tick(), await pendingTick);
  scheduler.stop();
  scheduler.stop();
  assert.deepEqual(cleared, timers);
});

test('manual reminders require a confirmed active item and a valid instant', (t) => {
  const { store, item } = fixture(t);
  assert.throws(() => store.remind({ itemId: item.itemId, dueAt: 'not-a-date' }), /INVALID_ARGS.*dueAt/);
  assert.throws(() => store.remind({ itemId: item.itemId }), /confirmed/);
  confirmed(store, item, '2026-11-20T00:00:00.000Z');
  const reminder = store.remind({ itemId: item.itemId, dueAt: '2026-11-22T00:00:00+08:00', kind: 'followup' });
  assert.equal(reminder.kind, 'followup');
  assert.equal(reminder.scheduledAt, '2026-11-21T16:00:00.000Z');
  assert.throws(() => store.reminders({ status: 'delivered' }), /INVALID_ARGS.*status/);
});

test('start recovers submitting reminders as unknown without resending them', async (t) => {
  let sends = 0;
  const { store, scheduler, item } = fixture(t, async () => {
    sends += 1;
    return { ok: true };
  });
  confirmed(store, item);
  const row = notification(store);
  store.db.prepare("UPDATE notifications SET status = 'submitting', attempts = 1 WHERE id = ?").run(row.id);
  scheduler.start();
  scheduler.stop();
  assert.equal(notification(store).status, 'unknown');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'nightdesk.reminder_unknown'").get().count, 1);
  assert.deepEqual(await scheduler.tick(), { processed: 0, accepted: 0, retry: 0, failed: 0 });
  assert.equal(sends, 0);
});

test('a cancellation during send still records delivery evidence and audit', async (t) => {
  let activeScheduler;
  let item;
  const { store, scheduler } = fixture(t, async () => {
    activeScheduler.cancelForItem(item.itemId, 'user_cancel');
    return { ok: true, channelMessageId: 'accepted-while-canceling' };
  });
  activeScheduler = scheduler;
  item = store.capture({ text: '竞态提醒' }).candidates[0];
  confirmed(store, item);
  const result = await scheduler.tick();
  assert.equal(result.accepted, 1);
  assert.equal(notification(store).status, 'canceled');
  assert.equal(store.db.prepare('SELECT status, channel_message_id FROM deliveries').get().status, 'accepted');
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'nightdesk.delivery_after_cancel'").get().count, 1);
});

test('stopping a scheduler does not invoke a new timer tick', (t) => {
  const timers = [];
  const { store } = fixture(t);
  const scheduler = createScheduler({
    store,
    channel: { name: 'test', send: async () => { throw new Error('must not send'); } },
    setInterval: (fn) => { timers.push(fn); return fn; },
    clearInterval: () => {},
  });
  scheduler.start();
  scheduler.stop();
  assert.equal(timers.length, 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE status = 'submitting'").get().count, 0);
});
