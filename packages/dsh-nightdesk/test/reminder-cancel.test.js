import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightDeskStore } from '../src/store.js';

function fixture(t, title = '2026-11-20 交付') {
  const store = new NightDeskStore({ dataDir: mkdtempSync(join(tmpdir(), 'nightdesk-cancel-')), ownerId: 'test' });
  const item = store.capture({ text: title }).candidates[0];
  store.onItemChanged = (changed, dueAt) => store.onReminderRequested(changed, dueAt, 'due');
  store.onReminderRequested = (requested, dueAt, kind) => {
    const at = new Date().toISOString();
    const id = `notification-${kind}`;
    store.db.prepare(`INSERT INTO notifications
      (id, owner_id, item_id, item_version, kind, due_at, scheduled_at, status,
       attempts, next_attempt_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`)
      .run(id, store.ownerId, item.itemId, requested.version, kind, dueAt, dueAt, dueAt, at, at);
    return store.reminders({ itemId: item.itemId }).notifications.find((row) => row.id === id);
  };
  store.confirm({ itemId: item.itemId, expectedVersion: 1, dueAt: '2026-11-20T00:00:00.000Z', timeStatus: 'resolved' });
  t.after(() => store.close());
  return { store, item };
}

test('cancel a queued reminder by notification id and filter reminders by item', (t) => {
  const { store, item } = fixture(t);
  const reminder = store.remind({ itemId: item.itemId, kind: 'advance', dueAt: '2026-11-19T12:00:00.000Z' });
  const result = store.cancelReminder({ notificationId: reminder.id });
  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.deepEqual(result.canceled, [{ id: reminder.id, itemId: item.itemId, kind: 'advance', dueAt: '2026-11-19T12:00:00.000Z' }]);
  const row = store.db.prepare('SELECT status, next_attempt_at FROM notifications WHERE id = ?').get(reminder.id);
  assert.equal(row.status, 'canceled');
  assert.equal(row.next_attempt_at, null);
  assert.equal(store.reminders({ itemId: item.itemId }).count, 2);
});

test('cancel a queued reminder by item id and kind', (t) => {
  const { store, item } = fixture(t);
  store.remind({ itemId: item.itemId, kind: 'advance', dueAt: '2026-11-19T12:00:00.000Z' });
  const result = store.cancelReminder({ itemId: item.itemId, kind: 'advance' });
  assert.equal(result.count, 1);
  assert.equal(result.canceled[0].kind, 'advance');
  assert.equal(store.reminders({ itemId: item.itemId, status: 'queued' }).notifications[0].kind, 'due');
});

test('cancel accepts a retry reminder', (t) => {
  const { store, item } = fixture(t);
  const reminder = store.reminders({ itemId: item.itemId }).notifications[0];
  store.db.prepare("UPDATE notifications SET status = 'retry' WHERE id = ?").run(reminder.id);
  assert.equal(store.cancelReminder({ notificationId: reminder.id }).count, 1);
});

test('cancel returns NOT_FOUND for an unknown id', (t) => {
  const { store } = fixture(t);
  assert.throws(() => store.cancelReminder({ notificationId: 'missing' }), /NOT_FOUND/);
});

test('cancel refuses an accepted reminder with NOT_CANCELABLE', (t) => {
  const { store, item } = fixture(t);
  const reminder = store.reminders({ itemId: item.itemId }).notifications[0];
  store.db.prepare("UPDATE notifications SET status = 'accepted' WHERE id = ?").run(reminder.id);
  assert.throws(() => store.cancelReminder({ notificationId: reminder.id }), /NOT_CANCELABLE.*accepted/);
  assert.equal(store.reminders({ itemId: item.itemId }).notifications[0].status, 'accepted');
});

test('cancel refuses a delivered reminder with NOT_CANCELABLE', (t) => {
  const { store, item } = fixture(t);
  const reminder = store.reminders({ itemId: item.itemId }).notifications[0];
  store.db.prepare("UPDATE notifications SET status = 'delivered' WHERE id = ?").run(reminder.id);
  assert.throws(() => store.cancelReminder({ notificationId: reminder.id }), /NOT_CANCELABLE.*delivered/);
  assert.equal(store.reminders({ itemId: item.itemId }).notifications[0].status, 'delivered');
});

test('a second cancel reports NOT_CANCELABLE and does not change the audit count', (t) => {
  const { store, item } = fixture(t);
  const reminder = store.reminders({ itemId: item.itemId }).notifications[0];
  store.cancelReminder({ notificationId: reminder.id });
  assert.throws(() => store.cancelReminder({ notificationId: reminder.id }), /NOT_CANCELABLE.*canceled/);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'nightdesk.reminder_canceled'").get().count, 1);
});

test('cancel writes its audit row in the same transaction', (t) => {
  const { store, item } = fixture(t);
  const reminder = store.reminders({ itemId: item.itemId }).notifications[0];
  store.cancelReminder({ notificationId: reminder.id });
  const audit = store.db.prepare(`SELECT * FROM audit_events
    WHERE action = 'nightdesk.reminder_canceled' AND item_id = ?`).get(item.itemId);
  assert.equal(audit.actor, 'test');
  assert.equal(JSON.parse(audit.detail_json).notificationId, reminder.id);
  assert.equal(store.reminders({ status: 'canceled' }).count, 1);
});

test('cancel requires exactly one identifier and a supported kind', (t) => {
  const { store, item } = fixture(t);
  assert.throws(() => store.cancelReminder({}), /INVALID_ARGS.*exactly one/);
  assert.throws(() => store.cancelReminder({ notificationId: 'x', itemId: item.itemId }), /INVALID_ARGS.*exactly one/);
  assert.throws(() => store.cancelReminder({ itemId: item.itemId, kind: 'followup' }), /INVALID_ARGS.*kind/);
});
