# Agent 运行：Hub 管理 agent 状态

状态：A1–A3 已实现（见下文各阶段的实现说明），A4 待做。对外开放（权限、Webhook、Bridge）见
`2026-10-14-agent-runs-external-access.md`。

## 目标与范围

Hub 把每个 coding agent 的一次运行当成一等对象来管理。每次运行都有明确的状态，以及在等人处理的请求（批准、提问）。这些状态通过本地 API、事件流和 CLI 提供给 Hub 的 App，也提供给后续的对外接口。

这件事在 Hub 本身就有价值：手机和桌面能看到“哪个 agent 在哪台机器上做什么、哪个在等我”，并且可以直接回答。不依赖任何托管服务。

第一期覆盖在 Offdesk 终端里运行的 Claude Code 和 Codex；现有的 ACP 会话也纳入同一个模型。

不在本期范围：

- 对外推送和外部系统的控制权限（见文档 B）。
- 转录全文的上传或同步。
- 新增 agent 类型（Gemini CLI 等）。适配器接口会留好，按需加。
- 自动批准策略。现有 `auto_run` 和 agent 自身的权限模式保持不变。

## 已确认现状

以 `origin/main` 67f47ce（2026-10-14）为基线。

- **终端是现在的产品形态。** `POST /api/machines/{m}/terminals` 接受 `cwd` 和 `startup_command`（`crates/hub/src/routes/terminals.rs`）。用 API token 打开的终端会记下 `opened_by: {kind: "cli", label}`（#518）。
- **状态识别只有屏幕识别。** `crates/machine/src/terminal_attention.rs` 对前台是 `claude`、`claude.exe`、`codex`、`node` 的 pane 每 5 秒执行一次 `capture-pane`。它只认英文的 yes/no 确认菜单，结果只有一个 `TerminalAttention::Confirmation`。按 `docs/terminal-attention.md`，屏幕文字不进入状态协议，也识别不了提问、完成和报错。
- **ACP 会话有结构化状态，但没有界面。** `AgentSessionStatus` 有 starting、working、asked、idle、error、disconnected 六种；`AgentEvent::Question` 带 `request_id` 和选项（`crates/protocol/src/lib.rs` 227–345 行）；回答走 `POST .../agent-sessions/{sid}/answer`。聊天界面在 2026-09-01 的 terminal-first reset 里删了，后端保留。ACP 进程不在 tmux 里，没有终端可以接管。
- **曾经有过一部分。** #492 实现过：从 Claude 的 session 文件读出忙、空闲、等待；读出 `~/.claude/tasks/<session>` 的任务清单；用结构化参数而非 shell 语法启动 agent 并带上第一条消息（“the relay's startup path, never shell syntax”）；E2E 用的假 claude 和 codex。#503（01b1981）在“to-do 改用 GitHub issues”时把这些连同 Node 端的 agent 识别一起删了。旧数据库里还留着没用的 `todos` 表。
- **重启后恢复已有。** `crates/machine/src/revive.rs` 会记下 claude 和 codex 的 resume 命令，重启后重建 pane 并恢复会话（#485）。
- **pane 环境变量有转发机制。** `crates/machine/src/pty.rs` 用 tmux `set-environment` 把选定的变量传进会话（目前只有 `CLAUDE_CODE_NO_FLICKER`）。
- **token 没有权限范围。** API token（`odk_`）和 JWT 都能操作该账号的所有机器（`crates/hub/src/auth.rs`）。`SECURITY.md` 的说法是：“A token is remote code execution on every registered machine.”

## 概念

### Agent Run

在一台机器上，一个 agent 进程从启动到结束是一次运行（run）。

| 字段 | 说明 |
| --- | --- |
| `id` | Hub 分配 |
| `machine_id`、`terminal_id` | 终端运行时两者都有；ACP 运行时是 `agent_session_id` |
| `agent` | `claude`、`codex`，可扩展 |
| `cwd` | 启动目录 |
| `status` | 见下 |
| `title` | 默认取 agent 自己的会话标题（Codex 已有 `codex_title.rs`），否则取目录名 |
| `external_ref` | 可选，`{source, id, url, title}`。Hub 不解释它，只保存并带进事件。可以是 GitHub issue、Linear，或任何任务系统 |
| `progress` | 可选，`{done, total, current}`，来自 agent 的任务清单 |
| `started_by` | `person`（App）、`cli`（token 名），或文档 B 中的集成名 |
| `started_at`、`ended_at`、`last_event_at` | |

一个终端前后可以有多次运行，比如退出 claude 后再开 codex。每次运行只属于一个终端。

### 状态

```
starting → working ⇄ waiting
              ↓         ↓
             idle ⇄ working
              ↓
         done | error | gone
```

- `working`：agent 在干活。
- `waiting`：有一个待处理请求（见下）。
- `idle`：一轮结束，等下一条指令。这是 agent 的正常停顿，不等于完成。
- `done`：agent 进程正常退出，或 agent 自己报告完成。
- `error`：进程异常退出，或适配器报告错误。
- `gone`：终端关闭或机器失联超过阈值，状态不可知。

“卡住”不是一种状态：客户端由 `idle` 加上最后一条 `blocked` 报告推导出来（见“agent 自报”）。这和 ACP 不把“完成未读”做成状态的做法一致。

### 待处理请求

```
{ id, run_id, kind: approval | question | input,
  prompt, detail?, options: [{id, label, detail?}],
  source: hooks | screen | acp | report,
  created_at, resolved_at?, resolution?: {by, option_id? | text?} }
```

- `approval`：要不要执行某个工具或命令。`detail` 是命令或文件路径。
- `question`：agent 主动提问，通常带选项。
- `input`：agent 停下来等一段自由输入，没有选项。

同一时间每次运行最多一个请求未处理；新的请求出现时，旧的自动标记为 `superseded`。

## 状态从哪来：适配器

每个适配器把 agent 的原生信号翻译成上面的状态和请求。多个来源同时可用时，结构化来源优先，屏幕识别只作兜底。

| 来源 | 适用 | 能给出什么 |
| --- | --- | --- |
| ACP 事件 | ACP 会话 | 全部，已经是结构化的 |
| Claude Code 钩子 | 终端里的 Claude Code | working、idle、approval（含工具名和命令）、question（含选项）、任务清单进度 |
| Codex `notify` | 终端里的 Codex | 一轮结束（idle） |
| agent 自报（`offdesk run …`） | 任何 agent | 进展说明、blocked、done 和交接摘要 |
| 屏幕识别（现有） | claude、codex | 只有 approval，没有文字 |
| 进程生命周期 | 所有终端 | 启动、退出、退出码 |

### Claude Code 钩子

钩子的事件名和字段要在实现时对照当时的 Claude Code 文档核对，以下是设计意图：

- `SessionStart`：把 Claude 的 session id 和这次运行关联起来，`revive.rs` 的 resume 也能用上。
- `UserPromptSubmit`、`PreToolUse`：working。
- `Notification` 里的权限提示，或者专门的权限请求钩子（如果当时的版本提供）：approval，带工具名和命令。
- `PreToolUse` 中 `tool_name` 为 `AskUserQuestion` 的调用：question，选项取自工具输入。
- `Stop`：idle。
- 写任务清单的工具调用（`TodoWrite` 等）：更新 `progress`。#492 读过 `~/.claude/tasks/<session>`，可以作为备选来源。

钩子只用来上报，不替用户做决定：不返回 allow 或 deny，批准仍然发生在终端里原来的菜单上。这样接管终端时看到的界面和平时一致，钩子失效也不会改变 agent 的行为。

**钩子怎么接上：**

1. 通过 Hub 启动的运行（见“启动 API”）：Hub 用 Claude Code 的 `--settings` 参数传入一份 Offdesk 管理的钩子配置，不改用户的 `~/.claude/settings.json`。
2. 用户自己在 Offdesk 终端里打 `claude`：提供可选命令 `offdesk agents hooks install`，把钩子合并进用户配置，不覆盖用户已有的钩子。钩子在 `OFFDESK_TERMINAL_ID` 不存在时直接退出，所以在 Offdesk 之外运行的 claude 不受影响。`offdesk agents hooks uninstall` 原样移除。

### 钩子上报的通道

钩子调用 Node 自带的命令（`offdesk-node hook <event>`），从 stdin 读钩子 JSON，写入 Node 的本地 Unix socket；Node 再通过现有的 `/ws/machine` 连接转发给 Hub（新增 `MachineToHub::AgentRunSignal`）。

Node 往每个终端的 tmux 会话里设置 `OFFDESK_TERMINAL_ID` 和 `OFFDESK_AGENT_SOCKET`，沿用 `pty.rs` 已有的 `set-environment` 机制。

**不往 agent 的环境里放任何 token。** agent 能读到自己的环境变量，而按 `SECURITY.md`，一个 token 就等于所有机器上的远程执行权限。socket 只接受上报，不提供任何控制能力；权限设为当前用户可读写（0600）。

### Codex

用 Codex 的 `notify` 配置在每轮结束时调用 `offdesk-node hook codex-notify`。`notify` 只能配一个程序，如果用户已经配了，就做成链式：先调用 Offdesk，再调用用户原来的程序。批准仍靠现有的屏幕识别。Codex 如果当时已经提供更完整的钩子，再接上。

### agent 自报

新增 CLI 子命令，走同一个本地 socket，不需要 token：

```
offdesk run note "Found it: tax is added twice"     # 进展说明
offdesk run blocked "2 tests still fail after 3 tries"
offdesk run done --summary "…" --link https://github.com/…/pull/212
```

agent 是否调用取决于给它的指令。通过 Hub 启动时可以在第一条消息里写明；用户也可以写进项目的 `CLAUDE.md` 或 `AGENTS.md`。`--link` 只保存为字符串，Hub 不去访问它。

## 内容和隐私

`terminal_attention.rs` 的原则是“不把终端内容写进状态协议”。本设计保持这条原则对屏幕识别依然成立：屏幕识别仍然只给出 approval，不带文字。

钩子和自报提供的结构化字段（提问原文、选项、命令、进展说明）是新的内容。它们由 agent 主动给出，Hub 按以下规则处理：

- 保存在 Hub 的数据库里。任何能看终端的人本来就能看到这些内容，所以不新增风险。
- 本地 API 和事件流对已登录的客户端开放，权限和终端相同。
- 对外暴露多少由文档 B 的“内容级别”控制，默认只给元数据。
- 请求和进展说明按运行保留，运行结束 30 天后清理（可配置）。

## 回答

`POST /api/agent-runs/{id}/requests/{rid}/answer`，body 是 `{option_id}` 或 `{text}`。

- Hub 先确认请求仍然待处理，再交给 Node；对终端运行，由适配器把选择转换成按键（比如 Claude 菜单的数字键，自由输入则输入文字后回车），走现有的终端输入通道。
- 和现有的 Enter 按钮一样：不确定是否送达时不自动重试，状态以后续钩子或屏幕识别为准，不以“已发送”为准。
- 只读模式和没有输入权限时拒绝。回答算作该用户的一次输入，遵守现有的 control lease 规则。
- ACP 运行直接转到现有的 `answer` 接口。

## 启动 API

`POST /api/agent-runs`，body：

```
{ machine_id, agent: "claude" | "codex", cwd,
  prompt?, label?, external_ref?, permission_mode? }
```

- Hub 根据 `agent` 拼出命令参数，不接受任意命令字符串。`prompt` 作为一个参数传进去，不经过 shell。#492 的启动路径就是这么做的，可以找回来用。
- 新建一个终端运行 agent，`opened_by` 记为调用方，返回 run 和 terminal。
- `permission_mode` 只能选 agent 自己的安全模式（比如“每次询问”）。本接口**不提供**跳过权限确认的参数（如 `--dangerously-skip-permissions`）。要这样用的人可以继续用原始的终端 API。
- 带 `external_ref` 时，把 `OFFDESK_RUN_ID` 和外部引用放进环境变量，agent 可以借此调用对应的任务系统。

和现有的 `POST .../terminals` + `startup_command` 相比，这个接口的输入是受限的：只有固定的 agent、目录和一段提示。正因为这样，文档 B 才能给它单独授权。

## 本地 API、事件和 CLI

- `GET /api/agent-runs?machine=&status=&active=true`、`GET /api/agent-runs/{id}`
- `GET /api/agent-runs/{id}/events?from_seq=`：运行的事件日志（状态变化、请求、进展说明），不含终端输出。
- `/ws/events` 新增 `AgentRunCreated`、`AgentRunUpdated`、`AgentRunRequestOpened`、`AgentRunRequestResolved`；bootstrap 快照包含活跃运行和待处理请求。断线补发沿用现有的 seq 机制。
- `TerminalInfo.attention` 继续保留，供旧客户端用；有运行请求时由请求推导出来。
- CLI：`offdesk runs [--waiting]`、`offdesk runs show <id>`、`offdesk answer <run> <option|--text>`、`offdesk start <machine> --agent claude --cwd … --prompt …`。
- Node 上报已安装的 agent 及版本（PATH 里的 `claude`、`codex`），供启动界面选择。登录状态暂不检测。

## 界面（本期最小范围）

- 手机：现有的注意力条改为显示请求的类型和原文，提问可以直接点选项回答；approval 保留现在的“打开查看”和 Enter。
- 桌面：侧栏列出活跃运行（机器、agent、状态、进度），点击打开对应终端。
- 不做新的聊天界面，终端仍然是主界面。

## 数据

Hub SQLite 新增 `agent_runs`、`agent_run_requests`、`agent_run_events`（按运行保留，见“内容和隐私”）。旧的 `todos` 表不复用。

## 兼容

- 旧 Node 不上报运行信号：Hub 退回现有的屏幕识别，只能看到 approval。
- 旧 Hub 忽略新的 `MachineToHub` 消息，和 `TerminalAttention` 当初的做法一样。
- App 通过 Hub 能力协商判断是否显示运行列表和回答按钮。

## 分阶段实施与完成标准

### A1 运行模型和生命周期

- 数据表、协议类型、本地读取 API、事件流和 bootstrap。
- 来源先接进程生命周期和现有的屏幕识别：claude 或 codex 成为前台进程时建立运行，退出时结束。
- 完成标准：在终端里启动和退出 claude 或 codex，`offdesk runs` 和事件流正确显示 starting、working、waiting（屏幕识别的 approval）、done 和 gone；Hub 或 Node 重启后状态能恢复。

#### A1 实现说明（2026-10-15）

和上面的设计相比，实际做法如下：

- **Node**：每 5 秒的元数据轮询里新增 `MachineToHub::TerminalAgent { terminal_id, agent }`，只在变化时发送，重连后对每个终端重发一次；同一轮里先于 attention 发送。识别规则在 `crates/machine/src/agent_detect.rs`：前台是 `claude` / `claude.exe` 就是 Claude，`codex` 就是 Codex；前台是 `node` 时，只有窗格下有名为 `claude` 或 `codex` 的进程才算（npm 版 codex 会启动原生子进程），其他 `node` 程序不算。只有出现 `node` 时才取进程快照。
- **类型**：叫 `RunAgent`（claude、codex、other），和 ACP 的 `AgentKind` 分开。状态是 `AgentRunStatus`，含 `starting`，但 A1 没有信号区分启动中，直接从 `working` 开始；`idle` 留给 A2 的钩子。
- **规则**（`crates/hub/src/machine_manager/agent_runs.rs`）：
  - agent 出现：新建运行。屏幕上已有确认菜单就是 `waiting`，否则 `working`。
  - 换成另一种 agent：上一个记 `done`，再新建。
  - agent 离开前台：`done`。**拿不到退出码**，所以 A1 分不出 `done` 和 `error`。
  - 确认菜单出现或消失：`waiting`（附一条 `approval` 请求，来源 `screen`，没有文字）和 `working` 之间切换。
  - 终端关闭，或机器重连时它已不在：`gone`。机器断开：它的运行全部 `gone`。
  - 机器回来、同一终端里还是同一种 agent：最近那次 `gone` 的运行接着用，不新建。Hub 重启不会断开机器，运行保持原样。
- **可见性**：运行属于机器，跟着机器的主人走（`machines.user_id`），和终端一致。
- **存储**：Hub SQLite 的 `agent_runs`、`agent_run_requests`。A1 没有 `agent_run_events`：目前的事件只有状态变化，和运行本身重复。等 A2 有了钩子带来的进展再加。
- **接口**：`GET /api/agent-runs`（默认是未结束的加最近一天结束的，`?active=true` 只要未结束的，`?machine=` 按机器筛）、`GET /api/agent-runs/{id}`；`/ws/events` 的 `agent_run_updated`；bootstrap 的 `agent_runs`；CLI `offdesk runs [--all] [--waiting] [--machine] [--json]`。App 的状态里有 `agentRuns`，界面留给 A3。
- **验证**：除了各层单元测试，还在本机用隔离的 Hub（`OFFDESK_CONFIG_DIR`、独立端口和数据库）和 node（独立配置目录和 `TMUX_TMPDIR`）跑过：一个名为 `claude` 的进程在终端里启动后显示 `working`，退出后 `done`；停掉 node 变 `gone`，重启后接回同一个运行；打印 Claude 确认菜单时变 `waiting` 并带 `approval` 请求；关闭终端变 `gone`。

### A2 Claude Code 钩子和 agent 自报

- `offdesk-node hook`、本地 socket、pane 环境变量、`offdesk agents hooks install|uninstall`、`offdesk run note|blocked|done`。
- 完成标准：E2E 的假 claude（从 #492 找回）通过钩子触发 working、idle、approval（带命令）、question（带选项）和 progress。用户已有的钩子在安装和卸载后保持原样。agent 环境变量里没有 token。

#### A2 实现说明（2026-10-15）

钩子的事件和字段对照了 Claude Code 当时的文档（code.claude.com/docs/en/hooks）。和上面的设计相比：

- **由 CLI 而不是 `offdesk-node` 接钩子**：`offdesk hook claude <事件>`（隐藏命令）从 stdin 读钩子的 JSON，翻译成 `AgentSignal`，写到 node 的 agent socket。它在读配置、找 Hub、要 token 之前就返回；不打印任何东西，总是退出 0，所以不会改变 agent 的行为。`offdesk run note|blocked|done` 走同一条路，供 agent 自报。
- **不往 pane 里设环境变量**：tmux 本来就给每个 pane 的进程设了 `$TMUX`（含 socket 路径）和 `$TMUX_PANE`。CLI 把两者交给 node，node 只接受 socket 名和自己一样的上报（排除用户自己的另一个 tmux 里编号相同的 pane），再用 `list-panes` 把 pane 换成终端。已经开着的终端也能用，agent 的环境里没有 token。
- **socket**：`<配置目录>/agent.sock`，权限 0600；配置目录太深、超出 Unix socket 路径上限（macOS 约 104 字节）时，放到临时目录，按配置目录的哈希命名，node 和 CLI 算出同一个位置（`offdesk_protocol::agent_socket_path`）。
- **事件映射**（`crates/cli/src/agents.rs`，Codex 的钩子事件和字段同名，共用一套）：
  - `SessionStart`、`Stop`、`Notification(idle_prompt)` → idle；`UserPromptSubmit`、`PreToolUse`、`PostToolUse(Failure)` → working。
  - `PermissionRequest` → approval，内容是“工具: 命令”（如 `Bash: npm test`）。`Notification(permission_prompt)` 不再报一次：前者更具体；没有这个钩子的旧版本还有屏幕识别。
  - `PreToolUse` 的 `AskUserQuestion` → question，带第一个问题和选项（字段格式文档没写，读得到多少用多少）；`TodoWrite` → 进度。新模型默认用 Task 系列工具代替 TodoWrite，它们的进度留待以后。
  - `Notification(agent_needs_input / elicitation_dialog)` → input。
  - Codex 的 `notify`（只有一轮结束）→ idle：`offdesk hook codex notify '<json>'`。
- **Hub**：没有打开的运行时，信号会开一个（钩子往往比 5 秒的轮询早）；working/idle 只在状态变化或请求被答复时才更新和广播；waiting 记下请求原文和选项；`blocked` 转 idle 并记下原因，`finished` 结束为 done。运行多了 `progress` 和 `report`（最近一条自报）。`agent_run_events` 记请求、自报和状态变化，`GET /api/agent-runs/{id}/events` 可读（不含终端输出）。
- **安装**：`offdesk agents hooks install|uninstall [--print]` 改 `$CLAUDE_CONFIG_DIR/settings.json` 或 `~/.claude/settings.json`：只加或删自己的钩子（命令里有 `offdesk` 和 ` hook claude `），用户的其他设置原样保留（顶层顺序和文本不变），重复安装不重复，写之前备份为 `settings.json.offdesk-backup`。没有用 `claude --settings`：文档没说清楚它的 hooks 会不会盖掉用户自己的。Codex 的钩子配置暂不自动安装。
- **验证**：除单元测试外，在隔离的 Hub 和 node 上，在一个终端里按顺序调用钩子和 `offdesk run`：approval（带命令）→ 答复后 working、进度 1/3 和备注 → idle → done 带链接，事件日志按序记下；在 Offdesk 之外、或在另一个 tmux 里调用钩子时，没有输出，退出 0。

### A3 回答

- 回答 API、按键转换、CLI `offdesk answer`、手机注意力条直接回答。
- 完成标准：回答 question 和 approval 后，请求被后续信号关闭；请求已经被别人处理时拒绝；只读模式下拒绝；送达不确定时显示“去终端查看”，不重试。

#### A3 实现说明（2026-10-15）

- **接口**：`POST /api/agent-runs/{id}/answer`，body 是 `AgentAnswer { request_id, approve? | option_id? | text?, device_id }`。成功返回 202 和运行：表示答案已经交给 node 打进终端，不表示 agent 已经接受。和设计里的 `/requests/{rid}/answer` 不同，请求 id 放在 body 里，便于“只回答当前打开的那个”。
- **检查**：运行是调用者机器上的、未结束；`request_id` 是当前打开的请求，且还没有答案（否则 409，避免同一个答案打两次）；回答的设备持有这台机器的控制权（和其他会改动机器的接口一致）；node 声明了 `agent-keys-v1` 能力（否则 503，提示更新 node）。
- **按键**（`keys_for`）：approval 同意是数字 `1`（Claude 和 Codex 的菜单第一项都是“Yes”），拒绝是 `Escape`；question 的选项是它的序号（前九个）；文字是一行（不含控制字符，最多 2000 字）加 Enter。node 新增 `HubToMachine::SendAgentKeys`，用 `tmux send-keys` 直接打进终端（文字用 `-l`，文字和 Enter 之间停 150 ms），只接受这几种键，不借用 attach。
- **请求何时关闭**：答案发出后请求标记 `answer_sent_at_ms`，仍然打开；agent 的下一个信号（钩子的 working、屏幕上的确认消失）才关闭它。所以送达不确定时 UI 显示“已发送”，而不是“已完成”。
- **CLI**：`offdesk answer <run> --approve|--decline|--option <id>|--text <words>`，会先取得控制权；`offdesk runs` 在等待中的运行下面写出它在等什么和怎么回答。
- **手机注意力条**：除了屏幕识别的确认，等待中的运行（比如钩子报告的提问）也列出来，显示请求内容；approval 有 yes/no，question 有前三个选项，点了就发送并显示 sent，直到 agent 继续。没有运行的屏幕确认仍是原来的 Enter。没有控制权时按钮不可用，提示先取得控制权。
- **验证**：Hub 测试覆盖别人、无控制权、错选项、过期请求、重复回答、旧 node 和各种按键；容器里的 E2E 覆盖注意力条里回答问题（含原有的注意力条测试）；隔离环境里，钩子报告 input 后用 `offdesk answer --text` 回答，假 agent 读到了 “Team, and keep the old prices”，再次回答得到 409。
- **真实会话验证（2026-10-15）**：隔离的 Hub 和 node，终端里跑真的 Claude Code（haiku）和 Codex。Claude Code：权限确认“1. Yes … 4. No · Esc to cancel”，`--approve` 打 `1`，命令执行了；`--decline` 打 Esc，显示 “Interrupted”，命令没有执行；AskUserQuestion 的选项 `--option 2` 选中了第二项，agent 回答了它。Codex（`-a on-request -s read-only`，屏幕识别的 approval）：“1. Yes, proceed … 3. No … (esc)”，`--approve` 执行、`--decline` 显示 “You canceled the request”。两个问题在这次验证里修好：Claude Code 对 AskUserQuestion 也会发 PermissionRequest，原来被当成 approval（`--approve` 会选第一项），现在仍算 question；拒绝后 Claude Code 不触发任何钩子，请求一直显示“已发送”，现在发出拒绝后 Hub 直接关掉请求、运行变成 idle。

### A4 启动 API 和 Codex

- 启动 API、CLI `offdesk start`、Codex `notify` 链式接入、Node 上报已安装的 agent。
- 完成标准：`offdesk start` 启动的 claude 和 codex 带着第一条消息开始工作，钩子自动生效；提示里的 shell 元字符原样传给 agent，不被执行；不提供跳过权限确认的方式。

#### A4 实现说明（2026-10-15）

- **接口**：`POST /api/agent-runs`，body 是 `StartAgentRun { machine_id, agent, cwd, prompt?, label?, external_ref?, permission_mode?, device_id }`，成功返回 201 和 `{ run, terminal }`。运行先是 `starting`，agent 出现在终端里后变成 `working`（或屏幕上有确认时 `waiting`）；60 秒还没出现就是 `error`（没装、没登录、一启动就退出）。终端和其他新终端一样放进自己的标签页。需要这台机器的控制权和声明了 `agent-start-v1` 的 node（否则 503，提示更新）。
- **没有命令字段**：hub 只把 `AgentStart { run_id, agent, prompt, permission_mode, external_ref }` 发给 node，由 node 拼命令。提示和外部引用写进 `<config dir>/agent-start/` 下的 0600 文件，命令里用 `"$(cat '<文件>')"` 读，shell 不解析内容；提示不能以 `-` 开头（会被当成选项），控制字符拒绝，最长 32 KB。命令形如 `env OFFDESK_RUN_ID=<id> [OFFDESK_EXTERNAL_REF=…] claude [模式参数] [钩子参数] "<提示>"`。文件一天后清理。
- **权限模式**只有三个，都不跳过确认：`ask`（Claude `--permission-mode default`；Codex `--sandbox read-only --ask-for-approval on-request`）、`accept_edits`（Claude `acceptEdits`；Codex `workspace-write` 沙箱加 `on-request`）、`plan`（只有 Claude）。不传就按 agent 自己的设置。`bypass_permissions` 之类的值反序列化就失败（422）。
- **钩子按会话生效**，不改用户的全局配置：Claude 用 `--settings <文件>` 带上 Offdesk 的钩子（用户已经 `offdesk agents hooks install` 过就不带，免得每个信号报两次）；Codex 用 `-c notify=[offdesk, hook, codex, notify, <用户自己的 notify…>]`（同样从文件读，用户的程序里有什么字符都行）。`offdesk hook codex notify` 报告之后用同一个 JSON 参数 exec 用户原来的程序。用户的 `config.toml` 读不了或者已经接了 Offdesk，就不加。钩子命令用 node 找到的 `offdesk` CLI 的绝对路径，找不到就不加钩子（屏幕识别照常）。
- **文件夹**：不存在的文件夹直接拒绝（502 “There's no folder … on this machine”），因为终端会退回到别的目录，agent 不能在那里干活。
- **已安装的 agent**：node 连上 hub 后在用户的交互式登录 shell 里 `command -v offdesk claude codex`（那里的 PATH 才是终端里的 PATH，服务进程的不是），再补查常见目录，各跑一次 `--version`（10 秒超时），用 `MachineToHub::InstalledAgents` 报给 hub；`GET /api/machines/{id}/agents` 列出来，给以后的启动界面用。
- **CLI**：`offdesk start <machine> --agent claude|codex --cwd <dir> [--prompt <text> | --prompt-file <path|->] [--label] [--ref] [--mode ask|accept-edits|plan] [--json]`，会先取得控制权。
- **没做**：启动界面（wireframe 里的提议）；`offdesk agents hooks install` 还只装 Claude 的全局钩子，Codex 的全局 notify 没有自动安装（通过 Offdesk 启动的 Codex 已经有）；不按 agent 版本调整参数。
- **验证**：node 单元测试用真的 `sh` 跑生成的命令，确认提示里的 `$(…)`、反引号、引号原样到达、什么都没执行，文件权限 0600/0700；hub 测试覆盖错误输入、旧 node、starting → working、超时变 error；隔离环境里用假的 claude/codex 走了一遍：提示原样到达，`OFFDESK_RUN_ID` 和运行一致，注入的 Claude 钩子把运行变成 idle，Codex 的 notify 先报告再调用用户自己的程序。**注意**：隔离测试要给 node 一个临时 `HOME` 并去掉 `USER`，否则终端用账户的登录 shell（读 `.zshrc`），会找到真的 claude。

## 待定问题

1. 钩子是否要扩展到 Offdesk 之外启动的 claude（比如用户自己的 iTerm）？本设计不支持：没有终端就无法接管，也无法回答。
2. Claude Code 当时的版本是否有专门的权限请求钩子？如果没有，approval 的命令文字只能从 `Notification` 的消息里取，可能不完整。
3. `idle` 持续多久算 `gone` 之外的“没人管”？这是客户端的展示规则，还是 Hub 发事件？
4. 运行事件和请求的保留期默认 30 天是否合适？
5. ACP 会话是否在界面上和终端运行混在一个列表里？
