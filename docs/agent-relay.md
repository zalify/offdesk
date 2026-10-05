# Continue a task in another agent

When a terminal runs Claude Code or Codex, a small agent chip floats over its
top-right corner. **Continue in Codex** (or **Continue in Claude**) starts the
other agent in a new tab in the same folder. Its first message is a handoff
brief, so it starts working right away.

## When it appears

- **Agent chip.** Shown while the Node sees a `claude` (including `claude.exe`)
  or `codex` process in the terminal. The chip is an overlay and never resizes
  the terminal. On desktop, the pane's context menu has the same action.
- **Usage-limit card.** Shown while the agent's own limit notice is in the last
  lines of the screen: Claude's `Usage limit reached …` or Codex's `You’ve hit
  your usage limit`. Context limits and fast-mode limits do not count. **Wait**
  hides the card until a different notice appears.

## The brief

The Node reads the source agent's own files and the working tree, and the
sheet shows the result as editable text:

- **Claude.** The session is matched through `~/.claude/sessions/<pid>.json`
  (its `tmux` field names the Offdesk terminal). A terminal running `claude
  attach <job>` is matched through `~/.claude/jobs/<job>/state.json`. Offdesk
  reads the first request and the latest reply from the session transcript
  (head and tail only), and the visible task list from
  `~/.claude/tasks/<session>/`.
- **Codex.** The open rollout file gives the first request and the latest
  agent message.
- **Both.** The current branch and up to 40 changed paths from `git status`.

Anything that cannot be read is listed in the sheet. The brief never claims a
session it could not match. It ends by asking the new agent to check the
files itself, because the notes may be incomplete. **Anything to add?** is
appended as a note from you.

## How the prompt reaches the agent

The Hub sends the prompt to the Node with the request to create the terminal.
The Node saves it to `<config dir>/relay/<terminal>.md` (mode 0600) and types
`codex "$(cat '<that file>')"` (or `claude …`). The prompt is read by the
shell, never parsed by it: quotes, `$(…)` and backticks arrive as written.
Prompts are limited to 32 KiB, and a leading `-` is rejected so it cannot
become an option.

The new terminal records where its task came from. **From Claude** in its
corner goes back to the source terminal, and the link survives a Hub restart.
The source agent keeps running untouched.

## Requirements and limits

- Starting a relay needs machine control. Viewers see the chip and the card,
  but the action is disabled.
- Hub and Node must both be new enough. An older Node is reported as "Update
  Offdesk on this machine", never silently given a bare shell.
- The target CLI must be on the login shell's `PATH`, signed in, and allowed
  to start in that folder.
- Offdesk does not decide when a task is finished, does not hand work back
  automatically, and does not run reviews yet (see
  `docs/plans/2026-10-05-agent-relay.md`).
