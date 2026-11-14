const objectSchema = { type: 'object', properties: {}, additionalProperties: true };

function definition(name, description, properties, required, execute, render = (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, required },
    output: {
      schema: objectSchema,
      render,
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

function delegationDefinition(name, description, properties, required, execute, getDelegation) {
  return definition(name, description, properties, required, async (args) => {
    try {
      if (!getDelegation()) throw new Error('INVALID_ARGS delegation is unavailable');
      return await execute(args ?? {});
    } catch (cause) {
      const code = cause?.code ?? String(cause?.message ?? 'INVALID_ARGS').split(/\s+/, 1)[0];
      const message = String(cause?.message ?? 'delegation failed').replace(new RegExp(`^${code}\\s*`), '');
      return { ok: false, code, message };
    }
  });
}

function publicBinding(record) {
  if (!record) return null;
  const { externalId, ...rest } = record;
  return { ...rest, openid: externalId };
}

export function createTools(store, { scheduler, channel, probe, sessionProbe, overview, channelConfig, delegation } = {}) {
  const getDelegation = () => delegation;
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
    definition(
      'nightdesk_overview',
      '只读汇总今日事项、待决事项、最近完成、来源健康和会话快照；不会控制宿主会话或外部通道。',
      {
        refreshSessions: { type: 'boolean', default: false },
      }, [], (args) => {
        requireObjectArgs(args);
        requireBoolean(args, 'refreshSessions');
        if (!overview || typeof overview.build !== 'function') {
          return { available: false, reason: 'overview-unavailable' };
        }
        return overview.build({ ownerId: store.ownerId, refreshSessions: args.refreshSessions ?? false });
      }, (_args, value) => [
        { type: 'text', text: JSON.stringify(value, null, 2) },
        { type: 'text', text: value?.today && value?.pending && value?.health
          ? (overview?.summary?.(value) ?? '汇总摘要不可用')
          : '汇总摘要不可用' },
      ]),
    delegationDefinition(
      'nightdesk_task_create',
      '为一个 worker 创建受管任务；只允许已注册工具，拒绝委派类工具与递归委派。',
      {
        objective: { type: 'string', minLength: 1, maxLength: 2000 },
        acceptance: { type: 'array', minItems: 1 },
        inputs: { type: 'array', items: { type: 'object' } },
        allowedTools: { type: 'array', items: { type: 'string' } },
        scope: { type: 'string' },
        completionRule: { type: 'string', minLength: 1 },
        budget: { type: 'object' },
        goalVersion: { type: 'integer', minimum: 1, default: 1 },
      }, ['objective', 'acceptance'], (args) => getDelegation().createTask({ ...args, ownerId: store.ownerId }), getDelegation,
    ),
    delegationDefinition(
      'nightdesk_task_start',
      '为任务启动一个本地草稿 attempt；同一任务已有进行中的 attempt 时幂等返回。',
      {
        taskId: { type: 'string', minLength: 1 },
        goalVersion: { type: 'integer', minimum: 1 },
      }, ['taskId'], (args) => getDelegation().startAttempt({ ...args, ownerId: store.ownerId }), getDelegation,
    ),
    delegationDefinition(
      'nightdesk_task_submit',
      '按目标版本与任务版本提交当前 attempt 的本地草稿，写入不可变 artifact。',
      {
        taskId: { type: 'string', minLength: 1 },
        attemptId: { type: 'string', minLength: 1 },
        draftText: { type: 'string', minLength: 1 },
        expectedTaskVersion: { type: 'integer', minimum: 1 },
        goalVersion: { type: 'integer', minimum: 1 },
        resources: { type: 'object' },
      }, ['taskId', 'attemptId', 'draftText', 'expectedTaskVersion'], (args) => getDelegation().submitDraft({ ...args, ownerId: store.ownerId }), getDelegation,
    ),
    delegationDefinition(
      'nightdesk_task_review',
      '核对当前已提交 attempt 的结构、证据与内容；pass 需三层全真，needs_revision 需至少一条 finding。',
      {
        taskId: { type: 'string', minLength: 1 },
        attemptId: { type: 'string', minLength: 1 },
        verdict: { type: 'string', enum: ['pass', 'needs_revision'] },
        structure: { type: 'object' },
        evidence: { type: 'object' },
        content: { type: 'object' },
        findings: { type: 'array', items: { type: 'object' } },
      }, ['taskId', 'attemptId', 'verdict', 'structure', 'evidence', 'content'], (args) => getDelegation().review({ ...args, ownerId: store.ownerId }), getDelegation,
    ),
    delegationDefinition(
      'nightdesk_task_stop',
      '停止任务与当前 attempt；停止后拒绝新的启动与提交。',
      {
        taskId: { type: 'string', minLength: 1 },
        reason: { type: 'string' },
      }, ['taskId'], (args) => getDelegation().stop({ ...args, ownerId: store.ownerId }), getDelegation,
    ),
    delegationDefinition(
      'nightdesk_tasks',
      '列出受管任务及当前 attempt 摘要；不返回草稿正文。',
      {
        status: { type: 'string', enum: ['drafting', 'submitted', 'needs_revision', 'accepted', 'exhausted', 'stopped', 'canceled'] },
      }, [], (args) => {
        requireObjectArgs(args);
        const tasks = getDelegation().list({ ...args, ownerId: store.ownerId });
        return { tasks, count: tasks.length };
      }, getDelegation,
    ),
  ];
}
