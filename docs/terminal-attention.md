# Mobile terminal attention

On a phone, a conditional strip below the title bar lists other reachable
terminals with detected confirmation prompts. Tap a terminal to open its tab
or machine directly. Several requests scroll horizontally. Viewing a request
does not resolve it; it disappears from the strip while that terminal is open,
and returns when leaving if the confirmation is still pending. The switcher
also labels these terminals. Opening a terminal by its name does not itself
send Enter.

The separate **Enter** button sends one Enter to that background terminal's
currently selected option without switching your view or focusing a keyboard
input. It does not mean “always approve”: open the terminal to inspect or change
its selection when needed. View-only mode and unavailable input permissions
disable the button.

Before sending, the client waits for the target terminal attachment and checks
that the request is still pending and input is permitted. It does not resize
the terminal, prevents repeated taps until the request clears, and never retries
an uncertain delivery automatically. **Sent** means the input was handed to the
transport, not that the command completed; **Check** means open the terminal to
inspect the result before trying again.

The node checks the visible tmux screen every five seconds for foreground
`claude`, `claude.exe` (including the native macOS build), `codex`, and `node` processes. The first adapter recognizes English
Claude/Codex yes/no confirmation menus with a selected choice and a cancellation
footer. Only the resulting `confirmation` state is sent to the Hub, on change;
screen text is not included in attention events. Listing waiting requests does
not stream background terminals. Tapping Enter briefly attaches to its target
through the existing encrypted or ordinary terminal transport. Detection adds one local `capture-pane` subprocess per
candidate terminal per poll, alongside the existing metadata poll.

This is best-effort screen recognition, not a semantic agent hook. Unrecognized
versions, localized prompts, free-text questions, trust dialogs and task
completion are not covered. Printed text that exactly imitates a live menu can
be misidentified. Never infer success or completion from quiet output. Future
agent hooks can feed the same attention field with explicit lifecycle signals.

Update both Hub and node for detection. Older nodes omit the optional field;
older Hubs ignore the new message. State is ephemeral, included in authenticated
bootstrap/events, and refreshed after node reconnect. Offline terminals are
excluded. For the Enter button, update the Hub's web UI for browser/ordinary
connections, or update the App for encrypted connections that use its bundled
UI. This feature is an in-app cue, not a background push notification.

中文：手机顶部显示其他终端的确认请求。点终端名称查看请求；点旁边的
Enter 可确认那个终端当前选项，保持当前视图和键盘焦点。Enter 不等于
“总是同意”，不确定时请先查看。重复点击会被阻止，发送不确定时不会自动重试。
通过电脑端可见屏幕识别常见英文 Claude/Codex 确认菜单，约五秒更新，
支持 macOS 原生 Claude 的 `claude.exe` 进程名，但不覆盖所有待办或任务完成状态。
需更新 Hub 和 node；加密连接还需更新 App 以获得新的内置界面。

Event delivery is checked synchronously against the last received sequence.
A gap triggers a fresh authenticated bootstrap, even when React batches state
updates. The snapshot restores pending confirmations missed during a disconnect;
this does not broaden the screen detector's supported prompt formats.
