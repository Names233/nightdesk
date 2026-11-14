import { createChannel, channelHealth, loadChannelConfig } from './channel.js';
import { consumeOutbox } from './outbox.js';
import { createScheduler } from './scheduler.js';
import { NightDeskStore } from './store.js';
import { createTools } from './tools.js';

export const name = 'nightdesk';
export const inject = ['tools'];

function applyItemChange(scheduler, item, payload = {}) {
  const itemId = item.itemId ?? item.id;
  const confirmed = item.confirmed === true || item.confirmed === 1;
  const active = confirmed && (item.completion ?? 'unconfirmed') === 'unconfirmed' && item.timeStatus !== 'canceled' && item.time_status !== 'canceled';
  if (!active) {
    scheduler.cancelForItem(itemId, item.completion && item.completion !== 'unconfirmed' ? 'completed' : 'canceled');
    return null;
  }
  const dueAt = item.dueAt ?? item.due_at;
  if (payload.cancel !== false) scheduler.cancelForItem(itemId, 'item_changed');
  if (!dueAt || item.timeStatus === 'unknown' || item.time_status === 'unknown'
    || item.timeStatus === 'ambiguous' || item.time_status === 'ambiguous') return null;
  return scheduler.scheduleForItem(item, dueAt, payload.kind ?? 'due');
}

export function apply(ctx, deps = {}) {
  let store = null;
  let scheduler = null;
  let outboxTimer = null;
  let consuming = null;
  try {
    store = new NightDeskStore();
    const channelConfig = loadChannelConfig(store.dataDir);
    const channel = createChannel(channelConfig, { fetch: deps.fetch, log: deps.log ?? ((text) => console.log(text)) });
    scheduler = createScheduler({ store, channel });
    store.onItemChanged = (item, dueAt, kind) => applyItemChange(scheduler, {
      ...item,
      ...(dueAt !== undefined ? { dueAt, due_at: dueAt } : {}),
    }, { kind });
    store.onReminderRequested = (item, dueAt, kind) =>
      scheduler.scheduleForItem({ ...item, dueAt, due_at: dueAt }, dueAt, kind ?? 'due');
    const handleEvent = async (payload) => {
      const item = store.ownedItem(payload.itemId);
      if (item) applyItemChange(scheduler, item, { ...payload, cancel: false });
    };
    const consume = () => {
      if (!consuming) {
        consuming = consumeOutbox({ store, handlers: { notifications: handleEvent } })
          .catch(() => {})
          .finally(() => { consuming = null; });
      }
      return consuming;
    };
    outboxTimer = setInterval(() => { void consume(); }, 30_000);
    scheduler.start();
    for (const tool of createTools(store, { scheduler, channel, channelConfig: channelHealth(channelConfig) })) {
      ctx.tools.register(tool);
    }
    ctx.effect(() => async () => {
      clearInterval(outboxTimer);
      scheduler.stop();
      await scheduler.whenIdle();
      await consuming;
      store.close();
    });
  } catch (cause) {
    if (outboxTimer !== null) clearInterval(outboxTimer);
    scheduler?.stop();
    store?.close();
    throw cause;
  }
}
