import { expect, test, type Page } from "@playwright/test";
import { createTerminalViaApi, expandTerminalById, getAuthHeaders, getDeviceId, listTerminals,
  openApp, releaseMachineControl, requestMachineControl, resetMachineState } from "./helpers";

async function setup(page: Page) {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const source = await createTerminalViaApi(page, { cwd: "/tmp" });
  const target = await createTerminalViaApi(page, { cwd: "/tmp" });
  await page.route("**/foreground-process", route => route.fulfill({
    json: { has_foreground_process: true, process_name: route.request().url().includes(source) ? "claude.exe" : "codex" },
  }));
  await expandTerminalById(page, source);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("button", { name: "Hand off to Codex", exact: true })).toBeEnabled();
  return { source, target };
}

async function prepare(page: Page, target: string) {
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Hand off this session" });
  await expect(dialog.getByRole("button", { name: "Prepare handoff to Codex" })).toBeDisabled();
  await dialog.getByText("Context and destination", { exact: true }).click();
  await expect(dialog.getByLabel("Target terminal", { exact: true })).toHaveValue(target);
  await dialog.getByLabel("Original goal").fill("Keep existing edits and ship the dashboard.");
  await dialog.getByLabel("Next step", { exact: true }).fill("Implement the metrics API.");
  await dialog.getByLabel("Progress and context").fill("Page is ready. Tests have not run. Preserve the response schema.");
  await dialog.getByLabel("Artifact paths (optional)").fill("assets/chart preview.png — example chart");
  await dialog.getByRole("button", { name: "Prepare handoff to Codex" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Ready to paste");
}

for (const viewport of [{ width: 1440, height: 960 }, { width: 390, height: 844 }]) {
  test(`manual handoff persists and returns to the original terminal at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const writes: string[] = [];
    page.on("websocket", socket => socket.on("framesent", frame => {
      if (typeof frame.payload !== "string") return;
      try { if (["input", "command_input", "composer"].includes(JSON.parse(frame.payload).type)) writes.push(frame.payload); } catch {}
    }));
    const { source, target } = await setup(page);
    writes.length = 0;
    await prepare(page, target);
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Handoff instructions")).toHaveValue(/assets\/chart preview\.png/);
    await page.screenshot({ path: testInfo.outputPath(`handoff-${viewport.width}.png`) });
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
      configurable: true, value: { writeText: async (value: string) => { (window as any).__handoffClipboard = value; } },
    }));
    await dialog.getByRole("button", { name: "Copy & open Codex" }).click();
    expect(await page.evaluate(() => (window as any).__handoffClipboard)).toContain("Implement the metrics API.");
    await expect(page).toHaveURL(new RegExp(target));
    await expect(page.getByRole("button", { name: "Handoff ready to paste" })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Handoff ready to paste" })).toBeVisible();
    await page.getByRole("button", { name: "Handoff ready to paste" }).click();
    await expect(page.getByLabel("Handoff instructions")).toHaveValue(/Keep existing edits/);
    await page.getByRole("button", { name: "I’ve submitted it to the agent" }).click();
    await expect(page.getByRole("dialog").getByRole("status")).toContainText("Submitted by you");
    await page.getByRole("button", { name: "Close handoff" }).click();
    await page.getByRole("button", { name: "Hand back to Claude", exact: true }).click();
    await page.getByText("Context and destination", { exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Source agent", exact: true })).toHaveValue("codex");
    await expect(page.getByLabel("Target terminal", { exact: true })).toHaveValue(source);
    await expect(page.getByLabel("Original goal")).toHaveValue("Keep existing edits and ship the dashboard.");
    await page.getByLabel("Next step", { exact: true }).fill("Connect the API to the page.");
    await page.getByLabel("Progress and context").fill("API ready; response schema preserved.");
    await page.getByRole("button", { name: "Prepare handoff to Claude" }).click();
    await page.getByRole("button", { name: "Open Claude terminal" }).click();
    await expect(page).toHaveURL(new RegExp(source));
    expect((await listTerminals(page)).map(t => t.id).sort()).toEqual([source, target].sort());
    expect(writes).toEqual([]);
  });
}

test("manual handoff handles clipboard denial, save replay, invalid directories and lost control", async ({ page }) => {
  const { source, target } = await setup(page);
  await prepare(page, target);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", {
    configurable: true, value: { writeText: async () => { throw new Error("denied"); } },
  }));
  await page.getByRole("button", { name: "Copy & open Codex" }).click();
  await expect(page).toHaveURL(new RegExp(source));
  await expect(page.getByRole("alert")).toContainText("Copy the selected instructions manually");
  const headers = await getAuthHeaders(page);
  const endpoint = "/api/machines/e2e-node/session-handoffs";
  const response = await page.request.get(`${endpoint}?terminal_id=${source}`, { headers });
  const [record] = await response.json();
  const data = { ...record, device_id: await getDeviceId(page) };
  expect((await page.request.post(endpoint, { headers, data })).status()).toBe(200);
  expect((await page.request.post(endpoint, { headers, data: { ...data, intent: "changed" } })).status()).toBe(409);
  const other = await createTerminalViaApi(page, { cwd: "/root" });
  expect((await page.request.post(endpoint, { headers, data: { ...data, id: "00112233-4455-4677-8899-aabbccddeeff", target_terminal_id: other } })).status()).toBe(409);
  await releaseMachineControl(page);
  await expect(page.getByRole("button", { name: "I’ve submitted it to the agent" })).toBeDisabled();
  expect((await page.request.post(`${endpoint}/${record.id}/confirm`, { headers, data: { device_id: data.device_id } })).status()).toBe(403);
  expect((await page.request.get(`${endpoint}?terminal_id=${source}`)).status()).toBe(401);
});

test("a lost save response retries the same record without losing the instructions", async ({ page }) => {
  const { source, target } = await setup(page);
  const ids: string[] = [];
  await page.route("**/api/machines/e2e-node/session-handoffs", async route => {
    if (route.request().method() !== "POST") return route.continue();
    ids.push(route.request().postDataJSON().id);
    const response = await route.fetch();
    if (ids.length === 1) await route.abort("failed");
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  await page.getByText("Context and destination", { exact: true }).click();
  await page.getByLabel("Target terminal", { exact: true }).selectOption(target);
  await page.getByLabel("Original goal").fill("Keep the draft on connection loss");
  await page.getByLabel("Next step", { exact: true }).fill("Continue implementation");
  await page.getByLabel("Progress and context").fill("Changes not committed");
  await page.getByRole("button", { name: "Prepare handoff to Codex" }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await expect(page.getByLabel("Original goal")).toBeDisabled();
  await page.getByRole("button", { name: "Retry saving handoff" }).click();
  await expect(page.getByLabel("Handoff instructions")).toHaveValue(/Keep the draft on connection loss/);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  const response = await page.request.get(`/api/machines/e2e-node/session-handoffs?terminal_id=${source}`, { headers: await getAuthHeaders(page) });
  expect(await response.json()).toHaveLength(1);
});

test("opening a new target needs only a next step and preserves the source", async ({ page }) => {
  const { source } = await setup(page);
  await page.route("**/foreground-process", route => route.fulfill({
    json: { has_foreground_process: true, process_name: "claude" },
  }));
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("A new terminal will open");
  await page.getByLabel("Next step", { exact: true }).fill("Finish the API");
  const creation = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/machines/e2e-node/terminals"));
  await page.getByRole("button", { name: "Prepare handoff to Codex" }).click();
  expect((await creation).postDataJSON().startup_command).toBe("codex");
  await expect(page.getByLabel("Handoff instructions")).toHaveValue(/Finish the API/);
  await expect(page).toHaveURL(new RegExp(source));
  expect((await listTerminals(page)).length).toBe(3);
});

test("auto detection captures context and only asks for the next step", async ({ page }, testInfo) => {
  const { source, target } = await setup(page);
  await page.evaluate(id => {
    (window as any).__offdeskTerminals.get(id).write("\r\nCONTEXT_MARKER: API design agreed.\r\n");
  }, source);
  await expect.poll(() => page.evaluate(id => {
    const t = (window as any).__offdeskTerminals.get(id);
    return Array.from({ length: t.buffer.active.length }, (_, i) => t.buffer.active.getLine(i)?.translateToString(true)).join("\n");
  }, source)).toContain("CONTEXT_MARKER");
  await expect(page.getByRole("button", { name: "Hand off to Claude", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("textbox")).toHaveCount(1);
  await page.getByLabel("Next step", { exact: true }).fill("Implement the agreed API");
  await page.screenshot({ path: testInfo.outputPath("automatic-handoff.png") });
  await page.getByRole("button", { name: "Prepare handoff to Codex" }).click();
  await expect(page.getByLabel("Handoff instructions")).toHaveValue(/CONTEXT_MARKER/);
  const response = await page.request.get(`/api/machines/e2e-node/session-handoffs?terminal_id=${source}`, { headers: await getAuthHeaders(page) });
  const [record] = await response.json();
  expect(record.target_terminal_id).toBe(target);
  expect(record.goal).toBe("Implement the agreed API");
  expect((await listTerminals(page)).length).toBe(2);
});

test("ambiguous destinations require one explicit choice", async ({ page }) => {
  const { target } = await setup(page);
  await createTerminalViaApi(page, { cwd: "/tmp" });
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  await page.getByLabel("Next step", { exact: true }).fill("Continue");
  await expect(page.getByRole("button", { name: "Prepare handoff to Codex" })).toBeDisabled();
  await page.getByLabel("Choose destination").selectOption(target);
  await expect(page.getByRole("button", { name: "Prepare handoff to Codex" })).toBeEnabled();
});
