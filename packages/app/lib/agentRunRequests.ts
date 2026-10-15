import type { AgentRunInfo } from "@offdesk/shared";

/** An agent run that waits on a person, by its terminal: the newest open run with a
 *  request. Approvals and questions can be answered from the strip; input opens the
 *  terminal. */
export function waitingRunsByTerminal(runs: readonly AgentRunInfo[]): Map<string, AgentRunInfo> {
  const waiting = new Map<string, AgentRunInfo>();
  for (const run of runs) {
    if (!run.terminal_id || run.ended_at_ms || !run.request) continue;
    const current = waiting.get(run.terminal_id);
    if (!current || run.started_at_ms > current.started_at_ms) waiting.set(run.terminal_id, run);
  }
  return waiting;
}

/** The buttons an open request offers in the strip: yes/no for an approval, its
 *  first options for a question; none for input (open the terminal to answer). */
export function answerChoices(run: AgentRunInfo, maxOptions = 3): { label: string; answer: { approve?: boolean; option_id?: string } }[] {
  const request = run.request;
  if (!request || request.answer_sent_at_ms) return [];
  if (request.kind === "approval") return [{ label: "yes", answer: { approve: true } }, { label: "no", answer: { approve: false } }];
  if (request.kind === "question") {
    return (request.options ?? []).slice(0, maxOptions).map(option => ({ label: option.label, answer: { option_id: option.id } }));
  }
  return [];
}
