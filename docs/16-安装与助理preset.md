# 安装与助理 preset

本文说明怎么在本机跑起 NightDesk，以及「助理 preset」怎么接进 dsh。它覆盖当前已实现的部分（D00 / D01 / D02 / D03 / D04 / D05 / D06 / D07 / D08）；D08 受管委派只做单 worker 本地草稿，真机与真实会话验证仍未做。

## 1. 运行前提

| 项 | 值 | 说明 |
| --- | --- | --- |
| dsh | `0.2.2-rc.3` | 与桌面版 DSH Desktop 使用同一个 npm 包 |
| Node | `>= 24.9`（实测 v24.19.0） | 存储用 `node:sqlite`，必须是 Node 24 内置版本 |
| **独立 HOME** | `C:\Users\Names\.dsh-nightdesk\` | **环境隔离的关键**，见下面说明 |
| profile | `C:\Users\Names\.dsh-nightdesk\profiles\nightdesk\` | 从 `web` 模板复制，端口默认 `5593` |
| 数据目录 | `C:\Users\Names\.dsh-nightdesk\nightdesk-data\nightdesk.db` | SQLite WAL，插件启动时自动建库并迁移 |
| 插件 | `E:\Agents Dev\nightdesk\packages\dsh-nightdesk\src\index.js` | 零第三方依赖，纯 ESM |

**隔离口径（2026-11-15 修正）**：只换 profile 是不够的。dsh 的会话存在 `$DSH_HOME\sessions\<工作目录>` 下、按工作目录归档，工作区清单和附件也在 `$DSH_HOME` 里，**跨 profile 共享**。所以 NightDesk 必须用独立的 `DSH_HOME`，否则会在 5593 里看到桌面版的全部会话与工作区。现在的部署是：独立 HOME + 独立 profile + 独立插件数据目录；桌面版仍在 `C:\Users\Names\.dsh` 与自己端口上，两边互不可见。

## 2. 启动

```powershell
# 两个环境变量必须一起设，缺一个都会落回共享 HOME
$env:DSH_HOME = 'C:\Users\Names\.dsh-nightdesk'
$env:NIGHTDESK_DATA_DIR = 'C:\Users\Names\.dsh-nightdesk\nightdesk-data'
npx -y @deepseek-ai/dsh@0.2.2-rc.3 nightdesk --port 5593 --no-open
```

启动后终端会打印带 token 的地址（`http://127.0.0.1:5593/?token=...`），用浏览器打开即可对话。第一次打开是**空的会话列表和空的工作区清单**，这是隔离生效的表现，不是数据丢了。

注意：

- 参数要跟在 profile 名后面直接给；写成 `dsh nightdesk web --port 5593` 会报 `too many arguments`。
- 停止服务用 `Ctrl+C`，插件会在 `ctx.effect` 的 teardown 里关定时器、等当前发送结束、再关数据库。

## 3. 数据与状态

- 数据库迁移版本：`schema_version=5`（observations / items / item_versions / notifications / deliveries / outbox / outbox_event_handler / audit_events / idempotency / channel_bindings / probes / watched_sessions / tasks / task_attempts / task_reviews / task_artifacts）。
- 所有时间字段按 RFC3339 UTC 保存；「今天」的判定用 `Asia/Shanghai` 日历。
- 事项状态：`timeStatus ∈ resolved|unknown|ambiguous|conflicted|canceled`，`completion ∈ unconfirmed|manual_complete|source_complete|conflicted`。只有 `unconfirmed` 才能改期重排提醒。
- 提醒状态机：`queued → submitting → accepted | failed`，可重试档位 10s / 30s / 120s / 120s，最多 5 次；进程重启时把遗留的 `submitting` 改成 `unknown` 并写审计，不自动重发（宁缺不重发）。
- 服务端 2xx 只记成 `accepted`（渠道受理）；`delivered`（手机显示）和 `read`（用户打开）不会被伪造。

## 4. 助理 preset

preset 是 dsh 的「一个 Agent 用哪些子插件」声明。NightDesk 的助理 preset 只给对话、时间和 skill，不给 shell / 文件写入 / plan / goal，避免个人助理误操作本机文件。

把下面这段追加到 `C:\Users\Names\.dsh-nightdesk\profiles\nightdesk\cordis.patch.yml` 末尾（与已有的 nightdesk 插件 `insert` 平级，属于同一个 YAML 列表）：

```yaml
- insert:
    - id: preset-nightdesk-assistant
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: nightdesk-assistant
        name: NightDesk 助理
        description: 看住消息、期限和已委托工作的私人助理（只读为主）
        order: 2
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: |-
                你是 NightDesk（拾光哨），一个替用户看住「消息、期限和进行中的工作」的私人助理。

                你的职责只有三件：
                1. 把用户主动转发的消息、截图、链接里与自己有关的事项记下来，日期不明确时标成待确认，不要替用户猜。
                2. 到点提醒用户，并把提醒的真实状态（已受理 / 已失败 / 未知）如实说明，不把「服务端接受」说成「已经送到你手机」。
                3. 汇总今天要做什么、哪些还等用户拍板、最近完成了什么、来源是否健康。

                你没有 shell、文件写入和计划模式工具，也不接管宿主的会话控制：不能取消、改期或替用户在别的会话里操作。需要这类动作时，明确告诉用户去宿主里操作。
                工具输出的 `runState` 恒为 `unknown` 时，不要说会话「正在运行」或「在等审批」。
              complete: true
              includeRuntimeContext: false
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config:
              maxBytes: 65536
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
```

改完必须重启 dsh 进程：preset 声明只在启动时读取，改了只影响之后创建的会话。

`nightdesk` 业务插件本身仍由 profile 顶层的 `insert` 全局加载，所以提醒调度在任意会话里都在跑；preset 只决定助理会话能看见哪些工具。

## 5. 工具清单（23 个）

| 工具 | 用途 |
| --- | --- |
| `nightdesk_health` | 插件健康：数据库路径、schema 版本、队列计数 |
| `nightdesk_capture` | 收一条原始消息/文本，落证据并切出候选事项 |
| `nightdesk_items` | 查事项（今日 / 全部 / 候选） |
| `nightdesk_confirm` | 确认事项与截止时间（带版本号 CAS） |
| `nightdesk_complete` | 标记完成（manual_complete） |
| `nightdesk_remind` | 手动为一个事项排提醒 |
| `nightdesk_reminders` | 查提醒与投递状态 |
| `nightdesk_tick` | 立刻跑一次调度（调试用） |
| `nightdesk_channel` | 当前通道种类与是否配置完整（不回显 secret） |
| `nightdesk_probe_qq` | QQ 通道能力探针（五项能力，可选发一条测试消息） |
| `nightdesk_probes` | 历史探针记录 |
| `nightdesk_channels` | 通道与身份绑定（openid 掩码） |
| `nightdesk_bind_channel` | 绑定 QQ openid 到本地身份 |
| `nightdesk_session_watch` | 把某个 dsh 会话加入只读观察名单 |
| `nightdesk_session_unwatch` | 移出观察名单 |
| `nightdesk_sessions` | 观察名单与最近一次读取结果（可先 refresh） |
| `nightdesk_overview` | 四段工作汇总（今日 / 待决 / 最近完成 / 来源健康）+ 中文摘要 |
| `nightdesk_task_create` | 创建单 worker 受管任务（目标、验收、允许工具、预算、目标版本） |
| `nightdesk_task_start` | 为任务启动本地草稿 attempt（幂等） |
| `nightdesk_task_submit` | 按目标与任务版本提交当前 attempt 的草稿，写入不可变 artifact |
| `nightdesk_task_review` | 核对结构 / 证据 / 内容；pass 或 needs_revision |
| `nightdesk_task_stop` | 停止任务与当前 attempt（幂等） |
| `nightdesk_tasks` | 查询任务与当前 attempt 摘要（不含草稿正文） |

## 6. QQ 通道怎么配

首版只有两条通道：`console`（默认，打日志，用于无凭据环境）和 `qqbot`（腾讯官方 QQ 机器人 C2C）。

```powershell
$env:NIGHTDESK_CHANNEL_KIND = 'qqbot'
$env:NIGHTDESK_QQBOT_APP_ID = '<机器人 AppID>'
$env:NIGHTDESK_QQBOT_CLIENT_SECRET = '<机器人 AppSecret>'
$env:NIGHTDESK_QQBOT_OPENID = '<你的 user_openid>'
```

也可以写在 `C:\Users\Names\.dsh-nightdesk\nightdesk-data\channel.json`：

```json
{ "kind": "qqbot", "appId": "...", "clientSecret": "...", "openid": "..." }
```

配置完先跑 `nightdesk_probe_qq`（`sendTest: false`）确认凭据与绑定，再跑 `sendTest: true` 发一条明确标注测试的消息。五类能力里 `passive_reply` 恒为 `blocked`（需要官方 dsh-qqbot 提供 `msg_id`），`attachment` 恒为 `missing`（首版不发附件）——这是如实缺口，不是配置错误。

## 7. 已知边界

- **主动推送**：QQ 官方对主动消息有频控和每日额度，用户也可以关掉「允许主动发送」；探针只能证明「服务端受理」。
- **微信**：v0.2 不做，缺官方主动推送承诺；需要时走独立探针，不复用 QQ 结论。
- **会话运行状态**：宿主只读面没有运行态字段，`runState` 恒为 `unknown`。
- **受管委派（D08）**：已实现单 worker 本地草稿、结构化核对、两轮返工、停止与旧 attempt 拒绝；不真的起子进程或子会话，不做多 worker、远程执行，也不写宿主 dsh 数据库。真机与真实会话验证仍未做。
- **提醒的时效**：调度器在 dsh 进程里跑，进程不在就不发；重启后只在下次 tick 补发未过期的 `queued/retry`，`submitting` 会保守地记为 `unknown`。
