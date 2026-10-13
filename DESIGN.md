# Offdesk DEV design system

This documents the system the app actually ships: direction B, "terminal".
A dark desk, monospace chrome, sans-serif prose, one lime accent. Canonical
tokens live in `packages/app/global.css` (CSS custom properties, sRGB
triplets) and are consumed via Tailwind (`tailwind.config.ts`),
`packages/app/lib/colors.web.ts`, and the literal copies in
`packages/app/lib/themePalette.ts` for React Native inline styles. The
primitives are `packages/app/components/Primitives.web.tsx` (+ `.css`).

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
3. **One accent.** Lime is only for the cursor, the primary action, the
   active tab and focus. Never decoration.
4. **Red means waiting.** `#ff8a75` is only for a terminal waiting on you,
   errors and destructive actions, and always comes with a word.
5. **Mono for machines, sans for people.** Terminals, labels, buttons and
   headings are Geist Mono; explanations, settings descriptions and docs are
   Geist.
6. **Real data or no data.** Meters and stats render only live values; no
   placeholder/mock series.

## Colour tokens

| Token | Dark | Light | Role |
|---|---|---|---|
| `--color-bg-0` | `#0c0c0b` | `#f5f5f3` | page |
| `--color-bg-1` | `#111110` | `#fbfbfa` | bars, panels, inputs |
| `--color-bg-2` | `#141413` | `#ffffff` | surfaces: menus, sheets, status line |
| `--color-bg-3` | `#1c1c1a` | `#ebebe7` | hover / pressed |
| `--color-line` | `#3a3936` | `#c4c2bb` | control edges (buttons, inputs, keys) |
| `--color-line-soft` | `#2a2927` | `#e2e1dc` | hairlines — never a control's only edge |
| `--color-fg-0` | `#ecebe6` | `#111111` | primary text |
| `--color-fg-1` | `#cfcdc7` | `#2b2a27` | body text |
| `--color-fg-2` | `#aeaca6` | `#4f4d48` | secondary text, prose |
| `--color-fg-3` | `#8f8d87` | `#65635d` | the darkest grey allowed for small text |
| `--color-primary` / `--color-on-primary` | `#d4ff3a` / `#0c0c0b` | same | the lime fill: primary button, "in control" |
| `--color-accent` | `#d4ff3a` | `#4a6000` | lime's ink: active text, icons, the active tab's underline |
| `--color-focus` | `#d4ff3a` | `#4a6000` | focus ring |
| `--color-err` = `--color-warn` | `#ff8a75` | `#b4381f` | waiting, danger, errors |
| `--color-on-err` | `#0c0c0b` | `#ffffff` | text on a waiting fill |
| `--color-ok` | `#d4ff3a` | `#4a6000` | online, running |
| `--color-term-bg` | `#0c0c0b` | `#0c0c0b` | terminal body — dark in both themes |

On paper lime cannot carry text (1.06:1), so in light it is only ever a fill
behind dark text; anything that has to be read in the accent colour uses
`--color-accent`, which darkens to olive. Every text pairing above is at least
4.5:1 on `bg-0`…`bg-3`. Alpha composition uses `rgb(var(--x) / a)`.

Focus-visible = 2px `focus` ring, 2px offset. Text selection = primary at
35%. The xterm theme (`lib/colors.shared.ts`) is `#0c0c0b` body, `#ecebe6`
text, lime block cursor; ANSI colours are tuned to read on the body.

The theme setting is Light / Dark / System, default System.

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
