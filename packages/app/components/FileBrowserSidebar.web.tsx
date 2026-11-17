import { useMemo } from "react";
import type { DragEvent } from "react";
import "./FileBrowser.css";
import { Folder, Home, X } from "lucide-react";
import { colors } from "@/lib/colors";
import { basename } from "@/lib/fileManager";
import { rem } from "@/lib/rem";

export interface Place {
  key: string;
  label: string;
  path: string;
  kind: "home" | "terminal" | "pinned";
}

/** Home, then the cwds of open terminals, then pinned folders (deduplicated). */
export function buildPlaces(homeDir: string | undefined, terminalCwds: string[], pinned: string[]): Place[] {
  const out: Place[] = [{ key: "home", label: "Home", path: "~", kind: "home" }];
  const seen = new Set<string>(["~", ...(homeDir ? [homeDir] : [])]);
  for (const cwd of terminalCwds) {
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    out.push({ key: `t:${cwd}`, label: basename(cwd), path: cwd, kind: "terminal" });
  }
  for (const p of pinned) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push({ key: `p:${p}`, label: basename(p), path: p, kind: "pinned" });
  }
  return out;
}

/**
 * Desktop-only favourites: Home, the cwds of this machine's open terminals,
 * then user-pinned folders (unpin on hover). The active location is
 * highlighted.
 */
export function FileBrowserSidebar({
  path,
  homeDir,
  terminalCwds,
  pinned,
  onGo,
  onUnpin,
  placeDrop,
  dropHover,
}: {
  path: string;
  homeDir?: string;
  terminalCwds: string[];
  pinned: string[];
  onGo: (path: string) => void;
  onUnpin: (path: string) => void;
  /** Places accept dropped rows (move) and files (upload). */
  placeDrop?: (path: string) => {
    onDragOver: (event: DragEvent<HTMLElement>) => void;
    onDragLeave: (event: DragEvent<HTMLElement>) => void;
    onDrop: (event: DragEvent<HTMLElement>) => void;
  };
  dropHover?: string | null;
}) {
  const places = useMemo(() => buildPlaces(homeDir, terminalCwds, pinned), [homeDir, terminalCwds, pinned]);

  const isActive = (place: Place) =>
    place.path === path || (place.kind === "home" && !!homeDir && path === homeDir);

  return (
    <nav
      aria-label="Favorites"
      data-testid="file-browser-sidebar"
      style={{
        flex: "0 0 180px",
        minHeight: 0,
        overflowY: "auto",
        padding: "12px 8px",
        borderRight: `1px solid ${colors.lineSoft}`,
        background: colors.bg0,
        fontFamily: "var(--font-display)",
      }}
    >
      <div
        style={{
          padding: "0 10px 6px",
          fontSize: rem(11),
          letterSpacing: "0.04em",
          textTransform: "lowercase",
          color: colors.fg3,
        }}
      >
        favorites
      </div>
      {places.map((place) => {
        const active = isActive(place);
        const Icon = place.kind === "home" ? Home : Folder;
        return (
          <div
            key={place.key}
            className="odk-fb-place"
            data-drop={dropHover === `place:${place.path}` ? "true" : undefined}
            {...placeDrop?.(place.path)}
            style={{ position: "relative", display: "flex", alignItems: "center" }}
          >
            <button
              type="button"
              data-testid="file-browser-place"
              data-path={place.path}
              data-active={active ? "true" : "false"}
              title={place.path === "~" ? "Home" : place.path}
              onClick={() => onGo(place.path)}
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 8,
                height: 30,
                padding: "0 10px",
                border: "none",
                borderRadius: 3,
                background: active ? colors.bg3 : "transparent",
                color: active ? colors.fg0 : colors.fg1,
                fontFamily: "var(--font-display)",
                fontSize: rem(13),
                fontWeight: active ? 600 : 400,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <Icon size={14} aria-hidden style={{ flexShrink: 0, color: active ? colors.primary : colors.fg3 }} />
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {place.label}
              </span>
            </button>
            {place.kind === "pinned" && (
              <button
                type="button"
                className="odk-fb-unpin"
                data-testid="file-browser-unpin"
                aria-label={`Unpin ${place.label}`}
                title="Remove from sidebar"
                onClick={() => onUnpin(place.path)}
                style={{
                  position: "absolute",
                  right: 4,
                  width: 22,
                  height: 22,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  padding: 0,
                  border: "none",
                  borderRadius: 3,
                  background: colors.bg3,
                  color: colors.fg2,
                  cursor: "pointer",
                }}
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}
