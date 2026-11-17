import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import type { DirEntry } from "@offdesk/shared";

/** Modifier keys of a click, as the selection model needs them. */
export interface ClickModifiers {
  toggle: boolean;
  range: boolean;
}

export const clickModifiers = (event: ReactMouseEvent): ClickModifiers => ({
  toggle: event.metaKey || event.ctrlKey,
  range: event.shiftKey,
});

type DragHandlers = {
  onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (event: ReactDragEvent<HTMLElement>) => void;
};

/** Desktop-only row behaviour from the file actions: inline rename and drag & drop. */
export interface RowInteraction {
  renamingPath: string | null;
  onRenameCommit: (entry: DirEntry, name: string) => Promise<string | null>;
  onRenameCancel: () => void;
  /** Highlight key of the current drop target (`row:<path>`). */
  dropHover: string | null;
  dragSource: (
    entry: DirEntry,
    renaming: boolean,
  ) => {
    draggable: boolean;
    onDragStart: (event: ReactDragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
  };
  /** Folders accept drops. */
  dropTarget: (entry: DirEntry) => DragHandlers;
}

/** Attributes shared by list rows and icon tiles (drag, drop, test hooks). */
export function rowInteractionProps(entry: DirEntry, interaction: RowInteraction | undefined) {
  if (!interaction) return {};
  const renaming = interaction.renamingPath === entry.path;
  const drop = entry.is_dir && !renaming ? interaction.dropTarget(entry) : {};
  return {
    ...interaction.dragSource(entry, renaming),
    ...drop,
    "data-drop": interaction.dropHover === `row:${entry.path}` ? "true" : undefined,
  };
}
