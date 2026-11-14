import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../src/index.js';

function loadPlugin(t, options = {}) {
  const registry = new Map();
  let cleanup;
  const ctx = {
    tools: { register: (definition) => { registry.set(definition.name, definition); return () => {}; } },
    effect: (fn) => { cleanup = fn(); },
    on: () => {},
  };
  process.env.NIGHTDESK_DATA_DIR = mkdtempSync(join(tmpdir(), 'nightdesk-tools-'));
  process.env.NIGHTDESK_OWNER = 'tools-test';
  if (options.kind) process.env.NIGHTDESK_CHANNEL_KIND = options.kind;
  t.after(async () => {
    await cleanup();
    delete process.env.NIGHTDESK_DATA_DIR;
    delete process.env.NIGHTDESK_OWNER;
    delete process.env.NIGHTDESK_CHANNEL_KIND;
  });
  plugin.apply(ctx, options);
  return { registry, getCleanup: () => cleanup };
}

test('plugin exports contract and registers all thirteen tools', (t) => {
  const { registry, getCleanup } = loadPlugin(t);
  assert.equal(plugin.name, 'nightdesk');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual([...registry.keys()], [
    'nightdesk_health', 'nightdesk_capture', 'nightdesk_items', 'nightdesk_confirm', 'nightdesk_complete',
    'nightdesk_remind', 'nightdesk_reminders', 'nightdesk_tick', 'nightdesk_channel',
    'nightdesk_probe_qq', 'nightdesk_probes', 'nightdesk_channels', 'nightdesk_bind_channel',
  ]);
  for (const definition of registry.values()) {
    assert.equal(definition.parameters.type, 'object');
    assert.equal(definition.output.schema.type, 'object');
    assert.equal(typeof definition.description, 'string');
    assert.match(definition.description, /[一-鿿]/);
    assert.deepEqual(definition.output.render({}, { ok: true }), [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }]);
  }
  assert.equal(typeof getCleanup(), 'function');
});

test('health and capture return lossless JSON values without auto-confirming', async (t) => {
  const { registry } = loadPlugin(t);
  const health = await registry.get('nightdesk_health').execute({}, {});
  assert.equal(health.ok, true);
  assert.equal(health.pluginVersion, '0.1.0');
  assert.equal(health.schemaVersion, 3);
  assert.equal(health.timeZone, 'Asia/Shanghai');
  assert.equal(health.readOnly, false);
  assert.match(health.nowUtc, /Z$/);
  const captured = await registry.get('nightdesk_capture').execute({ text: '今晚交作业' }, {});
  assert.equal(captured.candidates.length, 1);
  assert.equal(captured.candidates[0].timeStatus, 'ambiguous');
  assert.equal(captured.candidates[0].dueAt, null);
  assert.equal(captured.candidates[0].needsConfirmation, true);
  assert.equal(captured.candidates[0].version, 1);
  assert.equal(captured.totals.candidates, 1);
});

test('registry validation is supplemented by execute argument checks', async (t) => {
  const { registry } = loadPlugin(t);
  await assert.rejects(registry.get('nightdesk_capture').execute({ text: 42 }, {}), /INVALID_ARGS.*text/);
  await assert.rejects(registry.get('nightdesk_items').execute({ view: 'deleted' }, {}), /INVALID_ARGS.*view/);
  await assert.rejects(registry.get('nightdesk_items').execute({ limit: 0 }, {}), /INVALID_ARGS.*limit/);
  await assert.rejects(registry.get('nightdesk_confirm').execute({ itemId: 'x' }, {}), /INVALID_ARGS.*expectedVersion/);
  await assert.rejects(registry.get('nightdesk_complete').execute({ itemId: 'x', expectedVersion: 1, completion: 'maybe' }, {}), /INVALID_ARGS.*completion/);
});

test('capture, confirm and query execute through the registered tools', async (t) => {
  const { registry } = loadPlugin(t);
  const captured = await registry.get('nightdesk_capture').execute({ text: '2026-11-20 交报告', idempotencyKey: 'tools' }, {});
  const candidate = captured.candidates[0];
  const confirmed = await registry.get('nightdesk_confirm').execute({ itemId: candidate.itemId, expectedVersion: 1 }, {});
  assert.equal(confirmed.version, 2);
  const items = await registry.get('nightdesk_items').execute({ view: 'all', includeUnconfirmed: false, limit: 50 }, {});
  assert.equal(items.view, 'all');
  assert.equal(items.readScope.timeZone, 'Asia/Shanghai');
  assert.equal(items.items.length, 1);
  assert.equal(items.counts.returned, 1);
  const completed = await registry.get('nightdesk_complete').execute({ itemId: candidate.itemId, expectedVersion: 2 }, {});
  assert.equal(completed.completion, 'manual_complete');
});

test('reminder tools schedule, list, tick and hide channel credentials', async (t) => {
  const { registry } = loadPlugin(t);
  assert.deepEqual(await registry.get('nightdesk_channel').execute({}, {}), { name: 'console', configured: true });
  const captured = await registry.get('nightdesk_capture').execute({ text: '明天交材料' }, {});
  const item = captured.candidates[0];
  await registry.get('nightdesk_confirm').execute({
    itemId: item.itemId, expectedVersion: item.version, dueAt: '2026-11-20T00:00:00.000Z', timeStatus: 'resolved',
  }, {});
  const reminder = await registry.get('nightdesk_remind').execute({ itemId: item.itemId, dueAt: '2026-11-21T00:00:00.000Z', kind: 'followup' }, {});
  assert.equal(reminder.kind, 'followup');
  const listed = await registry.get('nightdesk_reminders').execute({ status: 'queued' }, {});
  assert.equal(listed.count, 2);
  assert.equal(listed.notifications.every((row) => row.deliveredAt === null), true);
  const tick = await registry.get('nightdesk_tick').execute({}, {});
  assert.deepEqual(tick, { processed: 0, accepted: 0, retry: 0, failed: 0 });
});

test('QQ binding, probe and history tools enforce masking and persistence', async (t) => {
  const { registry } = loadPlugin(t);
  const bound = await registry.get('nightdesk_bind_channel').execute({
    channel: 'qq', appId: 'public-app', openid: 'openid-12345678', displayName: 'phone',
  }, {});
  assert.equal(bound.channel, 'qq');
  assert.equal(bound.openid, 'ope***5678');
  assert.equal(JSON.stringify(bound).includes('openid-12345678'), false);
  const channels = await registry.get('nightdesk_channels').execute({}, {});
  assert.equal(channels.count, 1);
  assert.equal(channels.channels[0].openid, 'ope***5678');
  assert.equal(channels.channels[0].lastVerifiedAt, null);
  const probe = await registry.get('nightdesk_probe_qq').execute({}, {});
  assert.equal(probe.status, 'fail');
  assert.equal(probe.capabilities.length, 5);
  assert.equal(JSON.stringify(probe).includes('clientSecret'), false);
  assert.equal(JSON.stringify(probe).includes('access_token'), false);
  const history = await registry.get('nightdesk_probes').execute({ kind: 'qq', limit: 10 }, {});
  assert.equal(history.count, 1);
  assert.equal(history.probes[0].id, probe.id);
});

test('plugin teardown stops timers without starting a new delivery tick', async (t) => {
  const oldSetInterval = globalThis.setInterval;
  const oldClearInterval = globalThis.clearInterval;
  const timers = [];
  const cleared = [];
  const logs = [];
  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms };
    timers.push(timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => cleared.push(timer);
  const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-shutdown-'));
  process.env.NIGHTDESK_DATA_DIR = dataDir;
  process.env.NIGHTDESK_OWNER = 'shutdown-test';
  const registry = new Map();
  let cleanup;
  try {
    plugin.apply({
      tools: { register: (definition) => registry.set(definition.name, definition) },
      effect: (fn) => { cleanup = fn(); },
      on: () => {},
    }, { log: (text) => logs.push(text) });
    globalThis.setInterval = oldSetInterval;
    const captured = await registry.get('nightdesk_capture').execute({ text: '过期事项' }, {});
    await registry.get('nightdesk_confirm').execute({
      itemId: captured.candidates[0].itemId,
      expectedVersion: 1,
      dueAt: '2020-01-01T00:00:00.000Z',
      timeStatus: 'resolved',
    }, {});
    await cleanup();
  } finally {
    globalThis.setInterval = oldSetInterval;
    globalThis.clearInterval = oldClearInterval;
    delete process.env.NIGHTDESK_DATA_DIR;
    delete process.env.NIGHTDESK_OWNER;
  }
  assert.equal(timers.length, 2);
  assert.deepEqual(cleared, timers);
  assert.deepEqual(logs, []);
});
