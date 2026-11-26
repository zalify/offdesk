// The "databases" side of the drawer list: one card per database plus a
// "new database" form. Empty states say how databases get created.
import { useState } from "react";
import { Plus } from "lucide-react";

import { createDraftDatabase } from "@/lib/api";
import type { DraftDatabase } from "@/lib/api";
import { hubErrorMessage, relativeTime } from "@/lib/draftDatabases";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { MONO, fieldStyle, smallBtn } from "./ui.web";

export function DatabaseList({
  databases,
  loading,
  error,
  defaultProject,
  defaultSpaceId,
  compact,
  onOpen,
  onCreated,
}: {
  databases: DraftDatabase[];
  loading: boolean;
  error: string | null;
  defaultProject: string;
  defaultSpaceId?: string | null;
  compact: boolean;
  onOpen: (id: string) => void;
  onCreated: (db: DraftDatabase) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [project, setProject] = useState(defaultProject);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async () => {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    try {
      const db = await createDraftDatabase({
        name: n,
        project_group: project.trim() || "~",
        ...(defaultSpaceId ? { space_id: defaultSpaceId } : {}),
      });
      setCreating(false);
      setName("");
      setFormError(null);
      onCreated(db);
    } catch (err) {
      setFormError(hubErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 8, fontFamily: MONO }}>
      {creating ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderRadius: 6, border: `1px solid ${colors.line}`, background: colors.bg0 }}>
          <input
            autoFocus
            data-testid="draftdb-new-name"
            value={name}
            placeholder="database name"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              else if (e.key === "Escape") setCreating(false);
            }}
            style={fieldStyle(compact)}
          />
          <input
            data-testid="draftdb-new-project"
            value={project}
            placeholder="project"
            onChange={(e) => setProject(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            style={fieldStyle(compact)}
          />
          {formError && (
            <div role="alert" style={{ fontSize: rem(12), color: colors.err }}>
              {formError}
            </div>
          )}
          <div style={{ display: "flex", gap: 6 }}>
            <button type="button" data-testid="draftdb-new-submit" disabled={!name.trim() || busy} onClick={() => void submit()} style={{ ...smallBtn({ compact, active: true }), opacity: name.trim() ? 1 : 0.5 }}>
              {busy ? "creating…" : "create"}
            </button>
            <button type="button" onClick={() => setCreating(false)} style={smallBtn({ compact })}>
              cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            data-testid="draftdb-new"
            onClick={() => {
              setProject(defaultProject);
              setCreating(true);
            }}
            style={smallBtn({ compact, active: true })}
          >
            <Plus size={13} />
            new database
          </button>
        </div>
      )}

      {error && (
        <div role="alert" style={{ fontSize: rem(12), color: colors.err }}>
          {error}
        </div>
      )}

      {loading && databases.length === 0 ? (
        <div style={{ color: colors.fg2, fontSize: rem(13), padding: 16 }}>Loading databases…</div>
      ) : databases.length === 0 ? (
        <div style={{ color: colors.fg2, fontSize: rem(13), padding: 20, textAlign: "center", lineHeight: 1.6 }}>
          No databases yet. Create one here, or let an agent create it with:
          <pre style={{ marginTop: 10, padding: "8px 10px", borderRadius: 6, background: colors.bg0, color: colors.fg1, fontSize: rem(11.5), textAlign: "left", overflowX: "auto" }}>
            {`offdesk db create tasks`}
          </pre>
        </div>
      ) : (
        databases.map((d) => (
          <button
            key={d.id}
            type="button"
            data-testid={`draftdb-list-item-${d.id}`}
            onClick={() => onOpen(d.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              minHeight: compact ? 48 : 40,
              padding: "8px 12px",
              borderRadius: 6,
              border: `1px solid ${colors.lineSoft}`,
              background: colors.bg0,
              color: colors.fg0,
              fontFamily: MONO,
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <span style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: rem(13.5), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</span>
            <span style={{ fontSize: rem(11), padding: "1px 6px", borderRadius: 3, background: colors.bg2, color: colors.fg2 }}>{d.project_group}</span>
            <span style={{ fontSize: rem(11.5), color: colors.fg1, whiteSpace: "nowrap" }}>
              {d.row_count.toLocaleString()} {d.row_count === 1 ? "row" : "rows"}
            </span>
            <span style={{ fontSize: rem(11), color: colors.fg2, whiteSpace: "nowrap" }}>{relativeTime(d.updated_at)}</span>
          </button>
        ))
      )}
    </div>
  );
}
