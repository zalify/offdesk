import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { KeyboardEvent } from "react";

import { MONO, fieldStyle } from "../draftdb/ui.web";
import { chipStyle, ellipsis } from "./chipStyle";
import { addExplicitTag, explicitTags, suggestTags, tagTestId } from "@/lib/draftTags";
import { colors } from "@/lib/colors";
import { rem } from "@/lib/rem";

interface TagEditorProps {
  tags: string[];
  inlineTags: string[];
  /** Every known tag path, for type-ahead. */
  allPaths: string[];
  compact: boolean;
  /** Saves the new EXPLICIT set. Rejects on failure (the caller reverts the optimistic change). */
  onChange: (explicit: string[]) => Promise<void>;
}

export function TagEditor({ tags, inlineTags, allPaths, compact, onChange }: TagEditorProps) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);

  const explicit = useMemo(() => explicitTags(tags, inlineTags), [tags, inlineTags]);
  const inlineSet = useMemo(() => new Set(inlineTags.map((t) => t.toLowerCase())), [inlineTags]);
  const suggestions = useMemo(
    () => (focused && text.trim() ? suggestTags(allPaths, text, tags) : []),
    [focused, text, allPaths, tags],
  );

  const save = async (next: string[]) => {
    setBusy(true);
    setError(null);
    try {
      await onChange(next);
    } catch (e) {
      setError(`Could not save tags: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (raw: string) => {
    const result = addExplicitTag(explicit, tags, raw);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setText("");
    setActive(-1);
    await save(result.explicit);
  };

  const remove = async (tag: string) => {
    await save(explicit.filter((t) => t.toLowerCase() !== tag.toLowerCase()));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === "ArrowUp" && suggestions.length > 0) {
      e.preventDefault();
      setActive((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.nativeEvent.isComposing) return;
      void submit(active >= 0 && suggestions[active] ? suggestions[active] : text);
    } else if (e.key === "Escape" && text) {
      e.preventDefault();
      e.stopPropagation();
      setText("");
      setError(null);
    }
  };

  const hasInline = tags.some((t) => inlineSet.has(t.toLowerCase()));

  return (
    <div data-testid="draft-tag-editor" style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        {tags.map((t) => {
          const isInline = inlineSet.has(t.toLowerCase());
          return (
            <span
              key={t}
              data-testid={`draft-tag-chip-${t}`}
              data-inline={isInline ? "true" : undefined}
              title={isInline ? `#${t} comes from the body; edit the text to remove it` : `#${t}`}
              style={{ ...chipStyle({ compact, inline: isInline }), cursor: "default" }}
            >
              <span style={ellipsis}>#{t}</span>
              {!isInline && (
                <button
                  type="button"
                  data-testid={`draft-tag-remove-${t}`}
                  aria-label={`Remove tag ${t}`}
                  disabled={busy}
                  onClick={() => void remove(t)}
                  style={{
                    width: compact ? 36 : 18,
                    height: compact ? 36 : 18,
                    margin: compact ? "-4px -10px -4px -4px" : "0 -3px 0 0",
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: colors.fg2,
                    cursor: busy ? "default" : "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </span>
          );
        })}
        <div style={{ position: "relative", flex: "1 1 140px", minWidth: 120, maxWidth: 260 }}>
          <input
            data-testid="draft-tag-input"
            value={text}
            readOnly={busy}
            placeholder="+ add tag  (topic/sub)"
            aria-label="Add tag"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(e) => {
              setText(e.target.value);
              setActive(-1);
              if (error) setError(null);
            }}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            style={{ ...fieldStyle(compact), width: "100%" }}
          />
          {suggestions.length > 0 && (
            <div
              role="listbox"
              data-testid="draft-tag-suggestions"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "100%",
                marginTop: 2,
                zIndex: 5,
                background: colors.bg1,
                border: `1px solid ${colors.line}`,
                borderRadius: 4,
                boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
                padding: 3,
              }}
            >
              {suggestions.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-testid={`draft-tag-suggestion-${tagTestId(s)}`}
                  // mousedown (not click) so the input keeps focus and the pick lands before blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    void submit(s);
                  }}
                  style={{
                    display: "block",
                    width: "100%",
                    minHeight: compact ? 36 : 24,
                    padding: "0 8px",
                    border: "none",
                    borderRadius: 3,
                    background: i === active ? colors.bg2 : "transparent",
                    color: colors.fg1,
                    fontFamily: MONO,
                    fontSize: rem(12),
                    textAlign: "left",
                    cursor: "pointer",
                    ...ellipsis,
                  }}
                >
                  #{s}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {error && (
        <div
          role="alert"
          data-testid="draft-tag-error"
          style={{ fontFamily: MONO, fontSize: rem(11.5), color: colors.err }}
        >
          {error}
        </div>
      )}
      {hasInline && (
        <div style={{ fontSize: rem(11), color: colors.fg2, lineHeight: 1.4 }}>
          Dashed tags come from <code style={{ fontFamily: MONO }}>#tags</code> in the body; edit the text to remove them.
        </div>
      )}
    </div>
  );
}
