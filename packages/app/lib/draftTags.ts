// Pure helpers for draft tags: the tag tree, selection matching, card excerpts
// and client-side validation that mirrors the hub's contract (so mistakes show
// before the request is sent).

export const MAX_TAG_SEGMENTS = 4;
export const MAX_TAG_SEGMENT_LEN = 32;
export const MAX_EXPLICIT_TAGS = 20;
export const EXCERPT_MAX = 220;

interface Taggable {
  tags?: string[];
}

export interface TagNode {
  /** Lower-cased path; stable identity for comparisons and storage. */
  key: string;
  /** Last segment, in the first spelling seen. */
  name: string;
  /** Full path, in the first spelling seen. */
  path: string;
  /** Drafts carrying exactly this tag. */
  own: number;
  /** Drafts carrying this tag or any descendant (each draft counted once). */
  total: number;
  children: TagNode[];
}

interface WorkNode {
  key: string;
  name: string;
  path: string;
  own: Set<number>;
  all: Set<number>;
  children: Map<string, WorkNode>;
}

function compareNames(a: { key: string; name: string }, b: { key: string; name: string }): number {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Builds the tag tree from drafts. Merging is case-insensitive, first spelling wins. */
export function buildTagTree(drafts: Taggable[]): TagNode[] {
  const roots = new Map<string, WorkNode>();
  drafts.forEach((draft, index) => {
    for (const tag of draft.tags ?? []) {
      const segments = tag.split("/").filter((s) => s.length > 0);
      let level = roots;
      let parentPath = "";
      segments.forEach((segment, i) => {
        const segKey = segment.toLowerCase();
        let node = level.get(segKey);
        if (!node) {
          const path = parentPath ? `${parentPath}/${segment}` : segment;
          node = {
            key: path.toLowerCase(),
            name: segment,
            path,
            own: new Set(),
            all: new Set(),
            children: new Map(),
          };
          level.set(segKey, node);
        }
        node.all.add(index);
        if (i === segments.length - 1) node.own.add(index);
        parentPath = node.path;
        level = node.children;
      });
    }
  });
  const finish = (nodes: Map<string, WorkNode>): TagNode[] =>
    Array.from(nodes.values())
      .sort(compareNames)
      .map((n) => ({
        key: n.key,
        name: n.name,
        path: n.path,
        own: n.own.size,
        total: n.all.size,
        children: finish(n.children),
      }));
  return finish(roots);
}

/** Every path in the tree (parents included), depth-first in display order. */
export function flattenTagPaths(tree: TagNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TagNode[]) => {
    for (const n of nodes) {
      out.push(n.path);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** True when the draft carries `selected` or any descendant of it (case-insensitive). */
export function matchesTag(draft: Taggable, selected: string): boolean {
  const sel = selected.toLowerCase();
  return (draft.tags ?? []).some((t) => {
    const lower = t.toLowerCase();
    return lower === sel || lower.startsWith(`${sel}/`);
  });
}

/** A hub without tag support returns drafts with no `tags` field at all. */
export function hubSupportsTags(drafts: Taggable[]): boolean {
  return drafts.some((d) => Array.isArray(d.tags));
}

export interface DraftLike extends Taggable {
  title: string;
  content: string;
  project_group: string;
}

export interface DraftFilter {
  project: string | null;
  tag: string | null;
  query?: string;
}

/** Project AND tag AND text query. */
export function filterDrafts<T extends DraftLike>(drafts: T[], filter: DraftFilter): T[] {
  const q = (filter.query ?? "").trim().toLowerCase();
  return drafts.filter((d) => {
    if (filter.project !== null && d.project_group !== filter.project) return false;
    if (filter.tag !== null && !matchesTag(d, filter.tag)) return false;
    if (q) {
      const hay = `${d.title}\n${d.content}\n${(d.tags ?? []).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function projectCounts(drafts: { project_group: string }[]): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const d of drafts) {
    if (!d.project_group) continue;
    counts.set(d.project_group, (counts.get(d.project_group) ?? 0) + 1);
  }
  return Array.from(counts, ([name, count]) => ({ name, count })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

const DROPPED_FENCE_LANGS = new Set(["mermaid", "svg", "html", "xml", "artifact", "database", "dot", "graphviz"]);

/** Plain-text preview of markdown for a card. Cheap on purpose: never renders markup. */
export function excerptFromMarkdown(markdown: string, max: number = EXCERPT_MAX): string {
  // Only the head matters; keeps the regex passes cheap for huge drafts.
  let text = markdown.length > 6000 ? markdown.slice(0, 6000) : markdown;
  // Fenced blocks: keep plain code, drop diagrams/artifacts. An unclosed fence runs to the end.
  text = text.replace(/(^|\n)[ \t]*(```|~~~)([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\2[^\n]*|$)/g, (_m, lead, _f, info, body) => {
    const lang = String(info).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
    return DROPPED_FENCE_LANGS.has(lang) ? `${lead} ` : `${lead}${body}`;
  });
  text = text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm, " ")
    .replace(/\|/g, " ")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>+[ \t]?/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, "")
    .replace(/(\*\*|__|~~|`|\*)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  // Do not split a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

export type TagValidation = { ok: true; tag: string } | { ok: false; error: string };

/** Mirrors the hub's normalisation for explicit tags. */
export function normalizeTag(input: string): TagValidation {
  let s = input.trim();
  if (s.startsWith("#")) s = s.slice(1);
  if (s.trim() === "") return { ok: false, error: "Tag is empty." };
  const segments = s.split("/").map((x) => x.trim());
  if (segments.some((x) => x === "")) return { ok: false, error: "Tag has an empty segment." };
  if (segments.length > MAX_TAG_SEGMENTS) {
    return { ok: false, error: `At most ${MAX_TAG_SEGMENTS} levels (a/b/c/d).` };
  }
  for (const seg of segments) {
    // eslint-disable-next-line no-control-regex
    if (/[\s#,"'\u0000-\u001f\u007f]/.test(seg)) {
      return { ok: false, error: "Tags cannot contain spaces or # , \" '." };
    }
    if (Array.from(seg).length > MAX_TAG_SEGMENT_LEN) {
      return { ok: false, error: `Each level is at most ${MAX_TAG_SEGMENT_LEN} characters.` };
    }
  }
  return { ok: true, tag: segments.join("/") };
}

export type AddTagResult = { ok: true; explicit: string[]; tag: string } | { ok: false; error: string };

/**
 * Validates `input` and appends it to the explicit set.
 * `allTags` is everything already on the draft (explicit + inline) for the duplicate check.
 */
export function addExplicitTag(explicit: string[], allTags: string[], input: string): AddTagResult {
  const parsed = normalizeTag(input);
  if (!parsed.ok) return parsed;
  const lower = parsed.tag.toLowerCase();
  if (allTags.some((t) => t.toLowerCase() === lower)) {
    return { ok: false, error: "Already on this draft." };
  }
  if (explicit.length >= MAX_EXPLICIT_TAGS) {
    return { ok: false, error: `At most ${MAX_EXPLICIT_TAGS} tags per draft.` };
  }
  return { ok: true, explicit: [...explicit, parsed.tag], tag: parsed.tag };
}

/** The explicit tag set: tags minus the ones that only come from the body. */
export function explicitTags(tags: string[], inlineTags: string[]): string[] {
  const inline = new Set(inlineTags.map((t) => t.toLowerCase()));
  return tags.filter((t) => !inline.has(t.toLowerCase()));
}

/** Suggestions for the tag input: paths containing the typed text, not already used. */
export function suggestTags(paths: string[], typed: string, used: string[], limit = 6): string[] {
  const q = typed.trim().replace(/^#/, "").toLowerCase();
  const usedSet = new Set(used.map((t) => t.toLowerCase()));
  const out: string[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    if (usedSet.has(lower)) continue;
    if (q && !lower.includes(q)) continue;
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export function relativeTime(ms: number, now: number = Date.now()): string {
  const diffSec = Math.max(0, Math.floor((now - ms) / 1000));
  if (diffSec < 60) return "just now";
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Test-id fragment for a tag path (`a/b` -> `a__b`). */
export function tagTestId(path: string): string {
  return path.replace(/\//g, "__");
}
