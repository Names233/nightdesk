import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function invalid(message) {
  return new Error(`INVALID_ARGS ${message}`);
}

function redact(value, secrets) {
  let text = String(value ?? '').slice(0, 500);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
  }
  return text.slice(0, 500);
}

function failure(message, httpStatus = null, errorDetail = message) {
  return { ok: false, httpStatus, error: redact(message, []), errorDetail };
}

export function loadChannelConfig(dataDir) {
  let configured = {};
  try {
    configured = JSON.parse(readFileSync(join(dataDir, 'channel.json'), 'utf8'));
  } catch (cause) {
    if (cause?.code !== 'ENOENT') throw invalid(`channel.json must contain valid JSON: ${cause.message}`);
  }
  const env = process.env;
  const kind = env.NIGHTDESK_CHANNEL_KIND ?? configured.kind ?? 'console';
  const file = configured[kind] && typeof configured[kind] === 'object' ? { ...configured, ...configured[kind] } : configured;
  return {
    ...file,
    kind,
    appId: env.NIGHTDESK_QQBOT_APP_ID ?? file.appId,
    clientSecret: env.NIGHTDESK_QQBOT_CLIENT_SECRET ?? file.clientSecret,
    openid: env.NIGHTDESK_QQBOT_OPENID ?? file.openid,
  };
}

export function channelHealth(config) {
  const name = config.kind ?? 'console';
  const required = name === 'qqbot' ? ['appId', 'clientSecret', 'openid'] : [];
  const supported = name === 'console' || name === 'qqbot';
  return { name, configured: supported && required.every((key) => typeof config[key] === 'string' && config[key].length > 0) };
}

/** Return transport facts only; a 2xx response is channel acceptance, never device delivery. */
export function createChannel(config = {}, deps = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw invalid('config must be an object');
  const kind = config.kind ?? 'console';
  if (!['console', 'qqbot'].includes(kind)) throw invalid('channel kind must be console or qqbot');
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const log = deps.log ?? (() => {});
  let consoleSequence = 0;

  if (kind === 'console') {
    return {
      name: kind,
      async send(message) {
        consoleSequence += 1;
        log(String(message.text));
        return { ok: true, channelMessageId: `console-${consoleSequence}`, detail: 'console' };
      },
    };
  }

  const appId = config.appId;
  const clientSecret = config.clientSecret;
  const openid = config.openid;
  if (![appId, clientSecret, openid].every((value) => typeof value === 'string' && value.length > 0)) {
    throw invalid('qqbot appId, clientSecret and openid are required');
  }
  let token = null;
  let tokenExpiresAt = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExpiresAt) return token;
    const response = await fetchImpl('https://api.bot.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId, clientSecret }),
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = {}; }
    if (response.status < 200 || response.status >= 300 || typeof body.access_token !== 'string' || body.access_token.length === 0) {
      throw new Error(redact(text || `QQ token HTTP ${response.status}`, [clientSecret, body.access_token]));
    }
    token = body.access_token;
    const expires = Number(body.expires_in);
    tokenExpiresAt = Date.now() + (Number.isFinite(expires) && expires > 0 ? Math.max(1, expires - 60) * 1000 : 60_000);
    return token;
  }

  return {
    name: kind,
    async send(message) {
      if (typeof fetchImpl !== 'function') return failure('fetch is unavailable');
      let access;
      try {
        access = await accessToken();
      } catch (cause) {
        return { ok: false, errorDetail: redact(cause instanceof Error ? cause.message : cause, [clientSecret, token]) };
      }
      try {
        const response = await fetchImpl(`https://api.bot.qq.com/v2/users/${encodeURIComponent(openid)}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `QQBot ${access}` },
          body: JSON.stringify({ content: message.text, msg_type: 0 }),
        });
        const text = await response.text();
        let body;
        try { body = JSON.parse(text); } catch { body = {}; }
        const ok = response.status >= 200 && response.status < 300
          && (body.code === 0 || (body.code === undefined && typeof body.id === 'string' && body.id.length > 0));
        const errorDetail = ok ? null : redact(text || `QQ message HTTP ${response.status}`, [clientSecret, access]);
        return { ok, httpStatus: response.status, channelMessageId: typeof body.id === 'string' ? body.id : null, errorDetail };
      } catch (cause) {
        return { ok: false, errorDetail: redact(cause instanceof Error ? cause.message : cause, [clientSecret, access]) };
      }
    },
  };
}
