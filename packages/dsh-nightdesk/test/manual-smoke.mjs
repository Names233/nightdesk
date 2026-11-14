import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightDeskStore } from '../src/store.js';

const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-smoke-'));
const store = new NightDeskStore({ dataDir, ownerId: 'manual-smoke' });
try {
  const captured = store.capture({ text: '今晚核对提交入口。\n2026-11-20 交作业', sourceLabel: 'manual-smoke', idempotencyKey: 'smoke-001' });
  console.log('capture', JSON.stringify(captured, null, 2));
  const target = captured.candidates.find(({ timeStatus }) => timeStatus === 'resolved') ?? captured.candidates[0];
  const confirmed = store.confirm({ itemId: target.itemId, expectedVersion: target.version });
  console.log('confirm', JSON.stringify(confirmed, null, 2));
  const items = store.items({ view: 'all', includeUnconfirmed: true, limit: 50 });
  console.log('items', JSON.stringify(items, null, 2));
  console.log('health', JSON.stringify(store.health(), null, 2));
} finally {
  store.close();
}
