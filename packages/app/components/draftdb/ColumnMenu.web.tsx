// Column header menu (rename / hide / options / delete) and the "+" add-column popover.
import { useState } from "react";

import type { DraftDbColumn, DraftDbColumnType } from "@/lib/api";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { MONO, Popover, fieldStyle, smallBtn } from "./ui.web";

export const COLUMN_TYPES: DraftDbColumnType[] = ["text", "number", "select", "multi_select", "date", "checkbox", "url"];

export function ColumnMenu({
  column,
  anchor,
  compact,
  onClose,
  onRename,
  onHide,
  onDelete,
  onOptions,
}: {
  column: DraftDbColumn;
  anchor: HTMLElement | null;
  compact: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onHide: () => void;
  onDelete: () => void;
  onOptions: (options: NonNullable<DraftDbColumn["options"]>) => void;
}) {
  const [name, setName] = useState(column.name);
  const [confirm, setConfirm] = useState(false);
  const [newOption, setNewOption] = useState("");
  const options = column.options ?? [];
  const hasOptions = column.type === "select" || column.type === "multi_select";

  return (
    <Popover anchor={anchor} onClose={onClose} width={260} testId={`draftdb-column-menu-${column.id}`}>
      <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
        <input
          value={name}
          aria-label="Column name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim() && name.trim() !== column.name) {
              onRename(name.trim());
              onClose();
            }
          }}
          style={{ ...fieldStyle(compact), flex: 1 }}
        />
        <button
          type="button"
          disabled={!name.trim() || name.trim() === column.name}
          onClick={() => {
            onRename(name.trim());
            onClose();
          }}
          style={{ ...smallBtn({ compact }), opacity: !name.trim() || name.trim() === column.name ? 0.5 : 1 }}
        >
          rename
        </button>
      </div>
      <div style={{ color: colors.fg2, fontSize: rem(11), padding: "0 2px 6px" }}>type: {column.type}</div>
      {hasOptions && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: colors.fg2, fontSize: rem(11), padding: "2px" }}>options</div>
          {options.map((o) => (
            <div key={o.name} style={{ display: "flex", alignItems: "center", padding: "0 2px", minHeight: compact ? 36 : 24 }}>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{o.name}</span>
              <button
                type="button"
                aria-label={`Remove option ${o.name}`}
                onClick={() => onOptions(options.filter((x) => x.name !== o.name))}
                style={{ ...smallBtn({ compact }), border: "none", background: "transparent" }}
              >
                ×
              </button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input
              value={newOption}
              placeholder="new option"
              onChange={(e) => setNewOption(e.target.value)}
              onKeyDown={(e) => {
                const n = newOption.trim();
                if (e.key === "Enter" && n && !options.some((o) => o.name.toLowerCase() === n.toLowerCase())) {
                  onOptions([...options, { name: n }]);
                  setNewOption("");
                }
              }}
              style={{ ...fieldStyle(compact), flex: 1 }}
            />
            <button
              type="button"
              disabled={!newOption.trim()}
              onClick={() => {
                const n = newOption.trim();
                if (n && !options.some((o) => o.name.toLowerCase() === n.toLowerCase())) {
                  onOptions([...options, { name: n }]);
                  setNewOption("");
                }
              }}
              style={smallBtn({ compact })}
            >
              add
            </button>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 6, justifyContent: "space-between" }}>
        <button
          type="button"
          onClick={() => {
            onHide();
            onClose();
          }}
          style={smallBtn({ compact })}
        >
          hide in this view
        </button>
        {confirm ? (
          <button
            type="button"
            data-testid={`draftdb-column-delete-confirm-${column.id}`}
            onClick={() => {
              onDelete();
              onClose();
            }}
            style={smallBtn({ compact, danger: true })}
          >
            confirm delete
          </button>
        ) : (
          <button type="button" onClick={() => setConfirm(true)} style={smallBtn({ compact, danger: true })}>
            delete
          </button>
        )}
      </div>
      {confirm && (
        <div style={{ color: colors.warn, fontSize: rem(11), padding: "6px 2px 0" }}>
          Deleting “{column.name}” drops it from every view; stored values are no longer shown.
        </div>
      )}
    </Popover>
  );
}

export function AddColumnPopover({
  anchor,
  compact,
  onClose,
  onCreate,
}: {
  anchor: HTMLElement | null;
  compact: boolean;
  onClose: () => void;
  onCreate: (name: string, type: DraftDbColumnType) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<DraftDbColumnType>("text");
  const submit = () => {
    if (!name.trim()) return;
    onCreate(name.trim(), type);
    onClose();
  };
  return (
    <Popover anchor={anchor} onClose={onClose} width={260} testId="draftdb-add-column-popover">
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <input
          autoFocus
          value={name}
          placeholder="column name"
          data-testid="draftdb-add-column-name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          style={fieldStyle(compact)}
        />
        <select value={type} data-testid="draftdb-add-column-type" onChange={(e) => setType(e.target.value as DraftDbColumnType)} style={fieldStyle(compact)}>
          {COLUMN_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button type="button" data-testid="draftdb-add-column-submit" disabled={!name.trim()} onClick={submit} style={{ ...smallBtn({ compact, active: true }), opacity: name.trim() ? 1 : 0.5 }}>
          add column
        </button>
      </div>
    </Popover>
  );
}
