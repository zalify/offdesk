# Media

## Brand assets

A desk, and a terminal window flying off it with a lime `>_` prompt inside;
"offdesk/dev" set in Geist Mono SemiBold. Dark ground `#0c0c0b`, ink
`#ecebe6`, lime `#d4ff3a` only for the prompt. They are drawn by code, not
kept by hand, from the one mark in `site/scripts/brand.mjs`:

| File | What it is | Made by |
|---|---|---|
| `mark.svg` | the mark alone, for dark grounds (also `site/public/brand/`, `packages/app/public/brand/`) | `site/scripts/brand.mjs` |
| `mark-light.svg` | the mark in ink, for light grounds | `site/scripts/brand.mjs` |
| `logo.svg` | mark + "offdesk/dev" for light grounds, "/dev" on a lime block — the README | `site/scripts/brand.mjs` |
| `logo-dark.svg` | the same for dark grounds, "/dev" in lime — the web app's wordmark | `site/scripts/brand.mjs` |
| `favicon.svg` + `favicon-16/32.png` | the mark on the dark rounded tile, drawn for 16 and 32 | `brand.mjs`, then `scripts/app-icons.sh` |
| `hero-banner.png` | banner: the headline, the line, the install command, the CLI driving a terminal | `site/scripts/brand/render.mjs` |
| `og-1200x630.png` | share card (also `site/public/brand/og-square.png`) | `site/scripts/brand/render.mjs` |
| `avatar-400.png` | the mark on the dark ground, for profiles | `site/scripts/brand/render.mjs` |

The lockup is real glyph outlines (from `@fontsource/geist-mono`, a site
dependency, under the OFL), so it renders anywhere without the font.

Below 64px the mark drops its speed lines and the `_`, and its strokes get
heavier; the 16 and 32 sources (`packages/desktop/icon/*-16.svg`,
`*-32.svg`) are drawn for those sizes instead of scaled down. The app icons
all come from `packages/desktop/icon/`: `icon.svg` is the full-bleed master
(iOS, Android legacy, apple-touch), `icon-tile*.svg` the rounded tile
(Windows, Linux, favicons), `icon-macos*.svg` the tile on macOS's grid
(`icon.icns`), `icon-round.svg` and `icon-foreground.svg` Android, `tray.svg`
the macOS menu bar template and `tray-color.svg` the Windows/Linux tray. The
DMG background is `site/scripts/brand/dmg.html`.

To change the brand, edit `brand.mjs` (the mark, the colours, the sizes) or
the HTML in `site/scripts/brand/` (the banner, the card, the DMG), then, from
the repo root, with `pnpm install` run in `site/` and `packages/desktop/`:

```bash
node site/scripts/brand.mjs        # every SVG
scripts/app-icons.sh               # every PNG, ICO and ICNS, incl. Android and iOS
node site/scripts/brand/render.mjs # banner, share card, avatar, DMG background
```

# Screenshots and GIFs to record

Nothing here is committed yet. Each file below is referenced by the README, the
site, or both, and each will render as a broken image until it exists.

Shoot everything on a dark terminal. The product is dark-only, so a light
screenshot will look like a different app.

## Required

### `hero.gif`

Referenced by: `README.md` (top), `site/public/media/hero.gif` (hero section).
This is the one that has to work; everything else is optional.

The whole pitch in one loop: the same terminal, on two screens, at once.

- **Frame:** a desk screen and a phone in one shot. Real phone in hand is
  better than a simulated frame.
- **On the desk screen:** Claude Code mid-task in an offdesk terminal, output
  scrolling.
- **On the phone:** the same session, attached, showing the same output.
- **The beat that sells it:** type on the phone, and the desk screen updates.
  Then keep the desk screen visible while the phone keeps working — that is the
  control lease and it should read as obvious, not explained.
- **Length:** 6–10 seconds, looping cleanly. No captions, no cursor
  highlighting, no zoom effects.
- **Size:** under 4 MB. It loads on a phone, on mobile data, above the fold.

## Worth having

### `machines.png`

The machine list with **three** machines registered and online — a laptop, a
NAS, a VPS, named so the difference is obvious. This is the "one hub, many
machines" claim, and one machine in the shot proves nothing.

### `cli.png` or `cli.gif`

A terminal running the orchestration example from the README end to end:
`offdesk open` → `send` → `wait` → `read`. Let `wait` actually block for a
second or two; that pause is the point of the command.

### `tokens.png`

Settings → API tokens, with several tokens that have distinct names
(`claude-nas`, `ci-runner`, `phone`) and visibly different "last used" values.
This is the security story: per-agent tokens, individually revocable.

### `phone-terminal.png`

Portrait phone screenshot, real device. A full-screen terminal with the key bar
at the bottom — the Ctrl/Esc/arrow row. Something recognisable on screen, `vim`
or `htop` rather than a bare prompt, to make "it is the real terminal" land.

## Before you commit anything

- No real hostnames, tokens, IP addresses, or client names on screen. Check the
  tmux status area and the browser URL bar.
- No `webmux` anywhere in frame — that is the whole point of the rename.
- Compress GIFs (`gifsicle -O3 --lossy=80`). A 20 MB hero GIF is worse than no
  hero GIF.
