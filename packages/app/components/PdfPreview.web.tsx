import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Loader2, Minus, Plus, ScanLine } from "lucide-react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/legacy/build/pdf.mjs";
import { colors } from "@/lib/colors";
import {
  canvasOutputScale,
  MAX_ZOOM,
  MIN_ZOOM,
  isPasswordError,
  layoutPage,
  pdfAssetUrls,
  pixelRatio,
  stepZoom,
} from "@/lib/pdfPreview";

type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/**
 * Lazily loads pdf.js (legacy build, for older WebKitGTK / Android WebViews).
 * The worker runs on the main thread: pdf.js looks for `globalThis.pdfjsWorker`
 * before it ever touches `workerSrc`, so no worker URL has to resolve under
 * the Tauri / asset origins.
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [lib, worker] = await Promise.all([
        import("pdfjs-dist/legacy/build/pdf.mjs"),
        import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
      ]);
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      return lib;
    })();
    pdfjsPromise.catch(() => {
      pdfjsPromise = null;
    });
  }
  return pdfjsPromise;
}

type Load =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; pdf: PDFDocumentProxy; pages: number; estimate: { w: number; h: number } };

const PAGE_GAP = 12;
const SIDE_PAD = 12;

export function PdfPreview({
  bytes,
  name,
  touch,
  renderError,
}: {
  bytes: Uint8Array;
  name: string;
  touch: boolean;
  renderError: (message: string) => ReactNode;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    let task: PDFDocumentLoadingTask | null = null;
    setLoad({ status: "loading" });
    setZoom(1);
    (async () => {
      try {
        const pdfjs = await loadPdfjs();
        if (!live) return;
        const urls = pdfAssetUrls(document.baseURI);
        task = pdfjs.getDocument({
          // pdf.js may take ownership of the buffer, so hand it a copy.
          data: bytes.slice(),
          isEvalSupported: false,
          cMapUrl: urls.cMapUrl,
          cMapPacked: true,
          standardFontDataUrl: urls.standardFontDataUrl,
          wasmUrl: urls.wasmUrl,
          disableAutoFetch: true,
          disableStream: true,
        });
        const pdf = await task.promise;
        if (!live) return;
        const first = await pdf.getPage(1);
        const vp = first.getViewport({ scale: 1 });
        first.cleanup();
        if (!live) return;
        setLoad({
          status: "ready",
          pdf,
          pages: pdf.numPages,
          estimate: { w: vp.width, h: vp.height },
        });
      } catch (err) {
        if (!live) return;
        console.debug("pdf preview failed", err);
        setLoad({
          status: "error",
          message: isPasswordError(err) ? "PDF 有密码保护，无法预览" : "无法解析这个 PDF",
        });
      }
    })();
    return () => {
      live = false;
      void task?.destroy().catch(() => {});
    };
  }, [bytes]);

  // Track the container width (debounced) so pages re-fit on resize/rotation.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || load.status !== "ready") return;
    const measure = () => setWidth(Math.max(0, el.clientWidth - SIDE_PAD * 2));
    measure();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 150);
    });
    ro.observe(el);
    if (!touch) el.focus({ preventScroll: true });
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [load.status, touch]);

  if (load.status === "error") return <>{renderError(load.message)}</>;
  if (load.status === "loading") {
    return (
      <div
        data-testid="file-browser-preview-loading"
        style={{
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          fontSize: 13,
          color: colors.fg3,
        }}
      >
        <Loader2 size={16} aria-hidden style={{ animation: "offdeskSpin 800ms linear infinite" }} />
        正在解析 PDF…
      </div>
    );
  }

  const hit = touch ? 44 : 30;
  const btn = (disabled: boolean) =>
    ({
      minWidth: hit,
      height: hit,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 4,
      padding: "0 8px",
      border: "none",
      borderRadius: 6,
      background: "transparent",
      color: colors.fg2,
      fontSize: 12,
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.4 : 1,
    }) as const;

  return (
    <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "2px 8px",
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
        }}
      >
        <span
          data-testid="file-browser-preview-pdf-count"
          style={{ flex: 1, fontSize: 12, color: colors.fg3 }}
        >
          {load.pages} 页
        </span>
        <button
          type="button"
          data-testid="file-browser-preview-pdf-zoom-out"
          aria-label="缩小"
          title="缩小"
          disabled={zoom <= MIN_ZOOM}
          onClick={() => setZoom((z) => stepZoom(z, -1))}
          style={btn(zoom <= MIN_ZOOM)}
        >
          <Minus size={16} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="file-browser-preview-pdf-zoom-fit"
          aria-label="适合宽度"
          title="适合宽度"
          onClick={() => setZoom(1)}
          style={btn(false)}
        >
          <ScanLine size={16} aria-hidden />
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          data-testid="file-browser-preview-pdf-zoom-in"
          aria-label="放大"
          title="放大"
          disabled={zoom >= MAX_ZOOM}
          onClick={() => setZoom((z) => stepZoom(z, 1))}
          style={btn(zoom >= MAX_ZOOM)}
        >
          <Plus size={16} aria-hidden />
        </button>
      </div>
      <div
        ref={scrollRef}
        data-testid="file-browser-preview-pdf"
        aria-label={name}
        tabIndex={0}
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          overscrollBehavior: "contain",
          background: colors.bg2,
          outline: "none",
          padding: `${PAGE_GAP}px ${SIDE_PAD}px`,
          boxSizing: "border-box",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: PAGE_GAP,
            width: "max-content",
            minWidth: "100%",
          }}
        >
          {width > 0 &&
            Array.from({ length: load.pages }, (_, i) => (
              <PdfPage
                key={i + 1}
                pdf={load.pdf}
                pageNumber={i + 1}
                containerWidth={width}
                zoom={zoom}
                estimate={load.estimate}
                scrollRoot={scrollRef}
              />
            ))}
        </div>
      </div>
    </>
  );
}

function PdfPage({
  pdf,
  pageNumber,
  containerWidth,
  zoom,
  estimate,
  scrollRoot,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  containerWidth: number;
  zoom: number;
  estimate: { w: number; h: number };
  scrollRoot: React.RefObject<HTMLDivElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [size, setSize] = useState(estimate);

  const box = layoutPage(size.w, size.h, containerWidth, zoom);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { root: scrollRoot.current, rootMargin: "100% 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [scrollRoot]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible || !canvas) return;
    let live = true;
    let render: RenderTask | null = null;
    (async () => {
      try {
        const page = await pdf.getPage(pageNumber);
        if (!live) return;
        const base = page.getViewport({ scale: 1 });
        if (base.width !== size.w || base.height !== size.h) {
          setSize({ w: base.width, h: base.height });
        }
        const layout = layoutPage(base.width, base.height, containerWidth, zoom);
        const out = canvasOutputScale(layout, pixelRatio(window.devicePixelRatio));
        const viewport = page.getViewport({ scale: layout.scale });
        // Draw offscreen then swap, so a re-render does not flash blank.
        const buffer = document.createElement("canvas");
        buffer.width = Math.max(1, Math.floor(layout.cssWidth * out));
        buffer.height = Math.max(1, Math.floor(layout.cssHeight * out));
        render = page.render({
          canvas: buffer,
          viewport,
          transform: [out, 0, 0, out, 0, 0],
        });
        await render.promise;
        if (!live) return;
        canvas.width = buffer.width;
        canvas.height = buffer.height;
        canvas.getContext("2d")?.drawImage(buffer, 0, 0);
        page.cleanup();
      } catch (err) {
        if ((err as { name?: string })?.name !== "RenderingCancelledException") {
          console.debug("pdf page render failed", pageNumber, err);
        }
      }
    })();
    return () => {
      live = false;
      try {
        render?.cancel();
      } catch {
        // already finished
      }
    };
    // `size` is read only to avoid a redundant update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, pdf, pageNumber, containerWidth, zoom]);

  // Release pixel memory for pages that scrolled far away.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!visible && canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }, [visible]);

  return (
    <div
      ref={boxRef}
      style={{
        width: box.cssWidth,
        height: box.cssHeight,
        margin: "0 auto",
        background: "#fff",
        boxShadow: "0 1px 4px rgba(0,0,0,0.25)",
        flexShrink: 0,
      }}
    >
      <canvas
        ref={canvasRef}
        data-testid="file-browser-preview-pdf-page"
        data-page={pageNumber}
        style={{ display: "block", width: box.cssWidth, height: box.cssHeight }}
      />
    </div>
  );
}
