// Command palette (⌃B k) — Phase 2 D1 shell. Centered overlay with a fuzzy
// filter, arrow-key + Enter navigation, and mouse support. Rows are supplied
// by TerminalCanvas; `switchHost` / `sessionSwitcher` prefix actions open it
// pre-filtered to the hosts / tabs sections.

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import { AgentMarker } from "./Primitives.web";
import { rem } from "@/lib/rem";

export type PaletteSection = "terminals" | "actions" | "tabs" | "hosts";
export type PaletteFilter = "all" | "terminals" | "tabs" | "hosts";

export interface PaletteRow {
  id: string;
  section: PaletteSection;
  label: string;
  // Right-aligned binding hint (formatPrefixBinding output), when any.
  hint?: string;
  // Extra text the fuzzy filter matches on (e.g. machine name, cwd).
  keywords?: string;
  // Muted text after the label: a tab's programs, a machine's os.
  meta?: string;
  // Set when an agent opened a terminal in this tab: the opener's label
  // ("" when it gave none) — rendered as the `⌁ opened by agent` chip.
  opener?: string;
  // Highlighted when an agent in this terminal needs confirmation/attention.
  waiting?: boolean;
  // Machines only: the status dot.
  online?: boolean;
  disabled?: boolean;
  // Optional speculative pre-warm callback fired after the row stays
  // highlighted for ~120ms.
  onHighlight?: () => void;
  action: () => void;
}

interface CommandPaletteProps {
  rows: PaletteRow[];
  filter?: PaletteFilter;
  onClose: () => void;
}

// Case-insensitive subsequence match ("nt" matches "New terminal").
function fuzzyMatch(query: string, text: string): boolean {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  let i = 0;
  for (const char of haystack) {
    if (char === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return needle.length === 0;
}

export function CommandPalette({
  rows,
  filter = "all",
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const visibleRows = useMemo(() => {
    const trimmed = query.trim();
    const orderMap = trimmed ? SEARCH_SECTION_ORDER : SECTION_ORDER;
    const sectioned = (
      filter === "all" ? rows : rows.filter((row) => row.section === filter)
    )
      // Grouped under their section titles.
      .map((row, order) => ({ row, order }))
      .sort((a, b) => orderMap[a.row.section] - orderMap[b.row.section] || a.order - b.order)
      .map(({ row }) => row);
    if (!trimmed) return sectioned;
    return sectioned.filter((row) =>
      fuzzyMatch(trimmed, `${row.label} ${row.keywords ?? ""} ${row.meta ?? ""}`),
    );
  }, [rows, filter, query]);

  // Keep the highlight on the first row whenever the result set changes.
  useEffect(() => {
    setSelectedIndex(0);
  }, [visibleRows.length, query, filter]);

  // Speculative pre-warm: when a terminal or tab row stays highlighted for
  // 120ms (hover or arrow navigation), mount its group ahead of Enter/click.
  const highlightedRow = visibleRows[selectedIndex];
  useEffect(() => {
    const onHighlight = highlightedRow?.onHighlight;
    if (!onHighlight || highlightedRow?.disabled) return;
    const timer = window.setTimeout(onHighlight, 120);
    return () => window.clearTimeout(timer);
  }, [highlightedRow]);

  const runRow = (row: PaletteRow | undefined) => {
    if (!row || row.disabled) return;
    onClose();
    row.action();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (visibleRows.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next =
        (selectedIndex + delta + visibleRows.length) % visibleRows.length;
      setSelectedIndex(next);
      listRef.current
        ?.querySelector(`[data-palette-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      runRow(visibleRows[selectedIndex]);
    }
  };

  return (
    <div
      data-testid="command-palette"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 70,
        background: colorAlpha.overlay,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: 120,
      }}
    >
      <div
        className="odk-float"
        role="dialog"
        aria-label="Command palette"
        style={{
          width: "calc(100% - 48px)",
          maxWidth: 600,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "0 18px",
            borderBottom: `1px solid ${colors.lineSoft}`,
          }}
        >
          <span aria-hidden="true" style={{ color: colors.accent, fontSize: rem(15), fontWeight: 500 }}>:</span>
          <input
            ref={inputRef}
            data-testid="command-palette-input"
            aria-label="Command"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="type a command or search…"
            spellCheck={false}
            style={{
              flex: 1,
              minWidth: 0,
              height: 52,
              boxSizing: "border-box",
              background: "transparent",
              border: "none",
              outline: "none",
              color: colors.fg0,
              fontFamily: "var(--font-display)",
              fontSize: rem(15),
              padding: 0,
            }}
          />
          <span style={{ fontSize: rem(11), color: colors.fg3 }}>esc</span>
        </div>
        <div
          ref={listRef}
          style={{
            maxHeight: "50vh",
            overflowY: "auto",
            padding: 8,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {visibleRows.length === 0 && (
            <div style={{ padding: "14px", color: colors.fg3, fontSize: rem(12), textAlign: "center" }}>
              no matching commands
            </div>
          )}
          {visibleRows.map((row, index) => {
            const selected = index === selectedIndex;
            const header = index === 0 || visibleRows[index - 1].section !== row.section;
            return (
              <Fragment key={row.id}>
                {header && (
                  <div
                    style={{
                      padding: index === 0 ? "8px 12px 4px" : "10px 12px 4px",
                      fontSize: rem(11.5),
                      fontWeight: 500,
                      color: colors.fg3,
                    }}
                  >
                    {SECTION_TITLES[row.section]}
                  </div>
                )}
                <button
                  type="button"
                  data-testid={`command-palette-row-${row.id}`}
                  data-palette-index={index}
                  disabled={row.disabled}
                  onClick={() => runRow(row)}
                  onMouseEnter={() => setSelectedIndex(index)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    width: "100%",
                    border: "none",
                    borderRadius: 3,
                    background: selected ? colors.primary : "transparent",
                    color: selected ? colors.onPrimary : row.disabled ? colors.fg3 : colors.fg0,
                    fontFamily: "var(--font-display)",
                    fontSize: rem(13.5),
                    fontWeight: selected ? 600 : 400,
                    textAlign: "left",
                    padding: "8px 12px",
                    minHeight: 36,
                    cursor: row.disabled ? "default" : "pointer",
                    opacity: row.disabled && !selected ? 0.6 : 1,
                  }}
                >
                  {row.online !== undefined ? (
                    <span
                      role="img"
                      aria-label={row.online ? "Online" : "Offline"}
                      style={{ width: 9, flexShrink: 0, color: selected ? colors.onPrimary : row.online ? colors.ok : colors.fg3 }}
                    >
                      ●
                    </span>
                  ) : (
                    <span aria-hidden="true" style={{ width: 9, flexShrink: 0 }}>{selected ? "❯" : ""}</span>
                  )}
                  <span style={{ ...truncateStyle, flex: 1 }}>{row.label}</span>
                  {row.waiting && (
                    <span
                      style={{
                        fontSize: rem(11),
                        fontWeight: 600,
                        padding: "1px 6px",
                        borderRadius: 3,
                        background: selected ? colorAlpha.overlay : colorAlpha.warningSubtle,
                        color: selected ? colors.onPrimary : colors.accent,
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      waiting
                    </span>
                  )}
                  {row.opener !== undefined && (
                    <AgentMarker
                      label={row.opener}
                      style={selected ? { borderColor: colors.onPrimary, color: colors.onPrimary } : undefined}
                    />
                  )}
                  {row.meta && (
                    <span style={{ fontSize: rem(12), color: selected ? colors.onPrimary : colors.fg3, whiteSpace: "nowrap", flexShrink: 0 }}>
                      {row.meta}
                    </span>
                  )}
                  {row.hint && (
                    <span
                      style={{
                        color: selected ? colors.onPrimary : colors.fg3,
                        fontWeight: 400,
                        fontSize: rem(12),
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {row.hint}
                    </span>
                  )}
                </button>
              </Fragment>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const SECTION_TITLES: Record<PaletteSection, string> = {
  terminals: "terminals",
  actions: "actions",
  tabs: "tabs",
  hosts: "machines",
};

const SECTION_ORDER: Record<PaletteSection, number> = {
  actions: 0,
  terminals: 1,
  tabs: 2,
  hosts: 3,
};

const SEARCH_SECTION_ORDER: Record<PaletteSection, number> = {
  terminals: 0,
  tabs: 1,
  actions: 2,
  hosts: 3,
};

const truncateStyle: CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
