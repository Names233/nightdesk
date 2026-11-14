import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createQqProbe, probeCapabilities } from '../src/probe.js';
import { NightDeskStore } from '../src/store.js';

const NOW = '2026-11-14T10:00:00.000Z';
const CONFIG = { kind: 'qqbot', appId: 'app-123', clientSecret: 'secret-value', openid: 'openid-12345678' };

function response(status, body = {}) {
  return { status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}

function fixture(t, config = CONFIG) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nightdesk-probe-'));
  const store = new NightDeskStore({ dataDir, ownerId: 'probe-owner' });
  t.after(() => store.close());
  return { store, config };
}

function fixedNow() {
  return new Date(NOW);
}

function names(result) {
  return result.capabilities.map(({ id }) => id);
}

test('probe exports the requested factory and five stable capability ids', async () => {
  const capabilities = await probeCapabilities({ config: {}, fetch: async () => { throw new Error('must not fetch'); } });
  assert.deepEqual(capabilities.map(({ id }) => id), ['credential', 'proactive_text', 'passive_reply', 'attachment', 'binding']);
  assert.equal(typeof createQqProbe, 'function');
});

test('missing credentials fail without network access and name all required environment variables', async (t) => {
  const { store } = fixture(t, {});
  let calls = 0;
  const result = await createQqProbe({ store, config: {}, now: fixedNow, fetch: async () => { calls += 1; } }).run();
  assert.equal(calls, 0);
  assert.equal(result.status, 'fail');
  assert.deepEqual(names(result), ['credential', 'proactive_text', 'passive_reply', 'attachment', 'binding']);
  assert.equal(result.capabilities[0].state, 'missing');
  assert.match(result.capabilities[0].detail, /NIGHTDESK_QQBOT_APP_ID/);
  assert.match(result.capabilities[0].detail, /NIGHTDESK_QQBOT_CLIENT_SECRET/);
  assert.match(result.capabilities[1].detail, /NIGHTDESK_QQBOT_OPENID/);
  assert.equal(store.latestProbe('qq').id, result.id);
  assert.equal(JSON.stringify(result).includes('clientSecret'), false);
  assert.equal(JSON.stringify(result).includes('access_token'), false);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('credential-only probe accepts a successful token response without sending a message', async (t) => {
  const { store } = fixture(t);
  const calls = [];
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async (url, options) => { calls.push([url, options]); return response(200, { access_token: 'private-token', expires_in: 7200 }); },
  }).run();
  assert.equal(result.status, 'partial');
  assert.equal(result.capabilities[0].state, 'verified');
  assert.equal(result.capabilities[1].state, 'unverified');
  assert.equal(result.capabilities[1].evidence.sent, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /getAppAccessToken$/);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
  assert.equal(JSON.stringify(result).includes('access_token'), false);
});

test('credential probe distinguishes HTTP 401 credential rejection', async (t) => {
  const { store } = fixture(t);
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async () => response(401, { message: 'bad secret-value' }),
  }).run();
  assert.equal(result.status, 'fail');
  assert.equal(result.capabilities[0].state, 'unverified');
  assert.equal(result.capabilities[0].evidence.reason, 'credential_rejected');
  assert.equal(result.capabilities[0].evidence.httpStatus, 401);
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('credential probe distinguishes an HTTP 500 service failure', async (t) => {
  const { store } = fixture(t);
  const result = await createQqProbe({ store, config: CONFIG, now: fixedNow, fetch: async () => response(500, { error: 'temporary' }) }).run();
  assert.equal(result.status, 'fail');
  assert.equal(result.capabilities[0].evidence.reason, 'http_error');
  assert.equal(result.capabilities[0].evidence.httpStatus, 500);
});

test('credential probe distinguishes a network failure', async (t) => {
  const { store } = fixture(t);
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async () => { throw new Error('socket secret-value unavailable'); },
  }).run();
  assert.equal(result.status, 'fail');
  assert.equal(result.capabilities[0].evidence.reason, 'network_failure');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('credential probe distinguishes a nonzero business code', async (t) => {
  const { store } = fixture(t);
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async () => response(200, { code: 1001, message: 'clientSecret rejected' }),
  }).run();
  assert.equal(result.status, 'fail');
  assert.equal(result.capabilities[0].evidence.reason, 'credential_rejected');
  assert.equal(result.capabilities[0].evidence.businessCode, 1001);
  assert.equal(JSON.stringify(result).includes('clientSecret'), false);
});

test('binding is verified during a credential-only probe and remains masked', async (t) => {
  const { store } = fixture(t);
  const binding = store.bindChannel({ channel: 'qq', appId: CONFIG.appId, externalId: CONFIG.openid, displayName: 'phone' });
  assert.equal(binding.externalId, 'ope***5678');
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async () => response(200, { access_token: 'private-token' }),
  }).run();
  const bindingCapability = result.capabilities.find(({ id }) => id === 'binding');
  assert.equal(bindingCapability.state, 'verified');
  assert.equal(bindingCapability.evidence.externalId, 'ope***5678');
  assert.equal(store.channelBindings()[0].lastVerifiedAt, NOW);
  assert.equal(JSON.stringify(result).includes(CONFIG.openid), false);
});

test('sendTest sends an explicitly marked message and records server acceptance only', async (t) => {
  const { store } = fixture(t);
  store.bindChannel({ channel: 'qq', appId: CONFIG.appId, externalId: CONFIG.openid });
  const calls = [];
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async (url, options) => {
      calls.push([url, options]);
      return url.endsWith('getAppAccessToken')
        ? response(200, { access_token: 'private-token' })
        : response(200, { code: 0, id: 'message-123' });
    },
  }).run({ sendTest: true });
  const proactive = result.capabilities.find(({ id }) => id === 'proactive_text');
  assert.equal(result.status, 'partial');
  assert.equal(proactive.state, 'verified');
  assert.equal(proactive.detail.includes('手机'), true);
  assert.equal(proactive.evidence.httpStatus, 200);
  assert.equal(proactive.evidence.businessCode, 0);
  assert.equal(calls.length, 2);
  const body = JSON.parse(calls[1][1].body);
  assert.match(body.content, /^\[NightDesk 测试\]/);
  assert.equal(body.msg_type, 0);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('sendTest records a nonzero message business code as unverified', async (t) => {
  const { store } = fixture(t);
  store.bindChannel({ channel: 'qq', appId: CONFIG.appId, externalId: CONFIG.openid });
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async (url) => url.endsWith('getAppAccessToken')
      ? response(200, { access_token: 'private-token' })
      : response(200, { code: 3004, message: 'rejected' }),
  }).run({ sendTest: true });
  const proactive = result.capabilities.find(({ id }) => id === 'proactive_text');
  assert.equal(result.status, 'fail');
  assert.equal(proactive.state, 'unverified');
  assert.equal(proactive.evidence.businessCode, 3004);
  assert.equal(proactive.evidence.accepted, false);
});

test('sendTest records a message HTTP 500 without confusing it with device delivery', async (t) => {
  const { store } = fixture(t);
  store.bindChannel({ channel: 'qq', appId: CONFIG.appId, externalId: CONFIG.openid });
  const result = await createQqProbe({
    store, config: CONFIG, now: fixedNow,
    fetch: async (url) => url.endsWith('getAppAccessToken')
      ? response(200, { access_token: 'private-token' })
      : response(500, { error: 'server down' }),
  }).run({ sendTest: true });
  const proactive = result.capabilities.find(({ id }) => id === 'proactive_text');
  assert.equal(result.status, 'fail');
  assert.equal(proactive.state, 'unverified');
  assert.equal(proactive.evidence.httpStatus, 500);
  assert.equal(proactive.evidence.accepted, false);
});

test('passive reply and attachment remain explicitly blocked or missing', async (t) => {
  const { store } = fixture(t);
  const result = await createQqProbe({ store, config: {}, now: fixedNow, fetch: async () => response(500) }).run();
  assert.equal(result.capabilities.find(({ id }) => id === 'passive_reply').state, 'blocked');
  assert.equal(result.capabilities.find(({ id }) => id === 'attachment').state, 'missing');
  assert.match(result.capabilities.find(({ id }) => id === 'passive_reply').detail, /msg_id/);
  assert.match(result.capabilities.find(({ id }) => id === 'attachment').detail, /附件/);
});

test('run converts invalid options and a throwing clock into a persisted failure', async (t) => {
  const { store } = fixture(t, {});
  const probe = createQqProbe({ store, config: {}, now: () => { throw new Error('clock failure'); }, fetch: async () => response(500) });
  const result = await probe.run(null);
  assert.equal(result.status, 'fail');
  assert.equal(result.capabilities.length, 5);
  assert.equal(store.listProbes({ kind: 'qq' }).length, 1);
});

test('every probe run appends history and listProbes returns newest first', async (t) => {
  const { store } = fixture(t, {});
  const probe = createQqProbe({ store, config: {}, now: fixedNow, fetch: async () => response(500) });
  const first = await probe.run();
  const second = await probe.run();
  assert.notEqual(first.id, second.id);
  assert.equal(store.listProbes({ kind: 'qq', limit: 10 }).length, 2);
  assert.equal(store.latestProbe('qq').id, second.id);
});
