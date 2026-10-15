import type { ContentLevel, TokenAccess, TokenScope } from "@offdesk/shared";

/** What a new token may do, as the settings form holds it. */
export interface TokenAccessForm {
  /** "runs": agent runs only; "full": everything (terminals, input, machines). */
  kind: "runs" | "full";
  scopes: TokenScope[];
  content: ContentLevel;
  /** Folders `runs:start` may start in, one per line. */
  dirs: string;
  includeProduction: boolean;
}

export const RUN_SCOPES: { scope: TokenScope; label: string }[] = [
  { scope: "runs:read", label: "See runs" },
  { scope: "runs:answer", label: "Answer questions" },
  { scope: "runs:approve", label: "Approve commands" },
  { scope: "runs:start", label: "Start agents" },
];

export const CONTENT_LEVELS: { level: ContentLevel; label: string }[] = [
  { level: "metadata", label: "Status only" },
  { level: "requests", label: "Status and what they ask" },
  { level: "notes", label: "Also their notes" },
];

export const defaultTokenAccessForm = (): TokenAccessForm => ({
  kind: "runs",
  scopes: ["runs:read"],
  content: "metadata",
  dirs: "",
  includeProduction: false,
});

/** The access to create a token with (undefined: full), or why the form can't make one. */
export function accessFromForm(
  form: TokenAccessForm,
): { access?: TokenAccess; error?: string } {
  if (form.kind === "full") return {};
  if (form.scopes.length === 0) return { error: "Choose what the token may do" };
  const dirs = form.dirs
    .split("\n")
    .map((dir) => dir.trim())
    .filter(Boolean);
  if (form.scopes.includes("runs:start") && dirs.length === 0) {
    return { error: "List the folders it may start agents in" };
  }
  return {
    access: {
      scopes: form.scopes,
      content: form.content,
      ...(form.includeProduction ? { include_production: true } : {}),
      ...(form.scopes.includes("runs:start") ? { dirs } : {}),
    },
  };
}

/** One line on what a token may do, for the token list. */
export function describeAccess(access: TokenAccess | null | undefined): string {
  if (!access || access.scopes.includes("full")) {
    return "full access: every terminal and machine";
  }
  const parts = [access.scopes.join(", ")];
  const level = CONTENT_LEVELS.find((l) => l.level === (access.content ?? "metadata"));
  if (level) parts.push(level.label.toLowerCase());
  if (access.machines) parts.push(`machines: ${access.machines.length}`);
  else if (access.include_production) parts.push("production machines too");
  if (access.dirs?.length) parts.push(`in ${access.dirs.join(", ")}`);
  return parts.join(" · ");
}
