// "share" action: create / list / revoke public links for a draft, a database
// row (a row is a draft) or the open database view.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { createDraftShare, listDraftShares, revokeDraftShare } from "@/lib/api";
import type { DraftShare } from "@/lib/api";
import { hubErrorMessage } from "@/lib/draftDatabases";
import { EXPIRY_OPTIONS, expiryLabel, relativeAgo, summarizeAssets, truncateMiddle } from "@/lib/draftShares";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { MONO, Popover, Sheet, fieldStyle, openExternalLink, smallBtn } from "./ui.web";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function ShareControl({
  kind,
  targetId,
  viewId,
  compact,
  onCreated,
}: {
  kind: "draft" | "database";
  targetId: string;
  /** Database shares: the currently open view. */
  viewId?: string;
  compact: boolean;
  /** Called after a share is created (sharing pins a draft, so callers refresh it). */
  onCreated?: () => void;
}) {
  const [shares, setShares] = useState<DraftShare[] | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await listDraftShares(targetId);
      setAvailable(list !== null);
      setShares(list);
    } catch {
      // Transient failure: keep whatever we had and leave the button usable.
      setAvailable((a) => a ?? true);
    }
  }, [targetId]);

  useEffect(() => {
    setShares(null);
    setOpen(false);
    void load();
  }, [load]);

  if (available === false) return null;
  const active = (shares?.length ?? 0) > 0;

  const panel = (
    <SharePanel
      kind={kind}
      targetId={targetId}
      viewId={viewId}
      compact={compact}
      shares={shares ?? []}
      reload={load}
      onCreated={onCreated}
    />
  );

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="draft-share-button"
        aria-label={active ? "Share (link active)" : "Share"}
        onClick={() => {
          setAnchor(btnRef.current);
          setOpen((o) => !o);
        }}
        style={smallBtn({ compact, active: open })}
      >
        share
        {active && (
          <span
            data-testid="draft-share-marker"
            style={{ width: 6, height: 6, borderRadius: 999, background: colors.accent, display: "inline-block" }}
          />
        )}
      </button>
      {open &&
        (compact ? (
          <Sheet title="Share" onClose={() => setOpen(false)} testId="draft-share-panel">
            {panel}
          </Sheet>
        ) : (
          <Popover anchor={anchor} onClose={() => setOpen(false)} width={380} testId="draft-share-panel">
            {panel}
          </Popover>
        ))}
    </>
  );
}

function SharePanel({
  kind,
  targetId,
  viewId,
  compact,
  shares,
  reload,
  onCreated,
}: {
  kind: "draft" | "database";
  targetId: string;
  viewId?: string;
  compact: boolean;
  shares: DraftShare[];
  reload: () => Promise<void>;
  onCreated?: () => void;
}) {
  const [mode, setMode] = useState<"snapshot" | "live">(kind === "database" ? "live" : "snapshot");
  const [expiryIdx, setExpiryIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<DraftShare | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [revokeConfirm, setRevokeConfirm] = useState<string | null>(null);

  const flashCopied = (id: string) => {
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const days = EXPIRY_OPTIONS[expiryIdx].days;
      const share = await createDraftShare({
        kind,
        target_id: targetId,
        ...(kind === "draft" ? { mode } : { mode: "live" as const, ...(viewId ? { view_id: viewId } : {}) }),
        ...(days !== null ? { expires_in_days: days } : {}),
      });
      setCreated(share);
      if (await copyToClipboard(share.url)) flashCopied(share.id);
      await reload();
      onCreated?.();
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setBusy(true);
    setError(null);
    try {
      await revokeDraftShare(id);
      setRevokeConfirm(null);
      if (created?.id === id) setCreated(null);
      await reload();
    } catch (err) {
      setError(hubErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const muted: CSSProperties = { color: colors.fg2, fontSize: rem(11.5), lineHeight: 1.45 };
  const modeBtn = (m: "snapshot" | "live"): CSSProperties => ({
    ...smallBtn({ compact, active: mode === m }),
    flex: 1,
  });

  // The just-created share may not be in the list yet; keep it visible at the top.
  const rows = created && !shares.some((s) => s.id === created.id) ? [created, ...shares] : shares;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, fontFamily: MONO, minWidth: 0 }}>
      {error && (
        <div role="alert" data-testid="draft-share-error" style={{ padding: "6px 10px", background: colorAlpha.dangerSoft, fontSize: rem(12), borderRadius: 4, overflowWrap: "anywhere" }}>
          {error}
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((s) => {
            const fresh = created?.id === s.id;
            const summary = fresh ? summarizeAssets(created.assets) : null;
            return (
              <div
                key={s.id}
                data-testid={`draft-share-item-${s.id}`}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                  padding: 8,
                  borderRadius: 6,
                  border: `1px solid ${fresh ? colorAlpha.accentLine : colors.lineSoft}`,
                  background: fresh ? colorAlpha.accentSoft : colors.bg0,
                  minWidth: 0,
                }}
              >
                <div style={{ ...muted, display: "flex", flexWrap: "wrap", gap: "2px 8px" }}>
                  <span style={{ color: colors.fg0 }}>{s.mode}</span>
                  <span>created {relativeAgo(s.created_at)}</span>
                  <span>{expiryLabel(s.expires_at)}</span>
                  {kind === "database" && viewId && s.view_id && s.view_id !== viewId && <span>other view</span>}
                </div>
                <div
                  data-testid={`draft-share-url-${s.id}`}
                  data-url={s.url}
                  title={s.url}
                  onCopy={(e) => {
                    // The visible text is truncated; copy the full URL.
                    e.clipboardData.setData("text/plain", s.url);
                    e.preventDefault();
                  }}
                  style={{ fontSize: rem(12), color: colors.fg0, userSelect: "all", overflow: "hidden", whiteSpace: "nowrap", minWidth: 0 }}
                >
                  {truncateMiddle(s.url, compact ? 38 : 46)}
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button type="button" data-testid={`draft-share-copy-${s.id}`} onClick={async () => { if (await copyToClipboard(s.url)) flashCopied(s.id); }} style={smallBtn({ compact })}>
                    {copiedId === s.id ? "copied" : "copy link"}
                  </button>
                  <button type="button" data-testid={`draft-share-open-${s.id}`} onClick={() => openExternalLink(s.url)} style={smallBtn({ compact })}>
                    open
                  </button>
                  {revokeConfirm === s.id ? (
                    <>
                      <button type="button" data-testid={`draft-share-revoke-confirm-${s.id}`} disabled={busy} onClick={() => void revoke(s.id)} style={smallBtn({ compact, danger: true })}>
                        confirm revoke
                      </button>
                      <button type="button" onClick={() => setRevokeConfirm(null)} style={smallBtn({ compact })}>
                        cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" data-testid={`draft-share-revoke-${s.id}`} onClick={() => setRevokeConfirm(s.id)} style={smallBtn({ compact, danger: true })}>
                      revoke
                    </button>
                  )}
                </div>
                {summary && summary.total > 0 && (
                  <div data-testid="draft-share-assets" style={{ ...muted, display: "flex", flexDirection: "column", gap: 3 }}>
                    <span style={{ color: colors.fg1 }}>{summary.headline}</span>
                    {summary.failed.length > 0 && (
                      <>
                        <span style={{ color: colors.err }}>
                          {summary.failed.length} failed. These images will show as placeholders in the shared page.
                        </span>
                        {summary.failed.map((f, i) => (
                          <span key={`${f.source}-${i}`} style={{ overflowWrap: "anywhere" }}>
                            {f.source}: {f.reason}
                          </span>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: rows.length > 0 ? 8 : 0, borderTop: rows.length > 0 ? `1px solid ${colors.lineSoft}` : "none" }}>
        {kind === "draft" ? (
          <>
            <div style={{ display: "flex", gap: 6 }}>
              <button type="button" data-testid="draft-share-mode-snapshot" onClick={() => setMode("snapshot")} style={modeBtn("snapshot")}>
                snapshot
              </button>
              <button type="button" data-testid="draft-share-mode-live" onClick={() => setMode("live")} style={modeBtn("live")}>
                live
              </button>
            </div>
            <div style={muted}>
              {mode === "snapshot"
                ? "Snapshot: a frozen copy of what is here now. Later edits do not show up."
                : "Live: always shows the latest version of this draft."}
            </div>
          </>
        ) : (
          <div style={muted}>
            The link is live and read-only, and limited to this view&apos;s filters and visible columns.
          </div>
        )}
        <label style={{ ...muted, display: "flex", alignItems: "center", gap: 8 }}>
          expires
          <select
            data-testid="draft-share-expiry"
            value={expiryIdx}
            onChange={(e) => setExpiryIdx(Number(e.target.value))}
            style={{ ...fieldStyle(compact), flex: 1 }}
          >
            {EXPIRY_OPTIONS.map((o, i) => (
              <option key={o.label} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div style={{ ...muted, color: colors.warn }}>
          Anyone with the link can view this without signing in.
        </div>
        <button type="button" data-testid="draft-share-create" disabled={busy} onClick={() => void create()} style={{ ...smallBtn({ compact, active: true }), opacity: busy ? 0.6 : 1 }}>
          {busy ? "working…" : "create link"}
        </button>
      </div>
    </div>
  );
}
