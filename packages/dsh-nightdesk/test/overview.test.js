import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverview } from '../src/overview.js';
import { createTools } from '../src/tools.js';

const NOW = '2026-11-14T14:30:00.000Z';

function storeFixture({ items = [], probe = null, bindings = [], ownerId = 'overview-owner' } = {}) {
  return {
    ownerId,
    listItemsForOverview: () => items,
    latestProbe: () => probe,
    channelBindings: () => bindings,
  };
}

function item(id, values = {}) {
  return {
    id,
    title: values.title ?? id,
    dueAt: values.dueAt ?? null,
    timeStatus: values.timeStatus ?? 'resolved',
    completion: values.completion ?? 'unconfirmed',
    confirmed: values.confirmed ?? false,
    version: values.version ?? 1,
    updatedAt: values.updatedAt ?? '2026-11-14T10:00:00.000Z',
    ...values,
  };
}

function makeOverview(options = {}) {
  const store = options.store ?? storeFixture(options);
  return createOverview({ store, sessionProbe: options.sessionProbe, now: () => NOW, config: options.config ?? {} });
}

test('empty overview returns empty arrays and zero ranges', () => {
  const value = makeOverview().build({ ownerId: 'overview-owner' });
  assert.deepEqual(value.today.items, []);
  assert.deepEqual(value.pending.items, []);
  assert.deepEqual(value.pending.channels, []);
  assert.deepEqual(value.pending.sessions, []);
  assert.deepEqual(value.recent.items, []);
  assert.deepEqual(value.health.channels, []);
  assert.deepEqual(value.health.sessions, []);
  assert.deepEqual(value.today.range, { scannedItems: 0 });
  assert.deepEqual(value.pending.range, { scannedItems: 0 });
  assert.deepEqual(value.recent.range, { scannedItems: 0 });
  assert.deepEqual(value.health.range, { sessionsWatched: 0 });
});

test('today only includes unfinished Shanghai instants and sorts by dueAt', () => {
  const overview = makeOverview({ items: [
    item('late', { title: '晚上的报告', dueAt: '2026-11-14T12:00:00.000Z' }),
    item('early', { title: '早上的作业', dueAt: '2026-11-14T00:00:00.000Z' }),
    item('done', { dueAt: '2026-11-14T04:00:00.000Z', completion: 'manual_complete', confirmed: true }),
    item('tomorrow', { dueAt: '2026-11-15T00:00:00.000Z' }),
  ]});
  const value = overview.build({ ownerId: 'overview-owner' });
  assert.deepEqual(value.today.items.map(({ id }) => id), ['early', 'late']);
  assert.equal(value.today.items[0].title, '早上的作业');
  assert.equal(value.today.items[0].completion, 'unconfirmed');
  assert.equal(value.today.range.scannedItems, 4);
});

test('candidate, ambiguous and conflicted confirmed items enter pending in update order', () => {
  const overview = makeOverview({ items: [
    item('ambiguous', { confirmed: true, timeStatus: 'ambiguous', updatedAt: '2026-11-14T09:00:00.000Z' }),
    item('candidate', { confirmed: false, updatedAt: '2026-11-14T08:00:00.000Z' }),
    item('conflicted', { confirmed: true, completion: 'conflicted', updatedAt: '2026-11-14T10:00:00.000Z' }),
    item('clear', { confirmed: true, completion: 'unconfirmed', updatedAt: '2026-11-14T07:00:00.000Z' }),
  ]});
  const value = overview.build({ ownerId: 'overview-owner' });
  assert.deepEqual(value.pending.items.map(({ id }) => id), ['candidate', 'ambiguous', 'conflicted']);
});

test('pending items are capped at twenty after scanning all items', () => {
  const items = Array.from({ length: 21 }, (_, index) => item(`candidate-${index}`, {
    updatedAt: `2026-11-${String(1 + Math.floor(index / 3)).padStart(2, '0')}T00:00:00.000Z`,
  }));
  const value = makeOverview({ items }).build({ ownerId: 'overview-owner' });
  assert.equal(value.pending.items.length, 20);
  assert.equal(value.pending.range.scannedItems, 21);
});

test('recent completion window includes the seventh day and excludes the eighth day', () => {
  const overview = makeOverview({ items: [
    item('day-seven', { completion: 'manual_complete', confirmed: true, updatedAt: '2026-11-07T00:00:00.000Z' }),
    item('day-eight', { completion: 'source_complete', confirmed: true, updatedAt: '2026-11-06T23:59:59.999Z' }),
    item('today', { completion: 'source_complete', confirmed: true, updatedAt: '2026-11-14T13:00:00.000Z' }),
  ]});
  const value = overview.build({ ownerId: 'overview-owner' });
  assert.equal(value.recent.since, '2026-11-07T00:00:00.000Z');
  assert.deepEqual(value.recent.items.map(({ id }) => id), ['today', 'day-seven']);
  assert.deepEqual(value.recent.items.map(({ completion }) => completion), ['source_complete', 'manual_complete']);
});

test('failed QQ probe enters pending and health masks the app id', () => {
  const probe = {
    status: 'fail',
    finishedAt: '2026-11-14T13:40:00.000Z',
    capabilities: [
      { id: 'credential', state: 'missing', detail: '缺少 QQ 凭据：NIGHTDESK_QQBOT_APP_ID' },
      { id: 'proactive_text', state: 'missing' },
    ],
  };
  const overview = makeOverview({ probe, config: { kind: 'qq', appId: 'app-secret-id' } });
  const value = overview.build({ ownerId: 'overview-owner' });
  assert.equal(value.pending.channels.length, 1);
  assert.match(value.pending.channels[0].message, /NIGHTDESK_QQBOT_APP_ID/);
  assert.deepEqual(value.health.channels[0], {
    channel: 'qq',
    appIdMasked: 'app***t-id',
    lastProbeAt: '2026-11-14T13:40:00.000Z',
    status: 'fail',
    capabilitiesSummary: [
      { id: 'credential', state: 'missing' },
      { id: 'proactive_text', state: 'missing' },
    ],
  });
});

test('refreshSessions controls host reads and keeps stored read timestamps when false', () => {
  let refreshes = 0;
  const records = [{ sessionId: 'session-1', label: '编译', lastReadAt: '2026-11-14T12:00:00.000Z', lastSeq: 4, lastEventAt: null, lastEventType: null, status: 'read_ok', error: null }];
  const sessionProbe = {
    list: () => records,
    refresh: ({ ownerId }) => {
      assert.equal(ownerId, 'overview-owner');
      refreshes += 1;
      records[0] = { ...records[0], lastReadAt: NOW, lastSeq: 5 };
      return records;
    },
  };
  const overview = makeOverview({ sessionProbe });
  assert.equal(overview.build({ ownerId: 'overview-owner' }).health.sessions[0].lastReadAt, '2026-11-14T12:00:00.000Z');
  assert.equal(refreshes, 0);
  const refreshed = overview.build({ ownerId: 'overview-owner', refreshSessions: true });
  assert.equal(refreshes, 1);
  assert.equal(refreshed.health.sessions[0].capturedThroughSeq, 5);
});

test('failed watched sessions are pending while health keeps runState unknown', () => {
  const sessionProbe = {
    list: () => [{ sessionId: 'gone', label: '旧会话', lastReadAt: NOW, lastSeq: null, lastEventAt: null, lastEventType: null, status: 'not_found', error: 'SESSION_QUERY_SESSION_NOT_FOUND' }],
  };
  const value = makeOverview({ sessionProbe }).build({ ownerId: 'overview-owner' });
  assert.deepEqual(value.health.sessions[0], {
    sessionId: 'gone', label: '旧会话', lastReadAt: NOW, capturedThroughSeq: null,
    lastEventAt: null, lastEventType: null, runState: 'unknown',
  });
  assert.equal(value.pending.sessions[0].status, 'not_found');
  assert.equal(value.pending.sessions[0].error, 'SESSION_QUERY_SESSION_NOT_FOUND');
});

test('overview summary includes date and counts without calling unconfirmed work completed', () => {
  const overview = makeOverview({ items: [
    item('pending', { title: '周五前交', timeStatus: 'unknown' }),
    item('done', { title: '实验报告', confirmed: true, completion: 'manual_complete', updatedAt: '2026-11-14T13:00:00.000Z' }),
  ]});
  const value = overview.build({ ownerId: 'overview-owner' });
  const summary = overview.summary(value);
  assert.match(summary, /今日（11月14日）：0 件到期/);
  assert.match(summary, /待我拍板：1 条/);
  assert.match(summary, /最近完成：1 条/);
  assert.match(summary, /实验报告/);
  assert.doesNotMatch(summary, /周五前交.*已完成/);
});

test('overview tool renders JSON and a separate Chinese summary block', async () => {
  const store = storeFixture();
  const overview = createOverview({ store, now: () => NOW, config: {} });
  const overviewTool = createTools(store, { overview }).find(({ name }) => name === 'nightdesk_overview');
  const value = await overviewTool.execute({ refreshSessions: false }, {});
  const blocks = overviewTool.output.render({}, value);
  assert.equal(blocks.length, 2);
  assert.equal(JSON.parse(blocks[0].text).readAt, NOW);
  assert.match(blocks[1].text, /今日（11月14日）/);
});
