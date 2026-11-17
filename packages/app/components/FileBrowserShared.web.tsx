import type { ReactNode } from "react";
import type { DirEntry } from "@offdesk/shared";
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { colors } from "@/lib/colors";
import { entryKind } from "@/lib/fileManager";
import { rem } from "@/lib/rem";

export const SPIN = { animation: "offdeskSpin 800ms linear infinite" } as const;

const EXT_ICONS: Record<string, LucideIcon> = {};
const register = (icon: LucideIcon, exts: string) => {
  for (const ext of exts.split(" ")) EXT_ICONS[ext] = icon;
};
register(FileImage, "png jpg jpeg gif webp svg bmp ico heic avif");
register(FileText, "txt md markdown pdf doc docx rtf log csv");
register(
  FileCode,
  "ts tsx js jsx mjs cjs json rs py go java c h cpp hpp rb sh fish css html yml yaml toml xml sql lua swift kt",
);
register(FileArchive, "zip tar gz tgz bz2 xz 7z rar");
register(FileVideo, "mp4 mov mkv webm avi");
register(FileAudio, "mp3 wav flac ogg m4a aac");

/** Icon for an entry by kind: folder, or by extension family. */
export function iconForEntry(entry: DirEntry): LucideIcon {
  if (entry.is_dir) return Folder;
  return EXT_ICONS[entryKind(entry)] ?? FileIcon;
}

/** Display text for the Kind column. */
export function kindLabel(entry: DirEntry): string {
  const kind = entryKind(entry);
  return kind === "" ? "file" : kind;
}

/** Square text/icon button used across the toolbar (wireframes D08, P08). */
export function toolButtonStyle(touch: boolean, active = false) {
  return {
    width: touch ? 40 : 32,
    height: touch ? 40 : 32,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    border: `1px solid ${colors.line}`,
    borderRadius: 4,
    background: active ? colors.bg3 : "transparent",
    color: colors.fg0,
    fontFamily: "var(--font-display)",
    fontSize: rem(13),
    cursor: "pointer",
    flexShrink: 0,
  } as const;
}

export function Centered({
  children,
  testId,
  color,
}: {
  children: ReactNode;
  testId: string;
  color?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        minHeight: 160,
        padding: 24,
        textAlign: "center",
        fontSize: rem(13),
        color: color ?? colors.fg3,
      }}
    >
      {children}
    </div>
  );
}
