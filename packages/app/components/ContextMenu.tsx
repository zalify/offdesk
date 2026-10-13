import { useEffect, useRef, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { colors } from "@/lib/colors";

export interface ContextMenuItem {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  onClick: () => void;
  // Optional submenu ("Move pane to tab ▸"), shown on hover.
  children?: ContextMenuItem[];
}

export interface ContextMenuSeparator {
  type: "separator";
}

export type ContextMenuEntry = ContextMenuItem | ContextMenuSeparator;

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuEntry[];
  onClose: () => void;
}

function isSeparator(entry: ContextMenuEntry): entry is ContextMenuSeparator {
  return "type" in entry && entry.type === "separator";
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openSubmenu, setOpenSubmenu] = useState<number | null>(null);

  const adjustedPosition = useCallback(() => {
    const menu = menuRef.current;
    if (!menu) return { left: x, top: y };
    const rect = menu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 4);
    const top = Math.min(y, window.innerHeight - rect.height - 4);
    return { left: Math.max(0, left), top: Math.max(0, top) };
  }, [x, y]);

  useEffect(() => {
    const menu = menuRef.current;
    if (menu) {
      const pos = adjustedPosition();
      menu.style.left = `${pos.left}px`;
      menu.style.top = `${pos.top}px`;
    }
  }, [adjustedPosition]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Capture phase + stopPropagation: the menu must win over a focused
      // xterm textarea, which otherwise consumes Escape and sends \x1b to
      // the pty while the menu stays open.
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    const handleScroll = (e: Event) => {
      // Only page-level scrolls (a container that holds the menu) dismiss
      // it. Inner scrollables — the xterm viewport streaming output, the
      // tab strip — must not close a menu the user just opened.
      const target = e.target;
      if (
        target instanceof Node &&
        menuRef.current &&
        !target.contains(menuRef.current)
      ) {
        return;
      }
      onClose();
    };

    requestAnimationFrame(() => {
      document.addEventListener("mousedown", handleClickOutside);
    });
    document.addEventListener("keydown", handleEscape, true);
    window.addEventListener("scroll", handleScroll, true);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape, true);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [onClose]);

  const renderItem = (
    entry: ContextMenuItem,
    key: string,
    submenuIndex: number | null,
  ) => {
    const hasChildren = Boolean(entry.children?.length);
    const button = (
      <button
        role="menuitem"
        onClick={() => {
          if (entry.disabled || hasChildren) return;
          entry.onClick();
          onClose();
        }}
        disabled={entry.disabled}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          minHeight: 32,
          padding: "6px 12px",
          background: "none",
          border: "none",
          borderRadius: 3,
          color: entry.disabled ? colors.fg3 : colors.fg0,
          cursor: entry.disabled ? "default" : "pointer",
          fontFamily: "var(--font-display)",
          fontSize: 13,
          textAlign: "left",
        }}
        onMouseEnter={(e) => {
          if (!entry.disabled) {
            e.currentTarget.style.background = colors.bg3;
          }
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "none";
        }}
      >
        <span>{entry.label}</span>
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            marginLeft: 16,
          }}
        >
          {entry.shortcut && (
            <span style={{ fontSize: 11.5, color: colors.fg3 }}>
              {entry.shortcut}
            </span>
          )}
          {hasChildren && (
            <span style={{ fontSize: 11, color: colors.foregroundMuted }}>
              ▸
            </span>
          )}
        </span>
      </button>
    );

    if (!hasChildren) return <div key={key}>{button}</div>;

    return (
      <div
        key={key}
        style={{ position: "relative" }}
        onMouseEnter={() => {
          if (submenuIndex !== null && !entry.disabled) {
            setOpenSubmenu(submenuIndex);
          }
        }}
        onMouseLeave={() => {
          if (submenuIndex !== null) {
            setOpenSubmenu((current) =>
              current === submenuIndex ? null : current,
            );
          }
        }}
      >
        {button}
        {submenuIndex !== null && openSubmenu === submenuIndex && (
          <div
            style={{
              position: "absolute",
              left: "calc(100% - 4px)",
              top: -4,
              zIndex: 10000,
              background: colors.bg2,
              border: `1px solid ${colors.line}`,
              borderRadius: 6,
              padding: 4,
              boxShadow: "0 24px 64px rgb(0 0 0 / 0.45)",
              minWidth: 160,
            }}
          >
            {entry.children!.map((child, childIndex) => (
              <div key={childIndex}>{renderItem(child, `${key}-${childIndex}`, null)}</div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return createPortal(
    <div
      role="menu"
      ref={menuRef}
      data-testid="context-menu"
      style={{
        position: "fixed",
        left: x,
        top: y,
        zIndex: 9999,
        background: colors.bg2,
        border: `1px solid ${colors.line}`,
        borderRadius: 6,
        padding: 4,
        boxShadow: "0 24px 64px rgb(0 0 0 / 0.45)",
        minWidth: 180,
      }}
    >
      {items.map((entry, i) => {
        if (isSeparator(entry)) {
          return (
            <div
              key={`sep-${i}`}
              style={{
                height: 1,
                background: colors.lineSoft,
                margin: "4px 0",
              }}
            />
          );
        }
        return renderItem(entry, `item-${i}`, i);
      })}
    </div>,
    document.body,
  );
}
