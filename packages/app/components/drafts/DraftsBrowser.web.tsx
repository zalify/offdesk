import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search, Tag, X } from "lucide-react";

import { MONO, Popover, Sheet, fieldStyle, smallBtn } from "../draftdb/ui.web";
import { DraftCard } from "./DraftCard.web";
import { TagTree } from "./TagTree.web";
import { chipStyle, ellipsis } from "./chipStyle";
import { buildTagTree, filterDrafts, hubSupportsTags, projectCounts } from "@/lib/draftTags";
import type { DraftInfo } from "@/lib/api";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";

/** Drawer content width from which the tree becomes a left column. */
const WIDE_LAYOUT_MIN = 720;

interface DraftsBrowserProps {
  drafts: DraftInfo[];
  loading: boolean;
  showArchived: boolean;
  compact: boolean;
  project: string | null;
  tag: string | null;
  onProjectChange: (project: string | null) => void;
  onTagChange: (tag: string | null) => void;
  copiedId: string | null;
  onOpen: (draft: DraftInfo) => void;
  onCopy: (draft: DraftInfo) => void;
  onArchive: (draft: DraftInfo) => void;
  onSend?: (draft: DraftInfo) => void;
}

/** The drafts list: a tag/project tree for navigation beside (or behind a button above) a card stream. */
export function DraftsBrowser({
  drafts,
  loading,
  showArchived,
  compact,
  project,
  tag,
  onProjectChange,
  onTagChange,
  copiedId,
  onOpen,
  onCopy,
  onArchive,
  onSend,
}: DraftsBrowserProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [query, setQuery] = useState("");
  const [treeOpen, setTreeOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const closedAt = useRef(0);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w !== undefined) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const wide = !compact && width >= WIDE_LAYOUT_MIN;
  const tagsSupported = hubSupportsTags(drafts);

  // Drafts in scope: the Active / Archived toggle decides which side of the archive is shown.
  const scope = useMemo(() => drafts.filter((d) => (showArchived ? d.archived : !d.archived)), [drafts, showArchived]);
  const tree = useMemo(() => buildTagTree(scope), [scope]);
  const projects = useMemo(() => projectCounts(scope), [scope]);
  const visible = useMemo(() => filterDrafts(scope, { project, tag, query }), [scope, project, tag, query]);

  // Close the narrow tree when the layout switches to the wide column.
  useEffect(() => {
    if (wide) setTreeOpen(false);
  }, [wide]);

  const hasFilter = project !== null || tag !== null || query.trim() !== "";
  const clearAll = () => {
    onProjectChange(null);
    onTagChange(null);
    setQuery("");
  };

  const treeEl = (afterSelect?: () => void) => (
    <TagTree
      tree={tree}
      projects={projects}
      totalCount={scope.length}
      tagsSupported={tagsSupported}
      project={project}
      tag={tag}
      compact={compact}
      onSelectProject={(p) => {
        onProjectChange(p);
        afterSelect?.();
      }}
      onSelectTag={(t) => {
        onTagChange(t);
        afterSelect?.();
      }}
      onClear={() => {
        onProjectChange(null);
        onTagChange(null);
        afterSelect?.();
      }}
    />
  );

  const closeTree = () => {
    closedAt.current = Date.now();
    setTreeOpen(false);
  };

  const buttonLabel = tag !== null ? `#${tag}` : tagsSupported ? "tags" : "projects";

  const emptyState = () => {
    if (loading && drafts.length === 0) {
      return <div style={{ color: colors.fg2, fontSize: rem(13), padding: 16 }}>Loading drafts…</div>;
    }
    if (scope.length === 0) {
      return (
        <div style={{ color: colors.fg2, fontSize: rem(13), padding: 20, textAlign: "center", lineHeight: 1.6 }}>
          {showArchived ? "No archived drafts." : "No drafts yet. Agents can write here anytime with:"}
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
      );
    }
    return (
      <div style={{ color: colors.fg2, fontSize: rem(13), padding: 20, textAlign: "center", lineHeight: 1.8 }}>
        No drafts match.
        <div>
          <button type="button" data-testid="drafts-clear-filters" onClick={clearAll} style={smallBtn({ compact })}>
            clear filters
          </button>
        </div>
      </div>
    );
  };

  const filterChip = (kind: "project" | "tag", label: string, onRemove: () => void) => (
    <span
      key={kind}
      data-testid={`drafts-active-filter-${kind}`}
      style={{ ...chipStyle({ compact, active: true }), cursor: "default", paddingRight: 0 }}
    >
      <span style={ellipsis}>{label}</span>
      <button
        type="button"
        aria-label={`Remove ${kind} filter`}
        onClick={onRemove}
        style={{
          width: compact ? 36 : 20,
          height: compact ? 36 : 20,
          border: "none",
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
        }}
      >
        <X size={11} />
      </button>
    </span>
  );

  return (
    <div ref={rootRef} style={{ flex: 1, minHeight: 0, display: "flex", minWidth: 0 }}>
      {wide && (
        <div
          style={{
            width: 200,
            flexShrink: 0,
            overflowY: "auto",
            padding: "4px 6px",
            borderRight: `1px solid ${colors.lineSoft}`,
          }}
        >
          {treeEl()}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 12px 4px", flexShrink: 0 }}>
          {!wide && (
            <button
              type="button"
              ref={setAnchor}
              data-testid="drafts-tags-button"
              aria-expanded={treeOpen}
              onClick={() => {
                if (!treeOpen && Date.now() - closedAt.current < 250) return;
                setTreeOpen((o) => !o);
              }}
              style={{ ...smallBtn({ compact, active: tag !== null || project !== null }), maxWidth: "45%", minWidth: 0 }}
            >
              <Tag size={12} style={{ flexShrink: 0 }} />
              <span style={ellipsis}>{buttonLabel}</span>
            </button>
          )}
          <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
            <Search
              size={12}
              color={colors.fg2}
              style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}
            />
            <input
              data-testid="drafts-search-input"
              value={query}
              placeholder="search"
              aria-label="Search drafts"
              onChange={(e) => setQuery(e.target.value)}
              style={{ ...fieldStyle(compact), width: "100%", paddingLeft: 24 }}
            />
          </div>
          <span style={{ fontFamily: MONO, fontSize: rem(11), color: colors.fg2, flexShrink: 0 }}>
            {visible.length}
          </span>
        </div>

        {!wide && (project !== null || tag !== null) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "4px 12px", flexShrink: 0 }}>
            {project !== null && filterChip("project", project, () => onProjectChange(null))}
            {tag !== null && filterChip("tag", `#${tag}`, () => onTagChange(null))}
          </div>
        )}

        <div
          style={{
            flex: 1,
            overflowY: "auto",
            padding: 12,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            minHeight: 0,
          }}
        >
          {visible.length === 0
            ? emptyState()
            : visible.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  compact={compact}
                  copied={copiedId === d.id}
                  selectedTag={tag}
                  onOpen={() => onOpen(d)}
                  onSelectTag={(t) => onTagChange(t)}
                  onCopy={() => onCopy(d)}
                  onArchive={() => onArchive(d)}
                  onSend={onSend ? () => onSend(d) : undefined}
                />
              ))}
        </div>
      </div>

      {treeOpen && !wide && compact && (
        <Sheet title={tagsSupported ? "tags & projects" : "projects"} onClose={closeTree} testId="drafts-tag-sheet">
          {treeEl(closeTree)}
        </Sheet>
      )}
      {treeOpen && !wide && !compact && (
        <Popover anchor={anchor} onClose={closeTree} width={260} testId="drafts-tag-popover">
          {treeEl(closeTree)}
        </Popover>
      )}
    </div>
  );
}
