// iOS WebKit zooms the page into any editable field whose text is under
// 16px. A viewport capped at scale 1 stops that, so form fields can follow
// the interface text size instead of being forced up to 16px. Safari still
// lets the user pinch-zoom past the cap; only the focus zoom goes.
export function withoutFocusZoom(content: string): string {
  if (/maximum-scale\s*=/.test(content)) return content;
  return `${content.trim().replace(/,\s*$/, "")}, maximum-scale=1`;
}

export function isIosWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function preventIosFocusZoom(): void {
  if (typeof document === "undefined" || !isIosWebKit()) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (meta) meta.content = withoutFocusZoom(meta.content);
}
