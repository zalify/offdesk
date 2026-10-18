import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { TerminalInfo } from "@offdesk/shared";
import { MAX_PANES_PER_TAB } from "@offdesk/shared";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  FolderTree,
  Pencil,
  Plus,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { colors, colorAlpha } from "@/lib/colors";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { fontDisplay } from "./Primitives.web";
import { displayTerminalTitle } from "@/lib/displayTerminalTitle";
import { terminalOpenerDescription, terminalOpenerText } from "@/lib/terminalOpener";
import {
  collectPaneTerminalIds,
  type WorkspaceGroup,
} from "@/lib/terminalWorkspaceLayout";
import { rem } from "@/lib/rem";

export type WorkspaceManagerPlacement = "drawer" | "sheet";
export type WorkspaceManagerDropPlacement = "before" | "after";

interface WorkspaceManagerProps {
  open: boolean;
  placement: WorkspaceManagerPlacement;
  machineName: string;
  groups: WorkspaceGroup[];
  terminalsById: Map<string, TerminalInfo>;
  activeGroupId: string | null;
  activeTerminalId: string | null;
  canManage: boolean;
  onClose: () => void;
  onSelectGroup: (groupId: string) => void;
  onSelectTerminal: (terminalId: string) => void;
  onNewGroup: () => void;
  onNewTerminal: (group: WorkspaceGroup) => void;
  onRenameGroup: (group: WorkspaceGroup) => void;
  onDeleteGroup: (group: WorkspaceGroup) => void;
  onReorderGroups: (
    sourceGroupId: string,
    targetGroupId: string,
    placement: WorkspaceManagerDropPlacement,
  ) => void;
  onMoveTerminal: (terminal: TerminalInfo, targetGroup: WorkspaceGroup) => void;
  onCloseTerminal: (terminal: TerminalInfo) => void;
}

function WorkspaceManagerComponent({
  open,
  placement,
  machineName,
  groups,
  terminalsById,
  activeGroupId,
  activeTerminalId,
  canManage,
  onClose,
  onSelectGroup,
  onSelectTerminal,
  onNewGroup,
  onNewTerminal,
  onRenameGroup,
  onDeleteGroup,
  onReorderGroups,
  onMoveTerminal,
  onCloseTerminal,
}: WorkspaceManagerProps) {
  // "Move" opens a menu of the other tabs, anchored under the button.
  const [moveMenu, setMoveMenu] = useState<{
    terminal: TerminalInfo;
    targets: WorkspaceGroup[];
    x: number;
    y: number;
  } | null>(null);
  const moveMenuItems = useMemo<ContextMenuEntry[]>(
    () =>
      moveMenu
        ? moveMenu.targets.map((target) => ({
            label: target.label,
            onClick: () => {
              onMoveTerminal(moveMenu.terminal, target);
              setMoveMenu(null);
            },
          }))
        : [],
    [moveMenu, onMoveTerminal],
  );

  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeButtonRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  const persistentMoveTargets = useMemo(
    () =>
      groups.filter(
        (group) =>
          group.persistent &&
          group.workspaceGroupId !== null &&
          group.paneCount < MAX_PANES_PER_TAB,
      ),
    [groups],
  );

  if (!open) return null;

  const isSheet = placement === "sheet";

  return (
    <div
      data-testid="workspace-manager"
      data-placement={placement}
      onClick={onClose}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 45,
        display: "flex",
        alignItems: isSheet ? "flex-end" : "stretch",
        background: colorAlpha.backgroundShadow,
        animation: "offdeskFadeIn 120ms ease-out",
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-manager-title"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: isSheet ? "100%" : "min(380px, calc(100vw - 44px))",
          maxHeight: isSheet ? "86%" : "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          background: colors.bg1,
          borderRight: isSheet ? "none" : `1px solid ${colors.line}`,
          borderTop: isSheet ? `1px solid ${colors.line}` : "none",
          borderTopLeftRadius: isSheet ? 6 : 0,
          borderTopRightRadius: isSheet ? 6 : 0,
          boxShadow: isSheet
            ? "0 -20px 60px rgba(0, 0, 0, 0.35)"
            : "20px 0 60px rgba(0, 0, 0, 0.35)",
          paddingBottom: isSheet
            ? "max(10px, env(safe-area-inset-bottom))"
            : 0,
          animation: isSheet
            ? "offdeskSlideUp 200ms cubic-bezier(0.16, 1, 0.3, 1)"
            : "offdeskFadeIn 140ms ease-out",
        }}
      >
        {isSheet && (
          <div style={sheetHandleContainerStyle}>
            <span style={sheetHandleStyle} />
          </div>
        )}

        <header style={headerStyle}>
          <div style={headerIdentityStyle}>
            <div style={{ minWidth: 0 }}>
              <div id="workspace-manager-title" style={titleStyle}>
                tabs
              </div>
              <div style={subtitleStyle}>{machineName || "No host"}</div>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="workspace-manager-close"
            aria-label="Close the tab list"
            title="Close"
            onClick={onClose}
            className="odk-text-btn"
          >
            [esc]
          </button>
        </header>

        <div style={toolbarStyle}>
          <button
            type="button"
            data-testid="workspace-manager-new"
            disabled={!canManage}
            onClick={onNewGroup}
            className="odk-btn odk-btn--primary odk-btn--sm"
          >
            new tab
          </button>
          <span style={summaryStyle}>
            {groups.length} {groups.length === 1 ? "tab" : "tabs"}
          </span>
        </div>

        {!canManage && (
          <div data-testid="workspace-manager-view-only" style={viewOnlyStyle}>
            View only — take control to change tabs.
          </div>
        )}

        <div style={treeStyle}>
          {groups.length === 0 ? (
            <div data-testid="workspace-manager-empty" style={emptyStyle}>
              <span>No tabs yet</span>
              <span style={{ color: colors.fg3 }}>
                Create one, then start a terminal inside it.
              </span>
            </div>
          ) : (
            groups.map((group, index) => {
              const terminalIds = collectPaneTerminalIds(group.root);
              const groupTerminals = terminalIds
                .map((terminalId) => terminalsById.get(terminalId))
                .filter((terminal): terminal is TerminalInfo => Boolean(terminal));
              const isActive = group.id === activeGroupId;
              const canRenameOrDelete = canManage && group.persistent;
              return (
                <section
                  key={group.id}
                  data-testid={`workspace-manager-group-${group.id}`}
                  data-active={isActive ? "true" : undefined}
                  style={{
                    ...groupStyle,
                    borderColor: isActive ? colorAlpha.accentLine : colors.lineSoft,
                  }}
                >
                  <div style={groupHeaderStyle}>
                    <button
                      type="button"
                      aria-current={isActive ? "true" : undefined}
                      data-testid={`workspace-manager-select-${group.id}`}
                      onClick={() => {
                        onSelectGroup(group.id);
                        if (isSheet && groupTerminals.length > 0) onClose();
                      }}
                      style={groupSelectStyle}
                    >
                      <span style={treeBranchStyle} aria-hidden>
                        {index === groups.length - 1 ? "└" : "├"}
                      </span>
                      <span style={groupLabelStyle}>{group.label}</span>
                      {!group.persistent && (
                        <span style={automaticBadgeStyle}>automatic</span>
                      )}
                      <span style={countBadgeStyle}>{groupTerminals.length}</span>
                    </button>

                    <div style={groupActionsStyle}>
                      <ManagerIconButton
                        label={`Move ${group.label} up`}
                        testid={`workspace-manager-up-${group.id}`}
                        disabled={!canManage || index === 0}
                        icon
                        onClick={() =>
                          onReorderGroups(group.id, groups[index - 1].id, "before")
                        }
                      >
                        <ArrowUp size={14} aria-hidden />
                      </ManagerIconButton>
                      <ManagerIconButton
                        label={`Move ${group.label} down`}
                        testid={`workspace-manager-down-${group.id}`}
                        disabled={!canManage || index === groups.length - 1}
                        icon
                        onClick={() =>
                          onReorderGroups(group.id, groups[index + 1].id, "after")
                        }
                      >
                        <ArrowDown size={14} aria-hidden />
                      </ManagerIconButton>
                      <ManagerIconButton
                        label={`Rename ${group.label}`}
                        testid={`workspace-manager-rename-${group.id}`}
                        disabled={!canRenameOrDelete}
                        onClick={() => onRenameGroup(group)}
                      >
                        <span style={{ fontSize: rem(11.5) }}>rename</span>
                      </ManagerIconButton>
                      <ManagerIconButton
                        label={`Delete ${group.label}`}
                        testid={`workspace-manager-delete-${group.id}`}
                        disabled={!canRenameOrDelete}
                        danger
                        onClick={() => onDeleteGroup(group)}
                      >
                        [x]
                      </ManagerIconButton>
                    </div>
                  </div>

                  <div style={terminalTreeStyle}>
                    {groupTerminals.length === 0 ? (
                      <div style={emptyGroupStyle}>Empty tab</div>
                    ) : (
                      groupTerminals.map((terminal, terminalIndex) => {
                        const isTerminalActive = terminal.id === activeTerminalId;
                        const moveTargets = persistentMoveTargets.filter(
                          (target) => target.id !== group.id,
                        );
                        return (
                          <div
                            key={terminal.id}
                            data-testid={`workspace-manager-terminal-${terminal.id}`}
                            style={{
                              ...terminalRowStyle,
                              background: isTerminalActive
                                ? colors.bg3
                                : "transparent",
                            }}
                          >
                            <button
                              type="button"
                              aria-current={isTerminalActive ? "true" : undefined}
                              onClick={() => {
                                onSelectTerminal(terminal.id);
                                if (isSheet) onClose();
                              }}
                              style={terminalSelectStyle}
                            >
                              <span style={treeBranchStyle} aria-hidden>
                                {terminalIndex === groupTerminals.length - 1 ? "└" : "├"}
                              </span>
                              <span style={terminalTextStyle}>
                                <span style={terminalTitleStyle}>
                                  {displayTerminalTitle(terminal)}
                                </span>
                                <span style={terminalCwdStyle}>{terminal.cwd}</span>
                                {terminalOpenerText(terminal) && (
                                  <span
                                    data-testid={`workspace-manager-opener-${terminal.id}`}
                                    title={terminalOpenerDescription(terminal) ?? undefined}
                                    style={terminalCwdStyle}
                                  >
                                    ⌁ opened by {terminalOpenerText(terminal)}
                                  </span>
                                )}
                              </span>
                            </button>

                            {moveTargets.length > 0 ? (
                              <button
                                type="button"
                                data-testid={`workspace-manager-move-${terminal.id}`}
                                aria-label={`Move ${displayTerminalTitle(terminal)} to another tab`}
                                aria-haspopup="menu"
                                disabled={!canManage}
                                onClick={(event) => {
                                  const rect = event.currentTarget.getBoundingClientRect();
                                  setMoveMenu({
                                    terminal,
                                    targets: moveTargets,
                                    x: rect.left,
                                    y: rect.bottom + 4,
                                  });
                                }}
                                style={{
                                  ...moveButtonStyle,
                                  cursor: canManage ? "pointer" : "not-allowed",
                                  opacity: canManage ? 1 : 0.35,
                                }}
                              >
                                move
                              </button>
                            ) : null}

                            <ManagerIconButton
                              label={`Close ${displayTerminalTitle(terminal)}`}
                              testid={`workspace-manager-close-terminal-${terminal.id}`}
                              disabled={!canManage}
                              onClick={() => onCloseTerminal(terminal)}
                            >
                              [x]
                            </ManagerIconButton>
                          </div>
                        );
                      })
                    )}

                    <button
                      type="button"
                      data-testid={`workspace-manager-new-terminal-${group.id}`}
                      disabled={!canManage || group.paneCount >= MAX_PANES_PER_TAB}
                      onClick={() => onNewTerminal(group)}
                      style={{
                        ...newTerminalStyle,
                        cursor:
                          canManage && group.paneCount < MAX_PANES_PER_TAB
                            ? "pointer"
                            : "not-allowed",
                        opacity:
                          canManage && group.paneCount < MAX_PANES_PER_TAB
                            ? 1
                            : 0.4,
                      }}
                    >
                      [+] new terminal here
                    </button>
                  </div>
                </section>
              );
            })
          )}
        </div>

        {moveMenu ? (
          <ContextMenu x={moveMenu.x} y={moveMenu.y} items={moveMenuItems} onClose={() => setMoveMenu(null)} />
        ) : null}

        <footer style={footerStyle}>
          A tab holds up to four terminals. Moving or deleting a tab does not
          close its terminals.
        </footer>
      </section>
    </div>
  );
}

function ManagerIconButton({
  label,
  testid,
  disabled = false,
  danger = false,
  icon = false,
  onClick,
  children,
}: {
  label: string;
  testid: string;
  disabled?: boolean;
  danger?: boolean;
  /** A 14px icon, whose own inset makes up the rest of the text padding. */
  icon?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      style={{
        ...iconButtonStyle,
        ...(icon && { padding: "0 8px" }),
        color: danger ? colors.danger : colors.fg3,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.35 : 1,
      }}
    >
      {children}
    </button>
  );
}

export const WorkspaceManager = memo(WorkspaceManagerComponent);

const headerStyle: CSSProperties = {
  minHeight: 60,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px 8px 16px",
  borderBottom: `1px solid ${colors.lineSoft}`,
};

const headerIdentityStyle: CSSProperties = {
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const headerIconStyle: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: colorAlpha.accentLight,
  color: colors.accent,
  flexShrink: 0,
};

const titleStyle: CSSProperties = {
  color: colors.fg0,
  fontSize: rem(15),
  fontWeight: 600,
};

const subtitleStyle: CSSProperties = {
  marginTop: 2,
  color: colors.fg3,
  fontSize: rem(11),
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 12px",
};

const primaryButtonStyle: CSSProperties = {
  minHeight: 34,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  padding: "0 12px",
  border: "none",
  borderRadius: 7,
  background: colors.accent,
  color: colors.onAccent,
  fontSize: rem(12),
  fontWeight: 700,
};

const summaryStyle: CSSProperties = {
  color: colors.fg3,
  fontSize: rem(11),
  whiteSpace: "nowrap",
};

const viewOnlyStyle: CSSProperties = {
  margin: "0 12px 8px",
  padding: "7px 9px",
  border: `1px solid ${colors.lineSoft}`,
  borderRadius: 4,
  color: colors.fg2,
  background: colors.bg2,
  fontFamily: "var(--font-sans)",
  fontSize: rem(12),
};

const treeStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "0 10px 12px",
};

const groupStyle: CSSProperties = {
  marginBottom: 8,
  overflow: "hidden",
  border: "1px solid",
  borderRadius: 4,
  background: colors.bg0,
};

const groupHeaderStyle: CSSProperties = {
  minHeight: 40,
  display: "flex",
  alignItems: "center",
  borderBottom: `1px solid ${colors.lineSoft}`,
};

const groupSelectStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  minHeight: 40,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "0 6px 0 10px",
  border: "none",
  background: "transparent",
  color: colors.fg1,
  textAlign: "left",
  cursor: "pointer",
};

const treeBranchStyle: CSSProperties = {
  color: colors.fg3,
  fontFamily: "var(--font-mono)",
  fontSize: rem(11),
  flexShrink: 0,
};

const groupLabelStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: colors.fg0,
  fontSize: rem(12.5),
  fontWeight: 500,
};

const automaticBadgeStyle: CSSProperties = {
  padding: "1px 6px",
  border: `1px solid ${colors.line}`,
  borderRadius: 3,
  color: colors.fg3,
  fontSize: rem(10.5),
  whiteSpace: "nowrap",
};

const countBadgeStyle: CSSProperties = {
  minWidth: 19,
  height: 18,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: 3,
  color: colors.fg3,
  background: "transparent",
  fontSize: rem(11),
};

const groupActionsStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 1,
  paddingRight: 4,
};

// Sized to content so text actions ("rename", "[x]") and 14px icons sit
// evenly spaced; minWidth keeps the tap target.
const iconButtonStyle: CSSProperties = {
  minWidth: 30,
  height: 30,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 10px",
  border: "none",
  borderRadius: 3,
  background: "transparent",
  color: colors.fg2,
  fontFamily: "var(--font-display)",
  fontSize: rem(12.5),
  cursor: "pointer",
};

const terminalTreeStyle: CSSProperties = {
  padding: "4px 4px 6px 18px",
};

const terminalRowStyle: CSSProperties = {
  minHeight: 44,
  display: "flex",
  alignItems: "center",
  gap: 2,
  borderRadius: 3,
};

const terminalSelectStyle: CSSProperties = {
  minWidth: 0,
  minHeight: 42,
  flex: 1,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 5px",
  border: "none",
  background: "transparent",
  color: colors.fg2,
  textAlign: "left",
  cursor: "pointer",
};

const terminalTextStyle: CSSProperties = {
  minWidth: 0,
  flex: 1,
  display: "block",
};

const terminalTitleStyle: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: colors.fg1,
  fontSize: rem(12),
};

const terminalCwdStyle: CSSProperties = {
  display: "block",
  marginTop: 2,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: colors.fg3,
  fontSize: rem(10.5),
};

const moveButtonStyle: CSSProperties = {
  height: 28,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "0 10px",
  border: `1px solid ${colors.line}`,
  borderRadius: 3,
  background: "transparent",
  color: colors.fg0,
  fontFamily: fontDisplay,
  fontSize: rem(12),
  fontWeight: 500,
};

const emptyGroupStyle: CSSProperties = {
  padding: "9px 6px 5px 22px",
  color: colors.fg3,
  fontSize: rem(11),
  fontStyle: "italic",
};

const newTerminalStyle: CSSProperties = {
  minHeight: 30,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  margin: "4px 0 0 18px",
  padding: "0 8px",
  border: "none",
  borderRadius: 3,
  background: "transparent",
  color: colors.fg3,
  fontFamily: "var(--font-display)",
  fontSize: rem(12),
};

const emptyStyle: CSSProperties = {
  minHeight: 180,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: colors.fg2,
  fontSize: rem(12),
  textAlign: "center",
};

const footerStyle: CSSProperties = {
  padding: "9px 14px",
  borderTop: `1px solid ${colors.lineSoft}`,
  color: colors.fg3,
  fontFamily: "var(--font-sans)",
  fontSize: rem(12),
  lineHeight: 1.45,
};

const sheetHandleContainerStyle: CSSProperties = {
  display: "flex",
  justifyContent: "center",
  padding: "8px 0 0",
};

const sheetHandleStyle: CSSProperties = {
  width: 36,
  height: 4,
  borderRadius: 2,
  background: colors.line,
};
