import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Code2, Copy, Eye, X } from "lucide-react";
import { listMachines, readFile as apiReadFile } from "@/lib/api";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { parseArtifactSegments } from "@/lib/artifactSegments";
import { useOpenDirectory } from "./OpenDirectoryContext";
import { DatabaseEmbed } from "./draftdb/DatabaseEmbed.web";

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i;
const remoteImageCache = new Map<string, string>();
let machineLookupPromise: Promise<Map<string, string>> | null = null;

function parseRemoteFileHref(href: string): { host: string; path: string } | null {
  if (!/^file:\/\//i.test(href)) return null;
  const rest = href.slice("file://".length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) return null;
  const host = decodeURIComponent(rest.slice(0, slashIdx));
  const rawPath = rest.slice(slashIdx);
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    path = rawPath;
  }
  return { host, path };
}

async function resolveMachineId(host: string): Promise<string | null> {
  if (!machineLookupPromise) {
    machineLookupPromise = listMachines()
      .then((machines) => {
        const map = new Map<string, string>();
        for (const m of machines) {
          map.set(m.id.toLowerCase(), m.id);
          map.set(m.id.slice(0, 8).toLowerCase(), m.id);
          if (m.name) map.set(m.name.toLowerCase(), m.id);
        }
        return map;
      })
      .catch(() => {
        machineLookupPromise = null;
        return new Map<string, string>();
      });
  }
  const map = await machineLookupPromise;
  const key = host.toLowerCase();
  if (map.has(key)) return map.get(key)!;
  for (const [k, id] of map.entries()) {
    if (k.startsWith(key)) return id;
  }
  return null;
}

async function loadRemoteImageDataUrl(host: string, path: string): Promise<string | null> {
  const cacheKey = `${host}:${path}`;
  const cached = remoteImageCache.get(cacheKey);
  if (cached) return cached;
  const machineId = await resolveMachineId(host);
  if (!machineId) return null;
  try {
    const file = await apiReadFile(machineId, path);
    const mime = file.mime || "image/png";
    const dataUrl = `data:${mime};base64,${file.data_base64}`;
    if (remoteImageCache.size >= 48) {
      const oldest = remoteImageCache.keys().next().value;
      if (oldest !== undefined) remoteImageCache.delete(oldest);
    }
    remoteImageCache.set(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

export { parseArtifactSegments } from "@/lib/artifactSegments";
export type { ArtifactSegment } from "@/lib/artifactSegments";

const MARKDOWN_CSS = `
.odk-md { color: var(--odk-fg0); font-size: 13.5px; line-height: 1.65; word-break: break-word; }
.odk-md h1, .odk-md h2, .odk-md h3, .odk-md h4 {
  color: var(--odk-fg0); margin: 1.1em 0 0.5em; font-weight: 650; line-height: 1.3;
}
.odk-md h1 { font-size: 1.35em; border-bottom: 1px solid var(--odk-line); padding-bottom: 0.3em; }
.odk-md h2 { font-size: 1.18em; }
.odk-md h3 { font-size: 1.05em; }
.odk-md p { margin: 0.55em 0; }
.odk-md ul, .odk-md ol { margin: 0.5em 0; padding-left: 1.4em; }
.odk-md li { margin: 0.2em 0; }
.odk-md blockquote {
  margin: 0.65em 0; padding: 0.4em 0.85em;
  border-left: 3px solid var(--odk-accent);
  background: var(--odk-bg1); color: var(--odk-fg2); border-radius: 0 6px 6px 0;
}
.odk-md code {
  font-family: var(--font-mono); font-size: 0.9em;
  padding: 0.12em 0.38em; border-radius: 4px;
  background: var(--odk-bg2); color: var(--odk-fg0);
}
.odk-md pre {
  margin: 0.7em 0; padding: 10px 12px; border-radius: 8px;
  background: var(--odk-bg0); border: 1px solid var(--odk-line);
  overflow-x: auto;
}
.odk-md pre code { padding: 0; background: transparent; font-size: 12.5px; line-height: 1.5; }
.odk-md .odk-table-wrap { overflow-x: auto; margin: 0.75em 0; border-radius: 8px; border: 1px solid var(--odk-line); }
.odk-md table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.odk-md th, .odk-md td {
  padding: 7px 10px; text-align: left;
  border-bottom: 1px solid var(--odk-line); border-right: 1px solid var(--odk-line);
}
.odk-md th:last-child, .odk-md td:last-child { border-right: none; }
.odk-md tr:last-child td { border-bottom: none; }
.odk-md th { background: var(--odk-bg2); font-weight: 600; color: var(--odk-fg0); white-space: nowrap; }
.odk-md tr:nth-child(even) td { background: rgba(255, 255, 255, 0.02); }
.odk-md a { color: var(--odk-accent); text-decoration: underline; cursor: pointer; }
.odk-md img {
  display: block; max-width: 100%; max-height: 420px; width: auto; height: auto;
  margin: 8px 0; border-radius: 8px; border: 1px solid var(--odk-line);
  background: repeating-conic-gradient(#1f2127 0% 25%, #2a2d36 0% 50%) 50% / 16px 16px;
  cursor: zoom-in;
}
.odk-md .odk-inline-img-wrap { margin: 6px 0 10px; }
.odk-md .odk-inline-img-loading {
  display: inline-block; font-size: 11.5px; color: var(--odk-fg2);
  padding: 4px 8px; border-radius: 6px; border: 1px dashed var(--odk-line);
}
.odk-md hr { border: none; border-top: 1px solid var(--odk-line); margin: 1em 0; }
`;

const MarkdownSegmentView = memo(function MarkdownSegmentView({
  text,
  onZoomImage,
}: {
  text: string;
  onZoomImage?: (src: string, alt: string) => void;
}) {
  const [html, setHtml] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);
  const openDirectory = useOpenDirectory();
  // Keep a stable object identity across parent re-renders: React 19 checks
  // reference equality on `dangerouslySetInnerHTML` and re-assigns `innerHTML`
  // on every new object, which destroys child DOM nodes and resets `<pre>` /
  // table horizontal `scrollLeft`, text selection, and hydrated `file://` images.
  const htmlMarkup = useMemo(() => ({ __html: html }), [html]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { marked } = await import("marked");
      const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
      // Wrap tables in a horizontal-scroll container so wide tables never clip on mobile.
      const wrapped = raw
        .replace(/<table/g, '<div class="odk-table-wrap"><table')
        .replace(/<\/table>/g, "</table></div>");
      if (!cancelled) setHtml(wrapped);
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);

  // Hydrate `file://<machine>/path` <img> tags AND auto-preview `file://` image links inline.
  useEffect(() => {
    const root = containerRef.current;
    if (!root || !html) return;
    let cancelled = false;

    const hydrateImg = async (img: HTMLImageElement, host: string, path: string) => {
      const dataUrl = await loadRemoteImageDataUrl(host, path);
      if (cancelled || !dataUrl) return;
      img.src = dataUrl;
    };

    // 1. Direct Markdown images: ![alt](file://machine/path)
    const imgs = Array.from(root.querySelectorAll<HTMLImageElement>("img"));
    for (const img of imgs) {
      const rawSrc = img.getAttribute("src") ?? "";
      const parsed = parseRemoteFileHref(rawSrc);
      if (parsed) {
        img.removeAttribute("src");
        void hydrateImg(img, parsed.host, parsed.path);
      }
    }

    // 2. Markdown links pointing to remote image files: [name.png](file://machine/path)
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a[href]"));
    for (const link of links) {
      const href = link.getAttribute("href") ?? "";
      const parsed = parseRemoteFileHref(href);
      if (!parsed || !IMAGE_EXT_RE.test(parsed.path)) continue;
      if (link.dataset.odkPreviewAttached) continue;
      link.dataset.odkPreviewAttached = "1";

      const wrap = document.createElement("div");
      wrap.className = "odk-inline-img-wrap";
      const status = document.createElement("span");
      status.className = "odk-inline-img-loading";
      status.textContent = "Loading preview…";
      wrap.appendChild(status);
      link.insertAdjacentElement("afterend", wrap);

      void loadRemoteImageDataUrl(parsed.host, parsed.path).then((dataUrl) => {
        if (cancelled) return;
        if (!dataUrl) {
          wrap.remove();
          return;
        }
        const img = document.createElement("img");
        img.src = dataUrl;
        img.alt = link.textContent || parsed.path;
        wrap.innerHTML = "";
        wrap.appendChild(img);
      });
    }

    return () => {
      cancelled = true;
    };
  }, [html]);

  return (
    <div
      ref={containerRef}
      className="odk-md"
      onClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        const img = target.closest("img") as HTMLImageElement | null;
        if (img && img.src && onZoomImage) {
          e.preventDefault();
          e.stopPropagation();
          onZoomImage(img.src, img.alt || "image");
          return;
        }
        const link = target.closest("a") as HTMLAnchorElement | null;
        if (!link) return;
        const href = link.getAttribute("href") ?? "";
        const parsed = parseRemoteFileHref(href);
        if (parsed) {
          e.preventDefault();
          e.stopPropagation();
          if (openDirectory) {
            void resolveMachineId(parsed.host).then((machineId) => {
              if (machineId) openDirectory(machineId, parsed.path);
            });
          }
        }
      }}
      style={
        {
          "--odk-fg0": colors.fg0,
          "--odk-fg2": colors.fg2,
          "--odk-bg0": colors.bg0,
          "--odk-bg1": colors.bg1,
          "--odk-bg2": colors.bg2,
          "--odk-line": colors.lineSoft,
          "--odk-accent": colors.accent,
        } as React.CSSProperties
      }
      dangerouslySetInnerHTML={htmlMarkup}
    />
  );
});

let mermaidInitialized = false;

const MermaidArtifactCard = memo(function MermaidArtifactCard({ code }: { code: string }) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const svgMarkup = useMemo(() => (svg ? { __html: svg } : undefined), [svg]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const mod = await import("mermaid");
        const mermaid = mod.default ?? mod;
        if (!mermaidInitialized) {
          mermaid.initialize({
            startOnLoad: false,
            theme: "dark",
            securityLevel: "strict",
            fontFamily: "var(--font-sans), system-ui, sans-serif",
          });
          mermaidInitialized = true;
        }
        const rendered = await mermaid.render(`odk_mmd_${rawId}_${Date.now()}`, code);
        if (!cancelled) {
          setSvg(rendered.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, rawId]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      data-testid="draft-artifact-mermaid"
      style={{
        borderRadius: 8,
        border: `1px solid ${colors.line}`,
        background: colors.bg0,
        overflow: "hidden",
        margin: "8px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: `1px solid ${colors.lineSoft}`,
          background: colors.bg2,
          fontSize: rem(11.5),
          color: colors.fg2,
        }}
      >
        <span style={{ fontWeight: 600, color: colors.accent }}>mermaid</span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 7px",
            borderRadius: 4,
            border: `1px solid ${colors.lineSoft}`,
            background: colors.bg1,
            color: colors.fg1,
            fontSize: rem(11),
            cursor: "pointer",
          }}
        >
          {showSource ? <Eye size={11} /> : <Code2 size={11} />}
          {showSource ? "Diagram" : "Code"}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 7px",
            borderRadius: 4,
            border: `1px solid ${colors.lineSoft}`,
            background: colors.bg1,
            color: copied ? colors.ok : colors.fg1,
            fontSize: rem(11),
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {showSource || error ? (
        <div style={{ padding: 10 }}>
          {error && (
            <div style={{ color: colors.err, fontSize: rem(11.5), marginBottom: 6 }}>
              Diagram error: {error}
            </div>
          )}
          <pre
            style={{
              margin: 0,
              fontFamily: "var(--font-mono)",
              fontSize: rem(12),
              color: colors.fg1,
              overflowX: "auto",
              whiteSpace: "pre",
            }}
          >
            {code}
          </pre>
        </div>
      ) : svgMarkup ? (
        <div
          style={{
            padding: 12,
            overflowX: "auto",
            display: "flex",
            justifyContent: "center",
          }}
          dangerouslySetInnerHTML={svgMarkup}
        />
      ) : (
        <div style={{ padding: 14, color: colors.fg2, fontSize: rem(12) }}>
          Rendering diagram…
        </div>
      )}
    </div>
  );
});

const SandboxedArtifactCard = memo(function SandboxedArtifactCard({
  kind,
  code,
}: {
  kind: "svg" | "html";
  code: string;
}) {
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

  const srcDoc = useMemo(() => {
    if (kind === "svg") {
      return `<!doctype html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 12px; background: #0f1115; color: #e5e7eb; display: flex; justify-content: center; align-items: center; min-height: calc(100vh - 24px); box-sizing: border-box; }
        svg { max-width: 100%; height: auto; }
      </style></head><body>${code}</body></html>`;
    }
    if (/^<!doctype\s+html|^<html[\s>]/i.test(code)) {
      return code;
    }
    return `<!doctype html><html><head><meta charset="utf-8"><style>
      body { margin: 12px; background: #0f1115; color: #e5e7eb; font-family: system-ui, -apple-system, sans-serif; }
    </style></head><body>${code}</body></html>`;
  }, [kind, code]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      data-testid={`draft-artifact-${kind}`}
      style={{
        borderRadius: 8,
        border: `1px solid ${colors.line}`,
        background: colors.bg0,
        overflow: "hidden",
        margin: "8px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 10px",
          borderBottom: `1px solid ${colors.lineSoft}`,
          background: colors.bg2,
          fontSize: rem(11.5),
          color: colors.fg2,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            color: colors.accent,
            padding: "1px 6px",
            borderRadius: 4,
            background: colorAlpha.accentSoft,
          }}
        >
          {kind.toUpperCase()} Artifact
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 7px",
            borderRadius: 4,
            border: `1px solid ${colors.lineSoft}`,
            background: colors.bg1,
            color: colors.fg1,
            fontSize: rem(11),
            cursor: "pointer",
          }}
        >
          {showSource ? <Eye size={11} /> : <Code2 size={11} />}
          {showSource ? "Preview" : "Source"}
        </button>
        <button
          type="button"
          onClick={() => void handleCopy()}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            padding: "2px 7px",
            borderRadius: 4,
            border: `1px solid ${colors.lineSoft}`,
            background: colors.bg1,
            color: copied ? colors.ok : colors.fg1,
            fontSize: rem(11),
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {showSource ? (
        <pre
          style={{
            margin: 0,
            padding: 10,
            fontFamily: "var(--font-mono)",
            fontSize: rem(12),
            color: colors.fg1,
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        >
          {code}
        </pre>
      ) : (
        <iframe
          title={`${kind} artifact preview`}
          sandbox={kind === "html" ? "allow-scripts" : ""}
          srcDoc={srcDoc}
          style={{
            width: "100%",
            height: kind === "html" ? 360 : 280,
            border: "none",
            display: "block",
            background: "#0f1115",
          }}
        />
      )}
    </div>
  );
});

export function DraftArtifactPreview({
  content,
  projectGroup,
  onOpenDatabase,
}: {
  content: string;
  /** The draft's project group: database names resolve here first. */
  projectGroup?: string;
  /** Opens a database (and optionally a view) in the drafts drawer. */
  onOpenDatabase?: (databaseId: string, viewId?: string) => void;
}) {
  const segments = useMemo(() => parseArtifactSegments(content), [content]);
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null);
  const handleZoomImage = useCallback((src: string, alt: string) => {
    setZoomed({ src, alt });
  }, []);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (segments.length === 0) {
    return (
      <div style={{ color: colors.fg2, fontSize: rem(13), padding: 12 }}>
        (empty draft)
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <style>{MARKDOWN_CSS}</style>
      {segments.map((seg, idx) => {
        switch (seg.kind) {
          case "markdown":
            return (
              <MarkdownSegmentView
                key={idx}
                text={seg.text}
                onZoomImage={handleZoomImage}
              />
            );
          case "mermaid":
            return <MermaidArtifactCard key={idx} code={seg.code} />;
          case "svg":
            return <SandboxedArtifactCard key={idx} kind="svg" code={seg.code} />;
          case "html":
            return <SandboxedArtifactCard key={idx} kind="html" code={seg.code} />;
          case "database":
            return (
              <DatabaseEmbed
                key={idx}
                database={seg.database}
                view={seg.view}
                projectGroup={projectGroup}
                onOpenDatabase={onOpenDatabase}
              />
            );
        }
      })}
      {zoomed && (
        <div
          onClick={() => setZoomed(null)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            background: "rgba(0,0,0,0.82)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            cursor: "zoom-out",
          }}
        >
          <button
            type="button"
            aria-label="Close image preview"
            onClick={() => setZoomed(null)}
            style={{
              position: "fixed",
              top: 16,
              right: 16,
              width: 32,
              height: 32,
              borderRadius: 999,
              border: `1px solid ${colors.line}`,
              background: colors.bg1,
              color: colors.fg0,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
            }}
          >
            <X size={16} />
          </button>
          <img
            src={zoomed.src}
            alt={zoomed.alt}
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: "94vw",
              maxHeight: "88vh",
              objectFit: "contain",
              borderRadius: 8,
              border: `1px solid ${colors.line}`,
              background:
                "repeating-conic-gradient(#1f2127 0% 25%, #2a2d36 0% 50%) 50% / 20px 20px",
              cursor: "default",
            }}
          />
          <div style={{ marginTop: 10, fontSize: rem(12), color: colors.fg2 }}>
            {zoomed.alt}
          </div>
        </div>
      )}
    </div>
  );
}
