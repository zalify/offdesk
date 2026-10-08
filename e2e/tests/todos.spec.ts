import { devices, expect, test, type Page } from "@playwright/test";
import { getAuthHeaders, mobileOpenHostSheet, openApp } from "./helpers";

async function deleteAllTodos(page: Page) {
  const headers = await getAuthHeaders(page);
  const response = await page.request.get("/api/todos", { headers });
  expect(response.ok()).toBeTruthy();
  for (const todo of (await response.json()) as { id: string }[]) {
    expect((await page.request.delete(`/api/todos/${todo.id}`, { headers })).ok()).toBeTruthy();
  }
}

// A describe group cannot switch the browser type, so take only the phone's
// viewport and touch settings; the suite already runs Chromium.
const { defaultBrowserType: _browserType, ...pixel7 } = devices["Pixel 7"];

test.describe("to-dos on a phone", () => {
  test.use(pixel7);

  test("to-dos are added, finished, edited and deleted, and survive a reload", async ({ page }) => {
    await openApp(page);
    await deleteAllTodos(page);
    await page.reload();
    await page.getByTestId("mobile-workbench").waitFor();

    await mobileOpenHostSheet(page);
    await page.getByTestId("mobile-menu-todos").click();
    const panel = page.getByTestId("todos-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("My to-dos · 0");

    const input = panel.getByTestId("todo-new-input");
    await input.fill("  Renew the   certificate ");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    const row = panel.locator('[data-testid^="todo-row-"]').filter({ hasText: "Renew the certificate" });
    await expect(row).toBeVisible();
    await input.fill("Write release notes");
    await panel.getByTestId("todo-add").click();
    await expect(panel).toContainText("My to-dos · 2");
    // Newest on top.
    await expect(panel.locator('[data-testid^="todo-open-"]').first()).toContainText("Write release notes");

    // Stored on the Hub: a reload shows the same list, and the menu counts it.
    await page.reload();
    await page.getByTestId("mobile-workbench").waitFor();
    await mobileOpenHostSheet(page);
    await expect(page.getByTestId("mobile-menu-todos")).toContainText("2");
    await page.getByTestId("mobile-menu-todos").click();
    await expect(panel).toContainText("Renew the certificate");

    // Finish one: it moves into the collapsed Done section.
    await panel.getByRole("checkbox", { name: "Done: Renew the certificate" }).click();
    await expect(panel).toContainText("My to-dos · 1");
    await panel.getByTestId("todos-done-toggle").click();
    await expect(panel.getByRole("checkbox", { name: "Reopen: Renew the certificate" })).toBeChecked();

    // Edit the other in its detail view.
    await panel.locator('[data-testid^="todo-open-"]').filter({ hasText: "Write release notes" }).click();
    const detail = panel.getByTestId("todo-detail");
    await detail.getByTestId("todo-notes-input").fill("Cover the hand-off");
    await detail.getByTestId("todo-machine-select").selectOption({ index: 1 });
    await detail.getByTestId("todo-folder-input").fill("/root/projects/offdesk");
    await detail.getByTestId("todo-save").click();
    await expect(detail).toHaveCount(0);
    const edited = panel.locator('[data-testid^="todo-row-"]').filter({ hasText: "Write release notes" });
    await expect(edited).toContainText("offdesk");
    await expect(edited).toContainText("Cover the hand-off");

    // Delete takes a second tap.
    await edited.locator('[data-testid^="todo-open-"]').click();
    await detail.getByTestId("todo-delete").click();
    await expect(detail.getByTestId("todo-delete")).toHaveText("Tap again to delete");
    await detail.getByTestId("todo-delete").click();
    await expect(panel).not.toContainText("Write release notes");

    const headers = await getAuthHeaders(page);
    const stored = (await (await page.request.get("/api/todos", { headers })).json()) as { title: string; status: string }[];
    expect(stored).toEqual([expect.objectContaining({ title: "Renew the certificate", status: "done" })]);
  });
});

test("a to-do added on one device appears on another without a reload", async ({ browser }) => {
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const phone = await browser.newContext({ ...devices["Pixel 7"] });
  const desktopPage = await desktop.newPage();
  const phonePage = await phone.newPage();
  try {
    await openApp(desktopPage);
    await deleteAllTodos(desktopPage);
    await openApp(phonePage);

    await desktopPage.getByTestId("tab-bar-todos").click();
    const desktopPanel = desktopPage.getByTestId("todos-panel");
    await expect(desktopPanel).toContainText("My to-dos · 0");

    await mobileOpenHostSheet(phonePage);
    await phonePage.getByTestId("mobile-menu-todos").click();
    const phonePanel = phonePage.getByTestId("todos-panel");
    await phonePanel.getByTestId("todo-new-input").fill("Check the Web Pixel backfill");
    await phonePanel.getByTestId("todo-new-input").press("Enter");

    await expect(desktopPanel).toContainText("Check the Web Pixel backfill");
    await expect(desktopPage.getByTestId("tab-bar-todos")).toHaveAttribute("aria-label", "To-dos, 1 open");

    await desktopPanel.getByRole("checkbox", { name: "Done: Check the Web Pixel backfill" }).click();
    await expect(phonePanel).toContainText("My to-dos · 0");
  } finally {
    await desktop.close();
    await phone.close();
  }
});
