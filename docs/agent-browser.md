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

A web UI to watch and take over an agent browser is planned; it is not part of
this feature yet.

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
```

`--machine` takes a machine id, unique id prefix, or name. Without it, `open`
uses the only online machine, or else the machine the CLI runs on; `ls` lists
every online machine.

`wait` exits `0` when the condition matched, `1` on timeout (the reason is on
stderr) and `2` on an error. `--timeout` defaults to 30 seconds. Give at least
one of `--text`, `--url-regex`, `--idle`. Other commands exit `0` or `2`.

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
