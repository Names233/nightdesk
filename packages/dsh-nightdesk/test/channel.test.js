import test from 'node:test';
import assert from 'node:assert/strict';
import { createChannel, channelHealth } from '../src/channel.js';

const message = { text: '截止提醒', itemId: 'item-1', dueAt: '2026-11-14T00:00:00.000Z', kind: 'due' };
const response = (status, body = '', json = false) => ({
  status,
  text: async () => json ? JSON.stringify(body) : body,
});

test('console channel is the default and returns a local acceptance identifier', async () => {
  const output = [];
  const channel = createChannel({}, { log: (text) => output.push(text) });
  assert.equal(channel.name, 'console');
  assert.deepEqual(await channel.send(message), { ok: true, channelMessageId: 'console-1', detail: 'console' });
  assert.deepEqual(output, [message.text]);
});

test('webhook channel is unavailable', () => {
  assert.throws(() => createChannel({ kind: 'webhook' }), /INVALID_ARGS.*channel kind/);
});

test('qqbot obtains a token then posts a private message without msg_seq', async () => {
  const calls = [];
  const channel = createChannel({ kind: 'qqbot', appId: 'app', clientSecret: 'secret', openid: 'open/id' }, {
    fetch: async (url, options) => {
      calls.push([url, options]);
      if (calls.length === 1) return response(200, { access_token: 'token', expires_in: 7200 }, true);
      return response(200, { code: 0, id: 'message-1' }, true);
    },
  });
  const first = await channel.send(message);
  const second = await channel.send(message);
  assert.equal(first.ok, true);
  assert.equal(first.channelMessageId, 'message-1');
  assert.equal(calls.length, 3, 'token is reused for the second message');
  assert.equal(calls[0][0], 'https://api.bot.qq.com/app/getAppAccessToken');
  assert.deepEqual(JSON.parse(calls[0][1].body), { appId: 'app', clientSecret: 'secret' });
  assert.equal(calls[1][0], 'https://api.bot.qq.com/v2/users/open%2Fid/messages');
  assert.equal(calls[1][1].headers.Authorization, 'QQBot token');
  assert.deepEqual(JSON.parse(calls[1][1].body), { content: message.text, msg_type: 0 });
  assert.equal(Object.hasOwn(JSON.parse(calls[2][1].body), 'msg_seq'), false);
  assert.equal(second.ok, true);
});

test('qqbot rejects malformed 2xx responses and nonzero application codes', async () => {
  for (const reply of [response(200), response(200, 'not json'), response(200, { code: 123 }, true)]) {
    let calls = 0;
    const channel = createChannel({ kind: 'qqbot', appId: 'app', clientSecret: 'secret', openid: 'open' }, {
      fetch: async () => {
        calls += 1;
        return calls === 1 ? response(200, { access_token: 'private-token' }, true) : reply;
      },
    });
    const result = await channel.send(message);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, 200);
  }
});

test('qqbot accepts a code-free response only when it has a string id', async () => {
  const channel = createChannel({ kind: 'qqbot', appId: 'app', clientSecret: 'secret', openid: 'open' }, {
    fetch: async (url) => url.includes('/app/')
      ? response(200, { access_token: 'token' }, true)
      : response(201, { id: 'message-2' }, true),
  });
  assert.deepEqual(await channel.send(message), {
    ok: true, httpStatus: 201, channelMessageId: 'message-2', errorDetail: null,
  });
});

test('qqbot rejects non-2xx and redacts secrets', async () => {
  const failures = [
    [response(401, 'bad secret'), 401],
    [response(200, { code: 123, message: 'denied secret' }, true), 200],
  ];
  for (const [reply, status] of failures) {
    let calls = 0;
    const channel = createChannel({ kind: 'qqbot', appId: 'app', clientSecret: 'secret', openid: 'open' }, {
      fetch: async () => {
        calls += 1;
        return calls === 1 ? response(200, { access_token: 'private-token' }, true) : reply;
      },
    });
    const result = await channel.send(message);
    assert.equal(result.ok, false);
    assert.equal(result.httpStatus, status);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.ok(result.errorDetail.length <= 500);
  }
});

test('missing credentials are never returned by channel health', () => {
  assert.deepEqual(channelHealth({ kind: 'console' }), { name: 'console', configured: true });
  assert.deepEqual(channelHealth({ kind: 'qqbot', appId: 'app', clientSecret: 'secret' }), { name: 'qqbot', configured: false });
  assert.throws(() => createChannel({ kind: 'qqbot', appId: 'app' }), /clientSecret/);
  assert.throws(() => createChannel({ kind: 'unknown' }), /INVALID_ARGS.*kind/);
});
