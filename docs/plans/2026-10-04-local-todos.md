# 本地待办（To-dos）计划

状态：方案已确认（2026-10-04）。第一期（#491）已合入；第二、三期（agent 任务、交给 agent 与进度回写）已实现，见 `docs/todos.md`。

## 目标与范围

在手机上管理一份存在自己 Mac 上的待办，并把 agent 的任务进度合进同一张列表：

- **我的待办**：手动记录、勾选、编辑、删除；可以一键交给 Claude / Codex 去做。
- **Agent 任务**：汇总本机正在跑的 Claude Code 会话的任务列表（`4 tasks (2 done, 2 in progress)` 那种），只读。
- **回写**：交给 agent 的待办显示该 agent 的实时进度；agent 做完后由用户一键标记完成。

数据只存在用户自己的机器上（Hub SQLite + Node 本地文件），不经过云。主要入口是手机，桌面复用同一组件。

不在第一期：Codex 计划步骤进度（见“已确认现状”）、离线编辑、提醒/通知、多人共享列表。

## 已确认现状

### Offdesk

- **Hub 持久化**：SQLite（WAL）。新功能按 `crates/hub/src/db/session_handoffs.rs` 的写法：模块内 `init(conn)`，由 `init_db` 调用；`CREATE TABLE IF NOT EXISTS`，没有版本表；所有表按 `user_id` 隔离，时间戳为毫秒整数。
- **幂等写入**：handoff 由客户端生成 UUID，首次写入生效，同 id 不同内容返回 409。待办沿用。
- **实时同步**：`BrowserEvent`（`crates/protocol/src/lib.rs`）经 `/ws/events` 推送，事件历史只在内存保留 1024 条；出现缺口时客户端重新拉 `/api/bootstrap`。所以待办必须进 `BrowserStateSnapshot`，否则手机会漏改动。Handoff 只在聚焦时轮询，没有推送，不能照抄。
- **向 Node 取数据**：PR #481 的会话历史已经跑通 capability（`agent_session_history_v1`）+ `HubToMachine::X { request_id }` / `MachineToHub::XResult` + Hub 路由（无权限 404、无 capability 409、Node 出错 503）。Node 侧扫描有上限，结果带 `warnings`，不完整时不会伪装成空列表。
- **手机入口**：PR #481 在 Machines & Hub 菜单里加了 Conversations，打开 `<dialog>` 抽屉（`AgentSessionSidebar.web.tsx`）。待办放同一个菜单，用同样的抽屉写法。
- **终端与 agent 的关联**：目前没有。新建 agent 终端只是在 shell 里输入 `claude` / `codex`；handoff 通过剪贴板让用户自己粘贴。
- **向 agent 输入框发文字**：已有 composer transport（`TerminalViewRef.sendComposer`，带回执，需要控制权）。

### Claude Code 任务（2.1.285，本机实测）

- 路径：`~/.claude/tasks/<listId>/<n>.json`，每个任务一个文件，整文件原地重写。字段：`id`、`subject`、`description`、`status`（`pending | in_progress | completed`）、`activeForm?`、`owner?`、`blocks`、`blockedBy`、`metadata?`。`metadata._internal` 的任务 Claude 自己也隐藏。文件里没有时间戳，用 mtime。
- `listId` 默认是**当前** session id；`CLAUDE_CODE_TASK_LIST_ID` 或 agent team 会改它。
- 从终端找到任务列表：
  - `~/.claude/sessions/<pid>.json` 有 `sessionId`、`status`（busy/idle/waiting）、`kind`，以及 `tmux: "odk_<terminal>:@w.%p"`。Offdesk 终端就是 `odk_<terminal id>`，可以直接对上。
  - 后台会话（`claude attach <short>`）看 `~/.claude/jobs/<short>/state.json` 的 `resumeSessionId`。原始 `sessionId` 的目录会过期。
  - `/clear` 之类会换 session id，所以必须每次从 pid 文件重新解析，不能在派发时记死。
- **列表全部完成约 5 秒后，Claude 会删掉所有任务文件**。要显示“4/4 完成”，Hub 必须自己保存最后一次快照。
- 体量很小：本机 3 个目录、4 个任务文件，合计 24 KB。几秒轮询一次的成本可以忽略。

### Codex（0.159.2）

- 计划只存在于 rollout JSONL 里的 `update_plan` 调用。当前版本把它写成 code-mode JS 对象字面量（不是 JSON），实时计划只走 app-server 协议，不落盘。
- 本机 1395 个 rollout，共 3.1 GB；**最近 14 天 0 个含 `update_plan`**。第一期不读 Codex 进度，只显示“运行中 / 空闲”（前台进程）。

## 方案

### 数据模型（Hub）

新表 `todos`，主键 `(user_id, id)`：

| 字段 | 说明 |
| --- | --- |
| `id` | 客户端生成的 UUID，重试安全 |
| `title` / `notes` | 必填标题（≤500 字）；备注（≤8 KB） |
| `status` | `open` / `done`。“进行中”由关联的 agent 推导，不单独存 |
| `position` | 手动排序 |
| `machine_id` / `cwd` | 可选：在哪台机器、哪个目录做（派发时需要） |
| `agent` / `terminal_id` | 派发后记录：`claude` / `codex` 及 Offdesk 终端 id |
| `progress_json` | 最近一次 agent 进度快照 `{done, total, items[{subject,status}], session_status, seen_at}` |
| `created_at` / `updated_at` / `completed_at` | 毫秒 |

编辑采用字段级 PATCH，最后写入生效。删除为硬删除，并广播事件。改待办不需要机器控制权；派发要新建终端，沿用现有规则，需要控制权。

### 接口与同步

- `GET/POST /api/todos`，`PATCH/DELETE /api/todos/{id}`，`POST /api/todos/reorder`。
- `BrowserEvent::TodoUpserted { todo }`、`TodoDeleted { id }`；`BrowserStateSnapshot.todos`（`#[serde(default)]`）。前端 `bootstrapState.ts` 新增 `todos` 切片。
- 类型在 `packages/shared/src/contracts.ts` 手写镜像，与现有约定一致。

### Agent 任务（Node → Hub）

- Node 新增 `agent_tasks_v1` capability。约每 3 秒读一次 `~/.claude/sessions/*.json`（仅存活的 pid）、`jobs/*/state.json` 和对应的 `tasks/<listId>/`，有变化时用 `MachineToHub::AgentTasksChanged` 推给 Hub。只发标题和状态，不发 `description`。
- Hub 把每个会话的最新快照放在内存；对已关联待办的会话，同时写入 `todos.progress_json`。列表被 Claude 清空时保留最后快照，所以“4/4 完成”不会消失。
- 新事件 `AgentTasksUpdated { machine_id, sessions[...] }`，进 bootstrap。旧 Node 没有 capability 时，界面明确提示“更新 Node 以显示 agent 任务”，不显示为空。

### 派发（交给 Claude / Codex）

1. 待办选机器和目录：默认取待办上次的值，否则取当前终端的 cwd。
2. 新建终端，启动命令只有 `claude` 或 `codex`，不把用户文字拼进 shell 命令，避免注入。
3. 等前台进程变成 agent 后，用 composer transport 把待办标题和备注发进输入框，并等待回执。失败时保留文字，回退为复制到剪贴板。
4. 记录 `terminal_id`。Node 通过 `odk_<terminal id>` → pid 文件 → 当前 `sessionId` → 任务列表持续解析进度，`/clear` 后也能跟上。
5. Agent 空闲且任务全部完成时，待办上出现“完成了，标记为已完成？”。不自动勾选。

### 手机界面

- 入口：Machines & Hub 菜单 → **To-dos**，打开全高抽屉（同 Conversations 的 `<dialog>` 写法）。
- 顶部快速添加：单行输入，回车即添加，字号 16px 防 iOS 缩放。键盘弹出时列表区域随可用高度收缩，不遮挡输入框（复用今天的视口适配）。
- **我的待办**：未完成在上，已完成折叠。每行：勾选框、标题、目录标签、agent 徽标与进度（如 `Claude · 2/4`）。点开详情可以编辑、删除、派发、打开关联终端。
- **Agent 任务**：未关联待办的运行中 Claude 会话，每个一组，显示进度和条目。可以点“加入我的待办”，生成一个已关联的待办；也可以打开对应终端。
- 触控目标 ≥44px。桌面以同一组件作为对话框打开。

## 分期

| 期 | 内容 | 验证 |
| --- | --- | --- |
| 1 | 我的待办：表、CRUD、事件与 bootstrap、手机抽屉、桌面对话框 | db 与路由单测；`bootstrapState` 单测；容器 e2e：390px 增删改勾选、两个页面实时同步、重连后一致 |
| 2 | Agent 任务只读：Node 读取 Claude 任务、capability、推送、快照、“Agent 任务”分组 | Rust 用临时目录造 sessions/jobs/tasks 测解析、`/clear` 换 id、清空后保留快照；e2e 在 `e2e/agent-history/claude` 增加 fixtures |
| 3 | 派发与回写：交给 Claude/Codex、发送文字、进度显示、完成提示 | e2e 拦截建终端请求，校验启动命令里没有用户文字；用户在真机上走一遍 |
| 后续 | Codex 计划进度（app-server 或解析 rollout）、提醒、离线编辑 | 另行评估 |

每期都需要 Hub 与 Node 随桌面 App 更新，界面走独立 Web UI 渠道。旧 Hub/Node 必须显示明确的“需要更新”，不能静默失败。

## 已确认决定（2026-10-04）

1. **基线分支**：原定先合 PR #481；后改为在 agent 接力（#490）合入 main 后直接从 main 开 `feat/local-todos`。手机入口放在 main 已有的 Machines & Hub 菜单，桌面入口放在标签栏右侧。第三期的派发直接复用 #490 的接力机制（生成说明、启动 agent、首条提示词经文件送达）。
2. **完成规则**：agent 做完只提示，由用户一键标记完成，不自动勾选。
3. **Codex**：第一期只显示运行中 / 空闲，步骤进度放到后续。
