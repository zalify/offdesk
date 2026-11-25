import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  Check,
  Copy,
  Eye,
  FileText,
  Maximize2,
  Minimize2,
  Pencil,
  Pin,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { DraftArtifactPreview } from "./DraftArtifactPreview.web";
import { DatabasesPane } from "./draftdb/DatabasesPane.web";
import { useDraftDatabases } from "./draftdb/useDraftDatabases";
import { ShareControl } from "./draftdb/ShareControl.web";
import { HistoryButton, VersionBanner } from "./draftdb/VersionHistory.web";
import {
  deleteDraft,
  listDrafts,
  updateDraft,
  upsertDraft,
  type DraftInfo,
  type DraftVersion,
} from "@/lib/api";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";

interface DraftsDrawerProps {
  open: boolean;
  isCompact: boolean;
  defaultProjectGroup?: string;
  activeTerminalLabel?: string | null;
  onClose: () => void;
  onSendToTerminal?: (content: string) => void;
  onCountChange?: (activeCount: number) => void;
}

function relativeTime(ms: number): string {
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function DraftsDrawer({
  open,
  isCompact,
  defaultProjectGroup = "~",
  activeTerminalLabel = null,
  onClose,
  onSendToTerminal,
  onCountChange,
}: DraftsDrawerProps) {
  const [drafts, setDrafts] = useState<DraftInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [projectFilter, setProjectFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [wide, setWide] = useState(false);
  const [section, setSection] = useState<"drafts" | "databases">("drafts");
  const [dbOpen, setDbOpen] = useState(false);
  const [dbOpenRequest, setDbOpenRequest] = useState<{ id: string; viewId?: string; nonce: number } | null>(null);
  const [customWidth, setCustomWidth] = useState<number | null>(() => {
    try {
      const raw = Number(localStorage.getItem("offdesk:drafts-drawer-width"));
      return Number.isFinite(raw) && raw >= 360 ? raw : null;
    } catch {
      return null;
    }
  });
  const [resizing, setResizing] = useState(false);
  const [resizeHover, setResizeHover] = useState(false);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    const onMove = (ev: MouseEvent) => {
      const maxW = Math.max(420, Math.floor(window.innerWidth * 0.95));
      const next = Math.max(360, Math.min(maxW, Math.round(window.innerWidth - ev.clientX)));
      setCustomWidth(next);
    };
    const onUp = (ev: MouseEvent) => {
      setResizing(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const maxW = Math.max(420, Math.floor(window.innerWidth * 0.95));
      const finalW = Math.max(360, Math.min(maxW, Math.round(window.innerWidth - ev.clientX)));
      try {
        localStorage.setItem("offdesk:drafts-drawer-width", String(finalW));
      } catch {
        // ignore storage quota errors
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const resetWidth = useCallback(() => {
    setCustomWidth(null);
    try {
      localStorage.removeItem("offdesk:drafts-drawer-width");
    } catch {
      // ignore
    }
  }, []);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editProject, setEditProject] = useState(defaultProjectGroup);
  const [saving, setSaving] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // An earlier version being viewed read-only in the preview.
  const [viewing, setViewing] = useState<DraftVersion | null>(null);

  useEffect(() => {
    setViewing(null);
  }, [selectedId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await listDrafts({ includeArchived: true });
      setDrafts(rows);
      onCountChange?.(rows.filter((d) => !d.archived).length);
    } catch {
      // Keep previous list if offline/transient.
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Background poll for badge count even when closed.
  useEffect(() => {
    let active = true;
    const poll = async () => {
      try {
        const rows = await listDrafts({ includeArchived: false });
        if (active) onCountChange?.(rows.length);
      } catch {
        /* ignore */
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 30_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [onCountChange]);

  const dbs = useDraftDatabases(open, projectFilter !== "all" ? projectFilter : undefined);
  const dbAvailable = dbs.available !== false;
  const inDatabases = section === "databases" && dbAvailable;

  const projects = useMemo(() => {
    const set = new Set<string>();
    for (const d of drafts) {
      if (d.project_group) set.add(d.project_group);
    }
    for (const d of dbs.databases) {
      if (d.project_group) set.add(d.project_group);
    }
    return Array.from(set).sort();
  }, [drafts, dbs.databases]);

  const visibleDrafts = useMemo(
    () =>
      drafts.filter((d) => {
        if (showArchived ? !d.archived : d.archived) return false;
        if (projectFilter !== "all" && d.project_group !== projectFilter) return false;
        return true;
      }),
    [drafts, showArchived, projectFilter],
  );

  const selected = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId],
  );

  const openEditorFor = (draft: DraftInfo) => {
    setCreating(false);
    setSelectedId(draft.id);
    setMode("preview");
    setEditTitle(draft.title);
    setEditContent(draft.content);
    setEditProject(draft.project_group);
  };

  const startNewDraft = () => {
    setSelectedId(null);
    setCreating(true);
    setMode("edit");
    setEditTitle("");
    setEditContent("");
    setEditProject(projectFilter !== "all" ? projectFilter : defaultProjectGroup || "~");
  };

  const handleSave = async () => {
    const title = editTitle.trim();
    if (!title) return;
    setSaving(true);
    try {
      if (creating || !selected) {
        const created = await upsertDraft({
          title,
          content: editContent,
          project_group: editProject.trim() || "~",
          force_new: true,
        });
        setCreating(false);
        setSelectedId(created.id);
      } else {
        await updateDraft(selected.id, {
          title,
          content: editContent,
          project_group: editProject.trim() || "~",
        });
      }
      await refresh();
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async (draft: DraftInfo) => {
    try {
      await navigator.clipboard.writeText(draft.content);
      setCopiedId(draft.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === draft.id ? null : cur)), 1600);
    } catch {
      /* ignore */
    }
  };

  const handleTogglePin = async (draft: DraftInfo) => {
    await updateDraft(draft.id, { pinned: !draft.pinned });
    await refresh();
  };

  const handleToggleArchive = async (draft: DraftInfo) => {
    await updateDraft(draft.id, { archived: !draft.archived });
    if (selectedId === draft.id) setSelectedId(null);
    await refresh();
  };

  const handleDelete = async (draft: DraftInfo) => {
    await deleteDraft(draft.id);
    if (selectedId === draft.id) setSelectedId(null);
    await refresh();
  };

  if (!open) return null;

  const inDetail = !inDatabases && (creating || selected !== null);

  return (
    <div
      data-testid="drafts-drawer-backdrop"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(0, 0, 0, 0.48)",
        display: "flex",
        justifyContent: isCompact ? "stretch" : "flex-end",
        alignItems: isCompact ? "flex-end" : "stretch",
      }}
    >
      <div
        data-testid="drafts-drawer"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: "relative",
          width: isCompact
            ? "100%"
            : customWidth !== null
              ? `min(${customWidth}px, 95vw)`
              : wide || (inDatabases && dbOpen)
                ? "min(920px, 94vw)"
                : "min(540px, 92vw)",
          height: isCompact ? "86vh" : "100%",
          transition: resizing ? "none" : "width 160ms ease",
          background: colors.bg1,
          borderLeft: isCompact ? undefined : `1px solid ${colors.line}`,
          borderTop: isCompact ? `1px solid ${colors.line}` : undefined,
          borderRadius: isCompact ? "14px 14px 0 0" : 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          color: colors.fg0,
          fontFamily: "var(--font-sans)",
          userSelect: resizing ? "none" : undefined,
        }}
      >
        {/* Left-edge drag handle to resize drawer width */}
        {!isCompact && (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize drafts drawer"
            title="Drag to resize width · Double-click to reset"
            onMouseDown={startResize}
            onDoubleClick={resetWidth}
            onMouseEnter={() => setResizeHover(true)}
            onMouseLeave={() => setResizeHover(false)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 8,
              cursor: "col-resize",
              zIndex: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
            }}
          >
            <div
              style={{
                width: resizing || resizeHover ? 3 : 0,
                height: "100%",
                background: resizing ? colors.accent : colorAlpha.accentLine,
                transition: "width 120ms ease, background 120ms ease",
              }}
            />
          </div>
        )}
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            borderBottom: `1px solid ${colors.lineSoft}`,
            flexShrink: 0,
          }}
        >
          <FileText size={16} color={colors.accent} />
          <span style={{ fontWeight: 600, fontSize: rem(14), flex: 1 }}>
            Drafts · 草稿板
          </span>
          {!isCompact && (
            <button
              type="button"
              aria-label={wide ? "Narrow panel" : "Expand panel"}
              title={wide ? "Narrow panel" : "Expand panel for tables & diagrams"}
              onClick={() => {
                resetWidth();
                setWide((w) => !w);
              }}
              style={{
                width: 28,
                height: 28,
                borderRadius: 6,
                border: "none",
                background: "transparent",
                color: colors.fg2,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          )}
          {!inDatabases && (
          <button
            type="button"
            data-testid="drafts-new-btn"
            onClick={startNewDraft}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "5px 10px",
              borderRadius: 6,
              border: `1px solid ${colorAlpha.accentLine}`,
              background: colorAlpha.accentSoft,
              color: colors.accent,
              fontSize: rem(12),
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Plus size={13} />
            New
          </button>
          )}
          <button
            type="button"
            aria-label="Close drafts"
            onClick={onClose}
            style={{
              width: 28,
              height: 28,
              borderRadius: 6,
              border: "none",
              background: "transparent",
              color: colors.fg2,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Filter bar */}
        {!inDetail && !(inDatabases && dbOpen) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              padding: "8px 14px",
              borderBottom: `1px solid ${colors.lineSoft}`,
              overflowX: "auto",
              flexShrink: 0,
            }}
          >
            {dbAvailable && (
              <div
                style={{
                  display: "inline-flex",
                  borderRadius: 4,
                  border: `1px solid ${colors.line}`,
                  overflow: "hidden",
                  flexShrink: 0,
                  marginRight: 4,
                }}
              >
                {(["drafts", "databases"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    data-testid={`drafts-mode-${s}`}
                    onClick={() => setSection(s)}
                    style={{
                      minHeight: isCompact ? 36 : undefined,
                      padding: isCompact ? "0 12px" : "3px 10px",
                      border: "none",
                      borderLeft: s === "databases" ? `1px solid ${colors.line}` : "none",
                      background: section === s ? colorAlpha.accentSoft : colors.bg2,
                      color: section === s ? colors.accent : colors.fg2,
                      fontFamily: "var(--font-display)",
                      fontSize: rem(11.5),
                      cursor: "pointer",
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
            {!inDatabases && (
            <>
            <button
              type="button"
              onClick={() => setShowArchived(false)}
              style={{
                padding: "3px 9px",
                borderRadius: 999,
                border: `1px solid ${!showArchived ? colors.accent : colors.line}`,
                background: !showArchived ? colorAlpha.accentSoft : "transparent",
                color: !showArchived ? colors.accent : colors.fg2,
                fontSize: rem(11.5),
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Active
            </button>
            <button
              type="button"
              onClick={() => setShowArchived(true)}
              style={{
                padding: "3px 9px",
                borderRadius: 999,
                border: `1px solid ${showArchived ? colors.accent : colors.line}`,
                background: showArchived ? colorAlpha.accentSoft : "transparent",
                color: showArchived ? colors.accent : colors.fg2,
                fontSize: rem(11.5),
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              Archived
            </button>
            </>
            )}
            {!inDatabases && projects.length > 0 && (
              <span style={{ color: colors.line, margin: "0 2px" }}>|</span>
            )}
            {projects.length > 0 && (
              <button
                type="button"
                onClick={() => setProjectFilter("all")}
                style={{
                  padding: "3px 9px",
                  borderRadius: 999,
                  border: `1px solid ${projectFilter === "all" ? colors.fg1 : colors.lineSoft}`,
                  background: projectFilter === "all" ? colors.bg2 : "transparent",
                  color: projectFilter === "all" ? colors.fg0 : colors.fg2,
                  fontSize: rem(11.5),
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                All
              </button>
            )}
            {projects.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setProjectFilter((cur) => (cur === p ? "all" : p))}
                style={{
                  padding: "3px 9px",
                  borderRadius: 999,
                  border: `1px solid ${projectFilter === p ? colors.fg1 : colors.lineSoft}`,
                  background: projectFilter === p ? colors.bg2 : "transparent",
                  color: projectFilter === p ? colors.fg0 : colors.fg2,
                  fontSize: rem(11.5),
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {/* Body: Databases, or drafts List / Editor */}
        {inDatabases ? (
          <DatabasesPane
            databases={dbs.databases}
            loading={dbs.loading}
            error={dbs.error}
            defaultProject={projectFilter !== "all" ? projectFilter : defaultProjectGroup || "~"}
            compact={isCompact}
            onRefresh={dbs.refresh}
            openRequest={dbOpenRequest}
            onOpenChange={setDbOpen}
          />
        ) : inDetail ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              padding: 14,
              gap: 10,
              overflow: "hidden",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => {
                  setCreating(false);
                  setSelectedId(null);
                }}
                style={{
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${colors.line}`,
                  background: colors.bg2,
                  color: colors.fg1,
                  fontSize: rem(12),
                  cursor: "pointer",
                }}
              >
                ← Back
              </button>
              <input
                value={editProject}
                onChange={(e) => setEditProject(e.target.value)}
                placeholder="project"
                style={{
                  width: 110,
                  padding: "4px 8px",
                  borderRadius: 6,
                  border: `1px solid ${colors.line}`,
                  background: colors.bg0,
                  color: colors.fg1,
                  fontSize: rem(12),
                }}
              />
              <div style={{ flex: 1 }} />
              {selected && (
                <div
                  style={{
                    display: "inline-flex",
                    borderRadius: 6,
                    border: `1px solid ${colors.line}`,
                    overflow: "hidden",
                  }}
                >
                  <button
                    type="button"
                    data-testid="draft-mode-preview"
                    onClick={() => setMode("preview")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 8px",
                      border: "none",
                      background: mode === "preview" ? colorAlpha.accentSoft : colors.bg2,
                      color: mode === "preview" ? colors.accent : colors.fg2,
                      fontSize: rem(11.5),
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    <Eye size={12} />
                    Preview
                  </button>
                  <button
                    type="button"
                    data-testid="draft-mode-edit"
                    onClick={() => setMode("edit")}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 8px",
                      border: "none",
                      borderLeft: `1px solid ${colors.line}`,
                      background: mode === "edit" ? colorAlpha.accentSoft : colors.bg2,
                      color: mode === "edit" ? colors.accent : colors.fg2,
                      fontSize: rem(11.5),
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    <Pencil size={12} />
                    Edit
                  </button>
                </div>
              )}
              {selected && (
                <>
                  <ShareControl
                    kind="draft"
                    targetId={selected.id}
                    compact={isCompact}
                    onCreated={() => void refresh()}
                  />
                  <HistoryButton
                    draftId={selected.id}
                    currentTitle={selected.title}
                    compact={isCompact}
                    refreshKey={selected.updated_at}
                    onView={setViewing}
                  />
                  <button
                    type="button"
                    title="Copy content"
                    onClick={() => void handleCopy(selected)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "4px 8px",
                      borderRadius: 6,
                      border: `1px solid ${colors.line}`,
                      background: colors.bg2,
                      color: copiedId === selected.id ? colors.ok : colors.fg1,
                      fontSize: rem(12),
                      cursor: "pointer",
                    }}
                  >
                    {copiedId === selected.id ? <Check size={13} /> : <Copy size={13} />}
                    {copiedId === selected.id ? "Copied" : "Copy"}
                  </button>
                  {onSendToTerminal && (
                    <button
                      type="button"
                      title={
                        activeTerminalLabel
                          ? `Send to ${activeTerminalLabel}`
                          : "Send to active terminal"
                      }
                      onClick={() => {
                        onSendToTerminal(editContent);
                        onClose();
                      }}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "4px 8px",
                        borderRadius: 6,
                        border: `1px solid ${colorAlpha.accentLine}`,
                        background: colorAlpha.accentSoft,
                        color: colors.accent,
                        fontSize: rem(12),
                        cursor: "pointer",
                      }}
                    >
                      <Send size={13} />
                      Send
                    </button>
                  )}
                </>
              )}
            </div>

            {selected && viewing && !creating && (
              <VersionBanner
                draftId={selected.id}
                version={viewing}
                currentTitle={selected.title}
                compact={isCompact}
                onBack={() => setViewing(null)}
                onRestored={(d) => {
                  setViewing(null);
                  openEditorFor(d);
                  void refresh();
                }}
              />
            )}

            {(mode === "preview" || viewing) && !creating ? (
              <div
                data-testid="draft-artifact-preview"
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "12px 14px",
                  borderRadius: 8,
                  border: `1px solid ${colors.lineSoft}`,
                  background: colors.bg0,
                }}
              >
                <div
                  style={{
                    fontSize: rem(16),
                    fontWeight: 700,
                    color: colors.fg0,
                    marginBottom: 10,
                    paddingBottom: 8,
                    borderBottom: `1px solid ${colors.lineSoft}`,
                  }}
                >
                  {(viewing ? viewing.title : editTitle) || "(untitled)"}
                </div>
                <DraftArtifactPreview
                  content={viewing ? viewing.content : editContent}
                  projectGroup={editProject.trim() || undefined}
                  onOpenDatabase={(id, viewId) => {
                    setDbOpenRequest({ id, viewId, nonce: Date.now() });
                    setSection("databases");
                  }}
                />
              </div>
            ) : (
              <>
                <input
                  data-testid="draft-title-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  placeholder="Draft title…"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    border: `1px solid ${colors.line}`,
                    background: colors.bg0,
                    color: colors.fg0,
                    fontSize: rem(14),
                    fontWeight: 600,
                  }}
                />

                <textarea
                  data-testid="draft-content-input"
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="Write Markdown, GFM tables, ```mermaid diagrams, or ```svg / ```html artifacts…"
                  style={{
                    flex: 1,
                    resize: "none",
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${colors.line}`,
                    background: colors.bg0,
                    color: colors.fg0,
                    fontFamily: "var(--font-mono)",
                    fontSize: rem(13),
                    lineHeight: 1.55,
                  }}
                />
              </>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {selected && (
                <>
                  <button
                    type="button"
                    onClick={() => void handleTogglePin(selected)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "5px 9px",
                      borderRadius: 6,
                      border: `1px solid ${colors.line}`,
                      background: selected.pinned ? colorAlpha.accentSoft : colors.bg2,
                      color: selected.pinned ? colors.accent : colors.fg2,
                      fontSize: rem(12),
                      cursor: "pointer",
                    }}
                  >
                    <Pin size={13} />
                    {selected.pinned ? "Pinned" : "Pin"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleToggleArchive(selected)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "5px 9px",
                      borderRadius: 6,
                      border: `1px solid ${colors.line}`,
                      background: colors.bg2,
                      color: colors.fg2,
                      fontSize: rem(12),
                      cursor: "pointer",
                    }}
                  >
                    {selected.archived ? <RotateCcw size={13} /> : <Archive size={13} />}
                    {selected.archived ? "Restore" : "Archive"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(selected)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 4,
                      padding: "5px 9px",
                      borderRadius: 6,
                      border: `1px solid ${colors.line}`,
                      background: colors.bg2,
                      color: colors.err,
                      fontSize: rem(12),
                      cursor: "pointer",
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
              <div style={{ flex: 1 }} />
              <button
                type="button"
                data-testid="draft-save-btn"
                disabled={saving || !editTitle.trim()}
                onClick={() => void handleSave()}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "none",
                  background: colors.accent,
                  color: "#090a0c",
                  fontWeight: 700,
                  fontSize: rem(12.5),
                  cursor: saving || !editTitle.trim() ? "not-allowed" : "pointer",
                  opacity: saving || !editTitle.trim() ? 0.5 : 1,
                }}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              overflowY: "auto",
              padding: 12,
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {loading && drafts.length === 0 ? (
              <div style={{ color: colors.fg2, fontSize: rem(13), padding: 16 }}>
                Loading drafts…
              </div>
            ) : visibleDrafts.length === 0 ? (
              <div
                style={{
                  color: colors.fg2,
                  fontSize: rem(13),
                  padding: 20,
                  textAlign: "center",
                  lineHeight: 1.6,
                }}
              >
                {showArchived
                  ? "No archived drafts."
                  : "No drafts yet. Agents can write here anytime with:"}
                {!showArchived && (
                  <pre
                    style={{
                      marginTop: 10,
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: colors.bg0,
                      color: colors.fg1,
                      fontFamily: "var(--font-mono)",
                      fontSize: rem(11.5),
                      textAlign: "left",
                      overflowX: "auto",
                    }}
                  >
                    {`echo "..." | offdesk draft write "草稿标题"`}
                  </pre>
                )}
              </div>
            ) : (
              visibleDrafts.map((d) => (
                <div
                  key={d.id}
                  data-testid={`draft-card-${d.id}`}
                  onClick={() => openEditorFor(d)}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    border: `1px solid ${d.pinned ? colorAlpha.accentLine : colors.lineSoft}`,
                    background: colors.bg0,
                    cursor: "pointer",
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    {d.pinned && <Pin size={12} color={colors.accent} />}
                    <span
                      style={{
                        fontWeight: 600,
                        fontSize: rem(13.5),
                        color: colors.fg0,
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {d.title}
                    </span>
                    <span
                      style={{
                        fontSize: rem(11),
                        padding: "1px 6px",
                        borderRadius: 4,
                        background: colors.bg2,
                        color: colors.fg2,
                      }}
                    >
                      {d.project_group}
                    </span>
                    <span style={{ fontSize: rem(11), color: colors.fg2 }}>
                      {relativeTime(d.updated_at)}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: rem(12),
                      color: colors.fg2,
                      fontFamily: "var(--font-mono)",
                      display: "-webkit-box",
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: "vertical",
                      overflow: "hidden",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {d.content || "(empty)"}
                  </div>
                  <div
                    style={{ display: "flex", gap: 6, marginTop: 2 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      onClick={() => void handleCopy(d)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "3px 7px",
                        borderRadius: 5,
                        border: `1px solid ${colors.lineSoft}`,
                        background: colors.bg1,
                        color: copiedId === d.id ? colors.ok : colors.fg2,
                        fontSize: rem(11),
                        cursor: "pointer",
                      }}
                    >
                      {copiedId === d.id ? <Check size={11} /> : <Copy size={11} />}
                      {copiedId === d.id ? "Copied" : "Copy"}
                    </button>
                    {onSendToTerminal && (
                      <button
                        type="button"
                        onClick={() => {
                          onSendToTerminal(d.content);
                          onClose();
                        }}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "3px 7px",
                          borderRadius: 5,
                          border: `1px solid ${colors.lineSoft}`,
                          background: colors.bg1,
                          color: colors.fg2,
                          fontSize: rem(11),
                          cursor: "pointer",
                        }}
                      >
                        <Send size={11} />
                        Send
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleToggleArchive(d)}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "3px 7px",
                        borderRadius: 5,
                        border: `1px solid ${colors.lineSoft}`,
                        background: colors.bg1,
                        color: colors.fg2,
                        fontSize: rem(11),
                        cursor: "pointer",
                      }}
                    >
                      {d.archived ? <RotateCcw size={11} /> : <Archive size={11} />}
                      {d.archived ? "Restore" : "Done"}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
