# Mobile terminal attention

On a phone, a conditional strip below the title bar lists other reachable
terminals with detected confirmation prompts. Tap a terminal to open its tab
or machine directly. Several requests scroll horizontally. Viewing a request
does not resolve it; it disappears from the strip while that terminal is open,
and returns when leaving if the confirmation is still pending. The switcher
also labels these terminals. No control is claimed and no input is sent by the
shortcut.

The node checks the visible tmux screen every five seconds for foreground
`claude`, `codex`, and `node` processes. The first adapter recognizes English
Claude/Codex yes/no confirmation menus with a selected choice and a cancellation
footer. Only the resulting `confirmation` state is sent to the Hub, on change;
screen text stays on the machine. Background terminals are not streamed to the
phone for this feature. Detection adds one local `capture-pane` subprocess per
candidate terminal per poll, alongside the existing metadata poll.

This is best-effort screen recognition, not a semantic agent hook. Unrecognized
versions, localized prompts, free-text questions, trust dialogs and task
completion are not covered. Printed text that exactly imitates a live menu can
be misidentified. Never infer success or completion from quiet output. Future
agent hooks can feed the same attention field with explicit lifecycle signals.

Update both Hub and node for detection. Older nodes omit the optional field;
older Hubs ignore the new message. State is ephemeral, included in authenticated
bootstrap/events, and refreshed after node reconnect. Offline terminals are
excluded. This feature is an in-app cue, not a background push notification.

中文：手机顶部显示其他终端的确认请求，点击直接切换；处理后自动清除。
首版通过电脑端可见屏幕识别常见英文 Claude/Codex 确认菜单，约五秒更新，
并不覆盖所有待办或任务完成状态。需同时更新 Hub 和 node。
