# offdesk-tui

Native Go terminal client for Offdesk. It runs directly in Termux and streams the remote terminal into the existing terminal emulator. The compatibility target is Offdesk Hub and node **v0.25.6**, upstream commit **`2c2c7e374f870bd7b622e960f60b4ae3f44924aa`**. It supports Offdesk's encrypted device-pairing transport and its official HTTPS/WSS token transport. The token transport has been tested with the live Hub and a disposable terminal; encrypted device pairing and actual coding agents remain unverified live.

## Install and pair

Install Go 1.27.2 or newer in Termux and ensure the remote Offdesk node has tmux. From the repository root, build and install the executable to `$PREFIX/bin/offdesk-tui` in fish:

```fish
cd packages/offdesk-tui
go test ./...
go build -o bin/offdesk-tui ./cmd/offdesk-tui
install -m 700 bin/offdesk-tui $PREFIX/bin/offdesk-tui
```

Obtain either a **new encrypted device-pairing link** (`offdesk://pair?` with `v=2`, `hub`, `key`, and `code`) or an official Hub HTTPS sign-in link. Both are secrets; do not paste them into a shell command, terminal history, chat, or a log. Run:

```fish
offdesk-tui pair
```

Paste the entire link into the hidden prompt. An encrypted device-pairing link pins the Hub key and generates a new Noise device identity. A sign-in link creates a separate full-access API token named `offdesk-tui (Termux)`, independently revocable in the Hub's API token settings; it uses HTTPS/WSS rather than the Noise channel. The Hub's supported WSS protocol puts that token in the WebSocket query string, so Hub or reverse-proxy URL logs may contain it. Prefer encrypted device pairing if available.

Credentials are stored in `$XDG_CONFIG_HOME/offdesk-tui/config.json`, or `~/.config/offdesk-tui/config.json` if `XDG_CONFIG_HOME` is unset. The directory is mode 0700 and the file mode 0600. This is a private file, **not** Android Keystore. Protect backups containing it. The Android app's identity is not accessed. For an existing local sign-in link file, `offdesk-tui login-file PATH` reads it without printing the link; keep that file private and delete it when no longer needed.

The candidate key is saved before the single-use code is consumed. If pairing is interrupted, rerun `offdesk-tui pair`: it first tries to resume the same identity. If that fails, enter a new pairing link for the same Hub. To pair a different Hub, first move the existing configuration aside; do not delete the old identity unless you no longer need it.

Only HTTPS Hub origins are accepted, except HTTP loopback addresses used for local testing. The client connects directly and does not use proxy environment variables.

## Terminal

```fish
offdesk-tui
```

When no Offdesk-managed terminals exist, the client offers to create one. With multiple online machines, choose the machine first. Choose socket 1 to attach to or create a session on the default tmux server, or socket 2 for a new shell managed directly by Offdesk. Existing saved tabs reconnect to their machine; use the terminal list to select another. With tmux's standard bindings, `Ctrl+B c` opens a window and `Ctrl+B n` switches to the next one. For an additional terminal, use the local new-terminal command; it offers a plain shell as well as tmux. Output is rendered fullscreen by Termux, including ANSI, Unicode, and colors as supported by your terminal and font. The client does not emulate a terminal. It sends input promptly as it arrives, including Ctrl+C, Ctrl+B, ESC, Tab, arrows, function keys, Unicode, and the usual Alt+M sequence (`ESC m`). The actual keyboard's encoding and application behavior still need live verification.

Press the local prefix **Ctrl+]** to display the command menu, then press a listed key (no Enter needed). Escape returns to the terminal. The client briefly detaches while the menu is displayed and reattaches afterward; the remote process keeps running. The prefix also supports typing a command immediately:

| Key | Action |
| --- | --- |
| `?` or `b` | Show local tabs and help |
| `f` | File menu: list, download, attach a file or replace text |
| `c` | Show ownership and take or release control |
| `n` | Create a new terminal |
| `s` | List saved tabs and other Offdesk terminals, and select by number |
| `[` / `]`, `1`–`9` | Switch saved local terminal |
| `r` | Rename the local label |
| `d` | Remove the local tab without killing its terminal |
| `x` | Terminate the remote terminal after confirmation |
| `q` | Quit and preserve local tabs and remote processes |
| Ctrl+] again | Send a literal Ctrl+] |

Configure the prefix with a hex byte, for example `offdesk-tui prefix 1e` for Ctrl+^. Ctrl+C, Ctrl+B, and Escape cannot be selected as the prefix. A local command detaches the current view; it reconnects when returning. No terminal screen buffer is saved locally. When control belongs to another device, the Hub permits observation and the first input claims control; the client sends a resize after that input. The control menu lets you take or release control. Terminal-generated responses may also be treated as input by this client and claim control; see known limitations.

The terminal list marks terminals detached from this TUI as “detached here” and other terminals without local tabs as “not open here”. It groups terminals by known socket choice and keeps unidentifiable older terminals under Other / unknown. It shows the foreground process name when the Hub and machine provide it. This is best effort and describes the Offdesk-managed pane; when that pane runs a client for the default tmux server, it may say `tmux` rather than the program in a nested window. The Hub does not enumerate windows on external tmux sockets. Once attached to the default tmux session, use its window chooser (normally `Ctrl+B w`) or session chooser (`Ctrl+B s`).

When the connection fails, the client discards queued input and retries with backoff. Mutations and keystrokes are never automatically replayed: after an interruption their delivery can be uncertain. The Hub closes only the terminal attachment on detach, not its process. When a terminal exits after Ctrl+D, the client removes its local tab if its machine is online and returns to Termux. The client also removes saved tabs for terminals confirmed absent on online machines, including at startup. Tabs are kept when their state cannot be confirmed, so an offline machine or network interruption does not discard them. Removing a local tab does not delete a remote session.

### tmux

All normal tmux input passes through unchanged. Offdesk manages its terminal using its own `offdesk` tmux server, whose prefix is disabled. When socket 1 is selected, the TUI starts a tmux client inside that terminal, attaching the most recently used session on the user's `default` tmux server, or creating a session if none exists. It uses the user's tmux configuration and does not alter server options. Socket 2 starts a shell in the Offdesk-managed terminal; Offdesk normally disables its outer tmux prefix, so `Ctrl+B` shortcuts do not operate there. The separate default server and its sessions are also accessible to the Android client by running tmux inside an Offdesk terminal.

If the default server has multiple sessions, use tmux's session chooser (normally `Ctrl+B s`) or attach a particular session from a plain shell:

```fish
env -u TMUX tmux -L default attach-session -t YOUR_SESSION
```

`Ctrl+B d` detaches the tmux client and leaves the session running. The hosting Offdesk terminal may then close; reopening the TUI attaches the default server again. Attaching to an existing session can affect its window size and focus for other clients. `Ctrl+D` is sent to the active program or shell; it can exit a shell and close its tmux window. No existing sessions are migrated, killed, or restarted by the TUI.

Older TUI-created isolated tmux servers are not changed. Their saved names, when available, appear under `Ctrl+]` then `?`; recover a detached server with `env -u TMUX tmux -L SERVER_NAME attach-session -t work`.

## Files

```fish
offdesk-tui machines
offdesk-tui terminals
offdesk-tui ls MACHINE_ID /absolute/remote/directory
offdesk-tui download MACHINE_ID /absolute/remote/file ~/destination
# Explicit overwrite confirmation:
offdesk-tui download MACHINE_ID /absolute/remote/file ~/destination --overwrite
# Explicitly replace an EXISTING remote UTF-8 text file:
offdesk-tui upload MACHINE_ID ~/local.txt /absolute/remote/file --replace
```

In the terminal, `Ctrl+]` then `f` opens the interactive file browser for the current machine, starting in its home directory. Use the arrow keys or `j`/`k` to move, Enter to open a directory or download a file, `h` or the left arrow to go to the parent, `r` to refresh, and `q` to return to the terminal. Downloads go to `~/storage/downloads` if available, otherwise `~/Downloads` if it exists, otherwise the Termux home directory. An existing destination requires confirmation.

- **Download** saves the selected file, up to 20 MiB. The client checks its size and the supplied SHA-256 when available, and commits through a local temporary file.
- **Upload** (`u`) opens a local file picker and replaces an existing remote UTF-8 text file of the same name in the displayed directory, after confirmation. It checks the current hash, refuses a conflict, and verifies the returned size and SHA-256. The upstream API cannot create new files or upload binary files to the chosen directory.
- **Attach** (`a`) selects any local regular file of up to 23 MiB through the picker and sends it through Offdesk's terminal attachment protocol. Offdesk places it in a new remote temporary directory and pastes the resulting path into the active shell or program. Confirm this action because it sends input to that program. The protocol has no delivery receipt; inspect the resulting path in the terminal.

These upstream operations are bounded JSON/base64 requests, not streaming file transfers. Attaching does not choose an arbitrary remote destination, and replacement cannot create a new file or replace binary content. Progress reports local processing and completion, not continuous network progress. Ctrl+C cancels a transfer; if a write was already sent, its outcome can be unknown and it is not replayed.

## Known limitations

- Encrypted device pairing, actual network interruptions, physical-keyboard behavior, AGY, Codex, and visual font rendering remain unverified live. HTTPS/WSS discovery, remote execution, first-character delivery, detach, reattach, and bounded file transfers passed with a disposable terminal on the v0.25.6 Hub/node.
- Fullscreen passthrough is the only layout; there is no persistent tab bar or compact pane. The terminal emulator owns rendering and scrollback.
- One selected terminal is attached at a time. Local tabs persist as machine and terminal IDs; inactive tabs are detached, then freshly attached on selection.
- Terminal-generated responses are not distinguished from keyboard data; a response to a terminal query can claim control. On interrupted connections, input that may have reached the Hub is deliberately not resent.
- File transfers are limited as described above. Attachments have no upstream delivery receipt. Progress is not byte-level network progress.
- There is no separate clipboard service or clipboard API implementation. Native terminal OSC 52 behavior depends on Termux; the Android app's xterm clipboard integration does not establish a standalone Hub clipboard endpoint.
- `go test -race` is unsupported by the installed Go toolchain on android/arm64. No race-detector result is claimed.

See [protocol.md](docs/protocol.md) and [termux.md](docs/termux.md) for protocol details, test coverage and updates.
