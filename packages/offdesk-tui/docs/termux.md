# Termux build and test notes

Development, dependency downloads, build and tests were performed in Termux on the phone. The installed Go reported `go1.27.2 android/arm64` (`GOOS=android`, `GOARCH=arm64`). No root or compatibility environment is required. Dependencies are pinned by `go.mod` and `go.sum`.

```fish
cd packages/offdesk-tui
go test ./...
go vet ./...
go build -o bin/offdesk-tui ./cmd/offdesk-tui
install -m 700 bin/offdesk-tui $PREFIX/bin/offdesk-tui
```

This builds for the active native Termux Go target; it is not a desktop Linux cross-build. An update should first inspect upstream changes and pin a compatible commit, then run the tests and build again. The protocol reference is pinned in the client documentation.

## Executed tests

`go test ./...` passed on Android. The mock uses an independent encrypted Noise IK WebSocket responder and simulates API and terminal messages. Tests cover authentication rejection and key pinning, pair/resume, machine and terminal lists, binary output, first input, `ESC m`, Ctrl+C, Ctrl+B, arrows and Unicode, resize, ownership request, create/destroy of an isolated mock terminal, detach, reconnect, bounded upload/download and integrity checks. Unit tests cover prefix boundaries, split UTF-8, tab selection, pairing validation and unsafe file paths.

`tests/pty_test.go` also launches the actual raw-mode TUI under an Android pseudo-terminal and checks the immediate Ctrl+] command menu, literal-prefix forwarding, input forwarding, SIGWINCH, interrupted-connection recovery, file and control menus, and Ctrl+D exit and local tab removal. Mock tests also check choosing between multiple machines, removing absent tabs on online machines, and preserving tabs for offline machines. These tests do not contact the production Hub. `go vet ./...` passed. `go test -race ./...` cannot run: the installed Go toolchain reports that the race detector is unsupported on android/arm64.

Live tests used an independently revocable API token and the official HTTPS/WSS path: authentication, one-machine discovery, disposable terminal creation, WSS streaming, delivery of the first character, command execution, detach, reattach, bounded file download and conditional text upload all passed. A separate disposable terminal verified that `Ctrl+B c` creates a second window in the isolated tmux server. A native PTY test against the live Hub verified automatic creation when no terminal exists, the ownership and file-browse menus, a binary terminal attachment checked by downloading and comparing it, and a single Ctrl+D returning to Termux without a prompt. Test terminals and files were removed and control was released. No pre-existing sessions were terminated.

Not yet tested: encrypted device pairing with a live Hub, actual network interruptions, Codex/AGY responses including physical Alt+M, fullscreen programs, visual Nerd Font/color output, or Android background/foreground transitions. A mock streaming bytes containing a Nerd Font glyph does not prove the font rendered it. The mock HTTPS/WSS test also checks the token transport; mock Noise tests do not establish live Noise interoperability.

The local private config is under `$XDG_CONFIG_HOME/offdesk-tui/` or `~/.config/offdesk-tui/`; never commit or print it. The binary runs unprivileged. If a destination filesystem does not implement atomic `renameat2(RENAME_NOREPLACE)`, a download without `--overwrite` fails rather than silently overwriting a file.
