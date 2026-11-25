// Splits a draft into Markdown and rich artifact blocks. Pure, so it is unit tested.
import { parseDatabaseFence } from "./draftDatabases";

export type ArtifactSegment =
  | { kind: "markdown"; text: string }
  | { kind: "mermaid"; code: string }
  | { kind: "svg"; code: string }
  | { kind: "html"; code: string }
  | { kind: "database"; database: string; view?: string };

/**
 * Split a draft into interleaved Markdown and rich Artifact blocks
 * (`mermaid`, `svg`, `html`, `database`), or treat a standalone HTML/SVG document as one artifact.
 */
export function parseArtifactSegments(source: string): ArtifactSegment[] {
  const trimmed = source.trim();
  if (!trimmed) return [];
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) {
    return [{ kind: "html", code: trimmed }];
  }
  if (/^<svg[\s>]/i.test(trimmed) && trimmed.endsWith("</svg>")) {
    return [{ kind: "svg", code: trimmed }];
  }

  const segments: ArtifactSegment[] = [];
  const fenceRe = /```(mermaid|svg|html|database)\s*\n([\s\S]*?)```/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(source)) !== null) {
    if (match.index > lastIndex) {
      const md = source.slice(lastIndex, match.index).trim();
      if (md) segments.push({ kind: "markdown", text: md });
    }
    const lang = match[1].toLowerCase() as "mermaid" | "svg" | "html" | "database";
    const code = match[2].trim();
    if (code) {
      if (lang === "database") {
        const fence = parseDatabaseFence(code);
        if (fence) segments.push({ kind: "database", ...fence });
      } else {
        segments.push({ kind: lang, code });
      }
    }
    lastIndex = fenceRe.lastIndex;
  }
  if (lastIndex < source.length) {
    const tail = source.slice(lastIndex).trim();
    if (tail) segments.push({ kind: "markdown", text: tail });
  }
  return segments;
}
