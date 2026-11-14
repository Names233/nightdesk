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

export function createTools(store) {
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
  ];
}
