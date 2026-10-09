import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { DirEntry } from "@offdesk/shared";
import {
  ArrowUp,
  ChevronRight,
  File as FileIcon,
  Folder,
  Home,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { listDirectory } from "@/lib/api";
import { colors, colorAlpha } from "@/lib/colors";
import { FilePreview } from "./FilePreview.web";
import {
  describeListError,
  filterEntries,
  formatEntrySize,
  formatRelativeTime,
  isTooLarge,
  parentPath,
  rememberDirectory,
  sortEntries,
  splitBreadcrumb,
} from "@/lib/fileBrowser";

type Listing =
  | { status: "loading" }
  | { status: "ready"; entries: DirEntry[] }
  | { status: "error"; message: string };

const SPIN = { animation: "offdeskSpin 800ms linear infinite" } as const;

/**
 * The remote file browser core, shared by the desktop overlay and the phone's
 * full-screen surface: breadcrumb, toolbar, filter and a directory listing.
 * Tapping a directory enters it; tapping a file previews it in place, with a
 * download button there.
 */
export function FileBrowser({
  machineId,
  homeDir,
  startPath,
  touch,
}: {
  machineId: string;
  homeDir?: string;
  startPath: string;
  /** Phone surface: 44px rows, no keyboard navigation. */
  touch: boolean;
}) {
  const [path, setPath] = useState(startPath);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [selected, setSelected] = useState(0);
  // The file being previewed in place of the listing; null shows the listing.
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const listScroll = useRef(0);
  const [reloadTick, setReloadTick] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // The start path changes when the terminal opens a directory link while the
  // browser is already open.
  useEffect(() => {
    setPath(startPath);
    setFilter("");
    setPreviewPath(null);
  }, [startPath]);

  // Load the listing. A newer navigation or toggle supersedes an older
  // request: its result is dropped when the effect has been cleaned up.
  useEffect(() => {
    let live = true;
    setListing({ status: "loading" });
    listDirectory(machineId, path, { showHidden })
      .then((entries) => {
        if (!live) return;
        setListing({ status: "ready", entries: sortEntries(entries) });
        rememberDirectory(machineId, path);
      })
      .catch((err) => {
        if (!live) return;
        setListing({ status: "error", message: describeListError(err, path) });
      });
    return () => {
      live = false;
    };
  }, [machineId, path, showHidden, reloadTick]);

  const visible = useMemo(
    () => (listing.status === "ready" ? filterEntries(listing.entries, filter) : []),
    [listing, filter],
  );

  useEffect(() => {
    setSelected(0);
  }, [visible.length, path, filter]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[data-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, visible]);

  useEffect(() => {
    if (!touch) rootRef.current?.focus({ preventScroll: true });
  }, [touch]);

  const crumbs = useMemo(() => splitBreadcrumb(path, homeDir), [path, homeDir]);
  const up = parentPath(path, homeDir);

  const go = useCallback((next: string) => {
    setFilter("");
    setPreviewPath(null);
    setPath(next);
  }, []);

  const openPreview = useCallback((entry: DirEntry) => {
    if (listRef.current) listScroll.current = listRef.current.scrollTop;
    setPreviewPath(entry.path);
  }, []);

  const closePreview = useCallback(() => {
    setPreviewPath(null);
    if (!touch) rootRef.current?.focus({ preventScroll: true });
  }, [touch]);

  const activate = useCallback(
    (entry: DirEntry) => {
      if (entry.is_dir) {
        go(entry.path);
        return;
      }
      if (isTooLarge(entry)) return;
      openPreview(entry);
    },
    [go, openPreview],
  );

  // Files that prev/next can step through: the visible, previewable ones.
  const previewable = useMemo(
    () => visible.filter((e) => !e.is_dir && !isTooLarge(e)),
    [visible],
  );
  const previewIndex = previewable.findIndex((e) => e.path === previewPath);
  const previewEntry =
    previewIndex >= 0
      ? previewable[previewIndex]
      : (listing.status === "ready"
          ? listing.entries.find((e) => e.path === previewPath)
          : undefined);

  const stepPreview = useCallback(
    (delta: number) => {
      const target = previewable[previewIndex + delta];
      if (!target) return;
      setPreviewPath(target.path);
      setSelected(visible.findIndex((e) => e.path === target.path));
    },
    [previewable, previewIndex, visible],
  );
  const onPrev = previewIndex > 0 ? () => stepPreview(-1) : undefined;
  const onNext =
    previewIndex >= 0 && previewIndex < previewable.length - 1
      ? () => stepPreview(1)
      : undefined;

  // The row that had focus unmounts with the listing; keep keys flowing to the
  // browser root, and put the scroll position back when returning.
  useEffect(() => {
    if (previewPath !== null && !touch) rootRef.current?.focus({ preventScroll: true });
  }, [previewPath === null, touch]);
  useLayoutEffect(() => {
    if (previewPath === null && listRef.current) {
      listRef.current.scrollTop = listScroll.current;
    }
  }, [previewPath === null]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (touch || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (previewPath !== null) {
      // Handled (and prevented) here so the overlay's window-level Escape
      // listener sees defaultPrevented and leaves the overlay open.
      if (event.key === "Escape" || event.key === "Backspace") {
        event.preventDefault();
        closePreview();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        onPrev?.();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        onNext?.();
      }
      return;
    }
    const inFilter = target === filterRef.current;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((i) => Math.min(visible.length - 1, i + 1));
    } else if (event.key === "ArrowUp" && event.altKey) {
      event.preventDefault();
      if (up) go(up);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
    } else if (event.key === "Enter") {
      if (target.tagName === "BUTTON" && !target.hasAttribute("data-row")) return;
      if (target.tagName === "INPUT" && !inFilter) return;
      const entry = visible[selected];
      if (entry) {
        event.preventDefault();
        activate(entry);
      }
    } else if (event.key === "Backspace" && (!inFilter || filter === "")) {
      if (target.tagName === "INPUT" && !inFilter) return;
      event.preventDefault();
      if (up) go(up);
    } else if (event.key === "Escape" && inFilter && filter !== "") {
      event.preventDefault();
      setFilter("");
    } else if (
      !inFilter &&
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      target.tagName !== "INPUT"
    ) {
      // Typing anywhere in the list starts filtering.
      filterRef.current?.focus();
    }
  };

  const toolButton = (active = false) =>
    ({
      width: touch ? 40 : 28,
      height: touch ? 40 : 28,
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      padding: 0,
      border: "none",
      borderRadius: 6,
      background: active ? colorAlpha.accentSoft : "transparent",
      color: active ? colors.accent : colors.fg2,
      cursor: "pointer",
      flexShrink: 0,
    }) as const;

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="file-browser"
      data-path={path}
      onKeyDown={onKeyDown}
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        outline: "none",
        color: colors.fg0,
        background: colors.bg0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: touch ? "4px 6px" : "4px 8px",
          background: colors.bg1,
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          data-testid="file-browser-up"
          aria-label="上一级"
          title="上一级"
          disabled={!up}
          onClick={() => up && go(up)}
          style={{ ...toolButton(), opacity: up ? 1 : 0.4 }}
        >
          <ArrowUp size={16} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="file-browser-home"
          aria-label="主目录"
          title="主目录"
          onClick={() => go("~")}
          style={toolButton()}
        >
          <Home size={16} aria-hidden />
        </button>
        <button
          type="button"
          data-testid="file-browser-refresh"
          aria-label="刷新"
          title="刷新"
          onClick={() => setReloadTick((n) => n + 1)}
          style={toolButton()}
        >
          <RefreshCw size={15} aria-hidden style={listing.status === "loading" ? SPIN : undefined} />
        </button>
        <nav
          aria-label="路径"
          data-testid="file-browser-breadcrumb"
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            overflowX: "auto",
            whiteSpace: "nowrap",
            padding: "0 6px",
            fontSize: 12,
            scrollbarWidth: "none",
          }}
        >
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            return (
              <span key={crumb.path} style={{ display: "inline-flex", alignItems: "center" }}>
                {index > 0 && (
                  <ChevronRight size={12} aria-hidden style={{ color: colors.fg3, flexShrink: 0 }} />
                )}
                <button
                  type="button"
                  data-testid="file-browser-crumb"
                  data-path={crumb.path}
                  aria-current={last ? "page" : undefined}
                  onClick={() => go(crumb.path)}
                  style={{
                    border: "none",
                    background: "transparent",
                    padding: touch ? "10px 6px" : "3px 4px",
                    borderRadius: 4,
                    cursor: "pointer",
                    fontSize: 12,
                    fontWeight: last ? 600 : 400,
                    color: last ? colors.fg0 : colors.fg2,
                  }}
                >
                  {crumb.label}
                </button>
              </span>
            );
          })}
        </nav>
      </div>

      {previewPath !== null && (
        <FilePreview
          key={previewPath}
          machineId={machineId}
          path={previewPath}
          name={previewEntry?.name ?? previewPath.split("/").pop() ?? previewPath}
          size={previewEntry?.size}
          touch={touch}
          onBack={closePreview}
          onPrev={onPrev}
          onNext={onNext}
        />
      )}

      {previewPath === null && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: touch ? "6px 10px" : "6px 10px",
            borderBottom: `1px solid ${colors.lineSoft}`,
            flexShrink: 0,
          }}
        >
          <input
            ref={filterRef}
            data-testid="file-browser-filter"
            aria-label="按名称过滤"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="按名称过滤"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              minHeight: touch ? 38 : 28,
              padding: "0 10px",
              fontSize: touch ? 16 : 13,
              color: colors.foreground,
              background: colors.bg1,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              outline: "none",
            }}
          />
          <label
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              color: colors.fg2,
              cursor: "pointer",
              flexShrink: 0,
              minHeight: touch ? 38 : undefined,
            }}
          >
            <input
              type="checkbox"
              data-testid="file-browser-hidden"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            显示隐藏文件
          </label>
        </div>
      )}

      {previewPath === null && (
        <div
          ref={listRef}
          data-testid="file-browser-list"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}
        >
          {listing.status === "loading" && (
            <Centered testId="file-browser-loading">
              <Loader2 size={16} aria-hidden style={SPIN} /> 正在读取…
            </Centered>
          )}
          {listing.status === "error" && (
            <Centered testId="file-browser-error" color={colors.danger}>
              <div role="alert" style={{ marginBottom: 10 }}>
                {listing.message}
              </div>
              <button
                type="button"
                data-testid="file-browser-retry"
                onClick={() => setReloadTick((n) => n + 1)}
                style={{
                  minHeight: touch ? 44 : 30,
                  padding: "0 16px",
                  borderRadius: 6,
                  border: "none",
                  background: colors.accent,
                  color: colors.onAccent,
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                重试
              </button>
            </Centered>
          )}
          {listing.status === "ready" && visible.length === 0 && (
            <Centered testId="file-browser-empty">
              {filter ? "没有匹配的文件" : "这个目录是空的"}
            </Centered>
          )}
          {listing.status === "ready" &&
            visible.map((entry, index) => {
              const tooLarge = isTooLarge(entry);
              const isSelected = index === selected && !touch;
              const size = formatEntrySize(entry);
              return (
                <button
                  key={entry.path}
                  type="button"
                  data-row=""
                  data-testid="file-browser-row"
                  data-name={entry.name}
                  data-kind={entry.is_dir ? "dir" : "file"}
                  data-selected={isSelected ? "true" : "false"}
                  disabled={tooLarge}
                  title={tooLarge ? "超过 20 MB" : entry.path}
                  onClick={() => {
                    setSelected(index);
                    activate(entry);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    minHeight: touch ? 48 : 30,
                    padding: touch ? "0 14px" : "0 12px",
                    border: "none",
                    borderBottom: touch ? `1px solid ${colors.lineSoft}` : "none",
                    background: isSelected ? colorAlpha.accentSoft : "transparent",
                    color: tooLarge ? colors.fg3 : colors.fg0,
                    cursor: tooLarge ? "not-allowed" : "pointer",
                    textAlign: "left",
                    fontSize: touch ? 15 : 13,
                  }}
                >
                  {entry.is_dir ? (
                    <Folder size={16} aria-hidden style={{ flexShrink: 0, color: colors.accent }} />
                  ) : (
                    <FileIcon size={16} aria-hidden style={{ flexShrink: 0, color: colors.fg3 }} />
                  )}
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {entry.name}
                  </span>
                  {tooLarge && (
                    <span style={{ fontSize: 11, color: colors.warn, flexShrink: 0 }}>
                      {size} · 超过 20 MB
                    </span>
                  )}
                  {!tooLarge && size && (
                    <span
                      data-testid="file-browser-size"
                      style={{ fontSize: 11, color: colors.fg3, flexShrink: 0 }}
                    >
                      {size}
                    </span>
                  )}
                  {!touch && (
                    <span
                      style={{
                        width: 84,
                        textAlign: "right",
                        fontSize: 11,
                        color: colors.fg3,
                        flexShrink: 0,
                      }}
                    >
                      {formatRelativeTime(entry.modified_ms)}
                    </span>
                  )}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}

function Centered({
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
