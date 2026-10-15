# Agent 运行对外开放：权限、Webhook 与 Bridge

状态：草案，待评审。依赖 `2026-10-14-agent-runs.md`（文档 A）的运行模型。

## 目标与范围

让 Hub 之外的系统查看 agent 运行的状态，并在用户授予的范围内回答请求、启动运行。外部系统可以是用户自己写的服务、ntfy 或 Slack 这类通知服务、任务系统，也可以是托管的 Offdesk Cloud。

要满足三个条件：

1. **不需要入站端口。** Hub 通常在 NAT 后面，由 Hub 主动连出去。
2. **不把完整的远程执行权限交给外部系统。** 外部系统只能做被授权的那几件事，而且限定在用户指定的机器和目录里。
3. **不依赖托管服务。** 协议公开，任何人都可以实现服务端；托管服务只是其中一个实现，在 Hub 里没有特殊通道。

不在本期范围：

- 端到端加密的外部通道。外部系统能看到按“内容级别”授权给它的内容，文档会写明这一点。
- 任务系统本身（任务、评论、指派）。Hub 只带一个不解释的 `external_ref`。
- 推送服务（APNs、FCM）。推送由外部系统负责，Hub 只负责把事件送过去。

## 已确认现状

以 `origin/main` 67f47ce 为基线。

- **token 没有权限范围。** `odk_` token 和 JWT 都能操作该账号的所有机器（`crates/hub/src/auth.rs`）。`SECURITY.md`：“A token is remote code execution on every registered machine.” 每个 token 有名字和 `last_used_at`，可以单独撤销。
- **托管连接只通到加密入口。** Cloud 的隧道只把 `<hub>.cloud.offdesk.dev/ws/secure` 转到 `127.0.0.1:4318`，其他路径都是 404（`crates/hub/src/cloud.rs`，`docs/managed-connections.md`）。所以托管服务本身无法调用 Hub 的 HTTP API，这是有意的设计。
- **Hub 不主动连任何外部服务。** 除了开通、关闭这类生命周期调用，没有心跳、事件上报，也不接收指令。`cloud_connector.rs` 每 30 秒的检查只是隧道健康检查。
- **没有推送代码。** `tauri-plugin-notification` 装了但没调用；`docs/terminal-attention.md` 写明注意力条是“an in-app cue, not a background push notification”。
- **`offdesk mcp` 只有 agent browser 的工具**（`crates/cli/src/mcp.rs`）。

## 方案选择

| 方案 | 优点 | 主要代价 | 结论 |
| --- | --- | --- | --- |
| 外部系统直接调用 Hub API | 不用新协议 | 需要入站端口或隧道；要把 token 交给外部系统，而现在的 token 等于全部权限 | 不作为默认方式；有了带权限范围的 token 后，自托管用户仍可以这么做 |
| 只做 Webhook | 简单，通用 | 单向，外部系统无法回答或启动 | 做，作为最简单的接入方式 |
| Hub 主动建立的双向连接（Bridge） | 不需要入站端口；可以回答、启动、上报在线状态 | 要定协议，处理重连和断点续传 | 做，作为完整的接入方式 |

## 一、带权限范围的凭证

先修好权限模型，Webhook 和 Bridge 都建立在它上面。

### 权限范围

| 范围 | 允许 | 风险 |
| --- | --- | --- |
| `runs:read` | 读运行、请求和事件，内容多少由“内容级别”决定 | 信息泄露 |
| `runs:answer` | 回答 `question` 和 `input` 类请求 | 引导 agent 的决策 |
| `runs:approve` | 回答 `approval` 类请求，也就是批准命令或工具调用 | 相当于批准一次代码执行 |
| `runs:start` | 用启动 API 在允许的目录里启动 agent，带上提示 | 相当于在 agent 的权限模式内执行代码 |
| `runs:message` | 给运行中的 agent 发一段自由文本 | 同 `runs:start` |
| `full` | 现有的全部权限：终端、输入、机器管理 | 全部机器上的远程执行 |

- 现有 token 迁移为 `full`，行为不变。新建 token 时默认选窄的范围，UI 上把 `full` 标成危险。
- `approve` 和 `answer` 分开：回答一个“用哪个方案”的问题，和批准 `psql $PROD -f …`，风险不在一个量级。

### 约束

每个凭证还可以设：

- **机器**：允许的机器列表。`production` 机器（现有标记）默认排除，要单独勾选。
- **目录**：`runs:start` 只能在列出的目录及其子目录里启动。判断时先解析真实路径，防止用符号链接绕过。
- **agent**：允许的 agent 类型。
- **内容级别**：
  - `metadata`：状态、计数、机器、agent、时间、`external_ref`、标题。
  - `requests`：再加请求的原文、选项和命令。在外部系统上回答需要这一级。
  - `notes`：再加 agent 的进展说明和交接摘要。
  - 任何级别都不包含终端输出。
- **频率**：启动和回答的次数上限，防止失控的服务端刷爆机器。

### 审计

外部凭证做的每个写操作（回答、批准、启动、发消息）都记一条：哪个凭证或集成、什么操作、对象、结果、时间。Hub 设置页和 `offdesk-hub integrations log` 可以查看。

## 二、集成

“集成”是用户在 Hub 上配置的一个外部系统，包括类型、地址、密钥、一个带权限范围的凭证、启用状态、最近一次投递和错误。

- 在 Hub 设置里新增“集成”页，CLI 是 `offdesk-hub integrations add|list|show|disable|rm`。
- 每个集成的权限范围、约束和内容级别都写在页面上，一眼能看到谁能对你的机器做什么。
- 撤销集成立刻断开 Bridge、停止 Webhook，凭证同时失效。

## 三、Webhook（单向）

- 运行事件以 JSON POST 到集成配置的 URL。
- 签名采用 Standard Webhooks 的格式（`webhook-id`、`webhook-timestamp`、`webhook-signature`，HMAC-SHA256），这样现成的校验库可以直接用。
- 投递至少一次：Hub 用 SQLite 发件箱保存待投递事件，失败按指数退避重试，24 小时后放弃并在集成页显示错误。每个事件带唯一 id 和该运行内的 seq，接收方据此去重和排序。
- 可以按事件类型和机器过滤，比如只要“有新的待处理请求”和“运行结束”。
- Webhook 无法回答或启动。要回答，接收方需要另外的通道：Bridge，或者在自托管场景下用带权限范围的 token 直接调 Hub API。

示例：对接 ntfy 只需要一个把事件转成 ntfy 消息的小脚本，仓库里放在 `examples/` 下。

## 四、Bridge（双向）

Hub 主动连到集成配置的 `wss://` 地址，保持一条长连接。外部系统通过这条连接接收事件，并在授权范围内下发指令。

### 配对

1. 服务端为这个 Hub 生成一次性的配对码。
2. 用户在 Hub 上执行 `offdesk-hub integrations add bridge --url wss://…`，粘贴配对码，并在 Hub 上确认权限范围和约束。
3. Hub 生成自己的 bridge 密钥并交给服务端注册，此后用它认证。配对码只能用一次，10 分钟内有效。

权限范围由 Hub 一侧决定，服务端只能请求，不能自行扩大。

### 消息

```
Hub → 服务端
  hello      {hub_id, hub_version, protocol: 1, scopes, constraints, content_level}
  snapshot   {machines: [{id, name, online, stats?}], agents_installed, runs, requests}
  event      {seq, type, ...}            // 和本地 /ws/events 的运行事件同构，按内容级别裁剪
  result     {command_id, ok, error?}
  ping

服务端 → Hub
  ack        {seq}                       // 已持久化到该 seq，Hub 可以清理发件箱
  answer     {command_id, run_id, request_id, option_id? | text?}
  start      {command_id, machine_id, agent, cwd, prompt?, label?, external_ref?}
  message    {command_id, run_id, text}
  cancel     {command_id, run_id}         // 向 agent 发送中断键，不杀进程
  pong
```

- **断点续传**：Hub 按 `ack` 记录服务端已确认的 seq；重连时先发 `hello`，再从未确认的 seq 补发，补不上时改发 `snapshot`。
- **幂等**：每条指令带 `command_id`，Hub 记住最近处理过的 id，重复的直接返回原结果。
- **校验**：每条指令都在 Hub 上按凭证的权限范围、约束、频率和请求是否仍然待处理来检查，不通过的返回 `result {ok: false}` 并记入审计。指令一律走文档 A 中的 API，不新开执行路径。
- **在线状态**：机器上下线、`MachineStats` 的摘要（电量、睡眠）作为事件发出，服务端据此显示“在线、睡眠中、电池供电”。
- **重连**：指数退避加抖动。连接断开不影响本地使用。

### 传输安全

- 只接受 `wss://`；可选证书固定。
- 内容对服务端可见，范围由内容级别决定。这和端到端加密的终端连接不同，设置页和文档会写明。
- 终端输出永远不经过 Bridge。接管终端仍然走现有的加密连接或局域网。

### 规范和参考实现

- 协议规范单独成文：`docs/agent-bridge-protocol.md`，带版本号。破坏性改动升主版本，Hub 在 `hello` 里声明自己支持的版本。
- 仓库附一个最小的参考服务端（`examples/bridge-server`）：接收事件、打印、能回答请求。用于测试和给自托管用户做起点。
- 托管的 Offdesk Cloud 按同一规范实现服务端。托管开通流程会替用户完成配对，但仍然生成一条普通的集成记录，默认只开 `runs:read`（内容级别 `requests`）和 `runs:answer`；`runs:approve` 和 `runs:start` 需要用户在 Hub 上手动开启。

## 五、MCP

`offdesk mcp` 新增运行相关的工具：`list_runs`、`get_run`、`answer_request`、`start_run`。它们沿用 CLI 的 token，所以能做什么取决于这个 token 的权限范围。这样任何 MCP 客户端都可以用自然语言查看和处理 agent 运行。

## 威胁模型

| 外部系统被攻破时，攻击者能做什么 | 缓解 |
| --- | --- |
| 读到授权内容级别内的运行内容 | 默认 `metadata`；终端输出永不外发 |
| 回答问题，引导 agent | 只能选 agent 自己给出的选项或输入文字；审计 |
| 批准危险命令 | 单独的 `runs:approve`；`production` 机器默认排除；可以设成只允许 `question` |
| 用提示词让 agent 在允许的目录里做坏事 | 目录白名单；不提供跳过权限确认的模式；agent 仍会对危险操作请求批准；频率限制；审计；随时撤销 |
| 冒充 Hub 发送虚假事件给服务端 | Hub 用配对时注册的密钥认证 |
| 冒充服务端给 Hub 下指令 | Hub 只连自己配置的地址，校验 TLS；指令仍受权限范围约束 |

## 分阶段实施与完成标准

### B1 带权限范围的凭证和审计

- token 的权限范围、约束和内容级别；现有 token 迁移为 `full`；审计日志；设置页显示。
- 完成标准：只有 `runs:read` 的 token 调用终端或输入接口时返回 403；目录约束无法用 `..` 或符号链接绕过；现有 token 和 CLI 行为不变。

#### B1 实现说明（2026-10-15）

- **存储**：`api_tokens` 加一列 `access`（JSON 的 `TokenAccess`），空就是 `full`。所以“迁移为 full”不需要改数据：现有 token 和 CLI 登录产生的 token 都是空，行为不变。读不懂的 `access`（比如新版 Hub 写的未知范围）当成什么都不允许，绝不当成 full。创建接口不带 `access` 仍然是 full（CLI 登录靠这个），设置页默认建“只限 agent 运行”的 token。
- **默认拒绝**：不在每个接口里判断，而是在 `AuthUser` 提取器里按匹配到的路由放行（`auth.rs` 的 `scoped_route`）。窄范围 token 只能访问：读运行和事件、回答、启动、列已安装的 agent、机器列表（只列它能碰的机器）和控制权（CLI 回答和启动前要先取得）。其他接口一律 403 并记审计；以后新增的接口默认也对它关闭。WebSocket 和 release beacon 不走提取器，`verify_bearer_token` 直接只接受 full。
- **约束**：机器列表为空时排除 `production` 机器（除非 `include_production`）；`approve` 和 `answer` 按请求类型分开判断；`agents` 限制能启动的 agent；`dirs` 是 `runs:start` 的必填项。
- **目录两层检查**：Hub 先按文本检查（绝对路径或 `~/…`，没有 `.`/`..`，在某个目录之下），再把 `dirs` 放进 `AgentStart.allowed_dirs` 发给 node；node（新能力 `agent-start-dirs-v1`，旧 node 503）对 `cwd` 和每个目录做 `canonicalize` 后比较前缀，所以目录里指向外面的符号链接也会被拒。
- **内容级别**：`metadata` 去掉请求的原文和选项、回答的文字；`requests` 保留它们；`notes` 再保留进展说明、交接摘要和当前步骤。运行和事件历史都按这个裁剪。
- **审计和频率**：API token 的回答、批准、启动（含失败原因）和被拒的请求写进 `api_token_audit`（每个用户保留最近 1 万条），`GET /api/auth/api-tokens/audit` 查看；每小时上限按审计里成功的次数算，超出返回 429。审计只记 API token，不记 App 会话。
- **设置页**：新建 token 时选“只限 agent 运行”（默认，勾选看/回答/批准/启动、内容级别、启动目录、是否含生产机器）或“完全访问”（红字说明等于远程执行）；列表里每个 token 一行写明它能做什么，full 用红色。
- **没做**：`runs:message` 只定义了范围，还没有对应接口；按机器选择的 UI（API 支持 `machines`）；审计的界面（B4）；`offdesk-hub integrations log`（B2 的集成）。
- **验证**：路由测试走完整路由表：`runs:read` 访问终端、文件、token、回答、启动都是 403，WebSocket 校验拒绝；生产机器上的运行看不到；`metadata` 看不到问题原文、`requests` 看得到；`runs:answer` 不能批准；`..`、同前缀目录、相对路径、不允许的 agent 都被拒；频率上限 429；读不懂的 `access` 什么都不允许；审计里有每一条。node 测试覆盖符号链接和 `..`。隔离环境里用 CLI 实测：只读 token 能 `offdesk runs`，`ls`/`open`/`start` 都 403；启动 token 在允许目录里能启动，目录外被 Hub 拒，目录内指向外面的符号链接被 node 拒。

### B2 Webhook

- 集成记录、发件箱、签名、重试、过滤、ntfy 示例。
- 完成标准：Hub 离线重启后，未投递的事件继续投递；接收方用 Standard Webhooks 的现成库能校验签名；内容级别为 `metadata` 时，事件里没有请求原文。

#### B2 实现说明（2026-10-15）

- **集成记录**：`integrations` 表，`kind = "webhook"`，存 URL、签名密钥（`whsec_` 加 32 字节随机数，只在创建时返回一次，列表里没有）、要的事件类型（空表示全部）、`access`（复用 B1 的 `TokenAccess`：机器、是否含生产机器、内容级别；范围固定是 `runs:read`）、启用状态、最近一次投递和错误。接口在 `/api/integrations`（列表、创建、开关、删除、测试、最近投递），窄范围 token 访问不到。
- **事件从哪来**：所有 `agent_run_updated` 都交给一个 webhook 后台任务（通过 channel，按顺序处理，所以同一个运行的事件不会乱）。它把运行和 `webhook_run_state` 里上次的描述比较，得出 `run.started`、`run.request`、`run.request_resolved`、`run.status`、`run.progress`、`run.report`、`run.ended`。一次更新里新请求或结束已经说明了状态时，不再单发 `run.status`。每个事件有运行内递增的 `seq`。没有指明用户的更新（比如开发模式的 node）按机器的主人算。
- **发件箱**：每个启用的、要这个事件、能看这台机器的集成各写一条到 `webhook_outbox`，正文按它的内容级别裁剪（复用 B1 的 `shown_run`）。同一事件重试时 `webhook-id` 不变。
- **投递**：`webhook-id`、`webhook-timestamp`、`webhook-signature: v1,<base64 HMAC-SHA256(id.timestamp.body)>`。HMAC 自己写在 `sha2` 上，用规范的测试向量验证；另外在隔离环境里用官方 `standardwebhooks` npm 库校验了 Hub 真实发出的请求。10 秒超时，不跟随重定向。失败后 5 秒、10 秒……最长一小时重试，24 小时后放弃；错误只记“HTTP 503”“couldn't connect”这类，不记 URL 和正文。发件箱在 SQLite 里，Hub 重启后继续投递。测试事件从接口加入时唤醒后台任务。
- **开关和删除**：关掉后不再产生新事件，已排队的保留；删除时连同排队的一起删（连接池里不是每个连接都开了外键，所以显式删除，不靠级联）。
- **设置页**：“Webhooks” 一节：名字、URL、事件（默认“等你处理”和“结束”）、内容级别、是否含生产机器；密钥只显示一次；列表显示事件、内容级别、最近投递或错误，可以测试、关闭、删除。
- **ntfy 示例**：`examples/webhooks/ntfy-relay.mjs`，无依赖的 Node 脚本：校验签名和时间戳、按 `webhook-id` 去重、转成 ntfy 消息（等你处理是高优先级，内容级别够时带上问题原文）；ntfy 失败返回 502，让 Hub 重试。说明在 `docs/webhooks.md`。
- **没做**：`offdesk-hub integrations` 命令行（接口和设置页已经能做）；投递记录的界面（接口有，B4）；按机器选择的界面。
- **验证**：hub 测试覆盖事件推导、退避和放弃、签名测试向量；用本地 HTTP 接收方走一遍：过滤后只发要的事件、`metadata` 级别没有问题原文、接收方 503 时排队重试、换一个 Hub 进程打开同一个数据库后投递成功且只投一次、关闭和删除；接口测试覆盖校验、列表不含密钥、别人看不到、窄范围 token 403；e2e（1280/390）在设置页添加 webhook，测试事件到达接收方且签名正确，然后删除。隔离环境里：假 claude 启动、提问、终端关闭，ntfy 依次收到 started、status、“claude waits on you”（带问题原文）、request_resolved、done；伪造签名的请求被示例拒绝（401）。

### B3 Bridge

- 协议规范、Hub 客户端、配对、断点续传、指令校验、在线状态、参考服务端。
- 完成标准：
  - 参考服务端能收到快照和事件，回答一个 question 后 agent 继续。
  - 断网 10 分钟后重连，事件不丢、不重复处理。
  - 超出权限范围的指令被拒绝并记入审计。
  - 撤销集成后连接立刻断开。

### B4 MCP 工具和设置界面

- `offdesk mcp` 的运行工具；集成页的审计查看。
- 完成标准：Claude Code 通过 `offdesk mcp` 列出等待中的运行并回答其中一个。

## 待定问题

1. 内容级别的默认值：托管服务默认 `requests`，否则锁屏上无法显示问题。这样是否可以接受，还是应该默认 `metadata`，让用户手动开？
2. 现有 token 迁移为 `full` 之后，要不要提示用户把给 agent 用的 token 换成窄范围的？
3. `runs:message` 是否和 `runs:start` 合并？两者风险相同。
4. Bridge 是否需要支持多个服务端同时连接（比如托管服务加一个自建的通知服务）？本设计允许多个集成，每个单独连接。
5. 参考服务端用什么语言写：Node 最容易让人改，Rust 能和 Hub 共用类型定义。
