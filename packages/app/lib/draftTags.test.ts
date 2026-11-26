import { describe, expect, test } from "vitest";

import {
  addExplicitTag,
  buildTagTree,
  excerptFromMarkdown,
  explicitTags,
  filterDrafts,
  flattenTagPaths,
  hubSupportsTags,
  matchesTag,
  normalizeTag,
  projectCounts,
  suggestTags,
  tagTestId,
} from "./draftTags";

describe("buildTagTree", () => {
  test("counts own and descendant drafts, once per draft", () => {
    const tree = buildTagTree([
      { tags: ["research/competitors", "research"] },
      { tags: ["research/pricing"] },
      { tags: ["todo"] },
    ]);
    expect(tree.map((n) => n.path)).toEqual(["research", "todo"]);
    const research = tree[0];
    expect(research.own).toBe(1);
    expect(research.total).toBe(2);
    expect(research.children.map((c) => [c.path, c.own, c.total])).toEqual([
      ["research/competitors", 1, 1],
      ["research/pricing", 1, 1],
    ]);
  });

  test("merges case-insensitively and keeps the first spelling", () => {
    const tree = buildTagTree([{ tags: ["Research/Notes"] }, { tags: ["research/notes"] }, { tags: ["RESEARCH"] }]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Research");
    expect(tree[0].total).toBe(3);
    expect(tree[0].children[0].path).toBe("Research/Notes");
    expect(tree[0].children[0].total).toBe(2);
  });

  test("sorts by name and is stable across input order", () => {
    const a = buildTagTree([{ tags: ["b", "A", "c"] }]);
    const b = buildTagTree([{ tags: ["c"] }, { tags: ["A", "b"] }]);
    expect(a.map((n) => n.name)).toEqual(["A", "b", "c"]);
    expect(b.map((n) => n.name)).toEqual(["A", "b", "c"]);
  });

  test("ignores drafts without tags", () => {
    expect(buildTagTree([{}, { tags: [] }])).toEqual([]);
  });

  test("flattenTagPaths lists parents before children", () => {
    const tree = buildTagTree([{ tags: ["a/b/c", "z"] }]);
    expect(flattenTagPaths(tree)).toEqual(["a", "a/b", "a/b/c", "z"]);
  });
});

describe("matchesTag", () => {
  test("matches itself and descendants, not siblings or prefixes", () => {
    const d = { tags: ["research/competitors"] };
    expect(matchesTag(d, "research")).toBe(true);
    expect(matchesTag(d, "Research/Competitors")).toBe(true);
    expect(matchesTag(d, "res")).toBe(false);
    expect(matchesTag(d, "research/competitors/x")).toBe(false);
    expect(matchesTag({}, "research")).toBe(false);
  });
});

describe("filterDrafts", () => {
  const base = { content: "", tags: [] as string[] };
  const drafts = [
    { ...base, title: "One", project_group: "p1", tags: ["a/b"] },
    { ...base, title: "Two", project_group: "p2", tags: ["a"] },
    { ...base, title: "Three", project_group: "p1", content: "needle here" },
  ];
  test("ANDs project, tag and query", () => {
    expect(filterDrafts(drafts, { project: null, tag: "a" }).map((d) => d.title)).toEqual(["One", "Two"]);
    expect(filterDrafts(drafts, { project: "p1", tag: "a" }).map((d) => d.title)).toEqual(["One"]);
    expect(filterDrafts(drafts, { project: "p1", tag: null, query: "NEEDLE" }).map((d) => d.title)).toEqual(["Three"]);
    expect(filterDrafts(drafts, { project: null, tag: null })).toHaveLength(3);
  });
  test("projectCounts", () => {
    expect(projectCounts(drafts)).toEqual([
      { name: "p1", count: 2 },
      { name: "p2", count: 1 },
    ]);
  });
  test("hubSupportsTags", () => {
    expect(hubSupportsTags([{}])).toBe(false);
    expect(hubSupportsTags([{}, { tags: [] }])).toBe(true);
  });
});

describe("excerptFromMarkdown", () => {
  test("strips markup and collapses whitespace", () => {
    const out = excerptFromMarkdown("# Title\n\n- **bold** item\n- [link](http://x.y)\n\n> quote\n\n| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toBe("Title bold item link quote a b 1 2");
  });
  test("drops diagram fences, keeps plain code", () => {
    expect(excerptFromMarkdown("intro\n```mermaid\ngraph TD; A-->B\n```\nafter")).toBe("intro after");
    expect(excerptFromMarkdown("```ts\nconst x = 1;\n```")).toBe("const x = 1;");
    expect(excerptFromMarkdown("```svg\n<svg><rect/></svg>")).toBe("");
  });
  test("cuts to the limit with an ellipsis", () => {
    const out = excerptFromMarkdown("word ".repeat(200), 50);
    expect(out.length).toBeLessThanOrEqual(51);
    expect(out.endsWith("…")).toBe(true);
  });
  test("does not split surrogate pairs", () => {
    const out = excerptFromMarkdown("a" + "😀".repeat(50), 4);
    expect(out).toBe("a😀…");
  });
  test("handles huge input quickly", () => {
    const out = excerptFromMarkdown("x".repeat(2_000_000));
    expect(out.length).toBeLessThanOrEqual(221);
  });
});

describe("normalizeTag", () => {
  test("trims, strips one leading # and joins trimmed segments", () => {
    expect(normalizeTag("  #research / competitors ")).toEqual({ ok: true, tag: "research/competitors" });
    expect(normalizeTag("项目/想法")).toEqual({ ok: true, tag: "项目/想法" });
  });
  test.each([
    ["", "empty"],
    ["#", "empty"],
    ["a//b", "empty segment"],
    ["a/", "empty segment"],
    ["a b", "spaces"],
    ["a,b", "comma"],
    ["a#b", "hash"],
    ["a'b", "quote"],
    ["a/b/c/d/e", "levels"],
    ["x".repeat(33), "characters"],
  ])("rejects %j", (input) => {
    expect(normalizeTag(input).ok).toBe(false);
  });
  test("accepts exactly 4 levels and 32 chars", () => {
    expect(normalizeTag("a/b/c/d").ok).toBe(true);
    expect(normalizeTag("x".repeat(32)).ok).toBe(true);
  });
});

describe("addExplicitTag", () => {
  test("appends a valid tag", () => {
    expect(addExplicitTag(["a"], ["a", "body"], "#b/c")).toEqual({ ok: true, explicit: ["a", "b/c"], tag: "b/c" });
  });
  test("rejects duplicates against explicit and inline, case-insensitively", () => {
    expect(addExplicitTag(["a"], ["a", "body"], "A").ok).toBe(false);
    expect(addExplicitTag(["a"], ["a", "body"], "Body").ok).toBe(false);
  });
  test("rejects more than 20 explicit tags", () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(addExplicitTag(many, many, "extra").ok).toBe(false);
  });
  test("explicitTags removes inline-only tags", () => {
    expect(explicitTags(["a", "Body"], ["body"])).toEqual(["a"]);
  });
});

describe("suggestTags / tagTestId", () => {
  test("filters by substring and skips used tags", () => {
    const paths = ["research", "research/competitors", "todo"];
    expect(suggestTags(paths, "comp", [])).toEqual(["research/competitors"]);
    expect(suggestTags(paths, "#res", ["research"])).toEqual(["research/competitors"]);
    expect(suggestTags(paths, "", [], 2)).toEqual(["research", "research/competitors"]);
  });
  test("tagTestId replaces slashes", () => {
    expect(tagTestId("a/b/c")).toBe("a__b__c");
  });
});
