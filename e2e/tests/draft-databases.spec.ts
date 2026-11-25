import { test, expect, devices, type Page } from "@playwright/test";
import { getAuthHeaders, openApp } from "./helpers";

// Draft databases: Notion-style tables whose rows are drafts. Everything is
// seeded through the hub REST API; the UI is driven through the drafts drawer.

const GROUP = "e2e-draftdb";

interface Column {
  id: string;
  name: string;
  type: string;
}
interface Database {
  id: string;
  name: string;
  columns: Column[];
  views: Array<{ id: string; name: string; type: string; filters: unknown[]; sorts: unknown[] }>;
}
interface Row {
  id: string;
  title: string;
  properties: Record<string, unknown>;
}

const created: string[] = [];

function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function createDatabase(
  page: Page,
  name: string,
  columns: Array<{ name: string; type: string; options?: Array<{ name: string }> }>,
): Promise<Database> {
  const resp = await page.request.post("/api/draft-databases", {
    headers: await getAuthHeaders(page),
    data: { name, project_group: GROUP, columns },
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const db = (await resp.json()) as Database;
  created.push(db.id);
  return db;
}

async function addRows(
  page: Page,
  dbId: string,
  rows: Array<{ title: string; properties?: Record<string, unknown>; content?: string }>,
): Promise<Row[]> {
  const out: Row[] = [];
  // The hub accepts at most 500 rows per request.
  for (let i = 0; i < rows.length; i += 400) {
    const resp = await page.request.post(`/api/draft-databases/${dbId}/rows`, {
      headers: await getAuthHeaders(page),
      data: { rows: rows.slice(i, i + 400), on_conflict: "create" },
      timeout: 60_000,
    });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    out.push(...((await resp.json()) as { rows: Row[] }).rows);
  }
  return out;
}

async function getRow(page: Page, dbId: string, rowId: string): Promise<Row> {
  const resp = await page.request.get(`/api/draft-databases/${dbId}/rows/${rowId}`, {
    headers: await getAuthHeaders(page),
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return (await resp.json()) as Row;
}

const STATUSES = ["todo", "doing", "done"];

/**
 * A database with every column type and 8 rows. `doneFirst` puts the checkbox
 * right after the title so it is on screen without horizontal scrolling on a phone.
 */
async function seedTasks(page: Page, opts: { doneFirst?: boolean } = {}) {
  const name = uniqueName("e2e-tasks");
  const status = { name: "Status", type: "select", options: STATUSES.map((n) => ({ name: n })) };
  const rest = [
    { name: "Points", type: "number" },
    { name: "Tags", type: "multi_select", options: [{ name: "alpha" }, { name: "beta" }] },
    { name: "Due", type: "date" },
    { name: "Link", type: "url" },
  ];
  const done = { name: "Done", type: "checkbox" };
  const columns = opts.doneFirst ? [done, status, ...rest] : [status, ...rest.slice(0, 1), done, ...rest.slice(1)];
  const db = await createDatabase(page, name, columns);
  const titles = ["Alpha task", "Bravo task", "Charlie task", "Delta task", "Echo task", "Foxtrot task", "Golf task", "Hotel task"];
  const rows = await addRows(
    page,
    db.id,
    titles.map((title, i) => ({
      title,
      properties: {
        Status: STATUSES[i % 3],
        Points: (i + 1) * 10,
        Done: false,
        Tags: i % 2 === 0 ? ["alpha"] : ["alpha", "beta"],
        Due: `2026-12-${String(i + 1).padStart(2, "0")}`,
        Link: `https://example.com/${i}`,
      },
      content: i === 0 ? "# Spec heading\n\nBody paragraph written by the e2e seed." : undefined,
    })),
  );
  const col = (n: string) => db.columns.find((c) => c.name === n)!.id;
  return { db, rows, col, name };
}

async function openDatabasesDrawer(page: Page, phone = false): Promise<void> {
  const opener = page.getByTestId(phone ? "mobile-title-bar-drafts" : "status-drafts");
  if (phone) await opener.tap();
  else await opener.click();
  await expect(page.getByTestId("drafts-drawer")).toBeVisible();
  const tab = page.getByTestId("drafts-mode-databases");
  if (phone) await tab.tap();
  else await tab.click();
}

async function openDatabase(page: Page, dbId: string, phone = false): Promise<void> {
  await openDatabasesDrawer(page, phone);
  const item = page.getByTestId(`draftdb-list-item-${dbId}`);
  await expect(item).toBeVisible({ timeout: 15_000 });
  if (phone) await item.tap();
  else await item.click();
  await expect(page.getByTestId("draftdb-name")).toBeVisible();
}

test.afterEach(async ({ page }) => {
  // Best effort: leave no databases behind for other specs.
  const ids = created.splice(0);
  if (ids.length === 0) return;
  const headers = await getAuthHeaders(page).catch(() => null);
  if (!headers) return;
  for (const id of ids) await page.request.delete(`/api/draft-databases/${id}`, { headers }).catch(() => undefined);
});

test.describe("draft databases (desktop)", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("open the drawer, list databases, open one and see its rows", async ({ page }) => {
    await openApp(page);
    const { db, rows } = await seedTasks(page);
    await openDatabase(page, db.id);
    await expect(page.getByTestId("draftdb-table")).toBeVisible();
    await expect(page.getByTestId("draftdb-total")).toHaveText("8 rows");
    for (const r of rows) await expect(page.getByTestId(`draftdb-row-${r.id}`)).toContainText(r.title);
  });

  test("editing a number cell and a select cell persists through the REST API", async ({ page }) => {
    await openApp(page);
    const { db, rows, col } = await seedTasks(page);
    await openDatabase(page, db.id);
    const alpha = rows.find((r) => r.title === "Alpha task")!;

    const points = page.getByTestId(`draftdb-cell-${alpha.id}-${col("Points")}`);
    await points.click();
    await points.locator("input").fill("77");
    await points.locator("input").press("Enter");
    await expect.poll(async () => (await getRow(page, db.id, alpha.id)).properties[col("Points")]).toBe(77);

    // Alpha starts as "todo".
    await page.getByTestId(`draftdb-cell-${alpha.id}-${col("Status")}`).click();
    const picker = page.getByTestId("draftdb-option-picker");
    await expect(picker).toBeVisible();
    await picker.getByRole("button", { name: "done", exact: true }).click();
    await expect.poll(async () => (await getRow(page, db.id, alpha.id)).properties[col("Status")]).toBe("done");
    await expect(page.getByTestId(`draftdb-cell-${alpha.id}-${col("Status")}`)).toContainText("done");
  });

  test("a checkbox toggles from anywhere in its cell", async ({ page }) => {
    await openApp(page);
    const { db, rows, col } = await seedTasks(page, { doneFirst: true });
    await openDatabase(page, db.id);
    const bravo = rows.find((r) => r.title === "Bravo task")!;
    const cell = page.getByTestId(`draftdb-cell-${bravo.id}-${col("Done")}`);
    await cell.scrollIntoViewIfNeeded();
    // Click the right edge of the cell, well away from the 22px box.
    const box = (await cell.boundingBox())!;
    await page.mouse.click(box.x + box.width - 8, box.y + box.height / 2);
    await expect.poll(async () => (await getRow(page, db.id, bravo.id)).properties[col("Done")]).toBe(true);
  });

  test("adding a row from the footer creates it on the hub", async ({ page }) => {
    await openApp(page);
    const { db } = await seedTasks(page);
    await openDatabase(page, db.id);
    await page.getByTestId("draftdb-new-row").fill("Zulu needle row");
    await page.getByTestId("draftdb-new-row").press("Enter");
    await expect(page.getByTestId("draftdb-total")).toHaveText("9 rows");
    await expect(page.getByText("Zulu needle row")).toBeVisible();
    const resp = await page.request.post(`/api/draft-databases/${db.id}/rows/query`, {
      headers: await getAuthHeaders(page),
      data: { search: "needle" },
    });
    expect(((await resp.json()) as { total: number }).total).toBe(1);
  });

  test("search narrows the table and clearing it restores every row", async ({ page }) => {
    await openApp(page);
    const { db, rows } = await seedTasks(page);
    await openDatabase(page, db.id);
    await page.getByTestId("draftdb-search").fill("hotel");
    await expect(page.getByTestId("draftdb-total")).toHaveText("1 row");
    await expect(page.getByTestId(`draftdb-row-${rows.find((r) => r.title === "Hotel task")!.id}`)).toBeVisible();
    await page.getByTestId("draftdb-search").fill("");
    await expect(page.getByTestId("draftdb-total")).toHaveText("8 rows");
  });

  test("a select filter narrows the table", async ({ page }) => {
    await openApp(page);
    const { db } = await seedTasks(page);
    const todo = Math.ceil(8 / 3); // rows 0, 3, 6
    await openDatabase(page, db.id);
    await page.getByTestId("draftdb-filter-button").click();
    await page.getByTestId("draftdb-add-filter").click();
    const filter = page.getByTestId("draftdb-filter-0");
    await filter.locator("select").nth(0).selectOption({ label: "Status" });
    await filter.locator("select").nth(2).selectOption("todo");
    await expect(page.getByTestId("draftdb-total")).toHaveText(`${todo} rows`);
  });

  test("a row opens as a page with its markdown body", async ({ page }) => {
    await openApp(page);
    const { db, rows } = await seedTasks(page);
    await openDatabase(page, db.id);
    const alpha = rows.find((r) => r.title === "Alpha task")!;
    await page.getByTestId(`draftdb-row-open-${alpha.id}`).click();
    await expect(page.getByTestId("draftdb-row-page")).toBeVisible();
    const body = page.getByTestId("draftdb-row-body-preview");
    await expect(body.getByRole("heading", { name: "Spec heading" })).toBeVisible();
    await expect(body).toContainText("Body paragraph written by the e2e seed.");
    await page.getByTestId("draftdb-row-back").click();
    await expect(page.getByTestId("draftdb-table")).toBeVisible();
  });

  test("a row changed through the REST API shows up in the open table", async ({ page }) => {
    await openApp(page);
    const { db, rows } = await seedTasks(page);
    await openDatabase(page, db.id);
    const echo = rows.find((r) => r.title === "Echo task")!;
    await expect(page.getByTestId(`draftdb-row-${echo.id}`)).toContainText("Echo task");
    const resp = await page.request.patch(`/api/draft-databases/${db.id}/rows/${echo.id}`, {
      headers: await getAuthHeaders(page),
      data: { title: "Echo renamed by agent" },
    });
    expect(resp.ok(), await resp.text()).toBeTruthy();
    // The table polls every 5 s.
    await expect(page.getByTestId(`draftdb-row-${echo.id}`)).toContainText("Echo renamed by agent", { timeout: 20_000 });
  });

  test("a 1200-row table scrolls to the end while the DOM stays small", async ({ page }) => {
    await openApp(page);
    const db = await createDatabase(page, uniqueName("e2e-big"), [{ name: "N", type: "number" }]);
    await addRows(
      page,
      db.id,
      Array.from({ length: 1200 }, (_, i) => ({ title: `Row ${String(i + 1).padStart(4, "0")}`, properties: { N: i + 1 } })),
    );
    // Sort by title so the last row is deterministic (created_at can tie inside one batch).
    const view = db.views[0];
    const patched = await page.request.patch(`/api/draft-databases/${db.id}`, {
      headers: await getAuthHeaders(page),
      data: { views: [{ ...view, sorts: [{ column: "title", dir: "asc" }] }] },
    });
    expect(patched.ok(), await patched.text()).toBeTruthy();

    await openDatabase(page, db.id);
    await expect(page.getByTestId("draftdb-total")).toHaveText(/^1[,.\s]?200 rows$/);
    await expect(page.getByText("Row 0001", { exact: true })).toBeVisible();

    const rowElements = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll('[data-testid^="draftdb-row-"]')].filter(
            (e) => !(e.getAttribute("data-testid") ?? "").startsWith("draftdb-row-open-"),
          ).length,
      );
    expect(await rowElements()).toBeLessThan(150);

    await page.getByTestId("draftdb-scroller").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await expect(page.getByText("Row 1200", { exact: true })).toBeVisible({ timeout: 15_000 });
    expect(await rowElements()).toBeLessThan(150);
  });

  test("a board view groups rows by status and a card moves with the 'move to…' control", async ({ page }) => {
    await openApp(page);
    const { db, rows, col } = await seedTasks(page);
    await openDatabase(page, db.id);
    await page.getByTestId("draftdb-add-view").click();
    await page.getByTestId("draftdb-add-view-board").click();
    await expect(page.getByTestId("draftdb-board")).toBeVisible();
    // 8 rows cycle todo, doing, done, ... => 3 / 3 / 2.
    await expect(page.getByTestId("draftdb-board-count-todo")).toHaveText("3");
    await expect(page.getByTestId("draftdb-board-count-doing")).toHaveText("3");
    await expect(page.getByTestId("draftdb-board-count-done")).toHaveText("2");
    await expect(page.getByTestId("draftdb-board-column-__none__")).toHaveCount(0);

    const alpha = rows.find((r) => r.title === "Alpha task")!;
    await expect(page.getByTestId("draftdb-board-column-todo").getByTestId(`draftdb-card-${alpha.id}`)).toBeVisible();
    await page.getByTestId(`draftdb-card-move-${alpha.id}`).click();
    await page.getByTestId("draftdb-move-to-doing").click();

    await expect(page.getByTestId("draftdb-board-column-doing").getByTestId(`draftdb-card-${alpha.id}`)).toBeVisible();
    await expect(page.getByTestId("draftdb-board-count-doing")).toHaveText("4");
    await expect(page.getByTestId("draftdb-board-count-todo")).toHaveText("2");
    await expect.poll(async () => (await getRow(page, db.id, alpha.id)).properties[col("Status")]).toBe("doing");

    // "+ new" in a column creates a row with that column's value.
    await page.getByTestId("draftdb-board-new-done").click();
    await page.getByTestId("draftdb-board-new-input-done").fill("Board made card");
    await page.getByTestId("draftdb-board-new-input-done").press("Enter");
    await expect(page.getByTestId("draftdb-board-count-done")).toHaveText("3");
    const q = await page.request.post(`/api/draft-databases/${db.id}/rows/query`, {
      headers: await getAuthHeaders(page),
      data: { search: "Board made card" },
    });
    const made = ((await q.json()) as { rows: Row[] }).rows;
    expect(made).toHaveLength(1);
    expect(made[0].properties[col("Status")]).toBe("done");
  });

  test("a database fence in a draft renders a read-only view with an open button", async ({ page }) => {
    await openApp(page);
    const { db, name } = await seedTasks(page);
    const headers = await getAuthHeaders(page);
    const views = await page.request.patch(`/api/draft-databases/${db.id}`, {
      headers,
      data: { views: [...db.views, { name: "By status", type: "board", group_by: "status", filters: [], sorts: [] }] },
    });
    expect(views.ok(), await views.text()).toBeTruthy();
    const title = uniqueName("e2e-embed");
    const draft = await page.request.post("/api/drafts", {
      headers,
      data: {
        title,
        project_group: GROUP,
        content: `# Plan\n\n\`\`\`database\n${name}\nview: By status\n\`\`\`\n\n\`\`\`database\nno-such-database-e2e\n\`\`\`\n`,
      },
    });
    expect(draft.ok(), await draft.text()).toBeTruthy();
    const draftId = ((await draft.json()) as { id: string }).id;

    try {
      await page.getByTestId("status-drafts").click();
      await page.getByTestId(`draft-card-${draftId}`).click();
      const embeds = page.getByTestId("draft-artifact-database");
      const embed = embeds.first();
      await expect(embed).toHaveAttribute("data-state", "ready");
      await expect(embed).toContainText(name);
      await expect(embed.getByTestId("draftdb-board")).toBeVisible();
      await expect(embed.getByTestId("draftdb-board-count-todo")).toHaveText("3");
      // Read-only: no move controls on the cards.
      await expect(embed.locator('[data-testid^="draftdb-card-move-"]')).toHaveCount(0);
      // The unknown database is a quiet note, not an error.
      await expect(embeds.nth(1)).toHaveAttribute("data-state", "note");
      await expect(embeds.nth(1)).toContainText("not found");

      await embed.getByTestId("draft-artifact-database-open").click();
      await expect(page.getByTestId("draftdb-name")).toHaveText(name);
      await expect(page.getByTestId("draftdb-board")).toBeVisible();
    } finally {
      await page.request.delete(`/api/drafts/${draftId}`, { headers }).catch(() => undefined);
    }
  });
});

test.describe("draft databases (phone)", () => {
  // Same device as the other phone specs; browserName cannot be set inside a describe,
  // so drop the device's WebKit default and keep the project's browser.
  const { defaultBrowserType: _unused, ...phone } = devices["iPhone 14"];
  void _unused;
  test.use(phone);

  test("open a database, toggle a checkbox, switch to the board", async ({ page }) => {
    await openApp(page);
    const { db, rows, col } = await seedTasks(page, { doneFirst: true });
    await openDatabase(page, db.id, true);
    await expect(page.getByTestId("draftdb-table")).toBeVisible();
    // The short placeholder fits the phone's input.
    await expect(page.getByTestId("draftdb-new-row")).toHaveAttribute("placeholder", "+ new row");

    const alpha = rows.find((r) => r.title === "Alpha task")!;
    await expect(page.getByTestId(`draftdb-row-${alpha.id}`)).toBeVisible();
    await page.getByTestId(`draftdb-cell-${alpha.id}-${col("Done")}`).tap();
    await expect.poll(async () => (await getRow(page, db.id, alpha.id)).properties[col("Done")]).toBe(true);

    await page.getByTestId("draftdb-add-view").tap();
    await page.getByTestId("draftdb-add-view-board").tap();
    await expect(page.getByTestId("draftdb-board")).toBeVisible();
    // Done is the first select/checkbox column, so the board groups by it.
    await expect(page.getByTestId("draftdb-board-column-true")).toBeVisible();
    await expect(page.getByTestId("draftdb-board-count-true")).toHaveText("1");
    await expect(page.getByTestId("draftdb-board-count-false")).toHaveText("7");
    await expect(page.getByTestId(`draftdb-card-${alpha.id}`)).toBeVisible();
  });
});
