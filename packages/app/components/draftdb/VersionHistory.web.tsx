// Version history for a draft (or a database row, which is a draft): a
// `history` button with a version list, plus the banner shown while one
// earlier version is being viewed.
import { useCallback, useEffect, useRef, useState } from "react";

import { getDraftVersion, listDraftVersions, restoreDraftVersion } from "@/lib/api";
import type { DraftInfo, DraftVersion, DraftVersionInfo } from "@/lib/api";
import { hubErrorMessage } from "@/lib/draftDatabases";
import { formatBytes, relativeAgo } from "@/lib/draftShares";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { MONO, Popover, Sheet, smallBtn } from "./ui.web";

export function HistoryButton({
  draftId,
  currentTitle,
  compact,
  refreshKey,
  onView,
}: {
  draftId: string;
  currentTitle: string;
  compact: boolean;
  /** Changes whenever the draft is saved, so the list is re-read on next open. */
  refreshKey?: number | string;
  onView: (version: DraftVersion) => void;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [versions, setVersions] = useState<DraftVersionInfo[] | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await listDraftVersions(draftId);
      setAvailable(list !== null);
      setVersions(list);
      setError(null);
    } catch (err) {
      setAvailable((a) => a ?? true);
      setError(hubErrorMessage(err));
    }
  }, [draftId]);

  useEffect(() => {
    setVersions(null);
    setOpen(false);
  }, [draftId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (available === false) return null;

  const select = async (id: string) => {
    setLoadingId(id);
    try {
      const v = await getDraftVersion(draftId, id);
      setOpen(false);
      onView(v);
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setLoadingId(null);
    }
  };

  const list = (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontFamily: MONO }}>
      {error && (
        <div role="alert" style={{ padding: "6px 10px", background: colorAlpha.dangerSoft, fontSize: rem(12), borderRadius: 4 }}>
          {error}
        </div>
      )}
      {versions && versions.length === 0 && (
        <div style={{ color: colors.fg2, fontSize: rem(12), padding: 6, lineHeight: 1.45 }}>
          No earlier versions yet — a version is saved each time this draft changes.
        </div>
      )}
      {(versions ?? []).map((v) => (
        <button
          key={v.id}
          type="button"
          data-testid={`draft-history-item-${v.id}`}
          disabled={loadingId !== null}
          onClick={() => void select(v.id)}
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            gap: 2,
            minHeight: compact ? 44 : 32,
            padding: "4px 8px",
            border: `1px solid ${colors.lineSoft}`,
            borderRadius: 4,
            background: colors.bg0,
            color: colors.fg0,
            fontFamily: MONO,
            fontSize: rem(12),
            textAlign: "left",
            cursor: "pointer",
            minWidth: 0,
          }}
        >
          <span>
            {relativeAgo(v.created_at)} <span style={{ color: colors.fg2 }}>· {formatBytes(v.size)}</span>
          </span>
          {v.title !== currentTitle && (
            <span style={{ color: colors.fg2, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {v.title || "(untitled)"}
            </span>
          )}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="draft-history-button"
        onClick={() => {
          setAnchor(btnRef.current);
          setOpen((o) => !o);
          void load();
        }}
        style={smallBtn({ compact, active: open })}
      >
        history
      </button>
      {open &&
        (compact ? (
          <Sheet title="Version history" onClose={() => setOpen(false)} testId="draft-history-panel">
            {list}
          </Sheet>
        ) : (
          <Popover anchor={anchor} onClose={() => setOpen(false)} width={300} testId="draft-history-panel">
            {list}
          </Popover>
        ))}
    </>
  );
}

export function VersionBanner({
  draftId,
  version,
  currentTitle,
  compact,
  onBack,
  onRestored,
}: {
  draftId: string;
  version: DraftVersion;
  currentTitle: string;
  compact: boolean;
  onBack: () => void;
  onRestored: (draft: DraftInfo) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restore = async () => {
    setBusy(true);
    setError(null);
    try {
      const draft = await restoreDraftVersion(draftId, version.id);
      onRestored(draft);
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="draft-history-banner"
      style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", borderRadius: 6, border: `1px solid ${colorAlpha.accentLine}`, background: colorAlpha.accentSoft, fontFamily: MONO, fontSize: rem(12), color: colors.fg0, flexShrink: 0 }}
    >
      <div>
        viewing version from {relativeAgo(version.created_at)}
        {version.title !== currentTitle && <span style={{ color: colors.fg2 }}> · titled “{version.title || "(untitled)"}”</span>}
      </div>
      {error && (
        <div role="alert" style={{ color: colors.err }}>
          {error}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button type="button" data-testid="draft-history-restore" disabled={busy} onClick={() => void restore()} style={{ ...smallBtn({ compact, active: true }), opacity: busy ? 0.6 : 1 }}>
          {busy ? "restoring…" : "restore this version"}
        </button>
        <button type="button" data-testid="draft-history-back" onClick={onBack} style={smallBtn({ compact })}>
          back to current
        </button>
      </div>
    </div>
  );
}
