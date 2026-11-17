import { useLayoutEffect, useRef, useState } from "react";
import type { DirEntry } from "@offdesk/shared";
import { colors } from "@/lib/colors";
import { renameSelectionEnd } from "@/lib/fileActions";
import { rem } from "@/lib/rem";

/**
 * The inline name field of a row or tile. Enter commits, Escape cancels, blur
 * commits. `onCommit` resolves to an error message when the name was refused;
 * the field then stays open for another try.
 */
export function FileRenameInput({
  entry,
  onCommit,
  onCancel,
  centered = false,
  touch = false,
}: {
  entry: DirEntry;
  onCommit: (entry: DirEntry, name: string) => Promise<string | null>;
  onCancel: () => void;
  centered?: boolean;
  /** Phone: 16px text (no iOS zoom on focus) and a 40px field. */
  touch?: boolean;
}) {
  const [value, setValue] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement | null>(null);
  // Set once the edit ended (committed or cancelled) so blur does not repeat it.
  const done = useRef(false);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(0, renameSelectionEnd(entry.name, entry.is_dir));
  }, [entry.name, entry.is_dir]);

  const commit = async (fromBlur: boolean) => {
    if (done.current) return;
    const name = value.trim();
    if (fromBlur && name === "") {
      done.current = true;
      onCancel();
      return;
    }
    done.current = true;
    const message = await onCommit(entry, name);
    if (message === null) return;
    // Refused: keep editing.
    done.current = false;
    setError(message);
    ref.current?.focus();
  };

  return (
    <input
      ref={ref}
      data-testid="file-browser-rename-input"
      aria-label={`Rename ${entry.name}`}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      value={value}
      onChange={(event) => {
        setValue(event.target.value);
        setError(null);
      }}
      onBlur={() => void commit(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          void commit(false);
        } else if (event.key === "Escape") {
          // Prevented so the overlay's window-level Escape leaves it open.
          event.preventDefault();
          done.current = true;
          onCancel();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      style={{
        flex: 1,
        minWidth: 0,
        width: centered ? "100%" : undefined,
        height: touch ? 40 : 24,
        padding: "0 6px",
        fontFamily: "var(--font-display)",
        fontSize: touch ? rem(16) : rem(13),
        textAlign: centered ? "center" : "left",
        color: colors.fg0,
        background: colors.bg0,
        border: `1px solid ${error ? colors.danger : colors.primary}`,
        borderRadius: 3,
        outline: "none",
      }}
    />
  );
}
