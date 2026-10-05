import { devices, expect, test, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  getAuthHeaders,
  mobileOpenHostSheet,
  openApp,
  requestMachineControl,
  resetMachineState,
} from "./helpers";

// The Node image's fake `claude` (e2e/fake-agents) writes Claude's session
// file and a finished two-item task list when FAKE_TASKS is set; the fake
// `codex` prints its first prompt verbatim.
test.use({ ...devices["Pixel 7"], browserName: "chromium" });

async function deleteAllTodos(page: Page) {
  const headers = await getAuthHeaders(page);
  const todos = (await (await page.request.get("/api/todos", { headers })).json()) as { id: string }[];
  for (const todo of todos) await page.request.delete(`/api/todos/${todo.id}`, { headers });
}

async function openTodos(page: Page) {
  await mobileOpenHostSheet(page);
  await page.getByTestId("mobile-menu-todos").click();
  await expect(page.getByTestId("todos-panel")).toBeVisible();
  return page.getByTestId("todos-panel");
}

/** Terminal text with soft-wrapped rows joined back into logical lines. */
async function logicalText(page: Page, terminalId: string): Promise<string> {
  return page.evaluate((id) => {
    const term = (window as unknown as { __offdeskTerminals?: Map<string, any> }).__offdeskTerminals?.get(id);
    if (!term) return "";
    const buffer = term.buffer.active;
    let text = "";
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) text += (i > 0 && !line.isWrapped ? "\n" : "") + line.translateToString(true);
    }
    return text;
  }, terminalId);
}

test("an agent's task list becomes a to-do that offers to finish with it", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await deleteAllTodos(page);
  await requestMachineControl(page);
  const terminalId = await createTerminalViaApi(page, { cwd: "/root", startupCommand: "FAKE_TASKS=1 claude" });

  const panel = await openTodos(page);
  // The Node reports the task list from its 5 s poll.
  const card = panel.getByTestId(`agent-tasks-${terminalId}`);
  await expect(card).toContainText("2/2", { timeout: 20_000 });
  await expect(card).toContainText("Backfill orders");
  await expect(card).toContainText("idle");
  await card.getByTestId("agent-tasks-adopt").click();

  // The adopted to-do follows the agent and, with every task done and the
  // agent idle, offers to finish; the card is no longer listed separately.
  const row = panel.locator('[data-testid^="todo-row-"]').first();
  await expect(row.getByTestId("todo-agent-badge")).toContainText("Claude · idle · 2/2");
  await expect(panel.getByTestId(`agent-tasks-${terminalId}`)).toHaveCount(0);
  await expect(row.locator('[data-testid^="todo-finished-"]')).toContainText("Claude finished all 2 tasks");
  await row.getByRole("button", { name: "Mark done" }).click();
  await expect(panel).toContainText("My to-dos · 0");

  const headers = await getAuthHeaders(page);
  const [todo] = (await (await page.request.get("/api/todos", { headers })).json()) as {
    status: string;
    agent: string;
    terminal_id: string;
    cwd: string;
    progress: { done: number; total: number };
  }[];
  expect(todo).toMatchObject({ status: "done", agent: "claude", terminal_id: terminalId, cwd: "/root" });
  expect(todo.progress).toMatchObject({ done: 2, total: 2 });
});

test("a to-do is handed to Codex in its folder with the prompt as written", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await deleteAllTodos(page);
  await requestMachineControl(page);
  const headers = await getAuthHeaders(page);
  const created = await page.request.post("/api/todos", {
    headers,
    data: {
      id: "77777777-7777-4777-8777-777777777777",
      title: "Write the release notes",
      notes: `Keep quotes ' " and $(touch /tmp/todo-pwned) literal`,
      machine_id: "e2e-node",
      cwd: "/root",
    },
  });
  expect(created.ok()).toBeTruthy();
  await page.reload();
  await page.getByTestId("mobile-workbench").waitFor();

  const panel = await openTodos(page);
  await panel.locator('[data-testid^="todo-open-"]').filter({ hasText: "Write the release notes" }).click();
  const detail = panel.getByTestId("todo-detail");
  await detail.getByTestId("todo-dispatch-codex").click();
  const prompt = detail.getByTestId("todo-dispatch-prompt");
  await expect(prompt).toHaveValue(`Write the release notes\n\nKeep quotes ' " and $(touch /tmp/todo-pwned) literal`);

  const response = page.waitForResponse((r) => r.url().endsWith("/dispatch") && r.request().method() === "POST");
  await detail.getByTestId("todo-dispatch-start").click();
  const body = (await (await response).json()) as { todo: { agent: string; terminal_id: string }; terminal: { id: string } };
  expect(body.todo).toMatchObject({ agent: "codex", terminal_id: body.terminal.id });
  await expect(page.getByTestId("todos-panel")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/t/${body.terminal.id}$`));

  await expect.poll(() => logicalText(page, body.terminal.id), { timeout: 20_000 }).toContain("PROMPT-END");
  const text = await logicalText(page, body.terminal.id);
  expect(text).toContain("FAKE-CODEX ready");
  expect(text).toContain(`PROMPT-BEGIN\nWrite the release notes\n\nKeep quotes ' " and $(touch /tmp/todo-pwned) literal\nPROMPT-END`);

  // Back in the list, the to-do shows Codex on it.
  const reopened = await openTodos(page);
  await expect(reopened.getByTestId("todo-agent-badge")).toContainText("Codex", { timeout: 20_000 });

  // Nothing in the prompt ran in the shell.
  const probe = await createTerminalViaApi(page, {
    cwd: "/root",
    startupCommand: "test -e /tmp/todo-pwned && echo TODO-PWNED || echo TODO-CLEAN",
  });
  await page.goto(`/#/t/${probe}`);
  await expect.poll(() => logicalText(page, probe), { timeout: 15_000 }).toMatch(/^TODO-(CLEAN|PWNED)$/m);
  expect(await logicalText(page, probe)).toMatch(/^TODO-CLEAN$/m);
});
