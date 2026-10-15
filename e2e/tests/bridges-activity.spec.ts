import { expect, test } from "@playwright/test";
import { getAuthHeaders, mobileOpenHostSheet, openApp } from "./helpers";

for (const width of [1280, 390]) {
  test(`Settings shows bridges and what tokens did at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openApp(page);
    const auth = await getAuthHeaders(page);

    // A narrow token tries something outside its scopes: that's activity to show
    const token = await page.evaluate(async (headers) => {
      const made = await fetch("/api/auth/api-tokens", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ name: "e2e-reader", access: { scopes: ["runs:read"] } }),
      });
      return (await made.json()).token as string;
    }, auth);
    const refused = await page.evaluate(
      async (bearer) => (await fetch("/api/terminals", { headers: { Authorization: `Bearer ${bearer}` } })).status,
      token,
    );
    expect(refused).toBe(403);

    if (await page.getByTestId("mobile-workbench").isVisible()) await mobileOpenHostSheet(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Pair a bridge with a server that isn't there: it says so, and can be removed
    const name = page.getByLabel("Bridge name");
    await name.scrollIntoViewIfNeeded();
    await name.fill(`nowhere-${width}`);
    await page.getByLabel("Bridge URL").fill("ws://127.0.0.1:9/bridge");
    await page.getByLabel("Pairing code").fill("AB12-CD34");
    await page.getByRole("group", { name: "New bridge" }).getByRole("checkbox", { name: "Answer questions" }).check();
    await page.getByRole("button", { name: "Pair bridge" }).click();
    const row = page.getByRole("group", { name: `Bridge nowhere-${width}` });
    await expect(row).toBeVisible();
    await expect(row.getByText("runs:read, runs:answer · status only")).toBeVisible();
    await expect(row.getByText(/not paired: couldn't connect|connecting/)).toBeVisible();
    await expect(row.getByText("not paired: couldn't connect")).toBeVisible({ timeout: 15_000 });
    // A webhook list doesn't show bridges
    await expect(page.getByRole("group", { name: `Webhook nowhere-${width}` })).toHaveCount(0);

    // Activity: the refused request, by the token's name
    const activity = page.getByRole("heading", { name: "Activity" });
    await activity.scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(page.getByText("GET /api/terminals").first()).toBeVisible();
    await expect(page.getByText("outside its scopes").first()).toBeVisible();
    await page.screenshot({ path: `e2e/artifacts/bridges-activity-${width}.png` });

    await row.getByRole("button", { name: "Remove" }).click();
    await row.getByRole("button", { name: "Confirm?" }).click();
    await expect(row).toHaveCount(0);
  });
}
