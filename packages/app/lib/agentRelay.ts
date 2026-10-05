import type { RelayAgent, RelayBrief, RelayTask } from "@offdesk/shared";

/** Matches the Node's limit; the Hub rejects anything larger. */
export const MAX_RELAY_PROMPT_BYTES = 32 * 1024;

export const agentLabel = (agent: RelayAgent) => (agent === "claude" ? "Claude" : "Codex");

export const otherAgent = (agent: RelayAgent): RelayAgent =>
  agent === "claude" ? "codex" : "claude";

interface CryptoLike {
  randomUUID?: () => string;
  getRandomValues?: (buffer: Uint8Array) => Uint8Array;
}

/** RFC 4122 v4, also where `crypto.randomUUID` is missing (older WebViews). */
export function newRelayId(
  cryptoLike: CryptoLike | undefined = globalThis.crypto as CryptoLike | undefined,
): string {
  if (cryptoLike?.randomUUID) return cryptoLike.randomUUID();
  const bytes = new Uint8Array(16);
  if (cryptoLike?.getRandomValues) cryptoLike.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const taskLine = (task: RelayTask) => {
  if (task.status === "completed") return `- [x] ${task.subject}`;
  if (task.status === "in_progress") return `- [ ] ${task.subject} (in progress)`;
  return `- [ ] ${task.subject}`;
};

/** The editable body of a relay prompt, built from the source's brief. */
export function composeRelayBrief(brief: RelayBrief): string {
  const source = agentLabel(brief.agent);
  const reason = brief.usage_limit
    ? `${source} stopped: ${brief.usage_limit}.`
    : `${source} handed it over.`;
  const parts = [`Continue a task that ${source} was working on in this directory. ${reason}`];
  if (brief.title) parts.push(`Session: ${brief.title}`);
  if (brief.goal) parts.push(`Original request:\n${brief.goal}`);
  if (brief.tasks.length) parts.push(`Progress:\n${brief.tasks.map(taskLine).join("\n")}`);
  if (brief.latest) parts.push(`${source}'s latest update:\n${brief.latest}`);
  if (brief.git?.changed.length) {
    const more = brief.git.more ? `, +${brief.git.more} more` : "";
    const branch = brief.git.branch ? ` on ${brief.git.branch}` : "";
    parts.push(`Uncommitted changes${branch}: ${brief.git.changed.join(", ")}${more}`);
  }
  parts.push(
    "Start by checking the current state of the files (git status and diff); the notes above may be incomplete. Then continue the remaining work.",
  );
  return parts.join("\n\n");
}

/** What is sent: the (possibly edited) body plus the person's own note. */
export function finalRelayPrompt(body: string, note: string): string {
  const text = body.trim();
  const extra = note.trim();
  const prompt = extra ? `${text}\n\nNote from me: ${extra}` : text;
  // The CLI would read a leading dash as an option; the Hub rejects it too.
  return prompt.replace(/^-+\s*/, "");
}

export function relayPromptProblem(prompt: string): string | null {
  if (!prompt.trim()) return "The prompt is empty.";
  if (new TextEncoder().encode(prompt).length > MAX_RELAY_PROMPT_BYTES) {
    return "The prompt is too long. Shorten it and try again.";
  }
  return null;
}
