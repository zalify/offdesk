import { useEffect, useId, useMemo, useState } from "react";
import { Check, Code2, Copy, Eye } from "lucide-react";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";

export type ArtifactSegment =
  | { kind: "markdown"; text: string }
  | { kind: "mermaid"; code: string }
  | { kind: "svg"; code: string }
  | { kind: "html"; code: string };

/**
 * Split a draft into interleaved Markdown and rich Artifact blocks
 * (`mermaid`, `svg`, `html`), or treat a standalone HTML/SVG document as one artifact.
 */
export function parseArtifactSegments(source: string): ArtifactSegment[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
    return [{ kind: "html", code: trimmed }];
  }
  if (/^<svg[\s>]/i.test(trimmed) && trimmed.endsWith("</svg>")) {
    return [{ kind: "svg", code: trimmed }];
  }

  const segments: ArtifactSegment[] = [];
  const fenceRe = /```(mermaid|svg|html)\s*\n([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(source)) !== null) {
    if (match.index > lastIndex) {
      const md = source.slice(lastIndex, match.index).trim();
      if (md) segments.push({ kind: "markdown", text: md });
    }
    const lang = match[1].toLowerCase() as "mermaid" | "svg" | "html";
    const code = match[2].trim();
    if (code) {
      segments.push({ kind: lang, code });
    }
    lastIndex = fenceRe.lastIndex;
  }
  if (lastIndex < source.length) {
    const tail = source.slice(lastIndex).trim();
    if (tail) segments.push({ kind: "markdown", text: tail });
  }
  return segments;
}

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
.odk-md a { color: var(--odk-accent); text-decoration: underline; }
.odk-md hr { border: none; border-top: 1px solid var(--odk-line); margin: 1em 0; }
`;

function MarkdownSegmentView({ text }: { text: string }) {
  const [html, setHtml] = useState<string>("");

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

  return (
    <div
      className="odk-md"
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
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

let mermaidInitialized = false;

function MermaidArtifactCard({ code }: { code: string }) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState(false);

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
      ) : svg ? (
        <div
          style={{
            padding: 12,
            overflowX: "auto",
            display: "flex",
            justifyContent: "center",
          }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : (
        <div style={{ padding: 14, color: colors.fg2, fontSize: rem(12) }}>
          Rendering diagram…
        </div>
      )}
    </div>
  );
}

function SandboxedArtifactCard({
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
}

export function DraftArtifactPreview({ content }: { content: string }) {
  const segments = useMemo(() => parseArtifactSegments(content), [content]);

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
            return <MarkdownSegmentView key={idx} text={seg.text} />;
          case "mermaid":
            return <MermaidArtifactCard key={idx} code={seg.code} />;
          case "svg":
            return <SandboxedArtifactCard key={idx} kind="svg" code={seg.code} />;
          case "html":
            return <SandboxedArtifactCard key={idx} kind="html" code={seg.code} />;
        }
      })}
    </div>
  );
}
