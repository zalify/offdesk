# Agent browser

A headless Chromium that a node owns and an AI agent drives from the
`offdesk browser` CLI: open a page, read it as text, fill and click, wait,
take a screenshot. It runs on the machine the node runs on, so it sees that
machine's network (localhost dev servers, LAN hosts) and keeps its logins.

- One Chromium per node, started on the first `open` and reused afterwards.
- One persistent profile per machine at `<config dir>/agent-browser/profile`
  (cookies and logins survive restarts). `<config dir>` is the same directory
  that holds `machine.json`.
- One tab per agent browser. An agent browser is addressed by its id or a
  unique id prefix, like terminals.
- Requests go CLI to hub to node, so the CLI needs the usual `OFFDESK_URL` and
  `OFFDESK_TOKEN`, and the node must be online.

The web UI shows each agent browser live as a pane: in the tab of the terminal
that opened it, or in a tab of its own when it was opened without one. Its
header has the page title, URL, who is in control, a **Take over** / **Hand
back** button, connection state and a close button (see
[Taking over](#taking-over-and-handing-off)). A pane streams only while it is
visible: a hidden tab or a hidden browser window holds no connection, and the
node stops the screencast when the last viewer leaves.

## Commands

```
offdesk browser open [URL] [--machine M] [--json]   # prints the browser id
offdesk browser ls [--machine M] [--json]           # ID, MACHINE, URL, TITLE
offdesk browser close <browser>
offdesk browser goto <browser> <url> [--json]
offdesk browser snapshot <browser>                  # the page as text
offdesk browser click <browser> <ref>
offdesk browser fill <browser> <ref> <text>
offdesk browser press <browser> <key>               # Enter, Tab, Escape, ArrowDown, a, ...
offdesk browser wait <browser> [--text T] [--url-regex REGEX] [--idle MS] [--timeout SEC]
offdesk browser screenshot <browser> [-o FILE] [--full]
offdesk browser handoff <browser> --reason TEXT [--wait] [--timeout SEC]   # ask a person for help
offdesk browser wait-control <browser> [--timeout SEC]                      # wait until no person is in control
```

`--machine` takes a machine id, unique id prefix, or name. Without it, `open`
uses the only online machine, or else the machine the CLI runs on; `ls` lists
every online machine.

`wait` exits `0` when the condition matched, `1` on timeout (the reason is on
stderr) and `2` on an error. `--timeout` defaults to 30 seconds. Give at least
one of `--text`, `--url-regex`, `--idle`.

Exit codes for every `offdesk browser` command (also in `offdesk browser --help`):

| Code | Meaning |
| --- | --- |
| `0` | Success (`wait`: matched; `handoff --wait` / `wait-control`: the person is done) |
| `1` | Timeout (`wait`, `handoff --wait`, `wait-control`) |
| `2` | Error |
| `3` | A person is controlling the browser; `goto`, `click`, `fill`, `press` and `close` were refused |

`screenshot` writes a PNG and prints its path; the default file is
`./browser-<id8>-<timestamp>.png`, `--full` captures the whole page.

## Example

```sh
B=$(offdesk browser open https://example.com/login)
offdesk browser snapshot $B
#   - heading "Sign in" [level=1]
#   - textbox "Email" [ref=e1]
#   - textbox "Password" [ref=e2]
#   - button "Sign in" [ref=e3]
offdesk browser fill $B e1 me@example.com
offdesk browser fill $B e2 hunter2
offdesk browser click $B e3
offdesk browser wait $B --text "Dashboard" --timeout 20 || echo "login failed"
offdesk browser screenshot $B -o dashboard.png
offdesk browser close $B
```

`open` prints only the browser id, so it can be captured as above; `--json`
prints the whole record (`id`, `machine_id`, `url`, `title`). `goto` prints the
resulting URL and title separated by a tab.

## Taking over and handing off

A person watching the pane can take control of the browser, click and type in
it, and give it back. This is for what an agent cannot do: logging in, solving
a captcha, entering a 2FA code.

- **Who controls it.** Each agent browser is controlled by the agent (the
  default) or by one person's device. Taking control is last-writer-wins: if a
  second device takes it, the first one loses it. The state lives on the hub
  and is part of the browser record every client receives: `controller`
  (`"agent"` or `"human"`), and while a person controls it,
  `controller_device_id` and `controller_since` (ms).
- **While a person controls it,** commands that change the page (`goto`,
  `click`, `fill`, `press`, `close`) are refused: the hub answers HTTP 409
  `{"error": "a person is controlling this browser", "code": "user_in_control"}`
  (plus `"reason"` when a handoff is pending) and the CLI prints "A person is
  controlling this browser. Wait for them with `offdesk browser wait-control
  <browser>`." and exits `3`. `snapshot`, `screenshot`, `wait`, `ls` and
  `open` keep working, so an agent can watch what the person does.
- **In the web UI** the pane header shows "Agent in control" with a **Take
  over** button; "You're in control" with **Hand back** while this device
  controls it; "Controlled on another device" with **Take over** while another
  one does (taking it is last-writer-wins). While you control it, the pane
  takes focus and sends your mouse (move, press, release, drag), wheel,
  keyboard, IME composition and paste to the page; the context menu is
  suppressed on it. The workspace prefix key (Ctrl+B) still belongs to the
  workspace and is never sent to the page. Closing the pane while in control
  hands it back first, then closes the browser.
- **A handoff** shows a banner in the pane, "The agent needs you: <reason>",
  with a **Take over** button, and a small dot on the workspace tab that holds
  the browser until a person has taken over. **Hand back** (header or banner)
  clears the handoff.
- **Auto-release.** If the controlling device has no open viewer WebSocket for
  the browser for 2 minutes (the pane was closed or hidden, the app quit, the
  network dropped), the hub hands control back to the agent exactly like
  `release` (the handoff is cleared too) and tells every client. Reconnecting
  within the 2 minutes cancels it. Control taken over REST with no viewer
  connected is released after the same 2 minutes.
- **`wait-control <browser> [--timeout SEC]`** blocks until the agent controls
  the browser again: exit `0`, or `1` on timeout (default 600 s).
- **`handoff <browser> --reason "Please log in"`** asks a person for help: the
  reason is stored with the browser as `handoff` (`reason`, `requested_at`) and
  every client is told, so the pane can show a banner. It does not take control
  itself; the person does that from the pane. With `--wait` the command blocks
  until a person has taken control and handed it back (control back to the
  agent, handoff cleared): exit `0`, or `1` after `--timeout` seconds (default
  600). Without `--wait` it returns at once.

```sh
offdesk browser goto $B https://example.com/login
offdesk browser handoff $B --reason "Please log in; I need the account page" --wait \
  || { echo "nobody helped"; exit 1; }
offdesk browser snapshot $B     # now signed in
```

Waiting is a hub long-poll (at most 60 s per request, looped by the CLI), not
polling.

### Hub API

- `POST /api/machines/{machine}/agent-browser/{browser}/control`, body
  `{"action": "take" | "release", "device_id": "..."}` (`device_id` required for
  `take`). `release` also clears a pending handoff. Returns the browser record.
- `POST /api/machines/{machine}/agent-browser/{browser}/handoff`, body
  `{"reason": "..."}` (1 to 500 characters). Returns the browser record.
- `GET /api/machines/{machine}/agent-browser/{browser}/control`
  `?wait_for=agent|resolved&timeout_ms=`: `{"controller", "ready", "browser"}`.
  Without `wait_for` it answers at once. `agent` is ready when the agent controls
  the browser; `resolved` also needs no pending handoff. Waits at most 60 s;
  a timeout is a normal reply with `ready: false`.

### Viewer input

The viewer WebSocket `/ws/agent-browser/{machine}/{browser}` takes a
`device_id` query parameter. Only the device that currently controls the browser
may send input; anything else (another device, no `device_id`, nobody in
control) is dropped silently. Upstream JSON:

```
{"type":"input","event":{"kind":"mouse","action":"move"|"down"|"up","x":..,"y":..,
                         "button":"left"|"middle"|"right"|"none","buttons":0,"click_count":1,"modifiers":0}}
{"type":"input","event":{"kind":"wheel","x":..,"y":..,"delta_x":0,"delta_y":120,"modifiers":0}}
{"type":"input","event":{"kind":"key","action":"down"|"up","key":"a","code":"KeyA","text":"a","modifiers":0,"key_code":65}}
{"type":"input","event":{"kind":"text","text":"pasted or IME text"}}
```

Coordinates are CSS pixels in the fixed 1280x800 viewport and are clamped to it;
`modifiers` is the CDP bitmask (Alt 1, Ctrl 2, Meta 4, Shift 8); `text` events
are at most 10000 characters. The node applies each browser's input in order
on its own task, so it is never held up by screencast frames; a backlog of
mouse moves collapses to the latest one. Ctrl or Cmd with A, C, X, V, Z, Y runs
the matching editing command.

If the controlling person closes the pane without releasing, the hub releases
control after 2 minutes without a viewer from that device (see Auto-release
above); until then `wait-control` and `handoff --wait` keep waiting.

## Snapshots and refs

`snapshot` prints a pruned accessibility tree: one line per meaningful node,
indented by depth. Interactive nodes (links, buttons, text boxes, checkboxes,
and so on) carry a handle such as `[ref=e12]`; pass that handle to `click` and
`fill`.

**Refs go stale.** They are valid only for the page as it was when the
snapshot was taken. After navigation or any change to the DOM, run `snapshot`
again and use the new refs. A stale ref makes the command fail with an error.
Very large pages are truncated.

## Chromium discovery

The node looks for a browser in this order:

1. `OFFDESK_CHROMIUM`, a path to an executable (an error if it is not one).
2. `google-chrome` or `chromium` (and their common variants) on `PATH`.
3. The standard macOS application locations.
4. Otherwise, the first `open` downloads Chrome for Testing into
   `<config dir>/agent-browser/chrome/` (about 150 MB, so the first `open`
   can take minutes) and reuses it afterwards.

Chromium runs with its sandbox, except when the node runs as root or
`OFFDESK_CHROMIUM_NO_SANDBOX` is set, where it is started with `--no-sandbox`
(containers commonly need this). Set the variable in the node's environment.

## Limits

Time limits at the hub: `open` 5 minutes, `wait` its timeout plus 15 seconds,
everything else 60 seconds. If the machine is offline the CLI reports it; a
command that exceeds the limit reports a timeout.
