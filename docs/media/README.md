# Media

## Brand assets

A coral donut with sprinkles, and "offdesk" set in Fredoka Bold. They are
drawn by code, not kept by hand:

| File | What it is | Made by |
|---|---|---|
| `mark.svg` | the donut alone | `site/scripts/brand.mjs` |
| `logo.svg` | donut + wordmark in ink, for light grounds — the README | `site/scripts/brand.mjs` |
| `logo-dark.svg` | the same in cream, for dark grounds — the web app's setup page | `site/scripts/brand.mjs` |
| `favicon.svg` + `favicon-16/32.png` | the donut on a rounded sand square | `brand.mjs`, then `rsvg-convert` |
| `hero-banner.png` | the README's banner: headline, the one line, the phone | `site/scripts/brand/render.mjs` |
| `og-1200x630.png` | share card (also `site/public/brand/og-square.png`) | `site/scripts/brand/render.mjs` |
| `avatar-400.png` | the donut on sand, for profiles | `site/scripts/brand/render.mjs` |
| `fonts/Fredoka-Bold.ttf` | the outlines the wordmark is traced from (OFL, see `fonts/README.md`) | — |

The wordmark is real glyph outlines, so it renders anywhere without the font.
The site draws the same mark inline in its nav; the Android launcher icons are
`packages/desktop/icon/*.svg` (the donut on sand), rasterised by
`scripts/app-icons.sh`; the desktop icons come from `tauri icon` on a 1024px
render of `icon.svg`.

To change the brand, edit `brand.mjs` (the donut, the colours) or the HTML in
`site/scripts/brand/` (the banner, the card), then, from the repo root:

```bash
node site/scripts/brand.mjs && node site/scripts/brand/render.mjs
rsvg-convert -w 32 -h 32 docs/media/favicon.svg -o docs/media/favicon-32.png
rsvg-convert -w 16 -h 16 docs/media/favicon.svg -o docs/media/favicon-16.png
cp docs/media/favicon-*.png site/public/brand/
scripts/app-icons.sh
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
