# Agent 接力与复核（Handoff 重做）计划

状态：方向已确认（2026-10-05）。第一期已实现，等待 CI 与真机验证；用户文档见 `docs/agent-relay.md`。线稿：Handoff redesign wireframes（Claude 设计画布）。

## 为什么重做

旧 handoff（PR #487，未合并）的问题：

- 每个终端上方常驻一整行，在手机上挤掉两行终端。
- 下一步要用户自己写；上下文只是终端滚动的 200 行原文。
- 最后还要复制、切换、等 agent 就绪、手动粘贴。

## 新设计

- **不常驻。** 识别到 Claude / Codex 时，终端右上角浮一个 agent 标签（覆盖层，不缩小终端）。点开是动作菜单。
- **额度用完时主动提示。** Node 在屏幕上识别限额提示，终端底部浮出卡片：“Claude 额度用完，交给 Codex 继续？”。推送通知放第三期。
- **交接说明自动生成。** 由 Node 从会话记录、任务列表和 git 改动拼出：目标、已完成、剩余、最后进展、改动文件。卡片上标明来源，用户可以编辑、补一句。
- **一键送达。** 目标 agent 在同目录的新终端启动，说明作为第一条提示词直接提交，不经过剪贴板。
- **双向关联。** 目标终端显示“来自 Claude”，一键回到源终端。

## 已确认现状（main dadaeb3）

- Node 每 5 秒轮询 tmux 窗格。`revive.rs` 能从进程树判断 claude / codex，并对上 Claude session id（`~/.claude/sessions/<pid>.json` 的 `tmux` 字段）和 Codex rollout（打开的文件）。但这些结果没有发给 Hub。
- `terminal_attention.rs` 只识别确认对话框。屏幕文字检测与“变化才上报”的通道可以复用。
- `CreateTerminal.startup_command` 是逐字敲进 shell 的。多行或带引号的自由文本不能直接放进去。
- 两个 CLI 都接受首条提示词：`claude [prompt]`、`codex [PROMPT]`。
- 限额提示文字：Claude 2.1.285 显示 `Usage limit reached`，Codex 显示 `You’ve hit your usage limit`（弯引号）。
- 推送通知：完全没有，属于新建。

## 第一期：接力（Continue）

1. **Agent 身份。** 新增 `TerminalInfo.agent = { kind, session_id?, usage_limit? }`。Node 在现有轮询里计算，变化时用 `MachineToHub::TerminalAgent` 上报；Hub 只放内存，触发 `TerminalUpdated`，并进 bootstrap。旧客户端忽略这个字段。
2. **交接说明。** 新增 `GET /api/machines/{m}/terminals/{t}/relay-brief`。Node 读取：
   - Claude：会话记录的首条用户消息或自定义标题、最后一条 assistant 文本、`~/.claude/tasks/<session>/` 任务列表。
   - Codex：rollout 的首条用户消息、最后一条 agent 消息。
   - `git status --porcelain` 与当前分支。

   扫描都有上限，只读文件头尾。
3. **启动目标。** `CreateTerminal` 新增 `startup_prompt { agent, text }`。Node 把文字写到 `config_dir/relay/<terminal>.md`（0600），再输入 `claude -- "$(cat '<path>')"`。用户文字不进入 shell 语法。旧 Node 没有 `agent_relay_v1` capability 时返回 409。
4. **接力记录。** `POST /api/machines/{m}/relays`（客户端生成 id，需要控制权），存到 Hub 的 `agent_relays` 表，发出 `agent_relay_created` 事件，并进 bootstrap。目标终端据此显示“来自 Claude · 回去”。
5. **界面。**
   - 终端右上角的 agent 标签与菜单（手机、桌面共用）。
   - 限额卡片。
   - Continue 面板：说明预览、编辑、补一句、开始。
   - 目标终端的回链。
6. **测试。**
   - Rust：限额文字识别、说明提取（fixture 会话 / 任务 / rollout）、接力路由。
   - TS：说明排版。
   - 容器 e2e：用假的 `claude` / `codex` 脚本验证首条提示词原样送达，并验证限额卡片。

## 第二期：复核与交还

- **复核：** `codex review --uncommitted` 或 `claude -p` 在后台终端运行，结果写入文件，以卡片回到源终端；“Send to Claude”把问题清单发进输入框（需要无浏览器的输入通道）。
- **由 agent 自己写交接说明：** 源 agent 可用时，让它写说明。
- **交还：** 额度恢复时提示交还；也支持选择同目录已有的空闲会话作为目标。

## 第三期：推送通知

限额、完成等事件推送到手机（APNs / FCM 或 Tauri 本地通知），需要单独设计。

## 不做

- 旧 handoff（#487）不合并。
- 不自动判断 agent 是否完成工作，也不自动勾选或交还。
