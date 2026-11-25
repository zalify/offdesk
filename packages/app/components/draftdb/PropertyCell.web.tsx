// One editable property value, shared by table cells and the row page.
import { useEffect, useRef, useState } from "react";

import type { DraftDbColumn, DraftDbRow, DraftDbValue } from "@/lib/api";
import { matchingOptions, parseCellInput, toggleInList } from "@/lib/draftDatabases";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";
import { OptionChip, optionColor } from "./chips.web";
import { MONO, Popover, fieldStyle, isLinkable, openExternalLink, smallBtn } from "./ui.web";

interface PropertyCellProps {
  /** null edits the row title. */
  column: DraftDbColumn | null;
  row: Pick<DraftDbRow, "id" | "title" | "properties">;
  compact: boolean;
  /** Row-page variant: bordered, wraps, taller. */
  field?: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
  /** Title commits a string; properties commit the coerced value (null clears). */
  onCommit: (value: DraftDbValue) => void;
  invalid?: boolean;
  testId?: string;
}

function asList(v: DraftDbValue | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v) return [v];
  return [];
}

export function PropertyCell(props: PropertyCellProps) {
  const { column, row, compact, field, editing, onStartEdit, onEndEdit, onCommit, invalid, testId } = props;
  const type = column?.type ?? "title";
  const value: DraftDbValue | undefined = column ? row.properties[column.id] : row.title;
  const wrapRef = useRef<HTMLDivElement>(null);

  const wrapStyle: React.CSSProperties = {
    width: "100%",
    height: field ? undefined : "100%",
    minHeight: field ? (compact ? 40 : 30) : undefined,
    boxSizing: "border-box",
    padding: field ? "4px 8px" : "0 8px",
    display: "flex",
    alignItems: "center",
    flexWrap: field ? "wrap" : "nowrap",
    gap: 4,
    overflow: "hidden",
    cursor: type === "checkbox" ? "default" : "text",
    fontFamily: MONO,
    fontSize: rem(13),
    color: colors.fg0,
    border: field ? `1px solid ${invalid ? colors.err : colors.lineSoft}` : undefined,
    borderRadius: field ? 4 : undefined,
    outline: !field && invalid ? `1px solid ${colors.err}` : undefined,
    outlineOffset: -1,
  };

  if (type === "checkbox") {
    const checked = value === true;
    return (
      // The whole cell toggles; the box inside is the keyboard / screen-reader stop.
      <div ref={wrapRef} data-testid={testId} onClick={() => onCommit(!checked)} style={{ ...wrapStyle, cursor: "pointer" }}>
        <button
          type="button"
          role="checkbox"
          aria-checked={checked}
          aria-label={column?.name}
          style={{
            width: compact ? 36 : 22,
            height: compact ? 36 : 22,
            margin: compact ? "0 0 0 -8px" : 0,
            padding: 0,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <span
            style={{
              width: 16,
              height: 16,
              borderRadius: 3,
              border: `1px solid ${checked ? colors.accent : colors.fg3}`,
              background: checked ? colors.accent : "transparent",
              color: colors.onAccent,
              fontSize: 12,
              lineHeight: "14px",
              textAlign: "center",
            }}
          >
            {checked ? "✓" : ""}
          </span>
        </button>
      </div>
    );
  }

  if (type === "select" || type === "multi_select") {
    const list = asList(value);
    return (
      <>
        <div
          ref={wrapRef}
          data-testid={testId}
          onClick={editing ? undefined : onStartEdit}
          style={{ ...wrapStyle, outline: editing ? `1px solid ${colors.accent}` : wrapStyle.outline, outlineOffset: -1 }}
        >
          {list.map((o) => (
            <OptionChip key={o} name={o} color={optionColor(column, o)} />
          ))}
        </div>
        {editing && column && (
          <OptionPicker
            column={column}
            multi={type === "multi_select"}
            initial={list}
            compact={compact}
            anchor={wrapRef.current}
            onCommit={onCommit}
            onClose={onEndEdit}
          />
        )}
      </>
    );
  }

  if (editing && type === "date") {
    return (
      <div ref={wrapRef} data-testid={testId} style={wrapStyle}>
        <DateEditor
          initial={typeof value === "string" ? value.slice(0, 10) : ""}
          compact={compact}
          onPick={(v) => {
            onCommit(v === "" ? null : v);
            onEndEdit();
          }}
          onClose={onEndEdit}
        />
      </div>
    );
  }

  if (editing) {
    return (
      <div ref={wrapRef} data-testid={testId} style={{ ...wrapStyle, padding: 0 }}>
        <TextEditor
          type={type}
          initial={value === undefined || value === null ? "" : String(value)}
          compact={compact}
          onCommit={(v) => onCommit(v)}
          onClose={onEndEdit}
        />
      </div>
    );
  }

  const text = value === undefined || value === null ? "" : String(value);
  return (
    <div ref={wrapRef} data-testid={testId} onClick={onStartEdit} style={wrapStyle}>
      {type === "url" && text && isLinkable(text) ? (
        <a
          href={text}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openExternalLink(text);
          }}
          style={{ color: colors.accent, textDecoration: "underline", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: field ? "normal" : "nowrap", minHeight: compact ? 36 : undefined, display: "inline-flex", alignItems: "center" }}
        >
          {text}
        </a>
      ) : (
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: field ? "pre-wrap" : "nowrap", color: type === "title" && !text ? colors.fg3 : undefined }}>
          {type === "title" && !text ? "(untitled)" : text}
        </span>
      )}
    </div>
  );
}

function TextEditor({
  type,
  initial,
  compact,
  onCommit,
  onClose,
}: {
  type: DraftDbColumn["type"] | "title";
  initial: string;
  compact: boolean;
  onCommit: (v: DraftDbValue) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [bad, setBad] = useState(false);
  const done = useRef(false);

  const finish = (commit: boolean) => {
    if (done.current) return;
    if (!commit || text === initial) {
      done.current = true;
      onClose();
      return;
    }
    const parsed = parseCellInput(type, text);
    if (parsed === undefined || (type === "title" && text.trim() === "")) {
      setBad(true);
      return;
    }
    done.current = true;
    onCommit(type === "title" ? text.trim() : parsed);
    onClose();
  };

  return (
    <input
      autoFocus
      value={text}
      inputMode={type === "number" ? "decimal" : type === "url" ? "url" : "text"}
      enterKeyHint="done"
      onChange={(e) => {
        setText(e.target.value);
        setBad(false);
      }}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => {
        if (bad) {
          done.current = true;
          onClose();
        } else finish(true);
      }}
      style={{
        ...fieldStyle(compact),
        width: "100%",
        height: "100%",
        minHeight: compact ? 36 : 26,
        borderRadius: 0,
        border: `1px solid ${bad ? colors.err : colors.accent}`,
      }}
    />
  );
}

function DateEditor({
  initial,
  compact,
  onPick,
  onClose,
}: {
  initial: string;
  compact: boolean;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    try {
      ref.current?.showPicker?.();
    } catch {
      // showPicker needs a user gesture in some browsers; the field still works.
    }
  }, []);
  return (
    <input
      ref={ref}
      type="date"
      autoFocus
      defaultValue={initial}
      onChange={(e) => onPick(e.target.value)}
      onBlur={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      style={{ ...fieldStyle(compact), width: "100%", colorScheme: "dark light" }}
    />
  );
}

function OptionPicker({
  column,
  multi,
  initial,
  compact,
  anchor,
  onCommit,
  onClose,
}: {
  column: DraftDbColumn;
  multi: boolean;
  initial: string[];
  compact: boolean;
  anchor: HTMLElement | null;
  onCommit: (v: DraftDbValue) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const [query, setQuery] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const closed = useRef(false);

  const close = (commit: boolean) => {
    if (closed.current) return;
    closed.current = true;
    if (commit && multi) {
      const cur = selectedRef.current;
      const same = cur.length === initial.length && cur.every((x, i) => x === initial[i]);
      if (!same) onCommit(cur.length === 0 ? null : cur);
    }
    onClose();
  };

  const pick = (name: string) => {
    if (multi) {
      setSelected((s) => toggleInList(s, name));
      setQuery("");
      return;
    }
    closed.current = true;
    onCommit(name);
    onClose();
  };

  const options = matchingOptions(column, query);
  const trimmed = query.trim();
  const canCreate =
    trimmed !== "" && !(column.options ?? []).some((o) => o.name.toLowerCase() === trimmed.toLowerCase());
  const rowStyle = (on: boolean): React.CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    minHeight: compact ? 40 : 28,
    padding: "0 8px",
    border: "none",
    borderRadius: 4,
    background: on ? colorAlpha.accentSoft : "transparent",
    color: on ? colors.accent : colors.fg0,
    fontFamily: MONO,
    fontSize: rem(12.5),
    textAlign: "left",
    cursor: "pointer",
  });

  return (
    <Popover anchor={anchor} onClose={() => close(true)} testId="draftdb-option-picker">
      <input
        autoFocus
        value={query}
        placeholder={multi ? "find or add option" : "find or add option"}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && trimmed) {
            const exact = (column.options ?? []).find((o) => o.name.toLowerCase() === trimmed.toLowerCase());
            pick(exact ? exact.name : trimmed);
          } else if (e.key === "Escape") close(false);
        }}
        style={{ ...fieldStyle(compact), width: "100%", marginBottom: 6 }}
      />
      {options.map((name) => (
        <button key={name} type="button" onClick={() => pick(name)} style={rowStyle(selected.includes(name))}>
          <span style={{ width: 12 }}>{selected.includes(name) ? "✓" : ""}</span>
          {name}
        </button>
      ))}
      {canCreate && (
        <button type="button" onClick={() => pick(trimmed)} style={rowStyle(false)}>
          <span style={{ width: 12 }}>+</span>
          new option “{trimmed}”
        </button>
      )}
      {options.length === 0 && !canCreate && (
        <div style={{ padding: "6px 8px", color: colors.fg2 }}>No options yet. Type a name to add one.</div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 6, justifyContent: "space-between" }}>
        <button
          type="button"
          onClick={() => {
            closed.current = true;
            onCommit(null);
            onClose();
          }}
          style={smallBtn({ compact })}
        >
          clear
        </button>
        {multi && (
          <button type="button" onClick={() => close(true)} style={smallBtn({ compact, active: true })}>
            done
          </button>
        )}
      </div>
    </Popover>
  );
}
