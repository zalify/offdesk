// A row opened as a page: editable title, the properties, and the markdown
// body with the same preview/edit toggle the drafts drawer uses.
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, Eye, Pencil } from "lucide-react";

import { getDraftDbRow, patchDraftDbRow } from "@/lib/api";
import type { DraftDatabase, DraftDbRowFull, DraftDbValue, DraftVersion } from "@/lib/api";
import { applyRowPatch, hubErrorMessage, revertRow } from "@/lib/draftDatabases";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { DraftArtifactPreview } from "../DraftArtifactPreview.web";
import { PropertyCell } from "./PropertyCell.web";
import { MONO, smallBtn } from "./ui.web";
import { ShareControl } from "./ShareControl.web";
import { HistoryButton, VersionBanner } from "./VersionHistory.web";

const REFRESH_MS = 5000;

export function RowPage({
  db,
  rowId,
  compact,
  onBack,
  onDbChanged,
}: {
  db: DraftDatabase;
  rowId: string;
  compact: boolean;
  onBack: () => void;
  onDbChanged: () => void;
}) {
  const [row, setRow] = useState<DraftDbRowFull | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<{ columnId: string; message: string } | null>(null);
  const [editingCol, setEditingCol] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [savingBody, setSavingBody] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<DraftVersion | null>(null);
  const writes = useRef(0);
  const focused = useRef(false);
  const rowRef = useRef(row);
  rowRef.current = row;
  const contentDirty = useRef(false);
  contentDirty.current = content !== savedContent;

  const load = useCallback(async () => {
    try {
      const fresh = await getDraftDbRow(db.id, rowId);
      setLoadError(null);
      setRow(fresh);
      // Never clobber unsaved body text with a poll.
      if (!contentDirty.current) {
        setContent(fresh.content);
        setSavedContent(fresh.content);
      }
    } catch (err) {
      if (!rowRef.current) setLoadError(hubErrorMessage(err));
    }
  }, [db.id, rowId]);

  useEffect(() => {
    setRow(null);
    setViewing(null);
    void load();
  }, [load]);

  // Agents may be editing this row through the CLI; poll unless a field has focus.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (editingCol !== null || focused.current || writes.current > 0) return;
      void load();
    }, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [load, editingCol]);

  const commit = async (columnId: string, patch: { title?: string; properties?: Record<string, DraftDbValue> }) => {
    const cur = rowRef.current;
    if (!cur) return;
    const snapshot = cur;
    setRow({ ...cur, ...applyRowPatch(cur, patch) });
    writes.current += 1;
    try {
      const full = await patchDraftDbRow(db.id, rowId, patch);
      setRow((r) => (r ? { ...full, content: r.content } : full));
      setError(null);
      onDbChanged();
    } catch (err) {
      setRow({ ...snapshot, ...revertRow(snapshot) });
      setError({ columnId, message: hubErrorMessage(err) });
    } finally {
      writes.current -= 1;
    }
  };

  const saveBody = async () => {
    setSavingBody(true);
    try {
      const full = await patchDraftDbRow(db.id, rowId, { content });
      setRow(full);
      setSavedContent(full.content);
      setContent(full.content);
      setBodyError(null);
      onDbChanged();
    } catch (err) {
      setBodyError(hubErrorMessage(err));
    } finally {
      setSavingBody(false);
    }
  };

  const goBack = () => {
    if (contentDirty.current && !window.confirm("Discard unsaved changes to the body?")) return;
    onBack();
  };

  const dirty = content !== savedContent;
  const label: React.CSSProperties = { fontFamily: MONO, fontSize: rem(11.5), color: colors.fg2 };

  return (
    <div
      data-testid="draftdb-row-page"
      onFocusCapture={() => {
        focused.current = true;
      }}
      onBlurCapture={() => {
        focused.current = false;
      }}
      style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", fontFamily: MONO, color: colors.fg0 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "8px 12px", borderBottom: `1px solid ${colors.lineSoft}`, flexShrink: 0 }}>
        <button type="button" data-testid="draftdb-row-back" onClick={goBack} style={smallBtn({ compact })}>
          <ChevronLeft size={13} />
          {db.name}
        </button>
        <div style={{ flex: 1 }} />
        <ShareControl kind="draft" targetId={rowId} compact={compact} />
        <HistoryButton
          draftId={rowId}
          currentTitle={row?.title ?? ""}
          compact={compact}
          refreshKey={`${row?.updated_at ?? ""}`}
          onView={setViewing}
        />
        <div style={{ display: "inline-flex", borderRadius: 4, border: `1px solid ${colors.line}`, overflow: "hidden" }}>
          {(["preview", "edit"] as const).map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`draftdb-row-mode-${m}`}
              onClick={() => setMode(m)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                minHeight: compact ? 36 : 26,
                padding: "0 10px",
                border: "none",
                borderLeft: m === "edit" ? `1px solid ${colors.line}` : "none",
                background: mode === m ? colorAlpha.accentSoft : colors.bg2,
                color: mode === m ? colors.accent : colors.fg2,
                fontFamily: MONO,
                fontSize: rem(12),
                cursor: "pointer",
              }}
            >
              {m === "preview" ? <Eye size={12} /> : <Pencil size={12} />}
              {m}
            </button>
          ))}
        </div>
      </div>

      {!row ? (
        <div role={loadError ? "alert" : undefined} style={{ padding: 16, color: colors.fg2, fontSize: rem(13) }}>
          {loadError ?? "Loading row…"}
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <PropertyCell
              column={null}
              row={row}
              compact={compact}
              field
              editing={editingCol === "title"}
              onStartEdit={() => setEditingCol("title")}
              onEndEdit={() => setEditingCol((c) => (c === "title" ? null : c))}
              onCommit={(v) => void commit("title", { title: String(v) })}
              invalid={error?.columnId === "title"}
              testId="draftdb-row-title"
            />
          </div>

          {error && (
            <div role="alert" data-testid="draftdb-row-error" style={{ padding: "6px 10px", background: colorAlpha.dangerSoft, fontSize: rem(12), borderRadius: 4 }}>
              {error.message}
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "140px 1fr", gap: compact ? "10px 0" : "8px 12px", alignItems: "start" }}>
            {db.columns.map((c) => (
              <div key={c.id} style={{ display: "contents" }}>
                <div style={{ ...label, paddingTop: compact ? 0 : 8 }}>{c.name}</div>
                <PropertyCell
                  column={c}
                  row={row}
                  compact={compact}
                  field
                  editing={editingCol === c.id}
                  onStartEdit={() => setEditingCol(c.id)}
                  onEndEdit={() => setEditingCol((cur) => (cur === c.id ? null : cur))}
                  onCommit={(v) => void commit(c.id, { properties: { [c.id]: v } })}
                  invalid={error?.columnId === c.id}
                  testId={`draftdb-row-prop-${c.id}`}
                />
              </div>
            ))}
            {db.columns.length === 0 && <div style={{ ...label, gridColumn: "1 / -1" }}>This database has no property columns yet.</div>}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8, minHeight: 200 }}>
            {viewing && (
              <VersionBanner
                draftId={rowId}
                version={viewing}
                currentTitle={row.title}
                compact={compact}
                onBack={() => setViewing(null)}
                onRestored={() => {
                  setViewing(null);
                  // Restored content replaces the body, even over unsaved text.
                  void getDraftDbRow(db.id, rowId).then((fresh) => {
                    setRow(fresh);
                    setContent(fresh.content);
                    setSavedContent(fresh.content);
                    onDbChanged();
                  });
                }}
              />
            )}
            {mode === "preview" || viewing ? (
              <div
                data-testid="draftdb-row-body-preview"
                style={{ padding: "12px 14px", borderRadius: 8, border: `1px solid ${colors.lineSoft}`, background: colors.bg0, fontFamily: "var(--font-sans)" }}
              >
                {(viewing ? viewing.content : content).trim() ? (
                  <DraftArtifactPreview content={viewing ? viewing.content : content} />
                ) : (
                  <div style={{ ...label, fontFamily: MONO }}>No body yet. Switch to edit to write markdown.</div>
                )}
              </div>
            ) : (
              <>
                <textarea
                  data-testid="draftdb-row-body-input"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  placeholder="Write Markdown, GFM tables, ```mermaid diagrams, or ```svg / ```html artifacts…"
                  style={{
                    minHeight: 260,
                    resize: "vertical",
                    padding: 10,
                    borderRadius: 8,
                    border: `1px solid ${colors.line}`,
                    background: colors.bg0,
                    color: colors.fg0,
                    fontFamily: "var(--font-mono)",
                    fontSize: compact ? "16px" : rem(13),
                    lineHeight: 1.55,
                  }}
                />
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button
                    type="button"
                    data-testid="draftdb-row-save-body"
                    disabled={!dirty || savingBody}
                    onClick={() => void saveBody()}
                    style={{ ...smallBtn({ compact, active: true }), opacity: dirty && !savingBody ? 1 : 0.5 }}
                  >
                    {savingBody ? "saving…" : "save body"}
                  </button>
                  {dirty && <span style={label}>unsaved changes</span>}
                </div>
              </>
            )}
            {bodyError && (
              <div role="alert" style={{ padding: "6px 10px", background: colorAlpha.dangerSoft, fontSize: rem(12), borderRadius: 4 }}>
                {bodyError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
