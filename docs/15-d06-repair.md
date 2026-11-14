# D06 复核修复任务（自包含）

你在 `E:\Agents Dev\nightdesk` 这个仓库里工作。这是一个 dsh 业务插件仓库，纯 ESM JavaScript、零第三方依赖、用 Node 24 内置 `node:sqlite`。D06 的「到期提醒 → 投递 → 状态机」已经实现，但主审发现下列缺陷。请逐条修复并补测试。

## 硬约束

- 只改 `packages/dsh-nightdesk/src/`、`packages/dsh-nightdesk/test/`。不要改 `docs/12-*`、`docs/13-*`、`docs/14-*`（那是后续任务的简报）和 `docs/01~10`（产品契约）。
- 不要 `git commit` / `git push`。
- 不联网：测试里所有 HTTP 用注入的 fake `fetch`。
- 不得 `import` 任何 `@deepseek-ai/*`（宿主版本不匹配）。
- 保持既有工具名与参数：`nightdesk_health/capture/items/confirm/complete/remind/reminders/tick/channel`。
- 所有时间用 RFC3339 UTC 字符串；日历/时区逻辑留在 `dates.js`。

## 必须修复的缺陷

1. **手动提醒永远失败**（`src/index.js:30` 附近）：`createScheduler` 从未安装 `store.onReminderRequested`，`store.remind()` 因此抛 `INVALID_ARGS scheduler is unavailable`。
   要求：`apply()` 里接线，语义为「按给定 dueAt/kind 安排一条提醒」：
   ```js
   store.onReminderRequested = (item, dueAt, kind) =>
     scheduler.scheduleForItem({ ...item, dueAt, due_at: dueAt }, dueAt, kind ?? 'due');
   ```
   注意 `remind()` 已在事务里调用它，不要再嵌套事务（`scheduleForItem` 只用单条 `INSERT OR IGNORE`，可以接受）。

2. **Outbox 游标先写后跑，崩溃会永久跳过事件**（`src/outbox.js:22-30`）：现在是先 `INSERT OR IGNORE outbox_event_handler` 再执行 handler。
   要求：改成「先执行 handler，成功后再在同一事务里写游标」。失败时不写游标，改为
   `UPDATE outbox SET attempts = attempts + 1, available_at = ? WHERE id = ?`，退避 60s/300s/900s/3600s（按 attempts 递增，封顶 3600s），并写 `nightdesk.outbox_handler_failed` 审计。因为没有游标，重试是安全的——`scheduleForItem` 本身按 `(owner_id,item_id,item_version,kind)` 唯一索引幂等。事件只有在所有 handler 都成功后才置 `processed`。

3. **重启后卡在 `submitting` 的提醒永不恢复**（`src/scheduler.js`）：`start()` 时先做一次恢复：把本 `owner_id` 下 `status='submitting'` 的行改成 `status='unknown'`（表示「可能已发出，但无法确认」），写审计 `nightdesk.reminder_unknown`，且**不自动重发**（重发会重复打扰）。`tick()` 只处理 `queued`/`retry`。
   同时把 `nightdesk_reminders` 工具的 `status` 枚举补上 `unknown`（`src/tools.js:79`）。

4. **取消与在途发送竞态会丢投递证据**（`src/scheduler.js:123-124`）：`current?.status !== 'submitting'` 时直接 `continue`，连 `deliveries` 都不写。
   要求：无论通知当前是否仍为 `submitting`，都把本次尝试写进 `deliveries`（status 用本次结果）；只有在仍为 `submitting` 时才更新通知状态。若结果是已受理但通知已被取消，写审计 `nightdesk.delivery_after_cancel`。

5. **停机时还会发新消息**（`src/index.js:55`）：teardown 里 `await scheduler.tick()` 会触发新的投递。
   要求：删掉这次 `tick()`；改为 `scheduler.stop()` 后如果有在跑的 tick 就等它结束（给 scheduler 加 `whenIdle()` 返回当前 in-flight promise 或 `Promise.resolve()`）。

6. **`confirm` 接受非 RFC3339 时间**（`src/store.js:475`）：`new Date('2026-11-15')` 能过。
   要求：`dueAt` 必须是 `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±HH:MM)`，且 `Date.parse` 有效、含时区。`remind()` 的 `dueAt` 同样校验。

7. **QQ 通道仍是废弃域名与错误语义**（`src/channel.js`）：
   - 取令牌域名改为 `https://api.bot.qq.com/app/getAppAccessToken`；
   - 发消息域名改为 `https://api.bot.qq.com/v2/users/{openid}/messages`；
   - 主动推送**不要**带 `msg_seq`（官方 SDK 的 `sendProactiveMessage` 只发 `{content,msg_type}`，`msg_seq` 只用于带 `msg_id` 的被动回复）。删掉 `qqSequence`。
   - 成功判定：HTTP 2xx **且** 响应 JSON 里 `code === 0`（若响应无 `code` 字段，则必须有字符串 `id` 才算受理）。畸形 2xx（空体、非 JSON、`code` 非 0）一律 `ok:false`。
   - **删除 `webhook` 通道**（用户已明确否掉通用 webhook/Server酱/ntfy 路线）。只保留 `console`（测试/无凭据时的显式兜底）与 `qqbot`。`loadChannelConfig` 里去掉 `NIGHTDESK_CHANNEL_URL`/`NIGHTDESK_WEBHOOK_URL`；`channelHealth` 同步调整。

8. **迁移不回填既有事项的提醒**（`src/store.js:178` 迁移段）：v1 已确认且未完成的事项没有 notifications 行，升级后不会提醒。
   要求：迁移末尾按 `owner_id, item_id, item_version, kind='due'` 为「已确认、completion='unconfirmed'、time_status 不为 canceled/unknown/ambiguous、due_at 非空」的事项 `INSERT OR IGNORE` 一条 `notifications`（`scheduled_at = due_at`，`next_attempt_at = due_at`，`status='queued'`）。

9. **初始化失败会泄漏数据库/定时器**（`src/index.js`）：`apply()` 中途抛错（如 qqbot 缺凭据）时 store 与 interval 不释放。
   要求：把 `apply()` 主体包进 `try/catch`，catch 里清理（stop scheduler、`clearInterval`、`store.close()`）后 rethrow。

10. **两个失败测试**：`test/tools.test.js:93`、`test/scheduler.test.js:143` 因 fixture 没接 `store.onReminderRequested` 而失败。修复方式：这两个用例应显式接线（或改用带 scheduler 的 `createTools`），不要为了让测试过而放宽 `store.remind()` 的守卫——「没有调度器就报错」本身是正确行为，另写一个用例专门断言它。

## 测试要求

新增测试不少于 8 项，至少覆盖：outbox 崩溃后事件仍会被重试、outbox 成功后不重复执行、`submitting` 恢复为 `unknown` 且不重发、取消竞态下仍写 deliveries、停机不发新消息（用 fake setInterval 断言）、`confirm` 拒绝 `2026-11-15` 这类非 instant、QQ 畸形 2xx 视为失败、QQ 请求体不含 `msg_seq`、webhook 已不可用（`createChannel({kind:'webhook'})` 抛错）、迁移回填既有事项提醒。

## 验证命令（必须真的跑）

```
cd "E:\Agents Dev\nightdesk"
node --test packages/dsh-nightdesk/test
node -e "import('./packages/dsh-nightdesk/src/index.js').then(m=>console.log(m.name, typeof m.apply))"
git status --short
```

## 交付

- 全部测试通过（报告 tests/pass/fail 数字）。
- `git status --short` 只应出现 `packages/dsh-nightdesk/**` 的改动。
- 不提交。最后用不超过 20 行总结：每条缺陷怎么修的、测试数、还剩什么没做。
