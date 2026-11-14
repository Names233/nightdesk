import { createChannel } from './channel.js';

const QQ_TOKEN_URL = 'https://api.bot.qq.com/app/getAppAccessToken';
const QQ_MESSAGE_PATH = '/v2/users/';
const PLUGIN_VERSION = '0.1.0';
const CAPABILITY_IDS = ['credential', 'proactive_text', 'passive_reply', 'attachment', 'binding'];

function atValue(now) {
  try {
    const value = typeof now === 'function' ? now() : now;
    const date = value instanceof Date ? value : new Date(value ?? Date.now());
    return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function safeText(value, secrets = []) {
  let text = String(value ?? '').slice(0, 500);
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[redacted]');
  }
  return text
    .replace(/clientSecret/gi, '[redacted-field]')
    .replace(/access_token/gi, '[redacted-field]')
    .slice(0, 500);
}

function safeError(cause, config = {}) {
  return safeText(cause instanceof Error ? cause.message : cause, [config?.clientSecret]);
}

function capability(id, state, detail, evidence = {}) {
  return { id, state, detail, evidence };
}

function responseBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function missingEnv(config, includeOpenid = true) {
  const missing = [];
  if (typeof config.appId !== 'string' || config.appId.length === 0) missing.push('NIGHTDESK_QQBOT_APP_ID');
  if (typeof config.clientSecret !== 'string' || config.clientSecret.length === 0) missing.push('NIGHTDESK_QQBOT_CLIENT_SECRET');
  if (includeOpenid && (typeof config.openid !== 'string' || config.openid.length === 0)) {
    missing.push('NIGHTDESK_QQBOT_OPENID');
  }
  return missing;
}

function maskExternalId(value) {
  const text = String(value ?? '');
  return text.length <= 7 ? `${text.slice(0, 3)}***` : `${text.slice(0, 3)}***${text.slice(-4)}`;
}

function credentialDetail(reason, evidence = {}) {
  const labels = {
    credential_rejected: 'QQ 凭据被服务端拒绝',
    network_failure: 'QQ 凭据请求网络失败',
    http_error: 'QQ 凭据服务端返回错误',
    malformed_response: 'QQ 凭据响应缺少有效令牌',
  };
  return { detail: labels[reason] ?? 'QQ 凭据未验证', evidence: { reason, ...evidence } };
}

async function readResponse(response) {
  const text = await response.text();
  return { status: response.status, text, body: responseBody(text) };
}

function wrappedResponse(captured) {
  return { status: captured.status, text: async () => captured.text };
}

async function credentialAttempt({ fetchImpl, config }) {
  const capture = { response: null, networkError: null, tokenSeen: false };
  if (typeof fetchImpl !== 'function') {
    return { verified: false, ...credentialDetail('network_failure', { error: 'fetch is unavailable' }), capture };
  }
  const tokenOnlyFetch = async (url, options) => {
    if (url !== QQ_TOKEN_URL) {
      const error = new Error('probe stopped before message submission');
      error.probeOnly = true;
      throw error;
    }
    try {
      const response = await fetchImpl(url, options);
      const parsed = await readResponse(response);
      capture.response = parsed;
      capture.tokenSeen = typeof parsed.body.access_token === 'string' && parsed.body.access_token.length > 0;
      return wrappedResponse(parsed);
    } catch (cause) {
      capture.networkError = safeError(cause, config);
      throw cause;
    }
  };
  try {
    const channel = createChannel({ ...config, kind: 'qqbot', openid: config.openid || 'probe-openid' }, { fetch: tokenOnlyFetch });
    await channel.send({ text: '[NightDesk probe credential only]' });
  } catch (cause) {
    if (!capture.response && !capture.networkError) capture.networkError = safeError(cause, config);
  }
  if (capture.networkError) {
    return { verified: false, ...credentialDetail('network_failure', { error: capture.networkError }), capture };
  }
  if (!capture.response) {
    return { verified: false, ...credentialDetail('network_failure', { error: 'no response' }), capture };
  }
  const { status, body } = capture.response;
  if (status === 401 || status === 403 || (body.code !== undefined && body.code !== 0)) {
    return { verified: false, ...credentialDetail('credential_rejected', { httpStatus: status, businessCode: body.code ?? null }), capture };
  }
  if (status < 200 || status >= 300) {
    return { verified: false, ...credentialDetail('http_error', { httpStatus: status }), capture };
  }
  if (!capture.tokenSeen) {
    return { verified: false, ...credentialDetail('malformed_response', { httpStatus: status }), capture };
  }
  return {
    verified: true,
    detail: 'QQ 凭据已换取访问令牌；令牌值不写入探针记录',
    evidence: { httpStatus: status, tokenReceived: true },
    capture,
  };
}

async function sendAttempt({ fetchImpl, config, text }) {
  const capture = { token: null, message: null, networkError: null };
  const observingFetch = async (url, options) => {
    try {
      const response = await fetchImpl(url, options);
      const parsed = await readResponse(response);
      if (url === QQ_TOKEN_URL) capture.token = parsed;
      else if (url.includes(QQ_MESSAGE_PATH)) capture.message = parsed;
      return wrappedResponse(parsed);
    } catch (cause) {
      capture.networkError = safeError(cause, config);
      throw cause;
    }
  };
  try {
    const channel = createChannel({ ...config, kind: 'qqbot' }, { fetch: observingFetch });
    const result = await channel.send({ text });
    return { result, capture };
  } catch (cause) {
    return { result: { ok: false, errorDetail: safeError(cause, config) }, capture };
  }
}

function bindingFor(store, config) {
  if (!store || typeof store.findChannelBinding !== 'function' || !config.appId) return null;
  return store.findChannelBinding({ channel: 'qq', appId: config.appId, externalId: config.openid });
}

function fallbackCapabilities(detail) {
  return [
    capability('credential', 'unverified', detail, { reason: 'probe_exception' }),
    capability('proactive_text', 'unverified', '主动文本探针未完成', { reason: 'probe_exception' }),
    capability('passive_reply', 'blocked', '本插件不接收入站事件；需官方 dsh-qqbot 插件提供 msg_id 才能验证被动回复', { requires: 'official dsh-qqbot msg_id' }),
    capability('attachment', 'missing', '当前未实现附件发送', { implemented: false }),
    capability('binding', 'unverified', '身份绑定探针未完成', { reason: 'probe_exception' }),
  ];
}

async function evaluate({ fetch: fetchImpl = globalThis.fetch, now = () => new Date(), config = {}, store, sendTest = false }) {
  const safeConfig = config && typeof config === 'object' ? config : {};
  const binding = bindingFor(store, safeConfig);
  const configuredMissing = missingEnv(safeConfig, true);
  const credentialMissing = missingEnv(safeConfig, false);
  let credential;
  let proactive;
  let bindingCapability;
  let attemptedSend = false;

  if (credentialMissing.length > 0) {
    credential = {
      verified: false,
      detail: `缺少 QQ 凭据：${credentialMissing.join('、')}`,
      evidence: { reason: 'missing_credentials', missing: credentialMissing },
    };
    proactive = capability('proactive_text', 'missing', `未发送主动消息；需要 ${configuredMissing.join('、') || 'QQ 配置'}`, { sent: false, missing: configuredMissing });
  } else if (sendTest) {
    if (!binding) {
      credential = await credentialAttempt({ fetchImpl, config: safeConfig });
      proactive = capability('proactive_text', 'missing', '未建立 QQ 身份绑定，未发送测试消息', { sent: false, reason: 'binding_missing' });
    } else {
      const send = await sendAttempt({
        fetchImpl,
        config: { ...safeConfig, openid: binding.external_id },
        text: `[NightDesk 测试] QQ 通道探针 ${atValue(now)}`,
      });
      attemptedSend = true;
      const token = send.capture.token;
      if (token?.status === 401 || token?.status === 403 || (token?.body?.code !== undefined && token.body.code !== 0)) {
        credential = { verified: false, ...credentialDetail('credential_rejected', { httpStatus: token.status, businessCode: token.body.code ?? null }) };
      } else if (send.capture.networkError && !token) {
        credential = { verified: false, ...credentialDetail('network_failure', { error: send.capture.networkError }) };
      } else if (token && (token.status < 200 || token.status >= 300)) {
        credential = { verified: false, ...credentialDetail('http_error', { httpStatus: token.status }) };
      } else if (!token || typeof token.body.access_token !== 'string' || token.body.access_token.length === 0) {
        credential = { verified: false, ...credentialDetail('malformed_response', { httpStatus: token?.status ?? null }) };
      } else {
        credential = { verified: true, detail: 'QQ 凭据已换取访问令牌；令牌值不写入探针记录', evidence: { httpStatus: token.status, tokenReceived: true } };
      }
      const message = send.capture.message;
      const accepted = send.result?.ok === true;
      const evidence = {
        sent: true,
        accepted,
        httpStatus: message?.status ?? send.result?.httpStatus ?? null,
        businessCode: message?.body?.code ?? null,
        channelMessageId: typeof send.result?.channelMessageId === 'string' ? send.result.channelMessageId : null,
      };
      proactive = accepted
        ? capability('proactive_text', 'verified', '服务端已受理测试主动文本；不代表手机已显示', evidence)
        : capability('proactive_text', 'unverified', safeText(send.result?.errorDetail ?? '服务端未受理测试主动文本', safeConfig.clientSecret ? [safeConfig.clientSecret] : []), evidence);
    }
  } else {
    const attempt = await credentialAttempt({ fetchImpl, config: safeConfig });
    credential = attempt;
    proactive = attempt.verified
      ? capability('proactive_text', 'unverified', '未发送真实测试消息；传入 sendTest=true 才会验证服务端受理', { sent: false, requires: 'sendTest=true' })
      : capability('proactive_text', 'missing', `未发送主动消息；${attempt.detail}`, { sent: false, reason: attempt.evidence?.reason ?? 'credential_unverified' });
  }

  const credentialCapability = capability('credential', credential.verified ? 'verified' : (credential.evidence?.reason === 'missing_credentials' ? 'missing' : 'unverified'), credential.detail, credential.evidence ?? {});
  if (credential.verified && binding) {
    const verified = typeof store?.verifyBinding === 'function' ? store.verifyBinding(binding.id, atValue(now)) : binding;
    bindingCapability = capability('binding', verified?.lastVerifiedAt ? 'verified' : 'unverified', 'QQ 身份绑定已建立并由本次凭据探针验证', {
      bindingId: binding.id,
      externalId: verified?.externalId ?? maskExternalId(binding.external_id),
      lastVerifiedAt: verified?.lastVerifiedAt ?? atValue(now),
    });
  } else if (!binding) {
    bindingCapability = capability('binding', 'missing', '未建立 QQ 身份绑定；请先绑定 openid', { required: 'nightdesk_bind_channel' });
  } else {
    bindingCapability = capability('binding', 'unverified', '已有 QQ 绑定，但本次凭据尚未验证通过', { bindingId: binding.id });
  }

  const capabilities = [
    credentialCapability,
    proactive,
    capability('passive_reply', 'blocked', '本插件不接收入站事件；需官方 dsh-qqbot 插件提供 msg_id 才能验证被动回复', { requires: 'official dsh-qqbot msg_id' }),
    capability('attachment', 'missing', '当前未实现附件发送', { implemented: false }),
    bindingCapability,
  ];
  const status = !credential.verified || (attemptedSend && proactive.state !== 'verified')
    ? 'fail'
    : capabilities.every(({ state }) => state === 'verified') ? 'pass' : 'partial';
  return { capabilities, status, notes: sendTest ? 'sendTest=true；主动文本结果仅证明服务端受理' : 'sendTest=false；未发送真实消息' };
}

export async function probeCapabilities(options = {}) {
  try {
    return (await evaluate(options)).capabilities;
  } catch (cause) {
    return fallbackCapabilities(safeError(cause, options.config ?? {}));
  }
}

export function createQqProbe({ fetch: fetchImpl = globalThis.fetch, now = () => new Date(), config = {}, store } = {}) {
  return {
    async run(options = {}) {
      const startedAt = atValue(now);
      const configSecrets = [config?.clientSecret];
      let result;
      try {
        if (!options || typeof options !== 'object' || Array.isArray(options)) {
          throw new Error('INVALID_ARGS options must be an object');
        }
        const sendTest = options.sendTest ?? false;
        if (typeof sendTest !== 'boolean') throw new Error('INVALID_ARGS sendTest must be a boolean');
        result = await evaluate({ fetch: fetchImpl, now, config, store, sendTest });
      } catch (cause) {
        result = { capabilities: fallbackCapabilities(safeError(cause, config)), status: 'fail', notes: safeError(cause, config) };
      }
      const finishedAt = atValue(now);
      const record = {
        kind: 'qq',
        startedAt,
        finishedAt,
        status: result.status,
        capabilities: result.capabilities,
        hostVersion: process.env.DSH_VERSION ?? null,
        pluginVersion: PLUGIN_VERSION,
        notes: safeText(result.notes, configSecrets),
      };
      try {
        return typeof store?.recordProbe === 'function' ? store.recordProbe(record) : { ...record, id: null, ownerId: null, createdAt: finishedAt };
      } catch (cause) {
        return {
          ...record,
          id: null,
          ownerId: null,
          createdAt: finishedAt,
          status: 'fail',
          capabilities: fallbackCapabilities(safeError(cause, config)),
          notes: safeError(cause, config),
        };
      }
    },
  };
}
