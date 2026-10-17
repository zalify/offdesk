// The brand, drawn: Offdesk's desk, and a terminal window flying off it with
// a lime prompt in it; "offdesk/dev" in Geist Mono SemiBold as outlines, so
// the lockup renders anywhere without the font.
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

// The mark, the Offdesk icon's composition: the same hand-drawn desk and
// three speed lines (the Offdesk app's traced paths, filled), and in place of
// its checked box a terminal window, about 1.3 : 1, tilted −14° (left low,
// right high) with the `>_` prompt in it. Light on the dark ground where
// Offdesk is black on white. Drawn in the 1024 space of the app icon; small
// sizes drop detail rather than blur it:
//   full    everything                       64px and up
//   medium  no speed lines, `>` without `_`  16–48px, with heavier strokes
const SPEED = [
  "M6563 7695 c-59 -26 -556 -383 -702 -504 -97 -82 -124 -166 -81 -251 28 -56 72 -83 141 -88 74 -5 79 -3 290 155 96 72 251 183 344 248 200 139 211 148 236 197 75 146 -77 309 -228 243z",
  "M6663 6931 c-53 -25 -611 -398 -741 -496 -137 -103 -177 -189 -129 -281 56 -109 177 -124 300 -36 99 71 517 352 654 439 136 88 165 123 171 203 10 139 -127 231 -255 171z",
  "M7114 6396 c-37 -17 -476 -314 -692 -469 -186 -133 -207 -160 -207 -258 0 -102 64 -168 163 -169 63 0 89 14 292 160 102 72 284 199 406 280 233 157 267 186 284 251 38 139 -114 265 -246 205z",
];
const DESK = "M3325 4991 c-437 -12 -944 -40 -1002 -57 -162 -46 -187 -260 -40 -336 43 -22 175 -28 283 -12 l42 6 8 -339 c5 -186 7 -522 4 -748 -3 -225 -5 -514 -5 -641 l0 -231 30 -48 c70 -113 218 -118 301 -10 42 56 47 174 41 1161 l-6 872 97 6 c169 11 595 14 952 5 190 -4 660 -7 1045 -6 792 2 1327 -1 1334 -9 3 -2 6 -429 7 -947 1 -698 4 -957 13 -1000 42 -198 298 -217 360 -26 9 27 9 94 1 270 -5 129 -10 562 -10 962 l0 729 158 -7 c180 -8 219 1 271 61 79 90 58 220 -46 281 -39 23 -61 27 -176 34 -352 23 -3085 45 -3662 30z";
// The traced paths' own coordinates, placed as on the Offdesk icon
const TRACED = ["translate(513.875 495.125) scale(2.211) translate(-143.79 -105.01)",
  "translate(0 -20) scale(0.3486512205789726)", "translate(-218.585787,966.764618) scale(0.1,-0.1)"];
const TRACED_SCALE = 2.211 * 0.3486512205789726 * 0.1;
const WINDOW = "M 616.75 269.21 C 604.90 269.71 597.70 279.71 597.70 293.71 L 597.70 388.71 C 598.13 411.71 611.67 428.21 635.38 428.21 L 791.56 428.21 C 804.68 427.71 811.88 417.71 811.88 403.21 L 811.88 294.21 C 811.45 279.71 802.99 269.21 790.29 269.21 Z";
const CHEVRON = "M 646.20 321.71 L 675.20 349.21 L 644.70 375.71";
const UNDERSCORE = "M 704.20 375.71 C 723.20 377.21 743.20 374.71 763.20 376.21";
const TILT = "translate(20 -14) rotate(-14 704.79 348.71)";
// Stroke widths at `stroke` 2.2 (the weight the icon is drawn at): the
// window as heavy as the desk, the prompt a little heavier.
const WINDOW_STROKE = 24.9, PROMPT_STROKE = 26, UNIT = WINDOW_STROKE / 2.2;
// Where the mark sits: CENTER lands on the centre of a tile (as the icon has
// it, a little up and right of the drawing's middle, like Offdesk's); WIDTH is
// what `width` sizes, the drawn width. VISUAL is the drawing's own middle,
// for setting it beside type.
const CENTER = [512, 512], WIDTH = 667, VISUAL = [529.5, 493.8];

/** The mark in icon units. `stroke` thickens everything from its drawn 2.2;
 *  `halo` draws a wider outline in `haloInk` first. */
function markPaths({ ink, accent = ink, detail = "full", stroke = 2.2, halo = 0, haloInk = BG }) {
  const f = stroke / 2.2;
  const prompt = detail === "full" ? CHEVRON + " " + UNDERSCORE : CHEVRON;
  const layer = (grow, body, promptInk) => {
    // The traced shapes are fills: a stroke of their own ink makes them heavier
    const extra = WINDOW_STROKE * (f - 1) + grow;
    const outline = extra > 0
      ? ` stroke="${body}" stroke-width="${r(extra / TRACED_SCALE)}" stroke-linejoin="round"` : "";
    const traced = [DESK, ...(detail === "full" ? SPEED : [])].map((d) => `<path d="${d}"/>`).join("");
    return `<g transform="${TRACED[0]}"><g transform="${TRACED[1]}"><g transform="${TRACED[2]}" fill="${body}"${outline}>${traced}</g></g></g>` +
      `<g transform="${TILT}" fill="none" stroke="${body}" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="${WINDOW}" stroke-width="${r(WINDOW_STROKE * f + grow)}"/>` +
      `<path d="${prompt}" stroke="${promptInk}" stroke-width="${r(PROMPT_STROKE * f + grow)}"/></g>`;
  };
  return (halo ? layer(halo * UNIT * 2, haloInk, haloInk) : "") + layer(0, ink, accent);
}

const r = (v) => Math.round(v * 1000) / 1000;

/** The mark, `width` wide, its anchor on (cx, cy) in the caller's units:
 *  CENTER (as on the icon), or with `visual` the drawing's own middle. */
function mark(opts, cx, cy, width, { visual = false } = {}) {
  const s = width / WIDTH, [ax, ay] = visual ? VISUAL : CENTER;
  return `<g transform="translate(${r(cx - ax * s)} ${r(cy - ay * s)}) scale(${r(s)})">${markPaths(opts)}</g>`;
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
  const baseline = 16 + (0.71 * size) / 2;
  const pad = 3, w = Math.ceil(dev.end + (light ? pad : 0) + 2);
  const devX = base.end + tracking * size;
  const block = light
    ? `<rect x="${r(devX - pad)}" y="${r(baseline - 0.92 * size)}" width="${r(dev.end - devX + pad * 2)}" height="${r(1.2 * size)}" fill="${LIME}"/>`
    : "";
  return svg(w, 32,
    mark({ ink, accent: light ? INK : LIME }, 20, 16, 38, { visual: true }) +
    block +
    `<g transform="translate(0 ${r(baseline)})"><path fill="${ink}" d="${base.d}"/><path fill="${light ? INK : LIME}" d="${dev.d}"/></g>`,
    "Offdesk Dev");
}

// --- tiles ----------------------------------------------------------------

/** The app icon: the mark on the dark ground. `inset` and `radius` are
 *  fractions of `size`; detail and stroke follow the size it is drawn at. */
function tile(size, { inset = 0, radius = 0, detail = "full", stroke = 2.2, markWidth = WIDTH / 1024, round = false } = {}) {
  // Small sizes have no room for the icon's off-centre composition: the drawing
  // itself goes in the middle.
  const visual = detail !== "full";
  const box = size * (1 - inset * 2), o = size * inset;
  // A rounded tile gets a hairline edge, so it doesn't dissolve into a dark
  // Dock or taskbar.
  const edge = Math.max(0.75, size * 0.006);
  const ground = round
    ? `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="${BG}"/>`
    : `<rect x="${r(o)}" y="${r(o)}" width="${r(box)}" height="${r(box)}"${radius ? ` rx="${r(size * radius)}"` : ""} fill="${BG}"/>` +
      (radius ? `<rect x="${r(o + edge / 2)}" y="${r(o + edge / 2)}" width="${r(box - edge)}" height="${r(box - edge)}" rx="${r(size * radius - edge / 2)}" fill="none" stroke="${CONTROL}" stroke-width="${r(edge)}"/>` : "");
  return svg(size, size, ground + mark({ ink: TEXT, accent: LIME, detail, stroke }, o + box / 2, o + box / 2, box * markWidth, { visual }));
}

// --- write ----------------------------------------------------------------

const write = (path, body) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
};

// docs/media: the mark, the lockups, the favicon.
write("docs/media/mark.svg", svg(40, 32, mark({ ink: TEXT, accent: LIME }, 20, 16, 38, { visual: true }), "Offdesk Dev"));
write("docs/media/mark-light.svg", svg(40, 32, mark({ ink: INK }, 20, 16, 38, { visual: true }), "Offdesk Dev"));
write("docs/media/logo.svg", lockup({ light: true }));
write("docs/media/logo-dark.svg", lockup({ light: false }));
// Browsers draw the SVG favicon at 16–32px, so it carries the medium mark.
write("docs/media/favicon.svg", tile(32, { radius: 0.22, detail: "medium", stroke: 3, markWidth: 0.8 }));

const icon = "packages/desktop/icon";
// The master: full bleed, so iOS and Android can mask it, the mark inside
// every mask's safe area. tauri icon renders everything else from it.
write(`${icon}/icon.svg`, tile(1024));
// Android: the legacy round icon, and the adaptive foreground on
// transparent — the mark inside the central 66 of 108dp that every mask
// keeps. The background layer is ic_launcher_background.xml, the same dark.
write(`${icon}/icon-round.svg`, tile(108, { round: true, markWidth: 0.61 }));
write(`${icon}/icon-foreground.svg`, svg(108, 108, mark({ ink: TEXT, accent: LIME }, 54, 54, 54)));
// macOS draws icons as they are, so its tile carries the margins and the
// corner radius of the system grid (824 of 1024, 184 radius).
const mac = { inset: 100 / 1024, radius: 184 / 1024 };
write(`${icon}/icon-macos.svg`, tile(1024, mac));
// The small sizes, with less detail and heavier strokes: macOS's 16 and 32
// in icon.icns, and the full-bleed rounded tile Windows and the favicons use.
write(`${icon}/icon-macos-32.svg`, tile(32, { ...mac, detail: "medium", stroke: 3, markWidth: 0.74 }));
write(`${icon}/icon-macos-16.svg`, tile(16, { ...mac, detail: "medium", stroke: 3.4, markWidth: 0.84 }));
write(`${icon}/icon-tile.svg`, tile(1024, { radius: 0.22, markWidth: 0.74 }));
write(`${icon}/icon-tile-32.svg`, tile(32, { radius: 0.22, detail: "medium", stroke: 3, markWidth: 0.8 }));
write(`${icon}/icon-tile-16.svg`, tile(16, { radius: 0.22, detail: "medium", stroke: 3.4, markWidth: 0.86 }));
// The menu bar item on macOS: a template image, black with alpha, tinted
// for a light or dark bar. 22pt, the mark 20 wide.
write(`${icon}/tray.svg`, svg(22, 22, mark({ ink: "#000", detail: "medium", stroke: 3 }, 11, 11, 20, { visual: true })));
// Where the tray draws colour (Windows, Linux): the mark alone, no tile, in
// the dark ink with the lime prompt and a light halo, so it reads on a light
// taskbar and a dark one.
write(`${icon}/tray-color.svg`, svg(32, 32, mark({ ink: BG, accent: LIME, detail: "medium", stroke: 3.6, halo: 1.7, haloInk: TEXT }, 16, 16, 29, { visual: true })));

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
