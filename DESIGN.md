# Offdesk DEV design system

This documents the system the app actually ships: direction B, "terminal".
A dark desk, monospace chrome, sans-serif prose, one accent. Every theme is
in `packages/app/lib/themes.ts` (interface tokens and terminal colours);
`lib/theme.tsx` writes the chosen one onto `<html>` as CSS custom properties
(sRGB triplets), consumed via Tailwind (`tailwind.config.ts`) and
`packages/app/lib/colors.web.ts`. `global.css` carries Paper and Graphite for
the first paint, and `lib/themePalette.ts` derives the React Native values. The
primitives are `packages/app/components/Primitives.web.tsx` (+ `.css`).

The wireframes in the Offdesk DEV design canvas (desktop D01–D13 and Main,
phone P01–P08, the B boards and DEV-Tokens) are the spec for layout,
components and copy, element by element — not only for colour. When a screen
changes, compare it with its board at the same viewport (1280×800 desktop,
390×844 phone) and list any intentional difference in the PR.

## Principles

1. **The terminal is the interface.** Chrome exists to be ignored: one tab bar
   and a status line on large screens, one title bar + key bar on compact
   (phone / Fold cover). The Fold inner screen is large *and* touch — tab bar
   plus a portaled key bar, not the phone shell. See
   `docs/plans/2026-08-13-fold-touch-workspace.md` and
   `docs/superpowers/specs/2026-07-18-raw-terminal-ux-redesign-design.md`.
   Anything that competes with the terminal for attention is a bug.
2. **The chrome is a terminal too.** Tabs are tmux windows (`0:app`), the
   bottom of the workspace is a status line, buttons read like commands
   (`take control`, `[enter]`). Dark is the design; the light theme prints the
   same system on paper.
3. **One accent.** The theme's accent (lime in Graphite) is only for the
   cursor, the primary action, the active tab and focus. Never decoration.
4. **Red means waiting.** The theme's warn colour (coral in Graphite) is only
   for a terminal waiting on you, errors and destructive actions, and always
   comes with a word.
5. **Mono for machines, sans for people.** Terminals, labels, buttons and
   headings are Geist Mono; explanations, settings descriptions and docs are
   Geist.
6. **Real data or no data.** Meters and stats render only live values; no
   placeholder/mock series.

## Themes

Seven themes, chosen in Settings › Appearance or, on a phone, from
[m] › appearance (tried on the live terminal; cancel puts it back):

| Theme | Kind | Look |
|---|---|---|
| Graphite | dark, default | lifted black `#191917`, quieter lime `#b9d35f` |
| Midnight | dark | direction B as it first shipped: `#0c0c0b`, lime `#d4ff3a` |
| Slate | dark | blue-grey, low contrast (Nord-like), sage accent |
| Ember | dark | warm brown-black, amber accent, little blue light |
| Paper | light, default | ink on white; its terminal is Graphite's (dark) |
| Sepia | light, eye care | warm paper, brown ink, light terminal |
| Sage | light, eye care | pale green page, light terminal |

"Follow the system" switches between a light and a dark theme (Paper and
Graphite unless changed) with the device. An old Light / Dark choice opens in
Paper / Graphite. The terminal follows the theme: each has its own xterm
palette, and light terminals set xterm's `minimumContrastRatio` to 3 so
programs that assume a dark background stay readable.

`lib/themes.test.ts` holds every theme to: body text 7–18:1 on `bg-0` (no
white-on-black glare), `fg-1`/`fg-2`, accent and warn ≥ 4.5:1, `fg-3` ≥ 3.5:1,
text on the primary/accent/warn fills ≥ 4.5:1, terminal text ≥ 7:1 and ANSI
colours ≥ 3:1 on the terminal body. It also checks `global.css` against the
registry. A new theme is an entry in `THEMES` that passes those tests.

## Colour tokens

| Token | Graphite (dark) | Paper (light) | Role |
|---|---|---|---|
| `--color-bg-0` | `#191917` | `#f5f5f3` | page |
| `--color-bg-1` | `#1d1d1b` | `#fbfbfa` | bars, panels, inputs |
| `--color-bg-2` | `#21211f` | `#ffffff` | surfaces: menus, sheets, status line |
| `--color-bg-3` | `#2a2a27` | `#ebebe7` | hover / pressed |
| `--color-line` | `#474641` | `#c4c2bb` | control edges (buttons, inputs, keys) |
| `--color-line-soft` | `#31302d` | `#e2e1dc` | hairlines — never a control's only edge |
| `--color-fg-0` | `#dcdad3` | `#111111` | primary text |
| `--color-fg-1` | `#c3c1ba` | `#2b2a27` | body text |
| `--color-fg-2` | `#a29f98` | `#4f4d48` | secondary text, prose |
| `--color-fg-3` | `#87857e` | `#65635d` | the darkest grey allowed for small text |
| `--color-primary` / `--color-on-primary` | `#a9c64b` / `#191917` | `#c6e26a` / `#111111` | the accent fill: primary button, "in control" |
| `--color-accent` | `#b9d35f` | `#4a6000` | the accent's ink: active text, icons, the active tab's underline |
| `--color-focus` = `--color-ok` | accent | accent | focus ring; online, running |
| `--color-err` = `--color-warn` | `#e3907d` | `#b4381f` | waiting, danger, errors |
| `--color-on-err` | `#191917` | `#ffffff` | text on a waiting fill |
| `--color-term-bg` / `-fg` / `-accent` | terminal body, text, cursor | same (dark) | for chrome drawn on the terminal |

On paper lime cannot carry text, so in light themes the accent fill only ever
sits behind dark text; anything read in the accent colour uses
`--color-accent`, which darkens (olive, brown, green). Alpha composition uses
`rgb(var(--x) / a)`.

Focus-visible = 2px `focus` ring, 2px offset. Text selection = primary at
35%.

## Typography

- Chrome, headings, labels, buttons: `Geist Mono` (variable, 100–900).
  Prose: `Geist`. Both ship in `packages/app/public/fonts` (Latin + Latin
  Extended, SIL OFL) so a hub with no internet has them; other scripts fall
  back to the system. CSS: `--font-display` (mono chrome, also the body
  default), `--font-sans` (prose), `--font-mono` (ids, metrics).
- Terminal: `JetBrains Mono` → `Offdesk Terminal Symbols` → platform mono
  (`lib/terminalFonts.ts`). It stays the default because its box-drawing,
  block and braille coverage is what TUIs (Claude Code, Codex, vim) draw
  with; Geist Mono is offered in Settings. User-overridable.
- Scale: display 36–56 / 600 / −0.035em; heading 20–34 / 600 / −0.02em;
  label 12–13 / 500; terminal 12–13; prose 14–17 at 1.5.
- **Lowercase chrome.** Buttons, labels, tabs and menus are lowercase.
  Headings and prose use sentence case. Product name: "Offdesk DEV"; the
  lockup is `offdesk/dev` with `/dev` in the accent.

## Shape and space

Radii: 3px keys, tabs, chips; 4px buttons, inputs; 6px panels and sheets.
Space: 4 · 8 · 12 · 16 · 24 · 32 · 48. Shadows only on things that float
(menus, sheets): `0 24px 64px rgb(0 0 0 / .45)`. Touch targets are at least
44px on coarse pointers.

## Primitives

- **Buttons** (`Button`): `primary` lime fill, 600; `secondary` 1px `line`
  edge; `ghost` text only; `danger` red text; `bracket` = `[enter]`, brackets
  in `fg-3` and kept out of the accessible name. 40px (32px `sm`), 44px on
  touch.
- **Text buttons** (`TextButton`): chrome as plain lowercase text, no box —
  `files`, `settings`, `≡`, `[+]`, `mac-mini ▾`, `browser[2]` with a red `!`
  when the agent needs you; `square` gives the phone title bar's 44px
  `[f]` `[b]` `[m]`. Icon buttons in boxes are not part of the system.
- **Keys** (`Key`): the key bar's 36px keys, 1px `line` edge, 3px radius,
  lowercase labels (`esc`, `tab`, `⇧tab`, `[enter]`, `paste`); `^C` is the
  accent fill; a latched modifier (`ctrl`) is `aria-pressed` in the accent.
- **Badges** (`Badge`): square `waiting` / `2 waiting` blocks on `err`.
- **Toasts and floating cards** (`Toast`, `FloatCard`): 4px and 6px radii,
  `bg-2` with a `line` edge. Never pills.
- **Chips** (`Chip`): 22px, 3px radius. `outline` ("watching"), `solid`
  ("in control"), `waiting`. `AgentMarker` = `⌁ opened by agent · cli`.
- **Fields** (`Field`): lowercase mono label above, 38px input on `bg-1`,
  help text in Geist `fg-3`, errors in `err` with `role="alert"`.
- **Panels** (`Card`): `bg-1`, `line-soft` edge, 6px, 24px padding.
- **Waiting card** (`WaitingCard`): `err` edge, `"<program> is waiting for
  you"`, then `[enter]` and `take control`.
- **Status line** (`StatusLine`, `StatusBadge`, `StatusEnd`): 34px, `bg-2`,
  hairline above. Left: `waiting` badge, the terminal, `[enter]` / `open ↵`.
  Right: machine · latency, then the control state block (`in control` on
  lime, otherwise `watching`).
- **Tabs** (`Tab`): `0:app` + muted program; active = `fg-0` and a 2px
  accent underline; a waiting tab shows a red `!`.
- **Setup steps** (`StepMark`): `[✓]` done, `[~]` in progress (accent),
  `[ ]` not started (`fg-3`).
- **Logo** (`Logo`, `Wordmark`): v1 mark — a desk with a terminal window
  flying off it, `>_` in the accent. Below 24px the speed lines and the
  underscore drop.

## Chrome recipes

Display mode is two-axis, not a 768px window-width breakpoint. `isTouch`
comes from `(pointer: coarse)`; touch is always compact (every touch device
gets the single-column mobile layout — folding, rotation, or a soft keyboard
cannot flip chrome); non-touch keeps `innerWidth ≤ 768`. History and the
retired large-touch workspace: `docs/plans/2026-08-13-fold-touch-workspace.md`.

- **Desktop tab bar** (40px mouse, ≥44px touch): tmux tabs, `[+]`, then on
  the right the machine switcher (`nas ▾`), cpu/mem as text, and lowercase
  text buttons (`files`, `browser[2]`, `phone`, `settings`).
- **Pane header**: `●` (accent when it has focus), program, cwd, and the
  agent marker on the right.
- **Phone title bar**: program `▾` over `0:app · machine`, a control chip,
  then 44px bracket buttons (`[f]`, `[b]`, `[m]`). Attention strip below it
  on `bg-1`: `n waiting` badge, then chips with `[enter]`.
- **Key bar**: `bg-1`, 3px keys with `line` edges, `^C` on lime; latched
  `ctrl` in the accent.
- **Overlays** (palette, cheat sheet, sheets): `bg-2`, `line` edge, 6px.
- **Transient notices** go to the status line on the desktop workspace;
  banners elsewhere are tinted at 6–10% of their semantic colour and never
  block.

## Motion

Fades/slides 150–350ms ease-out; the block cursor may blink. Respect
`prefers-reduced-motion`. No decorative animation.

## History

Until 0.8 the chrome took the site's warm palette (sand and cream, coral
accent, Fredoka/Nunito, `components/Warm.web.tsx`); before 2026-09-04 it was a
dark, cool-neutral system with an amber accent. Git history has both.
