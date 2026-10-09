import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  File as FileIcon,
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
import { PdfPreview } from "./PdfPreview.web";
import { formatBytes } from "@/lib/resourceStats";

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

  const kind = state.status === "ready" ? state.view.kind : state.status;
  const shownSize = state.status === "ready" ? state.file.size : size;
  const hit = touch ? 44 : 30;

  const iconButton = (disabled = false) =>
    ({
      width: hit,
      height: hit,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 0,
      border: "none",
      borderRadius: 6,
      background: "transparent",
      color: colors.fg2,
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
      border: primary ? "none" : `1px solid ${colors.border}`,
      borderRadius: 6,
      background: primary ? colors.accent : "transparent",
      color: primary ? colors.onAccent : colors.fg1,
      cursor: disabled ? "default" : "pointer",
      opacity: disabled ? 0.5 : 1,
      fontSize: 13,
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
        ...(big ? { minHeight: 44, padding: "0 24px", fontSize: 14 } : null),
      }}
    >
      {saving ? <Loader2 size={14} aria-hidden style={SPIN} /> : <Download size={14} aria-hidden />}
      下载
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
          gap: 4,
          padding: touch ? "4px 6px" : "4px 8px",
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          data-testid="file-browser-preview-back"
          aria-label="返回列表"
          title="返回列表 (Esc)"
          onClick={onBack}
          style={touch ? iconButton() : { ...textButton(false, false), border: "none", color: colors.fg2, padding: "0 8px" }}
        >
          <ArrowLeft size={16} aria-hidden />
          {!touch && "返回列表"}
        </button>
        <div style={{ flex: 1, minWidth: 0, padding: "0 4px" }}>
          <div
            data-testid="file-browser-preview-name"
            title={path}
            style={{
              fontSize: 13,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {name}
          </div>
          {shownSize !== undefined && (
            <div style={{ fontSize: 11, color: colors.fg3 }}>{formatBytes(shownSize)}</div>
          )}
        </div>
        {state.status === "ready" && state.view.kind === "markdown" && (
          <button
            type="button"
            data-testid="file-browser-preview-source"
            aria-label={showSource ? "查看渲染效果" : "查看源码"}
            aria-pressed={showSource}
            title={showSource ? "查看渲染效果" : "查看源码"}
            onClick={() => setShowSource((v) => !v)}
            style={{
              ...iconButton(),
              background: showSource ? colorAlpha.accentSoft : "transparent",
              color: showSource ? colors.accent : colors.fg2,
            }}
          >
            <Code2 size={16} aria-hidden />
          </button>
        )}
        <button
          type="button"
          data-testid="file-browser-preview-prev"
          aria-label="上一个文件"
          title="上一个文件 (←)"
          disabled={!onPrev}
          onClick={onPrev}
          style={iconButton(!onPrev)}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="file-browser-preview-next"
          aria-label="下一个文件"
          title="下一个文件 (→)"
          disabled={!onNext}
          onClick={onNext}
          style={iconButton(!onNext)}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
        {downloadButton(false)}
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {state.status === "loading" && (
          <Message testId="file-browser-preview-loading">
            <Loader2 size={16} aria-hidden style={SPIN} /> 正在读取…
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
              style={textButton(true, false)}
            >
              重试
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
        {view.truncated && <Notice>只显示前 1 MB</Notice>}
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
        {view.truncated && <Notice>只显示前 1 MB</Notice>}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", overscrollBehavior: "contain" }}>
          <pre
            data-testid="file-browser-preview-text"
            style={{
              margin: 0,
              padding: touch ? "12px 14px" : "10px 14px",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              fontSize: touch ? 13 : 12,
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
      <div style={{ fontSize: 14, color: colors.fg0, wordBreak: "break-all" }}>{file.name}</div>
      <div style={{ fontSize: 12 }}>{formatBytes(file.size)}</div>
      <div style={{ marginBottom: 10 }}>无法预览这种文件</div>
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
        fontSize: 11,
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
        fontSize: 13,
        color: color ?? colors.fg3,
      }}
    >
      {children}
    </div>
  );
}
