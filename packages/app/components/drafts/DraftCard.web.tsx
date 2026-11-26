import { useMemo } from "react";
import { Archive, Check, Copy, Pin, RotateCcw, Send } from "lucide-react";
import type { KeyboardEvent } from "react";

import { chipStyle, ellipsis } from "./chipStyle";
import { excerptFromMarkdown, relativeTime } from "@/lib/draftTags";
import type { DraftInfo } from "@/lib/api";
import { colors, colorAlpha } from "@/lib/colors";
import { rem } from "@/lib/rem";

const MAX_CHIPS = 5;

interface DraftCardProps {
  draft: DraftInfo;
  compact: boolean;
  copied: boolean;
  selectedTag: string | null;
  onOpen: () => void;
  onSelectTag: (tag: string) => void;
  onCopy: () => void;
  onArchive: () => void;
  onSend?: () => void;
}

function actionBtn(compact: boolean, color: string) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    minHeight: compact ? 36 : undefined,
    padding: compact ? "0 12px" : "3px 7px",
    borderRadius: 5,
    border: `1px solid ${colors.lineSoft}`,
    background: colors.bg1,
    color,
    fontSize: rem(11),
    cursor: "pointer",
  } as const;
}

export function DraftCard({
  draft: d,
  compact,
  copied,
  selectedTag,
  onOpen,
  onSelectTag,
  onCopy,
  onArchive,
  onSend,
}: DraftCardProps) {
  // Plain text only: cards never render markdown, mermaid or artifacts.
  const excerpt = useMemo(() => excerptFromMarkdown(d.content), [d.content]);
  const tags = d.tags ?? [];
  const inline = useMemo(() => new Set((d.inline_tags ?? []).map((t) => t.toLowerCase())), [d.inline_tags]);
  const shown = tags.slice(0, MAX_CHIPS);
  const hidden = tags.length - shown.length;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      data-testid={`draft-card-${d.id}`}
      role="article"
      tabIndex={0}
      aria-label={d.title}
      onClick={onOpen}
      onKeyDown={onKeyDown}
      style={{
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${d.pinned ? colorAlpha.accentLine : colors.lineSoft}`,
        background: colors.bg0,
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minWidth: 0,
        flexShrink: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        {d.pinned && <Pin size={12} color={colors.accent} style={{ flexShrink: 0 }} />}
        <span
          style={{
            ...ellipsis,
            fontWeight: 600,
            fontSize: rem(13.5),
            color: colors.fg0,
            flex: 1,
          }}
        >
          {d.title}
        </span>
        {d.archived && (
          <span
            style={{
              fontFamily: "var(--font-display)",
              fontSize: rem(10.5),
              color: colors.fg2,
              border: `1px solid ${colors.lineSoft}`,
              borderRadius: 4,
              padding: "0 5px",
              flexShrink: 0,
            }}
          >
            archived
          </span>
        )}
        <span style={{ fontSize: rem(11), padding: "1px 6px", borderRadius: 4, background: colors.bg2, color: colors.fg2, ...ellipsis, maxWidth: "35%", flexShrink: 1 }}>
          {d.project_group}
        </span>
        <span style={{ fontSize: rem(11), color: colors.fg2, flexShrink: 0 }}>{relativeTime(d.updated_at)}</span>
      </div>
      <div
        style={{
          fontSize: rem(12),
          color: colors.fg2,
          lineHeight: 1.5,
          display: "-webkit-box",
          WebkitLineClamp: 3,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          overflowWrap: "anywhere",
        }}
      >
        {excerpt || "(empty)"}
      </div>
      {tags.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {shown.map((t) => (
            <button
              key={t}
              type="button"
              data-testid={`draft-card-tag-${d.id}-${t}`}
              title={inline.has(t.toLowerCase()) ? `#${t} (from the body)` : `#${t}`}
              onClick={(e) => { e.stopPropagation(); onSelectTag(t); }}
              style={chipStyle({
                compact,
                inline: inline.has(t.toLowerCase()),
                active: selectedTag?.toLowerCase() === t.toLowerCase(),
              })}
            >
              <span style={ellipsis}>#{t}</span>
            </button>
          ))}
          {hidden > 0 && (
            <span style={{ fontSize: rem(11), color: colors.fg2, alignSelf: "center" }}>+{hidden}</span>
          )}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 2, flexWrap: "wrap" }}>
        <button type="button" onClick={(e) => { e.stopPropagation(); onCopy(); }} style={actionBtn(compact, copied ? colors.ok : colors.fg2)}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy"}
        </button>
        {onSend && (
          <button type="button" onClick={(e) => { e.stopPropagation(); onSend(); }} style={actionBtn(compact, colors.fg2)}>
            <Send size={11} />
            Send
          </button>
        )}
        <button type="button" onClick={(e) => { e.stopPropagation(); onArchive(); }} style={actionBtn(compact, colors.fg2)}>
          {d.archived ? <RotateCcw size={11} /> : <Archive size={11} />}
          {d.archived ? "Restore" : "Done"}
        </button>
      </div>
    </div>
  );
}
