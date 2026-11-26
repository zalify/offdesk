---
name: offdesk
description: Use the `offdesk` CLI when running inside an Offdesk terminal (`$OFFDESK_TERMINAL_ID` is set) or when the user asks to deliver drafts/tables, open or drive the live agent browser, share local file download links, read encrypted vault secrets, report run progress, or communicate with other terminals/agents.
---
<!-- managed-by: offdesk-cli v{{VERSION}} -->

# Offdesk CLI

When `$OFFDESK_TERMINAL_ID` is set, you are running inside an **Offdesk** terminal connected to the user's desktop and mobile workspace. Use the `offdesk` CLI to deliver richer artifacts and collaborate with the user instead of dumping walls of text into the terminal.

> **Always up to date**: Do not guess subcommand flags — run `offdesk <cmd> --help` or `offdesk <cmd> <sub> --help` for the exact syntax of your installed version.

## When to use which command

### 1. Long documents, reports, plans, emails → `offdesk draft`
Instead of printing multi-screen markdown in the terminal, save it as a draft so the user can read, edit, or share it cleanly on desktop & mobile:
```bash
offdesk draft write --title "Title" < report.md
# or pipe content via stdin:
printf '%s\n' "# Summary" "..." | offdesk draft write --title "Summary"
offdesk draft list
offdesk draft read <id>
offdesk draft share <id>   # create a public read-only link (only when user asks)
```

### 2. Structured tables, task boards, comparison matrices → `offdesk db`
When presenting structured multi-row data (comparisons, checklists, bug lists, CSVs), create or update an Offdesk database:
```bash
offdesk db list
offdesk db create "Comparison" --col Status --col Score
offdesk db add <db> --title "Item A" --prop Status=Done --prop Score=95
offdesk db query <db> --where Status=Done
```

### 3. Live visible browser & human-in-the-loop login → `offdesk browser`
Use Offdesk's managed Chromium whenever you need to browse pages, inspect live UIs, or let the user take over for login / 2FA / CAPTCHA:
```bash
BID=$(offdesk browser open "https://example.com")
offdesk browser snapshot "$BID"          # text snapshot with [ref=eN] handles
offdesk browser click "$BID" e12
offdesk browser fill "$BID" e5 "query"
offdesk browser screenshot "$BID"
# If login, 2FA, or CAPTCHA is required — NEVER try to bypass; hand off to the user:
offdesk browser handoff "$BID" --reason "Please log in and complete verification" --wait
offdesk browser close "$BID"
```
*(If a command exits with code `3`, the user currently controls the browser — wait with `offdesk browser wait-control "$BID"`.)*

### 4. Local file download / preview links → `offdesk fetch`
When you generate files (`.docx`, `.pdf`, `.png`, `.zip`, etc.) and want the user to download or open them in one click from desktop or mobile:
```bash
offdesk fetch /abs/path/to/file.docx
```

### 5. Report status to the user's run tracker → `offdesk run`
Keep the user's mobile/desktop run dashboard updated during long tasks:
```bash
offdesk run note "Root cause found; running full test suite"
offdesk run blocked "Need confirmation on database migration strategy"
offdesk run done "Fixed drag selection and published OTA" --link https://...
```

### 6. Cross-terminal / multi-agent coordination → `offdesk msg`, `ls`, `read`, `send`, `wait`
Inspect or coordinate with other terminals and agents on any connected machine:
```bash
offdesk ls
offdesk read <terminal-id>
offdesk msg inbox
offdesk msg send <terminal-id> "Finished API changes, ready for frontend"
offdesk msg post "Deployed staging build"
```

### 7. Encrypted secrets & credentials → `offdesk vault`
Check saved secrets without asking the user to paste keys into chat (never echo decrypted secrets back into chat logs):
```bash
offdesk vault list
offdesk vault reveal <id-or-prefix>
```
