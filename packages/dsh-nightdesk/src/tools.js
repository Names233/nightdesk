const objectSchema = { type: 'object', properties: {}, additionalProperties: true };

function definition(name, description, properties, required, execute) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: objectSchema,
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    execute: async (args, exec) => execute(args ?? {}, exec),
  };
}

function requireObjectArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_ARGS arguments must be an object');
}

function requireBoolean(args, field) {
  if (args[field] !== undefined && typeof args[field] !== 'boolean') {
    throw new Error(`INVALID_ARGS ${field} must be a boolean`);
  }
}

function publicBinding(record) {
  if (!record) return null;
  const { externalId, ...rest } = record;
  return { ...rest, openid: externalId };
}

export function createTools(store, { scheduler, channel, probe, sessionProbe, channelConfig } = {}) {
  return [
    definition(
      'nightdesk_health',
      '读取 NightDesk 本地插件、数据库与待处理事件的健康状态。',
      {}, [], () => store.health(),
    ),
    definition(
      'nightdesk_capture',
      '逐字保存一段主动输入，按句生成未经确认的期限候选；不会替用户确认模糊时间。',
      {
        text: { type: 'string', minLength: 1 },
        sourceLabel: { type: 'string', default: 'manual' },
        sourceId: { type: 'string' },
        occurredAt: { type: 'string', format: 'date-time' },
        idempotencyKey: { type: 'string' },
      }, ['text'], (args) => store.capture(args),
    ),
    definition(
      'nightdesk_items',
      '按上海时区查询今日、待完成或全部事项，默认包含仍待确认的候选。',
      {
        view: { type: 'string', enum: ['today', 'pending', 'all'], default: 'today' },
        includeUnconfirmed: { type: 'boolean', default: true },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      }, [], (args) => store.items(args),
    ),
    definition(
      'nightdesk_confirm',
      '按预期版本确认事项及其期限，同时记录版本、审计与确认事件。',
      {
        itemId: { type: 'string', minLength: 1 },
        expectedVersion: { type: 'integer', minimum: 1 },
        dueDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        dueAt: { type: 'string', format: 'date-time' },
        title: { type: 'string', minLength: 1 },
        timeStatus: { type: 'string', enum: ['resolved', 'unknown', 'ambiguous'] },
      }, ['itemId', 'expectedVersion'], (args) => store.confirm(args),
    ),
    definition(
      'nightdesk_complete',
      '按预期版本将未取消事项标记为完成，并持久化完成事件。',
      {
        itemId: { type: 'string', minLength: 1 },
        expectedVersion: { type: 'integer', minimum: 1 },
        completion: { type: 'string', enum: ['manual_complete', 'source_complete', 'conflicted'], default: 'manual_complete' },
      }, ['itemId', 'expectedVersion'], (args) => store.complete(args),
    ),
    definition(
      'nightdesk_remind',
      '为已确认且未完成的事项安排提醒；可按事项当前版本指定到期时刻与类型。',
      {
        itemId: { type: 'string', minLength: 1 },
        dueAt: { type: 'string', format: 'date-time' },
        kind: { type: 'string', minLength: 1, default: 'due' },
      }, ['itemId'], (args) => store.remind(args),
    ),
    definition(
      'nightdesk_reminders',
      '查询提醒的调度、通道受理与设备确认状态，不把通道受理当作已送达。',
      {
        status: { type: 'string', enum: ['queued', 'retry', 'submitting', 'accepted', 'failed', 'canceled', 'unknown'] },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      }, [], (args) => store.reminders(args),
    ),
    definition(
      'nightdesk_tick',
      '手动处理当前到期的提醒；不依赖模型，也不产生设备送达回执。',
      {}, [], () => scheduler.tick(),
    ),
    definition(
      'nightdesk_channel',
      '查看所选提醒通道及必要配置是否齐全，不返回凭据或密钥。',
      {}, [], () => ({
        name: channel.name,
        configured: channelConfig.configured,
      }),
    ),
    definition(
      'nightdesk_probe_qq',
      '记录 QQ 官方通道能力探针；默认只换取凭据并核对绑定，sendTest=true 才发送明确标注的测试消息。',
      { sendTest: { type: 'boolean', default: false } }, [], (args) => {
        requireObjectArgs(args);
        requireBoolean(args, 'sendTest');
        if (!probe || typeof probe.run !== 'function') throw new Error('INVALID_ARGS QQ probe is unavailable');
        return probe.run({ sendTest: args.sendTest ?? false });
      },
    ),
    definition(
      'nightdesk_probes',
      '查询已经持久化的 QQ 通道探针记录，不返回凭据或令牌。',
      {
        kind: { type: 'string', minLength: 1 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      }, [], (args) => {
        requireObjectArgs(args);
        const probes = store.listProbes(args);
        return { probes, count: probes.length };
      },
    ),
    definition(
      'nightdesk_channels',
      '查询通道绑定概览；openid 只显示掩码，绝不返回凭据或完整外部身份。',
      {}, [], () => {
        const channels = store.channelBindings().map(publicBinding);
        return { channels, count: channels.length };
      },
    ),
    definition(
      'nightdesk_bind_channel',
      '建立 QQ 私聊 openid 与本地身份的绑定；返回值只包含掩码后的 openid。',
      {
        channel: { type: 'string', const: 'qq' },
        appId: { type: 'string', minLength: 1 },
        openid: { type: 'string', minLength: 1 },
        displayName: { type: 'string' },
      }, ['channel', 'appId', 'openid'], (args) => {
        requireObjectArgs(args);
        if (args.channel !== 'qq') throw new Error('INVALID_ARGS channel must be qq');
        return publicBinding(store.bindChannel({
          channel: args.channel,
          appId: args.appId,
          externalId: args.openid,
          displayName: args.displayName,
        }));
      },
    ),
    definition(
      'nightdesk_session_watch',
      '把一个 dsh 会话加入只读观察名单；不会控制、恢复或修改该会话。',
      {
        sessionId: { type: 'string', minLength: 1 },
        label: { type: 'string' },
      }, ['sessionId'], (args) => {
        requireObjectArgs(args);
        if (!sessionProbe) return { available: false, reason: 'session-probe-unavailable' };
        return sessionProbe.watch({ ownerId: store.ownerId, sessionId: args.sessionId, label: args.label });
      },
    ),
    definition(
      'nightdesk_session_unwatch',
      '从只读观察名单移除一个 dsh 会话；不会控制该会话。',
      {
        sessionId: { type: 'string', minLength: 1 },
      }, ['sessionId'], (args) => {
        requireObjectArgs(args);
        if (!sessionProbe) return { available: false, reason: 'session-probe-unavailable' };
        return sessionProbe.unwatch({ ownerId: store.ownerId, sessionId: args.sessionId });
      },
    ),
    definition(
      'nightdesk_sessions',
      '查询只读会话观察名单；refresh=true 时读取一次宿主快照，不声称运行或审批状态。',
      {
        refresh: { type: 'boolean', default: false },
      }, [], (args) => {
        requireObjectArgs(args);
        requireBoolean(args, 'refresh');
        if (!sessionProbe || (typeof sessionProbe.isAvailable === 'function' && !sessionProbe.isAvailable())) {
          return { available: false, reason: 'sessionQuery-unavailable' };
        }
        const refresh = args.refresh ?? false;
        const sessions = refresh
          ? sessionProbe.refresh({ ownerId: store.ownerId })
          : sessionProbe.list({ ownerId: store.ownerId });
        return { available: true, sessions, count: sessions.length };
      },
    ),
  ];
}
