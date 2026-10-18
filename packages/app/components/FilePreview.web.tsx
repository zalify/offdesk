import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  File as FileIcon,
  Globe,
  Loader2,
} from "lucide-react";
import { readFile } from "@/lib/api";
import type { RemoteFile } from "@/lib/api";
import { colors, colorAlpha } from "@/lib/colors";
import { describeFetchError, saveFetchedFile } from "@/lib/fetchRemoteFile";
import {
  analyzeFile,
  base64ToBytes,
  buildPreviewDocument,
  resolvePreviewTheme,
  truncateText,
} from "@/lib/filePreview";
import { isHtmlFile } from "@/lib/htmlPreview";
import { canPreviewHtml, openHtmlPreview } from "@/lib/nativeHtmlPreview";
import { showNotice } from "@/lib/workspaceToast";
import { PdfPreview } from "./PdfPreview.web";
import { formatBytes } from "@/lib/resourceStats";
import { rem } from "@/lib/rem";

type View =
  | { kind: "image"; src: string }
  | { kind: "markdown"; srcDoc: string; source: string; truncated: boolean }
  | { kind: "docx"; srcDoc: string }
  | { kind: "pdf"; bytes: Uint8Array }
  | { kind: "text"; text: string; truncated: boolean }
  | { kind: "unsupported" };

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; file: RemoteFile; view: View };

const SPIN = { animation: "offdeskSpin 800ms linear infinite" } as const;

// Empty on purpose: no scripts, no same-origin, no popups. The HTML inside comes
// from files on a remote machine.
const RICH_SANDBOX = "";

async function buildView(file: RemoteFile): Promise<View> {
  const bytes = base64ToBytes(file.data_base64);
  const analysis = analyzeFile({ name: file.name, mime: file.mime, bytes });
  switch (analysis.kind) {
    case "image":
      return { kind: "image", src: `data:${analysis.mime};base64,${file.data_base64}` };
    case "markdown": {
      const { text, truncated } = truncateText(analysis.text);
      const { marked } = await import("marked");
      const html = marked.parse(text, { async: false, gfm: true }) as string;
      return {
        kind: "markdown",
        srcDoc: buildPreviewDocument(html, resolvePreviewTheme()),
        source: text,
        truncated,
      };
    }
    case "docx": {
      const mod = await import("mammoth/mammoth.browser.min.js");
      // A CommonJS (UMD) bundle: the API is on `default` or on the namespace.
      const mammoth = mod.default ?? mod;
      const arrayBuffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const result = await mammoth.convertToHtml({ arrayBuffer });
      if (result.messages.length > 0) console.debug("mammoth", result.messages);
      return { kind: "docx", srcDoc: buildPreviewDocument(result.value, resolvePreviewTheme()) };
    }
    case "pdf":
      return { kind: "pdf", bytes };
    case "text": {
      const { text, truncated } = truncateText(analysis.text);
      return { kind: "text", text, truncated };
    }
    default:
      return { kind: "unsupported" };
  }
}

/**
 * Previews one remote file inside the file browser. The parent keeps the
 * listing state; this only owns loading and presentation of the file.
 */
export function FilePreview({
  machineId,
  path,
  name,
  size,
  touch,
  onBack,
  onPrev,
  onNext,
}: {
  machineId: string;
  path: string;
  name: string;
  size?: number;
  touch: boolean;
  onBack: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [showSource, setShowSource] = useState(false);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const pageable = isHtmlFile(name) && canPreviewHtml();

  useEffect(() => {
    let live = true;
    setState({ status: "loading" });
    setShowSource(false);
    (async () => {
      try {
        const file = await readFile(machineId, path);
        if (!live) return;
        const view = await buildView(file);
        if (!live) return;
        setState({ status: "ready", file, view });
      } catch (err) {
        if (!live) return;
        setState({ status: "error", message: describeFetchError(err, path) });
      }
    })();
    return () => {
      live = false;
    };
  }, [machineId, path, reloadTick]);

  const download = useCallback(() => {
    if (state.status !== "ready" || saving) return;
    setSaving(true);
    void saveFetchedFile(state.file).finally(() => setSaving(false));
  }, [state, saving]);

  const openPage = useCallback(() => {
    if (opening) return;
    setOpening(true);
    openHtmlPreview(machineId, path, name)
      .catch((err) => showNotice(err instanceof Error ? err.message : String(err), { tone: "error" }))
      .finally(() => setOpening(false));
  }, [machineId, path, name, opening]);

  const kind = state.status === "ready" ? state.view.kind : state.status;
  const shownSize = state.status === "ready" ? state.file.size : size;
  const hit = touch ? 44 : 32;

  const iconButton = (disabled = false) =>
    ({
      width: hit,
      height: hit,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 0,
      border: `1px solid ${colors.line}`,
      borderRadius: 4,
      background: "transparent",
      color: colors.fg0,
      fontFamily: "var(--font-display)",
      fontSize: rem(13),
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.4 : 1,
      flexShrink: 0,
    }) as const;

  const textButton = (primary: boolean, disabled: boolean) =>
    ({
      minHeight: hit,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 6,
      padding: "0 12px",
      border: primary ? "none" : `1px solid ${colors.line}`,
      borderRadius: 4,
      background: primary ? colors.primary : "transparent",
      color: primary ? colors.onPrimary : colors.fg0,
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1,
      fontFamily: "var(--font-display)",
      fontSize: rem(12.5),
      fontWeight: primary ? 600 : 500,
      flexShrink: 0,
    }) as const;

  const downloadButton = (big: boolean) => (
    <button
      type="button"
      data-testid="file-browser-preview-download"
      disabled={state.status !== "ready" || saving}
      onClick={download}
      style={{
        ...textButton(true, state.status !== "ready" || saving),
        ...(big ? { minHeight: 44, padding: "0 24px", fontSize: rem(14) } : null),
      }}
    >
      {saving ? <Loader2 size={14} aria-hidden style={SPIN} /> : null}
      download
    </button>
  );

  return (
    <div
      data-testid="file-browser-preview"
      data-kind={kind}
      data-path={path}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: touch ? "6px 10px" : "10px 20px",
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          data-testid="file-browser-preview-back"
          aria-label="Back to the list"
          title="Back to the list (Esc)"
          onClick={onBack}
          style={{ ...textButton(false, false), border: "none", color: colors.fg2, padding: "0 6px" }}
        >
          ←{!touch && " back to the list"}
        </button>
        <div style={{ flex: 1, minWidth: 0, padding: "0 4px" }}>
          <div
            data-testid="file-browser-preview-name"
            title={path}
            style={{
              fontSize: rem(13),
              fontWeight: 500,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </div>
          {shownSize !== undefined && (
            <div style={{ fontSize: rem(11), color: colors.fg3 }}>{formatBytes(shownSize)}</div>
          )}
        </div>
        {state.status === "ready" && state.view.kind === "markdown" && (
          <button
            type="button"
            data-testid="file-browser-preview-source"
            aria-label={showSource ? "Show rendered" : "Show source"}
            aria-pressed={showSource}
            title={showSource ? "Show rendered" : "Show source"}
            onClick={() => setShowSource((v) => !v)}
            style={{
              ...textButton(false, false),
              background: showSource ? colors.bg3 : "transparent",
            }}
          >
            {showSource ? "show rendered" : "show source"}
          </button>
        )}
        <button
          type="button"
          data-testid="file-browser-preview-prev"
          aria-label="Previous file"
          title="Previous file (←)"
          disabled={!onPrev}
          onClick={onPrev}
          style={iconButton(!onPrev)}
        >
          ←
        </button>
        <button
          type="button"
          data-testid="file-browser-preview-next"
          aria-label="Next file"
          title="Next file (→)"
          disabled={!onNext}
          onClick={onNext}
          style={iconButton(!onNext)}
        >
          →
        </button>
        {pageable && (
          <button
            type="button"
            data-testid="file-browser-preview-page"
            aria-label="Preview the page"
            title="Preview the page"
            disabled={opening}
            onClick={openPage}
            style={textButton(false, opening)}
          >
            {opening ? <Loader2 size={14} aria-hidden style={SPIN} /> : null}
            preview
          </button>
        )}
        {downloadButton(false)}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {state.status === "loading" && (
          <Message testId="file-browser-preview-loading">
            <Loader2 size={16} aria-hidden style={SPIN} /> reading…
          </Message>
        )}
        {state.status === "error" && (
          <Message testId="file-browser-preview-error" color={colors.danger}>
            <div role="alert" style={{ marginBottom: 10 }}>
              {state.message}
            </div>
            <button
              type="button"
              data-testid="file-browser-preview-retry"
              onClick={() => setReloadTick((n) => n + 1)}
              style={textButton(false, false)}
            >
              try again
            </button>
          </Message>
        )}
        {state.status === "ready" && (
          <ReadyView
            view={state.view}
            file={state.file}
            showSource={showSource}
            touch={touch}
            downloadButton={downloadButton(true)}
          />
        )}
      </div>
    </div>
  );
}

function ReadyView({
  view,
  file,
  showSource,
  touch,
  downloadButton,
}: {
  view: View;
  file: RemoteFile;
  showSource: boolean;
  touch: boolean;
  downloadButton: React.ReactNode;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const frameStyle = {
    flex: 1,
    minHeight: 0,
    width: "100%",
    border: "none",
    background: colors.bg0,
  } as const;

  if (view.kind === "image" && !imageFailed) {
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 12,
          overflow: "auto",
          background: colors.bg2,
        }}
      >
        <img
          data-testid="file-browser-preview-image"
          src={view.src}
          alt={file.name}
          onError={() => setImageFailed(true)}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        />
      </div>
    );
  }
  if (view.kind === "markdown" && !showSource) {
    return (
      <>
        {view.truncated && <Notice>Showing the first 1 MB</Notice>}
        <iframe
          data-testid="file-browser-preview-rich"
          title={file.name}
          sandbox={RICH_SANDBOX}
          srcDoc={view.srcDoc}
          style={frameStyle}
        />
      </>
    );
  }
  if (view.kind === "docx") {
    return (
      <iframe
        data-testid="file-browser-preview-rich"
        title={file.name}
        sandbox={RICH_SANDBOX}
        srcDoc={view.srcDoc}
        style={frameStyle}
      />
    );
  }
  if (view.kind === "pdf") {
    return (
      <PdfPreview
        bytes={view.bytes}
        name={file.name}
        touch={touch}
        renderError={(message) => (
          <Message testId="file-browser-preview-error" color={colors.danger}>
            <div role="alert" style={{ marginBottom: 10 }}>
              {message}
            </div>
            {downloadButton}
          </Message>
        )}
      />
    );
  }
  if (view.kind === "text" || view.kind === "markdown") {
    const text = view.kind === "text" ? view.text : view.source;
    return (
      <>
        {view.truncated && <Notice>Showing the first 1 MB</Notice>}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain" }}>
          <pre
            data-testid="file-browser-preview-text"
            style={{
              margin: 0,
              padding: touch ? "12px 14px" : "10px 14px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: rem(touch ? 13 : 12),
              lineHeight: 1.55,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: colors.fg0,
              userSelect: "text",
            }}
          >
            {text}
          </pre>
        </div>
      </>
    );
  }
  return (
    <Message testId="file-browser-preview-unsupported">
      <FileIcon size={40} aria-hidden style={{ color: colors.fg3 }} />
      <div style={{ fontSize: rem(14), color: colors.fg0, wordBreak: "break-all" }}>{file.name}</div>
      <div style={{ fontSize: rem(12) }}>{formatBytes(file.size)}</div>
      <div style={{ marginBottom: 10 }}>This kind of file has no preview</div>
      {downloadButton}
    </Message>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-testid="file-browser-preview-truncated"
      style={{
        padding: "4px 14px",
        fontSize: rem(11),
        color: colors.warn,
        background: colors.bg1,
        borderBottom: `1px solid ${colors.lineSoft}`,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  );
}

function Message({
  children,
  testId,
  color,
}: {
  children: React.ReactNode;
  testId: string;
  color?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 160,
        padding: 24,
        textAlign: "center",
        fontSize: rem(13),
        color: color ?? colors.fg3,
      }}
    >
      {children}
    </div>
  );
}
