import { describe, expect, it } from "vitest";
// @ts-ignore Vitest runs this in Node; the app tsconfig omits Node types (CI has none, local installs may).
import { readFileSync } from "node:fs";
import {
  MARK_CHEVRON,
  MARK_DESK,
  MARK_PLACE,
  MARK_SPEED,
  MARK_TILT,
  MARK_TRACED,
  MARK_UNDERSCORE,
  MARK_WINDOW,
  markWeights,
} from "./brandMark";

const read = (path: string): string =>
  readFileSync(decodeURIComponent(new URL(`../../../${path}`, import.meta.url).pathname), "utf8");

// The app and the site draw the mark inline (it takes the theme's colours),
// so nothing regenerates them with the brand files: these keep them the same
// drawing as the one brand.mjs writes.
describe("the inline mark", () => {
  it("matches docs/media/mark.svg", () => {
    const svg = read("docs/media/mark.svg");
    for (const part of [MARK_PLACE, ...MARK_TRACED, MARK_TILT, MARK_DESK, ...MARK_SPEED, MARK_WINDOW]) {
      expect(svg).toContain(part);
    }
    expect(svg).toContain(`${MARK_CHEVRON} ${MARK_UNDERSCORE}`);
    expect(svg).toContain(`stroke-width="${markWeights("full").window}"`);
    expect(svg).toContain(`stroke-width="${markWeights("full").prompt}"`);
  });

  it("draws the small sizes as the favicon does", () => {
    const svg = read("docs/media/favicon.svg");
    const { window, prompt, outline } = markWeights("medium");
    expect(svg).toContain(`stroke-width="${outline}"`);
    expect(svg).toContain(`stroke-width="${window}"`);
    expect(svg).toContain(`stroke-width="${prompt}"`);
    expect(svg).not.toContain(MARK_SPEED[0]);
  });

  it("is the one in the site header", () => {
    const header = read("site/src/layouts/Site.astro");
    for (const part of [MARK_PLACE, MARK_DESK, MARK_WINDOW, MARK_CHEVRON]) {
      expect(header).toContain(part);
    }
  });
});
