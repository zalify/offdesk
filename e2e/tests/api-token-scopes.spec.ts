import { expect, test } from "@playwright/test";
import { getAuthHeaders, mobileOpenHostSheet, openApp } from "./helpers";

for (const width of [1280, 390]) {
  test(`a new token reaches agent runs only, unless full access is chosen, at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openApp(page);
    if (await page.getByTestId("mobile-workbench").isVisible()) await mobileOpenHostSheet(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const name = page.getByPlaceholder("Token name (e.g. cli)");
    await name.scrollIntoViewIfNeeded();
    // Narrow by default: agent runs only, seeing runs
    await expect(page.getByRole("radio", { name: "Agent runs only" })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "See runs" })).toBeChecked();
    await page.getByRole("checkbox", { name: "Answer questions" }).check();
    await page.getByLabel("It sees").selectOption("requests");
    // Starting agents asks for folders
    await page.getByRole("checkbox", { name: "Start agents" }).check();
    await expect(page.getByPlaceholder("~/work")).toBeVisible();
    await page.getByRole("checkbox", { name: "Start agents" }).uncheck();
    // Full access says what it means
    await page.getByRole("radio", { name: "Full access" }).check();
    await expect(page.getByText("remote code execution on every machine", { exact: false })).toBeVisible();
    await page.getByRole("radio", { name: "Agent runs only" }).check();

    await name.fill(`notifier-${width}`);
    await page.getByRole("button", { name: "Create", exact: true }).click();
    const created = page.locator('input[readonly][value^="odk_"]');
    await expect(created).toBeVisible();
    const token = await created.inputValue();
    await expect(page.getByText("runs:read, runs:answer · status and what they ask").first()).toBeVisible();
    await page.screenshot({ path: `e2e/artifacts/api-token-scopes-${width}.png` });

    // The token reads runs but can't touch terminals; the app's own session still can
    const status = (path: string, auth: Record<string, string>) =>
      page.evaluate(
        async ({ path, auth }) => (await fetch(path, { headers: auth })).status,
        { path, auth },
      );
    const scoped = { Authorization: `Bearer ${token}` };
    expect(await status("/api/agent-runs", scoped)).toBe(200);
    expect(await status("/api/terminals", scoped)).toBe(403);
    expect(await status("/api/auth/api-tokens", scoped)).toBe(403);
    expect(await status("/api/terminals", await getAuthHeaders(page))).toBe(200);
  });
}
