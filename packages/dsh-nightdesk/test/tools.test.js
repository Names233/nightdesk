import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as plugin from '../src/index.js';

function loadPlugin(t) {
  const registry = new Map();
  let cleanup;
  const ctx = {
    tools: { register: (definition) => { registry.set(definition.name, definition); return () => {}; } },
    effect: (fn) => { cleanup = fn(); },
    on: () => {},
  };
  process.env.NIGHTDESK_DATA_DIR = mkdtempSync(join(tmpdir(), 'nightdesk-tools-'));
  process.env.NIGHTDESK_OWNER = 'tools-test';
  t.after(() => {
    cleanup();
    delete process.env.NIGHTDESK_DATA_DIR;
    delete process.env.NIGHTDESK_OWNER;
  });
  plugin.apply(ctx);
  return { registry, getCleanup: () => cleanup };
}

test('plugin exports contract and registers all five tools', (t) => {
  const { registry, getCleanup } = loadPlugin(t);
  assert.equal(plugin.name, 'nightdesk');
  assert.deepEqual(plugin.inject, ['tools']);
  assert.equal(typeof plugin.apply, 'function');
  assert.deepEqual([...registry.keys()], [
    'nightdesk_health', 'nightdesk_capture', 'nightdesk_items', 'nightdesk_confirm', 'nightdesk_complete',
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
  assert.equal(health.schemaVersion, 1);
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
