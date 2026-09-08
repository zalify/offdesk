// The brand, drawn: a coral donut with sprinkles, and "Offdesk" in Fredoka
// Bold as outlines, so the wordmark renders anywhere without the font.
//
//   node site/scripts/brand.mjs        (from the repo root)
//
// Writes docs/media/{logo,logo-dark,mark}.svg and copies them where the
// site, the web app and the Android app read them. Run scripts/app-icons.sh
// afterwards for the launcher PNGs.
import opentype from "opentype.js";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const font = opentype.parse(readFileSync(join(root, "docs/media/fonts/Fredoka-Bold.ttf")).buffer);

const CORAL = "#ff6b57", INK = "#2b2340", CREAM = "#fffbf4", SAND = "#fff4e3";
const SPRINKLES = ["#38b6e3", "#ff8fb1", "#ffc857", "#5ed3c1", "#ff8fb1"];

/** The donut, in a `size`×`size` box at (x, y). */
function donut(x, y, size) {
  const c = size / 2, r = size * 0.29, stroke = size * 0.26;
  const s = size / 34;
  const lines = [
    [10, 8.5, 13.2, 6.3], [24.5, 9.5, 27.1, 12.1], [6, 20, 4.8, 23.4], [22, 28.4, 25.6, 29], [14.5, 30, 11.7, 31.6],
  ];
  return `<g transform="translate(${x} ${y})"><circle cx="${c}" cy="${c}" r="${r.toFixed(2)}" fill="none" stroke="${CORAL}" stroke-width="${stroke.toFixed(2)}"/>` +
    lines.map(([x1, y1, x2, y2], i) => `<path d="M${(x1*s).toFixed(2)} ${(y1*s).toFixed(2)}L${(x2*s).toFixed(2)} ${(y2*s).toFixed(2)}" stroke="${SPRINKLES[i]}" stroke-width="${(2.6*s).toFixed(2)}" stroke-linecap="round"/>`).join("") +
    `</g>`;
}

/** "Offdesk" as one path at font size `size`, with its bounding box. */
function word(size) {
  const path = font.getPath("Offdesk", 0, 0, size, { kerning: false, features: false });
  const bb = path.getBoundingBox();
  // opentype.js 2.0's toPathData() emits NaN for some quadratic control
  // points in this font; the commands themselves are fine, so serialise them
  // here.
  const n = (v) => (Math.round(v * 100) / 100).toString();
  const d = path.commands
    .map((c) => {
      switch (c.type) {
        case "M": return `M${n(c.x)} ${n(c.y)}`;
        case "L": return `L${n(c.x)} ${n(c.y)}`;
        case "Q": return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
        case "C": return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
        default: return "Z";
      }
    })
    .join("");
  if (d.includes("NaN")) throw new Error("glyph outline has NaN coordinates");
  return { d, bb };
}

function wordmark(fill) {
  const size = 100;
  const { d, bb } = word(size);
  const textH = bb.y2 - bb.y1;
  const mark = textH * 1.18;              // the donut sits a touch taller than the x-height run
  const gap = size * 0.18;
  const markY = bb.y1 + (textH - mark) / 2 + textH * 0.06;
  const x0 = -bb.x1;
  const w = mark + gap + (bb.x2 - bb.x1);
  const h = textH + 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-4} ${(bb.y1 - 4).toFixed(2)} ${(w + 8).toFixed(2)} ${h.toFixed(2)}" width="${Math.round(w + 8)}" height="${Math.round(h)}" role="img" aria-label="Offdesk"><title>Offdesk</title>${donut(0, markY, mark)}<path transform="translate(${(mark + gap + x0).toFixed(2)} 0)" fill="${fill}" d="${d}"/></svg>\n`;
}

const out = join(root, "docs/media");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "logo.svg"), wordmark(INK));
writeFileSync(join(out, "logo-dark.svg"), wordmark(CREAM));
writeFileSync(join(out, "mark.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="34" height="34" role="img" aria-label="Offdesk"><title>Offdesk</title>${donut(0, 0, 34)}</svg>\n`);
writeFileSync(join(out, "favicon.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 34 34" width="34" height="34"><rect width="34" height="34" rx="8" fill="${SAND}"/>${donut(0, 0, 34)}</svg>\n`);

for (const [from, to] of [
  ["logo.svg", "site/public/brand/logo.svg"],
  ["logo-dark.svg", "site/public/brand/logo-dark.svg"],
  ["favicon.svg", "site/public/favicon.svg"],
  ["logo-dark.svg", "packages/app/public/brand/wordmark.svg"],
]) {
  mkdirSync(dirname(join(root, to)), { recursive: true });
  copyFileSync(join(out, from), join(root, to));
}
console.log("wrote docs/media/{logo,logo-dark,mark,favicon}.svg and copies");
