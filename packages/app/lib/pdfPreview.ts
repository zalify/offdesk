// Pure helpers for the PDF preview: zoom math, page sizing, asset URLs.

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 4;
export const ZOOM_STEP = 0.25;
/** Cap canvas pixel density to bound memory on high-DPI phones. */
export const MAX_PIXEL_RATIO = 2;
/** Skip canvases that would exceed this many pixels (browser canvas limits). */
export const MAX_CANVAS_PIXELS = 16_000_000;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom * 100) / 100));
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  return clampZoom(zoom + direction * ZOOM_STEP);
}

export function pixelRatio(devicePixelRatio: number | undefined): number {
  const dpr = devicePixelRatio && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(MAX_PIXEL_RATIO, dpr);
}

export interface PageLayout {
  /** CSS size of the page box. */
  cssWidth: number;
  cssHeight: number;
  /** pdf.js render scale (page units -> CSS px). */
  scale: number;
}

/** Fit a page (in PDF units) to the container width, then apply zoom. */
export function layoutPage(
  pageWidth: number,
  pageHeight: number,
  containerWidth: number,
  zoom: number,
): PageLayout {
  const safeW = pageWidth > 0 ? pageWidth : 1;
  const safeH = pageHeight > 0 ? pageHeight : 1;
  const fit = Math.max(1, containerWidth) / safeW;
  const scale = fit * clampZoom(zoom);
  return { cssWidth: safeW * scale, cssHeight: safeH * scale, scale };
}

/** Backing-store scale for the canvas, reduced so it stays under the pixel cap. */
export function canvasOutputScale(layout: PageLayout, ratio: number): number {
  const pixels = layout.cssWidth * layout.cssHeight * ratio * ratio;
  if (pixels <= MAX_CANVAS_PIXELS) return ratio;
  return Math.max(1, Math.sqrt(MAX_CANVAS_PIXELS / (layout.cssWidth * layout.cssHeight)));
}

export interface PdfAssetUrls {
  cMapUrl: string;
  standardFontDataUrl: string;
  wasmUrl: string;
}

/** Root-absolute on purpose: SPA routes would break page-relative URLs. */
export function pdfAssetUrls(baseURI: string): PdfAssetUrls {
  return {
    cMapUrl: new URL("/pdfjs/cmaps/", baseURI).href,
    standardFontDataUrl: new URL("/pdfjs/standard_fonts/", baseURI).href,
    wasmUrl: new URL("/pdfjs/wasm/", baseURI).href,
  };
}

export function isPasswordError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "PasswordException"
  );
}
