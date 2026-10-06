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

Agent browsers belong to the machine, not to a terminal: they are never panes or
tabs of the workspace. On the desktop web UI (and the desktop app) the **Browser**
button in the top bar opens them in an overlay; the phone has its own view (see
below). `opener_terminal_id` (the terminal that ran `offdesk browser open`) is
informational on the desktop; only the phone uses it, to list a browser beside its
terminal.

### On the desktop

The **Browser** (globe) button sits in the top bar whenever the active machine is
online. It shows how many browser tabs the machine has, and a warning dot while an
agent is waiting for a person (see [Taking over](#taking-over-and-handing-off)).
Clicking it opens a large floating panel over the workspace, with a light
backdrop. The terminals underneath stay mounted and keep their connections.

- **Tab strip.** One tab per agent browser of the machine, labelled with the page
  title (or the host), a dot when the agent needs you and a "you" chip while this
  device controls it. Click a tab to show it, its **x** to close that browser (the
  control is handed back first when you hold it). The last tab you looked at on a
  machine is remembered while the page stays open; if it goes away the first
  remaining tab is shown. Opening the overlay lands on a tab that is asking for
  help, if there is one.
- **New tab.** The **+** button shows an address field; Enter opens the page on the
  machine (`POST /api/machines/{machine}/agent-browser` with `{"type":"open","url":...}`)
  and selects the new tab. A bare host such as `aliyun.com` gets `https://`;
  `localhost` and IPv4 addresses get `http://`. Errors show under the field.
- **Body.** The selected browser, live, with the page title, URL, who is in
  control, **Take over** / **Hand back**, the connection state and the handoff
  banner. Only the selected tab streams: other tabs hold no connection, and the
  node stops the screencast when the last viewer leaves.
- **Empty state.** With no browser tabs it says "No browser tabs on this machine"
  and shows the address field.
- **Closing the overlay.** The **x** in the corner, a click on the backdrop, or
  Esc. While *this device is in control*, Esc (like every key) goes to the page and
  does not close the overlay; hand back first, or use the **x** or the backdrop.
  Closing the overlay stops streaming but does not hand control back: it is
  released automatically 2 minutes after this device stops watching (see
  Auto-release).
- **Shortcuts.** Workspace shortcuts (including the Ctrl+B prefix) do not fire while
  you type in the address field or control a page.
- **Handoffs while the overlay is closed.** A new handoff shows a toast, "The agent
  needs you in <title>: <reason>", and the dot on the button.

### On the phone

The mobile web UI (and the Android app, which wraps it) lists the agent browsers
of the active machine in the session switcher, with a globe icon: in the tab of
the terminal that opened it, or in a tab of its own. Picking one shows it
full-width in place of the terminal (terminals stay connected underneath); a
machine that has only browsers opens its browser straight away. The header has
the page title, who is in control, **Take over** / **Hand back** and close; a
handoff shows the same banner as on the desktop, and also appears in the bar of
sessions needing attention at the top of the phone UI with its reason (tap it to
open the browser).

- **Zoom** is local, a view aid that is never sent to the page. The page is
  1280x800, so on a phone it is small: pinch to zoom 1x to 3x around your
  fingers and drag with two fingers to pan. Double-tap toggles 1x and 2.5x at
  the tap point while you are *not* in control (one finger also pans a zoomed
  view then); a chip in the corner resets it.
- **While you are in control** one finger is the mouse: a tap is a left click,
  a one-finger drag scrolls the page (it follows your finger, like native
  scrolling), and holding still for about half a second is a right click. Two
  fingers are always zoom and pan and never reach the page.
- **Keyboard.** The keyboard button in the bar under the page opens the soft
  keyboard. Typed text and committed IME text are sent as text (a composition is
  sent once, when you commit it), and the bar has Esc, Tab, arrows, Backspace
  and Enter keys.
- The stream is sized to the view (times the device pixel ratio, at most
  1280x800) at JPEG quality 50.

## Commands

```
offdesk browser open [URL] [--machine M] [--json]   # prints the browser id
offdesk browser ls [--machine M] [--json]           # ID, MACHINE, URL, TITLE
offdesk browser close <browser>
offdesk browser goto <browser> <url> [--json]
offdesk browser snapshot <browser>                  # the page as text
offdesk browser click <browser> <ref>
offdesk browser click <browser> --text TEXT         # by visible text, for tabs/toggles without a ref
offdesk browser fill <browser> <ref> <text>
offdesk browser press <browser> <key>               # Enter, Tab, Escape, ArrowDown, a, ...
offdesk browser wait <browser> [--text T] [--url-regex REGEX] [--idle MS] [--timeout SEC]
offdesk browser screenshot <browser> [-o FILE] [--full]
offdesk browser handoff <browser> --reason TEXT [--wait] [--timeout SEC]   # ask a person for help
offdesk browser wait-control <browser> [--timeout SEC]                      # wait until no person is in control
offdesk browser logins <browser> [--json]           # saved 1Password logins for this page (no secrets)
offdesk browser login <browser> --item ITEM [--submit]   # fill a 1Password login into the page
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
| `3` | A person is controlling the browser; `goto`, `click`, `fill`, `login`, `press` and `close` were refused |

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

A person watching a browser can take control of the browser, click and type in
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
- **In the web UI** the overlay's browser header shows "Agent in control" with a **Take
  over** button; "You're in control" with **Hand back** while this device
  controls it; "Controlled on another device" with **Take over** while another
  one does (taking it is last-writer-wins). While you control it, the page
  takes focus and sends your mouse (move, press, release, drag), wheel,
  keyboard, IME composition and paste to the page; the context menu is
  suppressed on it. Every key, Esc and the workspace prefix key (Ctrl+B)
  included, is sent to the page. Closing a tab while in control hands it back
  first, then closes the browser.
- **A handoff** shows a banner above the page, "The agent needs you: <reason>",
  with a **Take over** button, and a warning dot on the top-bar **Browser**
  button and on the browser's tab until a person has taken over (a toast says so
  too when the overlay is closed). **Hand back** (header or banner)
  clears the handoff.
- **Auto-release.** If the controlling device has no open viewer WebSocket for
  the browser for 2 minutes (the overlay was closed, the tab hidden, the app quit, the
  network dropped), the hub hands control back to the agent exactly like
  `release` (the handoff is cleared too) and tells every client. Reconnecting
  within the 2 minutes cancels it. Control taken over REST with no viewer
  connected is released after the same 2 minutes.
- **`wait-control <browser> [--timeout SEC]`** blocks until the agent controls
  the browser again: exit `0`, or `1` on timeout (default 600 s).
- **`handoff <browser> --reason "Please log in"`** asks a person for help: the
  reason is stored with the browser as `handoff` (`reason`, `requested_at`) and
  every client is told, so the overlay can show a banner. It does not take control
  itself; the person does that from the overlay. With `--wait` the command blocks
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

If the controlling person closes the overlay without releasing, the hub releases
control after 2 minutes without a viewer from that device (see Auto-release
above); until then `wait-control` and `handoff --wait` keep waiting.

## MCP

`offdesk mcp` serves the same commands as MCP tools over stdio, for agents
that prefer MCP to shelling out. It makes the same hub calls as
`offdesk browser ...` and uses the same hub URL and token (`--url`/`--token`,
`OFFDESK_URL`/`OFFDESK_TOKEN`, or `config.toml`). Register it from inside an
offdesk terminal (the server then knows which terminal opened a browser, as the
CLI does):

```
claude mcp add offdesk -- offdesk mcp
codex mcp add offdesk -- offdesk mcp      # or in ~/.codex/config.toml:
                                          #   [mcp_servers.offdesk]
                                          #   command = "offdesk"
                                          #   args = ["mcp"]
```

Tools (arguments in brackets are optional):

| Tool | Arguments | Like |
| --- | --- | --- |
| `browser_open` | `[url]`, `[machine]` | `open --json` (returns the record, use its `id`) |
| `browser_list` | `[machine]` | `ls --json` |
| `browser_close` | `browser_id` | `close` |
| `browser_goto` | `browser_id`, `url` | `goto` (returns url and title) |
| `browser_snapshot` | `browser_id` | `snapshot` |
| `browser_click` | `browser_id`, `ref` or `text` (exactly one) | `click` / `click --text` |
| `browser_fill` | `browser_id`, `ref`, `text` | `fill` |
| `browser_press` | `browser_id`, `key` | `press` |
| `browser_wait` | `browser_id`, `[text]`, `[url_regex]`, `[idle_ms]`, `[timeout_ms]` (default 30000) | `wait` |
| `browser_screenshot` | `browser_id`, `[full_page]` | `screenshot` (returned as an MCP image, no file) |
| `browser_handoff` | `browser_id`, `reason`, `[wait]`, `[timeout_ms]` (default 600000) | `handoff` |
| `browser_logins` | `browser_id` | `logins --json` |
| `browser_login` | `browser_id`, `item`, `[submit]` | `login` |
| `browser_wait_control` | `browser_id`, `[timeout_ms]` (default 600000) | `wait-control` |

`browser_id` is an id or unique prefix, resolved across all online machines
like the CLI. Timeouts are in milliseconds here (seconds in the CLI).

Results and errors:

- Success is a text result with what the CLI prints (the snapshot, JSON for
  `browser_open`/`browser_list`, `url<TAB>title` for `browser_goto`, a short
  confirmation for click/fill/press/close).
- A person controlling the browser (CLI exit 3) is a tool error (`isError`)
  saying so and telling the agent not to retry until `browser_wait_control`
  returns.
- Timeouts (CLI exit 1) are **not** errors: `browser_wait` returns
  `did not match before the timeout: ...`, and `browser_wait_control` /
  `browser_handoff` with `wait` say a person is still in control or has not
  helped yet. The agent decides whether to wait again.
- Everything else (no hub configured, unreachable hub, stale ref, unknown tool,
  bad arguments) is a tool error with the message.

Requests run concurrently, so a long `browser_wait` or `browser_wait_control`
does not block `ping` or other calls. On stdin EOF the server gives running
calls up to 5 seconds to answer, then exits. `notifications/cancelled` is
accepted but does not interrupt a running call.

## Snapshots and refs

`snapshot` prints a pruned accessibility tree: one line per meaningful node,
indented by depth. Interactive nodes (links, buttons, text boxes, checkboxes,
and so on) carry a handle such as `[ref=e12]`; pass that handle to `click` and
`fill`.

**Refs go stale.** They are valid only for the page as it was when the
snapshot was taken. After navigation or any change to the DOM, run `snapshot`
again and use the new refs. A stale ref makes the command fail with an error.
Very large pages are truncated.
Iframe contents are included (see Iframes).

## Iframes

Login forms and payment widgets often live in iframes (Aliyun's login box is
`passport.aliyun.com` inside `account.aliyun.com`). `snapshot` reads them: each
iframe's tree is nested under its `Iframe` line, which names the frame's host,
and refs keep counting across frames:

```
- Iframe [frame=passport.aliyun.com]
  - textbox "+86" [ref=e2]
  - textbox "验证码" [ref=e3]
  - button "获取验证码" [ref=e4]
```

`click`, `fill` and `press` work on those refs like any other. Same-process
iframes and out-of-process iframes (cross-site, each its own CDP target; the
node enables `Target.setAutoAttach` and follows the child sessions) are both
supported, nested up to 3 deep. A click inside an out-of-process iframe is
translated to page coordinates by adding the content-box offset of each
iframe element, and the iframes on the way are scrolled into view. Iframes
that are hidden or 0 pixels large are skipped. Shadow DOM is only searched by
`click --text` and `login`, not shown specially in snapshots beyond what the
accessibility tree already exposes.

## Click by text

Many tabs and toggles are clickable `div`s with no accessibility role, so they
get no ref. `click <browser> --text "账密登录"` (MCP: `browser_click` with
`text`) finds the smallest visible element, in any frame, whose trimmed text
equals the given text (else the smallest one that contains it, an exact match
always wins) and clicks its centre. It prints what it clicked (tag and text,
for example `clicked div "账密登录"`). Give exactly one of a ref and `--text`.

## Logging in with 1Password

An agent can log in without taking over and without ever seeing the password:

```
offdesk browser logins <browser>                    # which saved logins fit this site?
ITEM ID    TITLE         USERNAME           VAULT
fakeid111  Fake Console  alice@example.com  Personal

offdesk browser login <browser> --item fakeid111 --submit
{"filled":["username","password"],"frames":["passport.aliyun.com"],"submitted":true}
```

**Setup.** The CLI side uses the 1Password CLI, `op`, on the machine where
`offdesk` (or `offdesk mcp`) runs. Either install `op` and turn on
*Integrate with 1Password CLI* in the 1Password desktop app (Settings >
Developer; the app may ask you to approve each request), or export
`OP_SERVICE_ACCOUNT_TOKEN` for a service account that can read the vault. With
`op` missing or not signed in, the command prints this setup hint and exits
`2`. `op`'s own stderr is passed through (that is where the desktop approval
prompt message appears), and it gets 120 seconds.

**What the agent sees.** `logins` runs `op item list --categories Login` and
keeps the items with a website on the same registrable domain as the browser's
page. It prints item id, title, username (the account name from
`additional_information`) and vault, and `--json` prints the same as JSON.
No secret field is requested or printed. `login` fetches the one item with
`op item get <id> --reveal` and keeps username and password in memory only:
never on a command line, never printed, wiped after use. The node's reply
names the fields filled and the hosts of the frames, never values.

**Domain check.** The password is typed only into a frame whose registrable
domain (eTLD+1) is one of the item's website domains. The CLI refuses when
the page itself is on another domain, and the node checks again for every
frame it fills (using the frame's origin) and refuses with an error naming
the frame's domain, so an iframe from an unrelated site embedded in a trusted
page never gets the secret. The registrable domain is computed by
`offdesk_protocol::domain`, shared by CLI and node: the last two labels of a
host, or three under a short built-in list of common multi-part suffixes
(`com.cn`, `net.cn`, `org.cn`, `com.hk`, `co.uk`, `com.au`, `co.jp`, ...).
IP addresses and `localhost` are their own domain. For a site under a
multi-part suffix that is not on the list, the domain comes out too broad;
add the suffix to `MULTI_PART_SUFFIXES`.

**What `login` does.** In every frame it looks for a visible password field
and the username field before it (same form, `autocomplete=username|email`
first); it prefers a frame on an allowed domain. Each field is focused,
cleared and filled with `Input.insertText`, which fires the same trusted
`beforeinput`/`input` events as typing (React-style controlled inputs keep the
value), then a `change` event. If the page shows only a username field
(two-step logins), only the username is filled and the reply says so: wait
for the next step and call `login` again. `--submit` presses Enter in the last
field. `login` is a mutating command: it is refused with exit `3` while a
person controls the browser, like `fill`.

**Redaction.** `AgentBrowserCommand::Login` carries the credentials as a
`Secret`, whose `Debug` prints `Secret(<redacted>)` (so no `{:?}` of a command
or message leaks it) and which is zeroed on drop. The hub only forwards the
command (it neither logs nor stores bodies), the node does not log CDP
parameters, error messages never include the values, and the `op` output is
never quoted in errors.

**Not covered.** Sites that distrust synthetic input (they listen for
`isTrusted` keystrokes with timing checks, or block paste/insert) may still
reject the fill; captchas and 2FA codes need `handoff`. Fields inside closed
shadow roots are not found. A password manager item with several accounts for
one site needs the right `--item`; titles must be exact (and unique).

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
