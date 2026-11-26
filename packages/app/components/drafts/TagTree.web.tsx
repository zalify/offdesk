import { useCallback, useState } from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";

import { MONO } from "../draftdb/ui.web";
import { ellipsis } from "./chipStyle";
import { tagTestId, type TagNode } from "@/lib/draftTags";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";

const COLLAPSED_KEY = "offdesk:drafts-tag-collapsed";

function loadCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveCollapsed(set: Set<string>): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(Array.from(set)));
  } catch {
    // Storage may be blocked; the tree still works for this session.
  }
}

interface TagTreeProps {
  tree: TagNode[];
  projects: { name: string; count: number }[];
  totalCount: number;
  /** False on hubs that predate tags: only projects are listed. */
  tagsSupported: boolean;
  project: string | null;
  tag: string | null;
  compact: boolean;
  onSelectProject: (project: string | null) => void;
  onSelectTag: (tag: string | null) => void;
  onClear: () => void;
}

function sectionLabel(text: string) {
  return (
    <div
      style={{
        padding: "10px 8px 4px",
        fontFamily: MONO,
        fontSize: rem(10.5),
        letterSpacing: "0.04em",
        color: colors.fg2,
      }}
    >
      {text}
    </div>
  );
}

function Row(props: {
  label: string;
  count: number;
  depth?: number;
  selected: boolean;
  compact: boolean;
  testId: string;
  hasChildren?: boolean;
  collapsed?: boolean;
  toggleTestId?: string;
  onToggle?: () => void;
  onSelect: () => void;
}) {
  const h = props.compact ? 36 : 26;
  const depth = props.depth ?? 0;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        minHeight: h,
        paddingLeft: 2 + depth * 14,
        borderRadius: 4,
        background: props.selected ? colorAlpha.accentSoft : "transparent",
      }}
    >
      {props.hasChildren ? (
        <button
          type="button"
          data-testid={props.toggleTestId}
          aria-label={props.collapsed ? `Expand ${props.label}` : `Collapse ${props.label}`}
          aria-expanded={!props.collapsed}
          onClick={props.onToggle}
          style={{
            width: props.compact ? 36 : 20,
            height: h,
            flexShrink: 0,
            border: "none",
            background: "transparent",
            color: colors.fg2,
            cursor: "pointer",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
        >
          {props.collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        </button>
      ) : (
        <span style={{ width: props.compact ? 36 : 20, flexShrink: 0 }} />
      )}
      <button
        type="button"
        data-testid={props.testId}
        data-count={props.count}
        aria-pressed={props.selected}
        title={props.label}
        onClick={props.onSelect}
        style={{
          flex: 1,
          minWidth: 0,
          height: h,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 8px 0 2px",
          border: "none",
          background: "transparent",
          color: props.selected ? colors.accent : colors.fg1,
          fontFamily: MONO,
          fontSize: rem(12),
          textAlign: "left",
          cursor: "pointer",
        }}
      >
        <span style={{ ...ellipsis, flex: 1 }}>{props.label}</span>
        <span style={{ color: colors.fg2, fontSize: rem(11), flexShrink: 0 }}>{props.count}</span>
      </button>
    </div>
  );
}

export function TagTree({
  tree,
  projects,
  totalCount,
  tagsSupported,
  project,
  tag,
  compact,
  onSelectProject,
  onSelectTag,
  onClear,
}: TagTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggle = useCallback((key: string) => {
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsed(next);
      return next;
    });
  }, []);

  const selLower = tag?.toLowerCase() ?? null;
  const hasSelection = project !== null || tag !== null;

  const renderNodes = (nodes: TagNode[], depth: number) =>
    nodes.map((n) => {
      const hasChildren = n.children.length > 0;
      // A collapsed ancestor of the selected tag is shown open so the selection stays visible.
      const holdsSelection = selLower !== null && selLower.startsWith(`${n.key}/`);
      const isCollapsed = hasChildren && collapsed.has(n.key) && !holdsSelection;
      return (
        <div key={n.key}>
          <Row
            label={n.name}
            count={n.total}
            depth={depth}
            compact={compact}
            selected={selLower === n.key}
            testId={`drafts-tag-node-${tagTestId(n.path)}`}
            toggleTestId={`drafts-tag-toggle-${tagTestId(n.path)}`}
            hasChildren={hasChildren}
            collapsed={isCollapsed}
            onToggle={() => toggle(n.key)}
            onSelect={() => onSelectTag(selLower === n.key ? null : n.path)}
          />
          {hasChildren && !isCollapsed && renderNodes(n.children, depth + 1)}
        </div>
      );
    });

  return (
    <div data-testid="drafts-tag-tree" style={{ display: "flex", flexDirection: "column", paddingBottom: 8 }}>
      <Row
        label="all drafts"
        count={totalCount}
        compact={compact}
        selected={!hasSelection}
        testId="drafts-tag-all"
        onSelect={onClear}
      />
      {hasSelection && (
        <button
          type="button"
          data-testid="drafts-tag-clear"
          onClick={onClear}
          style={{
            alignSelf: "flex-start",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            minHeight: compact ? 36 : 22,
            margin: "2px 0 0 22px",
            padding: "0 6px",
            border: "none",
            background: "transparent",
            color: colors.fg2,
            fontFamily: MONO,
            fontSize: rem(11),
            cursor: "pointer",
          }}
        >
          <X size={11} />
          clear selection
        </button>
      )}

      {sectionLabel("projects")}
      {projects.length === 0 ? (
        <div style={{ padding: "2px 8px", fontSize: rem(11.5), color: colors.fg2 }}>none</div>
      ) : (
        projects.map((p) => (
          <Row
            key={p.name}
            label={p.name}
            count={p.count}
            compact={compact}
            selected={project === p.name}
            testId={`drafts-project-node-${p.name}`}
            onSelect={() => onSelectProject(project === p.name ? null : p.name)}
          />
        ))
      )}

      {tagsSupported && (
        <>
          {sectionLabel("tags")}
          {tree.length === 0 ? (
            <div
              data-testid="drafts-tag-empty"
              style={{ padding: "2px 8px", fontSize: rem(11.5), lineHeight: 1.5, color: colors.fg2 }}
            >
              Tags come from <code style={{ fontFamily: MONO }}>offdesk draft write --tag topic/sub</code> or{" "}
              <code style={{ fontFamily: MONO }}>#topic/sub</code> in the body.
            </div>
          ) : (
            renderNodes(tree, 0)
          )}
        </>
      )}
    </div>
  );
}
