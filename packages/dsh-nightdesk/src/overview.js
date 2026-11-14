import { TIME_ZONE } from './dates.js';

const RUN_STATE = 'unknown';
const RUN_STATE_REASON = 'host read seam does not expose run state';
const COMPLETION_LABELS = {
  manual_complete: '手动标记完成',
  source_complete: '来源确认完成',
  conflicted: '完成状态冲突',
  unconfirmed: '未确认',
};

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error('INVALID_ARGS now must be a valid date');
  return date;
}

function nowValue(now) {
  return asDate(typeof now === 'function' ? now() : now);
}

function dateParts(value, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value).filter(({ type }) => type !== 'literal').map(({ type, value: part }) => [type, part]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function dateString(value, timeZone) {
  const { year, month, day } = dateParts(value, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDate(value, days) {
  const [year, month, day] = value.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(shifted.getUTCFullYear()).padStart(4, '0')}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

function isValidInstant(value) {
  return typeof value === 'string' && Number.isFinite(new Date(value).getTime());
}

function normalizeItem(item) {
  return {
    id: item.id ?? item.itemId,
    title: item.title ?? '',
    dueAt: item.dueAt ?? item.due_at ?? null,
    timeStatus: item.timeStatus ?? item.time_status ?? 'unknown',
    completion: item.completion ?? 'unconfirmed',
    version: item.version ?? null,
    updatedAt: item.updatedAt ?? item.updated_at ?? null,
    confirmed: item.confirmed === true || item.confirmed === 1,
    status: item.status ?? null,
  };
}

function publicItem(item) {
  return {
    id: item.id ?? null,
    title: item.title,
    dueAt: item.dueAt,
    timeStatus: item.timeStatus,
    completion: item.completion,
    version: item.version,
    updatedAt: item.updatedAt,
  };
}

function compareAscending(a, b, field) {
  const left = a[field] ?? '';
  const right = b[field] ?? '';
  return String(left).localeCompare(String(right)) || String(a.id ?? '').localeCompare(String(b.id ?? ''));
}

function compareDescending(a, b, field) {
  return compareAscending(b, a, field);
}

function isCandidate(item) {
  return item.status === 'candidate' || !item.confirmed;
}

function needsDecision(item) {
  return isCandidate(item)
    || (item.confirmed && ['unknown', 'ambiguous', 'conflicted'].includes(item.timeStatus))
    || (item.confirmed && item.completion === 'conflicted');
}

function itemReason(item) {
  if (isCandidate(item)) return '未确认，需要拍板';
  if (item.completion === 'conflicted') return '完成状态冲突，需要核对';
  if (item.timeStatus === 'unknown') return '时间未知，需要确认具体日期';
  if (item.timeStatus === 'ambiguous') return '时间有歧义，需要确认具体时刻';
  if (item.timeStatus === 'conflicted') return '时间冲突，需要核对';
  return '需要核对';
}

function readItems(store, ownerId) {
  let result;
  if (typeof store.listItemsForOverview === 'function') {
    result = store.listItemsForOverview({ ownerId });
  } else if (typeof store.listItems === 'function') {
    result = store.listItems({ ownerId });
  } else if (typeof store.items === 'function') {
    result = store.items({ view: 'all', includeUnconfirmed: true, limit: 100 });
    result = result?.items ?? result;
  } else if (store.db && typeof store.db.prepare === 'function') {
    result = store.db.prepare('SELECT * FROM items WHERE owner_id = ? ORDER BY updated_at, id').all(ownerId);
  } else {
    result = [];
  }
  if (!Array.isArray(result)) return [];
  return result.map(normalizeItem).filter(({ id }) => id !== undefined && id !== null);
}

function maskAppId(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  return text.length <= 7 ? `${text.slice(0, 3)}***` : `${text.slice(0, 3)}***${text.slice(-4)}`;
}

function latestProbe(store) {
  if (typeof store.latestProbe !== 'function') return null;
  return store.latestProbe('qq');
}

function capabilitySummary(probe) {
  if (!probe || !Array.isArray(probe.capabilities)) return null;
  return probe.capabilities.map((capability) => ({
    id: capability?.id ?? null,
    state: capability?.state ?? null,
  }));
}

function channelIssue(probe) {
  if (!probe || probe.status === 'pass') return null;
  const credential = probe.capabilities?.find(({ id }) => id === 'credential');
  const proactive = probe.capabilities?.find(({ id }) => id === 'proactive_text');
  if (credential?.state === 'missing' || credential?.evidence?.reason === 'missing_credentials') {
    return credential.detail ?? '缺少 QQ 凭据';
  }
  if (proactive?.evidence?.sent === true && proactive?.evidence?.accepted === false) {
    return 'QQ 通道投放失败，服务端未受理消息';
  }
  if (proactive?.state === 'unverified') return proactive.detail ?? 'QQ 通道投放尚未验证';
  if (probe.status === 'fail') return 'QQ 通道探测未通过';
  return 'QQ 通道能力未完全验证';
}

function channelRows(store, config, probe) {
  const bindings = typeof store.channelBindings === 'function' ? store.channelBindings() : [];
  const configuredKind = config?.kind ?? 'console';
  const rows = [];
  const add = (channel, appId) => {
    const normalizedChannel = channel === 'qqbot' ? 'qq' : channel;
    const key = `${normalizedChannel}:${appId ?? ''}`;
    if (rows.some((row) => row.key === key)) return;
    rows.push({
      key,
      channel: normalizedChannel ?? null,
      appIdMasked: maskAppId(appId),
      lastProbeAt: normalizedChannel === 'qq' ? (probe?.finishedAt ?? probe?.startedAt ?? null) : null,
      status: normalizedChannel === 'qq' ? (probe?.status ?? 'unknown') : 'unknown',
      capabilitiesSummary: normalizedChannel === 'qq' ? capabilitySummary(probe) : null,
    });
  };

  if (config && config.kind && (configuredKind !== 'console' || config.appId)) add(configuredKind, config?.appId);
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    add(binding?.channel ?? null, binding?.appId ?? binding?.app_id ?? null);
  }
  if (probe && !rows.some(({ channel }) => channel === 'qq')) add('qq', config?.appId);
  return rows.map(({ key, ...row }) => row);
}

function sessionRows(sessionProbe, ownerId) {
  if (!sessionProbe || typeof sessionProbe.list !== 'function') return [];
  const records = sessionProbe.list({ ownerId });
  if (!Array.isArray(records)) return [];
  return records.map((record) => ({
    sessionId: record.sessionId ?? null,
    label: record.label ?? null,
    lastReadAt: record.lastReadAt ?? null,
    capturedThroughSeq: record.lastSeq ?? null,
    lastEventAt: record.lastEventAt ?? null,
    lastEventType: record.lastEventType ?? null,
    runState: RUN_STATE,
    status: record.status ?? null,
    error: record.error ?? null,
  }));
}

function formatClock(value, timeZone) {
  if (!isValidInstant(value)) return '未读取';
  return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

function formatDue(value, timeZone) {
  if (!isValidInstant(value)) return '时间未知';
  return `${formatClock(value, timeZone)} `;
}

function statusText(status) {
  return { pass: '通过', partial: '部分通过', fail: '未通过', unknown: '未知' }[status] ?? '未知';
}

function overviewSummary(value, timeZone = TIME_ZONE) {
  const todayLabel = `${Number(value.today.date.slice(5, 7))}月${Number(value.today.date.slice(8, 10))}日`;
  const todayItems = value.today.items.map((item) => `${formatDue(item.dueAt, timeZone)}${item.title}`).join('；');
  const todayText = `今日（${todayLabel}）：${value.today.items.length} 件到期${todayItems ? ` —— ${todayItems}` : ''}`;

  const pendingDetails = [
    ...value.pending.items.map((item) => `「${item.title}」${itemReason(item)}`),
    ...value.pending.channels.map((channel) => channel.message ?? `「${channel.channel}」${channel.reason ?? '通道待核对'}`),
    ...value.pending.sessions.map((session) => `会话「${session.label ?? session.sessionId}」${session.status ?? '读取失败'}`),
  ];
  const pendingText = `待我拍板：${value.pending.items.length} 条${pendingDetails.length ? ` —— ${pendingDetails.join('；')}` : ''}`;

  const recentDetails = value.recent.items.map((item) => `「${item.title}」（${COMPLETION_LABELS[item.completion] ?? item.completion ?? '状态未知'}）`).join('；');
  const recentText = `最近完成：${value.recent.items.length} 条${recentDetails ? ` —— ${recentDetails}` : ''}`;

  const channels = value.health.channels.map((channel) => {
    const at = channel.lastProbeAt ? `上次探测 ${channel.lastProbeAt.slice(0, 16).replace('T', ' ')}` : '尚无探测';
    const label = channel.channel === 'qq' ? 'QQ' : (channel.channel ?? '未知通道');
    return `${label} ${at} ${statusText(channel.status)}${channel.status !== 'pass' && channel.status !== 'unknown' ? `（${value.pending.channels.find(({ channel: name }) => name === channel.channel)?.reason ?? '能力未完全验证'}）` : ''}`;
  });
  const sessions = value.health.sessions;
  const lastRead = sessions.map(({ lastReadAt }) => lastReadAt).filter(Boolean).sort().at(-1);
  const healthText = `来源健康：${channels.length ? channels.join('；') : '暂无通道记录'}；观察中会话 ${sessions.length} 个${lastRead ? `，最后读取 ${formatClock(lastRead, timeZone)}` : ''}`;
  return `${todayText}\n${pendingText}\n${recentText}\n${healthText}`;
}

export function createOverview({ store, sessionProbe, now = Date.now, config = {} } = {}) {
  if (!store || typeof store !== 'object') throw new Error('INVALID_ARGS store is required');
  const timeZone = config.timeZone ?? TIME_ZONE;

  function build(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('INVALID_ARGS options must be an object');
    }
    if (options.refreshSessions !== undefined && typeof options.refreshSessions !== 'boolean') {
      throw new Error('INVALID_ARGS refreshSessions must be a boolean');
    }
    const ownerId = options.ownerId ?? store.ownerId;
    if (typeof ownerId !== 'string' || ownerId.length === 0) throw new Error('INVALID_ARGS ownerId must be a non-empty string');
    const readAtDate = nowValue(now);
    const readAt = readAtDate.toISOString();
    const todayDate = dateString(readAtDate, timeZone);
    if (options.refreshSessions === true && sessionProbe && typeof sessionProbe.refresh === 'function') {
      sessionProbe.refresh({ ownerId });
    }
    const items = readItems(store, ownerId);
    const sessions = sessionRows(sessionProbe, ownerId);
    const probe = latestProbe(store);
    const channels = channelRows(store, config, probe);
    const todayItems = items
      .filter((item) => item.completion === 'unconfirmed' && isValidInstant(item.dueAt) && dateString(new Date(item.dueAt), timeZone) === todayDate)
      .sort((a, b) => compareAscending(a, b, 'dueAt'))
      .map(publicItem);
    const pendingItems = items
      .filter(needsDecision)
      .sort((a, b) => compareAscending(a, b, 'updatedAt'))
      .slice(0, 20)
      .map(publicItem);
    const recentSinceDate = shiftDate(todayDate, -7);
    const recentSince = new Date(`${recentSinceDate}T00:00:00.000Z`).toISOString();
    const recentItems = items
      .filter((item) => item.completion !== 'unconfirmed'
        && isValidInstant(item.updatedAt)
        && item.updatedAt >= recentSince
        && item.updatedAt <= readAt)
      .sort((a, b) => compareDescending(a, b, 'updatedAt'))
      .slice(0, 20)
      .map(publicItem);
    const pendingChannels = probe && probe.status !== 'pass'
      ? (() => {
        const reason = channelIssue(probe);
        return [{
          channel: 'qq',
          status: probe.status ?? 'unknown',
          lastProbeAt: probe.finishedAt ?? probe.startedAt ?? null,
          reason,
          message: reason?.startsWith('QQ ') ? reason : `QQ 通道${reason ?? '待核对'}`,
        }];
      })()
      : [];
    const pendingSessions = sessions.filter(({ status }) => status !== 'read_ok').map(({ status, error, ...session }) => ({
      ...session,
      status: status ?? 'never_read',
      error,
    }));

    const result = {
      readAt,
      timeZone,
      today: { date: todayDate, items: todayItems, range: { scannedItems: items.length } },
      pending: {
        items: pendingItems,
        channels: pendingChannels,
        sessions: pendingSessions,
        range: { scannedItems: items.length },
      },
      recent: { since: recentSince, items: recentItems, range: { scannedItems: items.length } },
      health: {
        channels,
        sessions: sessions.map(({ status, error, ...session }) => session),
        range: { sessionsWatched: sessions.length },
      },
    };
    return result;
  }

  return { build, summary: (value) => overviewSummary(value, timeZone) };
}
