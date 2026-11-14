import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NightDeskStore } from '../src/store.js';
import { createSessionProbe } from '../src/sessions-probe.js';
import { createTools } from '../src/tools.js';

const READ_AT = '2026-11-14T14:10:00.000Z';
const EVENT_AT = Date.parse('2026-11-14T14:02:11.000Z');

function makeStore(ownerId = 'owner-test') {
  const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-sessions-'));
  const store = new NightDeskStore({ dataDir, ownerId });
  return {
    store,
    close() {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function makeProbe(store, query, now = READ_AT) {
  return createSessionProbe({ getSessionQuery: () => query, now: () => now, store });
}

function surface({ id, live, persisted, capturedThroughSeq = 0, inheritedEventCount = 0, events = [] }) {
  return {
    session: { header: { id }, live, persisted, formatStatus: 'ok' },
    inheritedEventCount,
    capturedThroughSeq,
    events,
  };
}

function findTool(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

test('schema v4 creates watched_sessions and starts empty', () => {
  const fixture = makeStore();
  try {
    assert.equal(fixture.store.health().schemaVersion, 4);
    assert.deepEqual(fixture.store.listWatchedSessions({ ownerId: 'owner-test' }), []);
  } finally {
    fixture.close();
  }
});

test('watch stores a record with RFC3339 added time', () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, {}, READ_AT);
    const watched = probe.watch({ ownerId: 'owner-test', sessionId: 'session-1', label: 'build' });
    assert.equal(typeof watched.id, 'string');
    const [record] = probe.list({ ownerId: 'owner-test' });
    assert.equal(record.ownerId, 'owner-test');
    assert.equal(record.sessionId, 'session-1');
    assert.equal(record.label, 'build');
    assert.equal(record.addedAt, READ_AT);
    assert.equal(record.lastReadAt, null);
  } finally {
    fixture.close();
  }
});

test('duplicate watch is idempotent and updates the label', () => {
  const fixture = makeStore();
  try {
    const firstProbe = makeProbe(fixture.store, {}, READ_AT);
    firstProbe.watch({ ownerId: 'owner-test', sessionId: 'session-1', label: 'old' });
    const secondProbe = makeProbe(fixture.store, {}, '2026-11-14T14:11:00.000Z');
    const updated = secondProbe.watch({ ownerId: 'owner-test', sessionId: 'session-1', label: 'new' });
    assert.equal(updated.label, 'new');
    assert.equal(secondProbe.list({ ownerId: 'owner-test' }).length, 1);
    assert.equal(updated.addedAt, READ_AT);
    assert.equal(updated.updatedAt, '2026-11-14T14:11:00.000Z');
  } finally {
    fixture.close();
  }
});

test('unwatch reports false for an item that is not present', () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, {}, READ_AT);
    assert.deepEqual(probe.unwatch({ ownerId: 'owner-test', sessionId: 'missing' }), { removed: false });
  } finally {
    fixture.close();
  }
});

test('refresh reads a live session and returns the last event range', () => {
  const fixture = makeStore();
  try {
    const query = {
      readSurface(id) {
        assert.equal(id, 'live-1');
        return surface({
          id,
          live: true,
          persisted: true,
          capturedThroughSeq: 412,
          events: [{ type: 'assistant/message', seq: 412, time: EVENT_AT, data: {} }],
        });
      },
    };
    const probe = makeProbe(fixture.store, query);
    probe.watch({ ownerId: 'owner-test', sessionId: 'live-1', label: 'live build' });
    const [result] = probe.refresh({ ownerId: 'owner-test' });
    assert.deepEqual(result, {
      sessionId: 'live-1',
      label: 'live build',
      found: true,
      live: true,
      persisted: true,
      capturedThroughSeq: 412,
      eventCount: 1,
      inheritedEventCount: 0,
      lastEvent: { type: 'assistant/message', seq: 412, time: '2026-11-14T14:02:11.000Z' },
      readAt: READ_AT,
      runState: 'unknown',
      runStateReason: 'host read seam does not expose run state',
      status: 'read_ok',
      error: null,
    });
    const [record] = probe.list({ ownerId: 'owner-test' });
    assert.equal(record.lastSeq, 412);
    assert.equal(record.lastEventType, 'assistant/message');
    assert.equal(record.status, 'read_ok');
  } finally {
    fixture.close();
  }
});

test('refresh supports a persisted-only session with no events', () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, {
      readSurface: () => surface({ id: 'persisted-1', live: false, persisted: true, events: [] }),
    });
    probe.watch({ ownerId: 'owner-test', sessionId: 'persisted-1' });
    const [result] = probe.refresh({ ownerId: 'owner-test' });
    assert.equal(result.found, true);
    assert.equal(result.live, false);
    assert.equal(result.persisted, true);
    assert.equal(result.eventCount, 0);
    assert.equal(result.lastEvent, null);
    assert.equal(result.runState, 'unknown');
    assert.equal(result.status, 'read_ok');
  } finally {
    fixture.close();
  }
});

test('session query not-found errors become not_found records', () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, {
      readSurface() {
        throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
      },
    });
    probe.watch({ ownerId: 'owner-test', sessionId: 'gone' });
    const [result] = probe.refresh({ ownerId: 'owner-test' });
    assert.equal(result.found, false);
    assert.equal(result.status, 'not_found');
    assert.equal(result.error, 'SESSION_QUERY_SESSION_NOT_FOUND');
    assert.equal(probe.list({ ownerId: 'owner-test' })[0].lastReadAt, READ_AT);
  } finally {
    fixture.close();
  }
});

test('unexpected session query errors become read_failed records', () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, {
      readSurface() {
        throw Object.assign(new Error('host broke'), { code: 'HOST_READ_FAILED' });
      },
    });
    probe.watch({ ownerId: 'owner-test', sessionId: 'broken' });
    const [result] = probe.refresh({ ownerId: 'owner-test' });
    assert.equal(result.status, 'read_failed');
    assert.equal(result.error, 'HOST_READ_FAILED');
    assert.equal(result.runState, 'unknown');
  } finally {
    fixture.close();
  }
});

test('one failed session does not prevent the other sessions from refreshing', () => {
  const fixture = makeStore();
  try {
    const calls = [];
    const probe = makeProbe(fixture.store, {
      readSurface(id) {
        calls.push(id);
        if (id === 'bad') throw Object.assign(new Error('bad'), { code: 'BROKEN_SESSION' });
        return surface({ id, live: true, persisted: true, capturedThroughSeq: 8,
          events: [{ type: 'user/message', seq: 8, time: EVENT_AT, data: {} }] });
      },
    });
    probe.watch({ ownerId: 'owner-test', sessionId: 'bad' });
    probe.watch({ ownerId: 'owner-test', sessionId: 'good' });
    const results = probe.refresh({ ownerId: 'owner-test' });
    assert.deepEqual(calls.sort(), ['bad', 'good']);
    assert.equal(results.length, 2);
    assert.deepEqual(results.map(({ status }) => status).sort(), ['read_failed', 'read_ok']);
  } finally {
    fixture.close();
  }
});

test('refresh can select a subset of watched sessions', () => {
  const fixture = makeStore();
  try {
    const calls = [];
    const probe = makeProbe(fixture.store, {
      readSurface(id) {
        calls.push(id);
        return surface({ id, live: false, persisted: true });
      },
    });
    probe.watch({ ownerId: 'owner-test', sessionId: 'one' });
    probe.watch({ ownerId: 'owner-test', sessionId: 'two' });
    const results = probe.refresh({ ownerId: 'owner-test', sessionIds: ['two'] });
    assert.deepEqual(calls, ['two']);
    assert.deepEqual(results.map(({ sessionId }) => sessionId), ['two']);
  } finally {
    fixture.close();
  }
});

test('missing sessionQuery is a soft dependency and does not throw', () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, undefined);
    probe.watch({ ownerId: 'owner-test', sessionId: 'headless' });
    assert.deepEqual(probe.refresh({ ownerId: 'owner-test' }), {
      available: false,
      reason: 'sessionQuery-unavailable',
    });
    assert.deepEqual(probe.list({ ownerId: 'owner-test' }).map(({ sessionId }) => sessionId), ['headless']);
  } finally {
    fixture.close();
  }
});

test('session tools expose watch, unwatch and refresh behavior', async () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, {
      readSurface: () => surface({ id: 'tool-session', live: true, persisted: true }),
    });
    const tools = createTools(fixture.store, { sessionProbe: probe });
    assert.deepEqual(tools.filter(({ name }) => name.startsWith('nightdesk_session') || name === 'nightdesk_sessions')
      .map(({ name }) => name), [
      'nightdesk_session_watch', 'nightdesk_session_unwatch', 'nightdesk_sessions',
    ]);
    await findTool(tools, 'nightdesk_session_watch').execute({ sessionId: 'tool-session' });
    const refreshed = await findTool(tools, 'nightdesk_sessions').execute({ refresh: true });
    assert.equal(refreshed.available, true);
    assert.equal(refreshed.sessions[0].status, 'read_ok');
    const removed = await findTool(tools, 'nightdesk_session_unwatch').execute({ sessionId: 'tool-session' });
    assert.deepEqual(removed, { removed: true });
  } finally {
    fixture.close();
  }
});

test('session tool reports unavailable when the host service is absent', async () => {
  const fixture = makeStore();
  try {
    const probe = makeProbe(fixture.store, undefined);
    const tools = createTools(fixture.store, { sessionProbe: probe });
    const result = await findTool(tools, 'nightdesk_sessions').execute({});
    assert.deepEqual(result, { available: false, reason: 'sessionQuery-unavailable' });
  } finally {
    fixture.close();
  }
});
