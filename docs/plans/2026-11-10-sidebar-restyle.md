# Sidebar restyle, after kero.sh and herdr.dev (OFF-124)

Wireframes: the **Sidebar restyle (OFF-124)** page of the Offdesk DEV design
canvas, https://claude.ai/artifact/Nk6qySyE2jZzDjLDznA6hM (boards R00–R05,
drawn in Graphite). Status: proposal, not built. The rest of the canvas is
unchanged.

## What the two references do

Both are desktop apps for running many coding agents, with a session sidebar
that is far quieter than ours.

- **kero.sh** — sessions grouped by project (`snake 2`, `website 3`, a host
  chip such as `devbox` for remote ones). Each row is one line: title, age
  (`now`), one state glyph (working arc, waiting ring, done check). The group
  header carries the only call to action, `1 needs you`. The selected row is a
  filled pill. Top: the traffic lights, a sidebar toggle and `+`. Bottom:
  files, search, settings icons and state totals. No tab bar, no filters, no
  per-row buttons.
- **herdr.dev** — the same one-line rows (agent icon, name, age, state dot,
  `Needs you` chip), machines as quiet section headers (`This computer`,
  `macbook`, `vps`, each with an online dot and `+`), tabs of the selected
  space above the panes, and Settings at the bottom.

Shared ideas worth taking: the sidebar owns the full height of the window's
left edge; one line per row; state is a single mark at the right edge plus a
word when it needs you; actions appear on hover or right-click, never as
standing buttons; the header and footer hold only a few unboxed icons.

## Where ours is heavier (0.25.12, OFF-82)

`WorkspaceManager.web.tsx` in `sidebar` placement, pinned under the tab bar:

- two bars of chrome above the list: the tab bar, then a 60px `sessions` /
  machine / `hide` header and a toolbar (`new tab` button, `recent | tabs`);
- every row is 3–4 lines (title, `0:offdesk · 5m`, cwd, `⌁ opened by cli`)
  with `move` and `[x]` buttons standing on it;
- `tabs` order draws boxed groups with tree glyphs and four buttons each
  (up, down, rename, `[x]`) plus `[+] new terminal here`;
- the machine appears twice (tab bar switcher and sidebar subtitle), the tabs
  appear twice (tab bar and groups).

About ten terminals fit in an 800px window; the new layout fits about
eighteen, with their tabs as headers.

## The proposal (boards R00–R05)

**Layout (R01).** On desktop windows ≥1024px the sidebar is a 248px column at
the window's left edge, full height, `bg-1` with a `line-soft` edge. While it
is shown there is **no tab bar**: tabs are the sidebar's groups, and the panes
start at the top, their 40px headers lining up with the sidebar's top row
(window drag area). `⌘B` (and the sidebar icon) hides it; then the tab bar
comes back exactly as today (R03). Narrower windows keep it as a drawer.

**Top row.** Traffic lights (or the logo mark on Windows/Linux, as D13), then
two unboxed 15px icons: hide sidebar, new terminal.

**Machine row.** `mac-mini ▾`, the three-bar load glyph and latency. It is
the machine switcher (moved from the tab bar); its menu also holds the order
choice, `group by tab` / `latest output first`.

**Groups.** A group is a tab: its name and pane count in `fg-3` 11.5px mono,
`1 waiting` at the right in `warn`. Hover: `+` (new terminal in this tab, up
to four) and `⋯` (rename, delete). Clicking the name folds the group;
dragging a header reorders tabs; dragging a row onto a group moves it.

**Rows.** 30px, one line, Geist Mono 12.5px: title, then age or a word, then
one 12px mark. States (R02), all from data the hub already sends:

| State | Source | Right edge |
|---|---|---|
| waiting | `attention` set | `waiting` in warn + filled ring; title 600 |
| working | `last_activity_ms` within a minute | `now` + accent arc |
| quiet | older output | `4m` + hollow `fg-3` ring |
| can't reach | `reachable: false` | `offline` + dashed ring; muted title |
| opened by an agent | `opened_by` | `⌁` before the title, detail in the tooltip |

Selected (focused pane) = `bg-3` fill and `fg-0`; hover = `bg-2` and a close
button in place of the age and mark. Rename is inline (double-click). The
cwd moves to the tooltip and the pane header. Everything else (rename, move
to ▸, split right, open in a new tab, close) is on right-click.

**Footer.** Files, agent browser (with its count), phone, and settings at the
right: the panel icons that sat at the right of the tab bar. In view only it
reads `watching` with a `take control` button.

**Status line.** Unchanged, minus `machine · latency` (now on the machine
row): the waiting prompt with `[enter]`, and the control block.

**Phone (R05).** The sessions sheet uses the same groups and one-line rows at
44px; no `[x]` per row (hold a row for the menu); the `tabs` button goes,
`new terminal` sits at the bottom within thumb reach.

**Option B (R04), not the default.** Every machine in one list, herdr-style:
machines as foldable headers (load glyph, latency, `offline 4m`), their tabs
under them; choosing a row on another machine switches to it. It removes the
machine switcher but needs every machine's terminals at once, which the
workspace does not load today.

## Rules this keeps

One accent (the working arc and focus only), red only with a word
(`waiting`, `1 waiting`), lowercase mono chrome, unboxed 15px panel icons,
real data only (no "done" state, since nothing reports one), 44px touch rows.

## Decisions for Ryan

1. Hide the tab bar while the sidebar is shown (R01), or keep both?
2. Current machine only (R01, recommended) or every machine (R04)?
3. Default order: by tab (recommended; stable for `⌘1`–`⌘9`) or latest
   output first, as OFF-82 shipped?

## Implementation, once approved

Per the ui-restyle flow, stacked PRs with board-vs-app compare images:

1. Desktop sidebar: full-height placement, one-line rows and states, group
   headers, hover close, right-click menu, inline rename; the tab bar hidden
   while it is shown; machine row and footer icons moved; DESIGN.md's
   "Sessions sidebar" entry rewritten. Files: `TabBar.web.tsx`,
   `WorkspaceManager.web.tsx` (likely split into a sidebar and the drawer),
   `TerminalWorkspace.web.tsx`, `WorkspaceStatusLine.web.tsx`,
   `e2e/tests/workspace-tabs.spec.ts`.
2. Phone sheet (R05) on the same row component.
3. Option B only if chosen.
