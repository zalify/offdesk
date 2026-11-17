import type { MenuActionId, MenuSpec } from "@/lib/fileActions";
import { ContextMenu } from "./ContextMenu";
import type { ContextMenuEntry } from "./ContextMenu";

/** The file browser's right-click menu: maps the pure item list onto ContextMenu. */
export function FileActionMenu({
  x,
  y,
  specs,
  onAction,
  onClose,
}: {
  x: number;
  y: number;
  specs: MenuSpec[];
  onAction: (id: MenuActionId) => void;
  onClose: () => void;
}) {
  const items: ContextMenuEntry[] = specs.map((spec) =>
    spec === "separator"
      ? { type: "separator" }
      : {
          label: spec.label,
          shortcut: spec.shortcut,
          disabled: spec.disabled,
          testId: `file-action-${spec.id}`,
          onClick: () => onAction(spec.id),
        },
  );
  return <ContextMenu x={x} y={y} items={items} onClose={onClose} testId="file-browser-context-menu" />;
}
