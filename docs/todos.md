# To-dos

A personal to-do list that lives on your Hub (your own machine) and stays in
sync on every device you sign in with.

- **Phone:** Machines & Hub menu → **To-dos**. The menu shows how many are open.
- **Desktop:** the checklist button next to Settings in the tab bar.

Type in **Add a to-do** and press Enter. New items go to the top. Tick an item
to move it to **Done**, which stays collapsed until you open it. Tap an item to
edit its title and notes, or to note which machine and folder the work belongs
to. Delete takes a second tap.

Changes appear right away, then are confirmed by the Hub and pushed to your
other devices. If saving fails, the change is undone and the reason is shown.
To-dos belong to your account, need no machine control, and survive Hub
restarts. Forgetting a machine keeps its to-dos and clears only the machine.

Limits: titles are one line up to 500 characters; notes up to 8 KB; at most
2,000 to-dos per account.

## From a terminal or an agent

`offdesk todo` reads and edits the same list, so you can tell Claude or Codex
"add that to my to-dos" in a conversation, and it can run:

```sh
offdesk todo add "Renew the certificate" --notes "Expires on the 9th"
offdesk todo ls            # open to-dos; --all includes finished ones
offdesk todo done 5f3a     # id, unique id prefix (4+ characters) or exact title
offdesk todo reopen 5f3a
offdesk todo rm 5f3a
```

New to-dos go on top and default to this machine and the current folder, so
they are ready to hand off later (`--folder PATH` or `--no-folder` change
that). Every command takes `--json`.

No setup is needed on a machine running Offdesk Node: without an API token
the CLI signs in with that machine's own credentials (from `machine.json`),
which reach only your to-dos, never terminals or hand-offs. Anywhere else,
create an API token in Settings and set `OFFDESK_URL` and `OFFDESK_TOKEN`.

## Agents

**Hand off.** Open a to-do that has a machine and folder (or tap **Use the
current terminal's folder**), save, and choose **Hand off to Claude** or
**Hand off to Codex**. The title and notes become the agent's first message,
and you can edit them before starting. The agent starts in a new tab in that
folder, and the prompt arrives exactly as written (it is never parsed by the
shell). Starting an agent needs machine control. A retried start opens the
agent that is already running instead of starting a second one.

**Progress.** A to-do handed to Claude shows Claude's own task list and
whether it is working, idle or needs you; Codex shows only that it runs.
Claude deletes a finished task list a few seconds after the last task, so
the to-do keeps the last list it saw. When every task is done and Claude is
idle (or its terminal has closed), the to-do asks **Mark done?**. It is never
ticked for you.

**Agent tasks.** Claude sessions with a task list that no to-do follows yet
are listed under **Agent tasks**. **Add to my to-dos** turns one into a to-do
that follows it; **Open terminal** jumps to the session.
