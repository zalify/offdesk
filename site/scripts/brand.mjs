// The brand, drawn: a desk, and a terminal window flying off it with a lime
// prompt in it; "offdesk/dev" in Geist Mono SemiBold as outlines, so the
// lockup renders anywhere without the font.
//
//   node site/scripts/brand.mjs        (from the repo root, after
//                                       `pnpm install` in site/)
//
// Every vector the repo ships is written here, from the one mark below:
// docs/media/{mark,mark-light,logo,logo-dark,favicon}.svg, their copies for
// the site and the web app, and the app icon sources in
// packages/desktop/icon/. Run scripts/app-icons.sh afterwards for every PNG,
// ICO and ICNS, and site/scripts/brand/render.mjs for the banner, the share
// card, the avatar and the DMG background.
import opentype from "opentype.js";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fontFile = readFileSync(
  join(root, "site/node_modules/@fontsource/geist-mono/files/geist-mono-latin-600-normal.woff"),
);
const font = opentype.parse(fontFile.buffer.slice(fontFile.byteOffset, fontFile.byteOffset + fontFile.byteLength));

const BG = "#0c0c0b", TEXT = "#ecebe6", LIME = "#d4ff3a", INK = "#111111", CONTROL = "#3a3936";

// The mark, on a 40×32 grid: the desk, two speed lines, and the window
// tilted −14° about its centre with the `>_` prompt inside. Round caps and
// joins throughout. Small sizes drop detail rather than blur it:
//   full    everything                       64px and up
//   medium  no speed lines, `>` without `_`  16–48px, with heavier strokes
const DESK = "M3 23h18M5.5 23v7M18.5 23v7";
const SPEED = "M19.5 16l3-2M18 12.5l3-2";
const WINDOW = `<rect x="23" y="3" width="15" height="12" rx="2.5"/>`;
const CHEVRON = "M26.5 7.2l2 1.6-2 1.6";
const UNDERSCORE = "M30.5 11h3";
const TILT = `rotate(-14 30 9)`;
// The drawn extent of the full mark at stroke 2.2, so it can be centred and
// sized by what you see rather than by the grid.
const CENTER = [20.85, 15.9], WIDTH = 38;

/** The mark in grid units. `halo` draws a wider stroke in `haloInk` first. */
function markPaths({ ink, accent = ink, detail = "full", stroke = 2.2, halo = 0, haloInk = BG }) {
  const prompt = detail === "full" ? CHEVRON + UNDERSCORE : CHEVRON;
  const layer = (sw, body, promptInk) =>
    `<g fill="none" stroke="${body}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">` +
    `<path d="${DESK}"/>` +
    (detail === "full" ? `<path d="${SPEED}"/>` : "") +
    `<g transform="${TILT}">${WINDOW}` +
    `<path d="${prompt}" stroke="${promptInk}"/>` +
    `</g></g>`;
  return (halo ? layer(stroke + halo * 2, haloInk, haloInk) : "") + layer(stroke, ink, accent);
}

const r = (v) => Math.round(v * 1000) / 1000;

/** The mark, `width` wide, centred on (cx, cy) in the caller's units. */
function mark(opts, cx, cy, width) {
  const s = width / WIDTH;
  return `<g transform="translate(${r(cx - CENTER[0] * s)} ${r(cy - CENTER[1] * s)}) scale(${r(s)})">${markPaths(opts)}</g>`;
}

const svg = (w, h, body, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"` +
  (label ? ` role="img" aria-label="${label}"><title>${label}</title>` : ">") +
  body + `</svg>\n`;

// --- the lockup -----------------------------------------------------------

/** `text` as one path at font size `size`, tracked by `tracking` em. */
function word(text, x, size, tracking) {
  const scale = size / font.unitsPerEm;
  let d = "", pen = x;
  for (const ch of text) {
    const glyph = font.charToGlyph(ch);
    d += glyph.getPath(pen, 0, size).toPathData(2);
    pen += glyph.advanceWidth * scale + tracking * size;
  }
  return { d, end: pen - tracking * size };
}

/** Mark + "offdesk/dev", as the design canvas sets it: a 40×32 mark, 10
 *  apart from 20px type tracked −0.02em. `light` is for light grounds, where
 *  "/dev" sits on a lime block instead of being lime. */
function lockup({ light }) {
  const size = 20, tracking = -0.02, gap = 10;
  const ink = light ? INK : TEXT;
  const tx = 40 + gap;
  const base = word("offdesk", tx, size, tracking);
  const dev = word("/dev", base.end + tracking * size, size, tracking);
  // Centre the caps on the mark: Geist Mono's cap height is 0.71em.
  const baseline = CENTER[1] + (0.71 * size) / 2;
  const pad = 3, w = Math.ceil(dev.end + (light ? pad : 0) + 2);
  const devX = base.end + tracking * size;
  const block = light
    ? `<rect x="${r(devX - pad)}" y="${r(baseline - 0.92 * size)}" width="${r(dev.end - devX + pad * 2)}" height="${r(1.2 * size)}" fill="${LIME}"/>`
    : "";
  return svg(w, 32,
    markPaths({ ink, accent: light ? INK : LIME }) +
    block +
    `<g transform="translate(0 ${r(baseline)})"><path fill="${ink}" d="${base.d}"/><path fill="${light ? INK : LIME}" d="${dev.d}"/></g>`,
    "Offdesk DEV");
}

// --- tiles ----------------------------------------------------------------

/** The app icon: the mark on the dark ground. `inset` and `radius` are
 *  fractions of `size`; detail and stroke follow the size it is drawn at. */
function tile(size, { inset = 0, radius = 0, detail = "full", stroke = 2.4, markWidth = 0.6, round = false } = {}) {
  const box = size * (1 - inset * 2), o = size * inset;
  // A rounded tile gets a hairline edge, so it doesn't dissolve into a dark
  // Dock or taskbar.
  const edge = Math.max(0.75, size * 0.006);
  const ground = round
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${BG}"/>`
    : `<rect x="${r(o)}" y="${r(o)}" width="${r(box)}" height="${r(box)}"${radius ? ` rx="${r(size * radius)}"` : ""} fill="${BG}"/>` +
      (radius ? `<rect x="${r(o + edge / 2)}" y="${r(o + edge / 2)}" width="${r(box - edge)}" height="${r(box - edge)}" rx="${r(size * radius - edge / 2)}" fill="none" stroke="${CONTROL}" stroke-width="${r(edge)}"/>` : "");
  return svg(size, size, ground + mark({ ink: TEXT, accent: LIME, detail, stroke }, size / 2, size / 2, box * markWidth));
}

// --- write ----------------------------------------------------------------

const write = (path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};

// docs/media: the mark, the lockups, the favicon.
write("docs/media/mark.svg", svg(40, 32, markPaths({ ink: TEXT, accent: LIME }), "Offdesk DEV"));
write("docs/media/mark-light.svg", svg(40, 32, markPaths({ ink: INK }), "Offdesk DEV"));
write("docs/media/logo.svg", lockup({ light: true }));
write("docs/media/logo-dark.svg", lockup({ light: false }));
// Browsers draw the SVG favicon at 16–32px, so it carries the medium mark.
write("docs/media/favicon.svg", tile(32, { radius: 0.22, detail: "medium", stroke: 3, markWidth: 0.74 }));

const icon = "packages/desktop/icon";
// The master: full bleed, so iOS and Android can mask it, the mark inside
// every mask's safe area. tauri icon renders everything else from it.
write(`${icon}/icon.svg`, tile(1024));
// Android: the legacy round icon, and the adaptive foreground on
// transparent — the mark inside the central 66 of 108dp that every mask
// keeps. The background layer is ic_launcher_background.xml, the same dark.
write(`${icon}/icon-round.svg`, tile(108, { round: true, markWidth: 0.56 }));
write(`${icon}/icon-foreground.svg`, svg(108, 108, mark({ ink: TEXT, accent: LIME, stroke: 2.4 }, 54, 54, 50)));
// macOS draws icons as they are, so its tile carries the margins and the
// corner radius of the system grid (824 of 1024, 184 radius).
const mac = { inset: 100 / 1024, radius: 184 / 1024 };
write(`${icon}/icon-macos.svg`, tile(1024, mac));
// The small sizes, with less detail and heavier strokes: macOS's 16 and 32
// in icon.icns, and the full-bleed rounded tile Windows and the favicons use.
write(`${icon}/icon-macos-32.svg`, tile(32, { ...mac, detail: "medium", stroke: 3, markWidth: 0.68 }));
write(`${icon}/icon-macos-16.svg`, tile(16, { ...mac, detail: "medium", stroke: 3.4, markWidth: 0.86 }));
write(`${icon}/icon-tile.svg`, tile(1024, { radius: 0.22, markWidth: 0.68 }));
write(`${icon}/icon-tile-32.svg`, tile(32, { radius: 0.22, detail: "medium", stroke: 3, markWidth: 0.74 }));
write(`${icon}/icon-tile-16.svg`, tile(16, { radius: 0.22, detail: "medium", stroke: 3.4, markWidth: 0.9 }));
// The menu bar item on macOS: a template image, black with alpha, tinted
// for a light or dark bar. 22pt, the mark 20 wide.
write(`${icon}/tray.svg`, svg(22, 22, mark({ ink: "#000", detail: "medium", stroke: 3 }, 11, 11, 20)));
// Where the tray draws colour (Windows, Linux): the mark alone, no tile, in
// the dark ink with the lime prompt and a light halo, so it reads on a light
// taskbar and a dark one.
write(`${icon}/tray-color.svg`, svg(32, 32, mark({ ink: BG, accent: LIME, detail: "medium", stroke: 3.6, halo: 1.7, haloInk: TEXT }, 16, 16, 29)));

for (const [from, to] of [
  ["docs/media/logo.svg", "site/public/brand/logo.svg"],
  ["docs/media/logo-dark.svg", "site/public/brand/logo-dark.svg"],
  ["docs/media/mark.svg", "site/public/brand/mark.svg"],
  ["docs/media/favicon.svg", "site/public/favicon.svg"],
  ["docs/media/logo-dark.svg", "packages/app/public/brand/wordmark.svg"],
  ["docs/media/mark.svg", "packages/app/public/brand/mark.svg"],
]) {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(join(root, from), join(root, to));
}
console.log("wrote docs/media/*.svg, packages/desktop/icon/*.svg and their copies");
