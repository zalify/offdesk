import { describe, expect, it } from "vitest";
import {
  MAX_CANVAS_PIXELS,
  canvasOutputScale,
  clampZoom,
  isPasswordError,
  layoutPage,
  pdfAssetUrls,
  pixelRatio,
  stepZoom,
} from "./pdfPreview";

describe("pdfPreview helpers", () => {
  it("clamps and steps zoom", () => {
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.1)).toBe(0.5);
    expect(clampZoom(NaN)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(0.5, -1)).toBe(0.5);
    expect(stepZoom(4, 1)).toBe(4);
  });

  it("caps pixel ratio at 2", () => {
    expect(pixelRatio(3)).toBe(2);
    expect(pixelRatio(1.5)).toBe(1.5);
    expect(pixelRatio(undefined)).toBe(1);
    expect(pixelRatio(0)).toBe(1);
  });

  it("fits pages to the container width and applies zoom", () => {
    const l = layoutPage(600, 800, 300, 1);
    expect(l.scale).toBe(0.5);
    expect(l.cssWidth).toBe(300);
    expect(l.cssHeight).toBe(400);
    expect(layoutPage(600, 800, 300, 2).cssWidth).toBe(600);
    expect(layoutPage(0, 0, 300, 1).cssWidth).toBe(300);
  });

  it("reduces canvas scale for huge pages", () => {
    const small = layoutPage(600, 800, 600, 1);
    expect(canvasOutputScale(small, 2)).toBe(2);
    const huge = layoutPage(600, 800, 3000, 1);
    const s = canvasOutputScale(huge, 2);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(huge.cssWidth * huge.cssHeight * s * s).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * 1.0001);
  });

  it("resolves asset urls against the base uri", () => {
    expect(pdfAssetUrls("https://hub.example/files/x").cMapUrl).toBe("https://hub.example/pdfjs/cmaps/");
    expect(pdfAssetUrls("tauri://localhost/").standardFontDataUrl).toBe("tauri://localhost/pdfjs/standard_fonts/");
    expect(pdfAssetUrls("https://hub.example/files/x").wasmUrl).toBe("https://hub.example/pdfjs/wasm/");
  });

  it("detects password errors", () => {
    expect(isPasswordError({ name: "PasswordException" })).toBe(true);
    expect(isPasswordError(new Error("x"))).toBe(false);
    expect(isPasswordError(null)).toBe(false);
  });
});
