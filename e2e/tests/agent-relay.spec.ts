import { devices, expect, test, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  getImmersiveTerminal,
  listTerminals,
  openApp,
  releaseMachineControl,
  requestMachineControl,
  resetMachineState,
} from "./helpers";

// The Node image ships fake `claude` / `codex` CLIs (e2e/fake-agents): real
// processes with the agents' names that print their first prompt verbatim.
// The fake Claude also shows Claude's usage-limit notice.
test.use({ ...devices["Pixel 7"], browserName: "chromium" });

/** Terminal text with soft-wrapped rows joined back into logical lines. */
async function logicalText(page: Page, terminalId: string): Promise<string> {
  return page.evaluate((id) => {
    const term = (window as unknown as { __offdeskTerminals?: Map<string, any> }).__offdeskTerminals?.get(id);
    if (!term) return "";
    const buffer = term.buffer.active;
    let text = "";
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (!line) continue;
      text += (i > 0 && !line.isWrapped ? "\n" : "") + line.translateToString(true);
    }
    return text;
  }, terminalId);
}

test("agent relay hands a usage-limited Claude task to Codex with a verbatim first prompt", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const sourceId = await createTerminalViaApi(page, { cwd: "/root", startupCommand: "claude" });
  await expect(getImmersiveTerminal(page)).toBeVisible();

  // The Node reports the agent and its limit notice from its 5 s poll.
  await expect(page.getByTestId("agent-chip")).toContainText("Claude", { timeout: 20_000 });
  const card = page.getByTestId("usage-limit-card");
  await expect(card).toContainText("Usage limit reached · resets 3pm", { timeout: 20_000 });
  await card.getByRole("button", { name: "Continue in Codex" }).click();

  const sheet = page.getByTestId("relay-sheet");
  const brief = sheet.getByTestId("relay-brief");
  await expect(brief).toHaveValue(/^Continue a task that Claude was working on in this directory\./);
  await expect(brief).toHaveValue(/Claude stopped: Usage limit reached · resets 3pm\./);
  // No Claude session file exists in the container: the sheet says so.
  await expect(sheet.getByTestId("relay-provenance")).toContainText("could not be matched");

  const note = `Keep quotes ' " and $(touch /tmp/relay-pwned) literal`;
  await sheet.getByTestId("relay-note").fill(note);
  const created = page.waitForResponse(
    (response) => response.url().endsWith("/relays") && response.request().method() === "POST",
  );
  await sheet.getByTestId("relay-start").click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const target = (await response.json()) as { id: string; relay_source: { terminal_id: string; agent: string } };
  expect(target.relay_source).toMatchObject({ terminal_id: sourceId, agent: "claude" });
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`#/t/${target.id}$`));

  // Codex starts in the new tab with the brief and the note as one argument.
  await expect.poll(() => logicalText(page, target.id), { timeout: 20_000 }).toContain("PROMPT-END");
  const text = await logicalText(page, target.id);
  expect(text).toContain("FAKE-CODEX ready");
  expect(text).toContain("PROMPT-BEGIN\nContinue a task that Claude was working on in this directory.");
  expect(text).toContain(`Note from me: ${note}\nPROMPT-END`);

  // The relayed terminal links back, and the link survives in the listing.
  await expect(page.getByTestId("agent-chip")).toContainText("Codex", { timeout: 20_000 });
  const listed = (await listTerminals(page)).find((terminal) => terminal.id === target.id) as
    | { relay_source?: { terminal_id: string; agent: string } }
    | undefined;
  expect(listed?.relay_source).toMatchObject({ terminal_id: sourceId, agent: "claude" });
  await page.getByTestId("relay-back").click();
  await expect(page).toHaveURL(new RegExp(`#/t/${sourceId}$`));
  await expect(page.getByTestId("agent-chip")).toContainText("Claude");

  // Nothing in the prompt ran as shell syntax.
  const probeId = await createTerminalViaApi(page, {
    cwd: "/root",
    startupCommand: "test -e /tmp/relay-pwned && echo RELAY-PWNED || echo RELAY-CLEAN",
  });
  await page.goto(`/#/t/${probeId}`);
  await expect.poll(() => logicalText(page, probeId), { timeout: 15_000 }).toMatch(/RELAY-(CLEAN|PWNED)\s*$/m);
  expect(await logicalText(page, probeId)).not.toContain("RELAY-PWNED\n");
  expect(await logicalText(page, probeId)).toMatch(/^RELAY-CLEAN$/m);
});

test("viewers see the agent but cannot start a relay", async ({ page }) => {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  await createTerminalViaApi(page, { cwd: "/root", startupCommand: "claude" });
  await expect(page.getByTestId("agent-chip")).toContainText("Claude", { timeout: 20_000 });

  await releaseMachineControl(page);
  await page.getByTestId("agent-chip").click();
  await expect(page.getByRole("menuitem", { name: /Continue in Codex/ })).toBeDisabled();
  await expect(page.getByTestId("agent-menu")).toContainText("Take control of this machine first.");
  await expect(
    page.getByTestId("usage-limit-card").getByRole("button", { name: "Continue in Codex" }),
  ).toBeDisabled();
});
