import { expect, test, type Page } from "@playwright/test";
import { createTerminalViaApi, expandTerminalById, getAuthHeaders, getDeviceId, listTerminals,
  openApp, releaseMachineControl, requestMachineControl, resetMachineState } from "./helpers";

async function setup(page: Page) {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const source = await createTerminalViaApi(page, { cwd: "/tmp" });
  const target = await createTerminalViaApi(page, { cwd: "/tmp" });
  await expandTerminalById(page, source);
  await expect(page.getByRole("button", { name: "Hand off to Codex", exact: true })).toBeEnabled();
  return { source, target };
}

async function prepare(page: Page, target: string) {
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Hand off this session" });
  await dialog.getByLabel("Target terminal", { exact: true }).selectOption(target);
  await dialog.getByLabel("Original goal").fill("Keep existing edits and ship the dashboard.");
  await dialog.getByLabel("Next step", { exact: true }).fill("Implement the metrics API.");
  await dialog.getByLabel("Progress and context").fill("Page is ready. Tests have not run. Preserve the response schema.");
  await dialog.getByLabel("Artifact paths (optional)").fill("assets/chart preview.png — example chart");
  await expect(dialog.getByRole("button", { name: "Prepare handoff to Codex" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
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
    await expect(page.getByRole("combobox", { name: "Source agent", exact: true })).toHaveValue("codex");
    await expect(page.getByLabel("Target terminal", { exact: true })).toHaveValue(source);
    await expect(page.getByLabel("Original goal")).toHaveValue("Keep existing edits and ship the dashboard.");
    await page.getByLabel("Next step", { exact: true }).fill("Connect the API to the page.");
    await page.getByLabel("Progress and context").fill("API ready; response schema preserved.");
    await page.getByRole("checkbox").check();
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
  await page.getByLabel("Target terminal", { exact: true }).selectOption(target);
  await page.getByLabel("Original goal").fill("Keep the draft on connection loss");
  await page.getByLabel("Next step", { exact: true }).fill("Continue implementation");
  await page.getByLabel("Progress and context").fill("Changes not committed");
  await page.getByRole("checkbox").check();
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

test("opening a new target keeps the source draft and only launches the chosen CLI", async ({ page }, testInfo) => {
  const { source } = await setup(page);
  await page.getByRole("button", { name: "Hand off to Codex", exact: true }).click();
  await page.getByLabel("Original goal").fill("Preserve this draft");
  const creation = page.waitForRequest(request => request.method() === "POST" && request.url().endsWith("/api/machines/e2e-node/terminals"));
  await page.getByRole("button", { name: "Open new Codex terminal" }).click();
  expect((await creation).postDataJSON().startup_command).toBe("codex");
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Opened a new Codex terminal");
  await expect(page).toHaveURL(new RegExp(source));
  await expect(page.getByLabel("Original goal")).toHaveValue("Preserve this draft");
  expect((await listTerminals(page)).length).toBe(3);
  await page.screenshot({ path: testInfo.outputPath("handoff-draft.png") });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("direct Claude button presets the opposite direction", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Hand off to Claude", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Source agent", exact: true })).toHaveValue("codex");
  await expect(page.getByRole("button", { name: "Open new Claude terminal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Prepare handoff to Claude" })).toBeDisabled();
});
