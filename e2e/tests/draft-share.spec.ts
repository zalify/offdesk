import { test, expect, type Browser, type Page } from "@playwright/test";
import { getAuthHeaders, openApp } from "./helpers";

// Draft public sharing + version history. Data is seeded through the hub REST
// API; links are created and revoked through the drafts drawer; the public
// page is always opened in a fresh browser context with no storage or auth.

const GROUP = "e2e-draftshare";

interface DraftRow {
  id: string;
  title: string;
  content: string;
  pinned?: boolean;
}

const createdDrafts: string[] = [];
const createdDbs: string[] = [];

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function seedDraft(page: Page, title: string, content: string): Promise<DraftRow> {
  const resp = await page.request.post("/api/drafts", {
    headers: await getAuthHeaders(page),
    data: { title, content, project_group: GROUP, force_new: true },
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const draft = (await resp.json()) as DraftRow;
  createdDrafts.push(draft.id);
  return draft;
}

async function patchDraft(page: Page, id: string, patch: { title?: string; content?: string }): Promise<DraftRow> {
  const resp = await page.request.patch(`/api/drafts/${id}`, { headers: await getAuthHeaders(page), data: patch });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  return (await resp.json()) as DraftRow;
}

async function getDraft(page: Page, id: string): Promise<DraftRow> {
  const resp = await page.request.get("/api/drafts?include_archived=true", { headers: await getAuthHeaders(page) });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const found = ((await resp.json()) as DraftRow[]).find((d) => d.id === id);
  expect(found, `draft ${id} should exist`).toBeTruthy();
  return found!;
}

async function openDrafts(page: Page): Promise<void> {
  await page.getByTestId("status-drafts").click();
  await expect(page.getByTestId("drafts-drawer")).toBeVisible();
}

async function openDraftDetail(page: Page, id: string): Promise<void> {
  await openDrafts(page);
  const card = page.getByTestId(`draft-card-${id}`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByTestId("draft-share-button")).toBeVisible();
}

/** Creates a draft share from the open detail view and returns its public path. */
async function createShareFromUi(page: Page, mode: "snapshot" | "live"): Promise<string> {
  await page.getByTestId("draft-share-button").click();
  await expect(page.getByTestId("draft-share-panel")).toBeVisible();
  await page.getByTestId(`draft-share-mode-${mode}`).click();
  await page.getByTestId("draft-share-create").click();
  const url = page.locator('[data-testid^="draft-share-url-"]').first();
  await expect(url).toBeVisible({ timeout: 15_000 });
  const shareUrl = await url.getAttribute("data-url");
  expect(shareUrl).toContain("/s/");
  // The origin comes from the hub's OFFDESK_BASE_URL, which may not be the origin
  // Playwright uses; only the path matters.
  return new URL(shareUrl!).pathname;
}

async function freshContextPage(browser: Browser, baseURL: string) {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  return { context, page };
}

test.afterEach(async ({ page }) => {
  const headers = await getAuthHeaders(page).catch(() => null);
  const drafts = createdDrafts.splice(0);
  const dbs = createdDbs.splice(0);
  if (!headers) return;
  for (const id of drafts) await page.request.delete(`/api/drafts/${id}`, { headers }).catch(() => undefined);
  for (const id of dbs) await page.request.delete(`/api/draft-databases/${id}`, { headers }).catch(() => undefined);
});

test.describe("draft sharing", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("snapshot share is public, sandboxed, and frozen against later edits", async ({ page, browser, baseURL }) => {
    await openApp(page);
    const title = unique("Snapshot title");
    const draft = await seedDraft(page, title, "# Heading\n\nsnapshot body marker one");
    await openDraftDetail(page, draft.id);
    const path = await createShareFromUi(page, "snapshot");

    const { context, page: pub } = await freshContextPage(browser, baseURL!);
    try {
      const resp = await pub.goto(path);
      expect(resp?.status()).toBe(200);
      expect(resp?.headers()["content-security-policy"] ?? "").toContain("sandbox");
      await expect(pub.locator("h1").first()).toContainText(title, { timeout: 15_000 });
      await expect(pub.getByText("snapshot body marker one")).toBeVisible();

      await patchDraft(page, draft.id, { content: "# Heading\n\nsnapshot body marker two" });
      await pub.reload();
      await expect(pub.locator("h1").first()).toContainText(title, { timeout: 15_000 });
      await expect(pub.getByText("snapshot body marker one")).toBeVisible();
      await expect(pub.getByText("snapshot body marker two")).toHaveCount(0);
    } finally {
      await context.close();
    }

    // Sharing pins the draft on the hub so the 7-day auto-archive never hides it.
    await expect.poll(async () => (await getDraft(page, draft.id)).pinned).toBe(true);
    await expect(page.getByRole("button", { name: "Pinned" })).toBeVisible();
  });

  test("live share reflects edits after reload", async ({ page, browser, baseURL }) => {
    await openApp(page);
    const title = unique("Live title");
    const draft = await seedDraft(page, title, "live body marker one");
    await openDraftDetail(page, draft.id);
    const path = await createShareFromUi(page, "live");

    const { context, page: pub } = await freshContextPage(browser, baseURL!);
    try {
      await pub.goto(path);
      await expect(pub.getByText("live body marker one")).toBeVisible({ timeout: 15_000 });
      await patchDraft(page, draft.id, { content: "live body marker two" });
      await pub.reload();
      await expect(pub.getByText("live body marker two")).toBeVisible({ timeout: 15_000 });
      await expect(pub.getByText("live body marker one")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("revoking from the UI makes the public URL 404", async ({ page, browser, baseURL }) => {
    await openApp(page);
    const draft = await seedDraft(page, unique("Revoke title"), "revoke body");
    await openDraftDetail(page, draft.id);
    const path = await createShareFromUi(page, "snapshot");

    const { context, page: pub } = await freshContextPage(browser, baseURL!);
    try {
      expect((await pub.goto(path))?.status()).toBe(200);

      const item = page.locator('[data-testid^="draft-share-item-"]').first();
      await item.locator('[data-testid^="draft-share-revoke-"]').click();
      await item.locator('[data-testid^="draft-share-revoke-confirm-"]').click();
      await expect(page.locator('[data-testid^="draft-share-item-"]')).toHaveCount(0);

      expect((await pub.goto(path))?.status()).toBe(404);
    } finally {
      await context.close();
    }
  });

  test("a shared database view only exposes rows matching its filter", async ({ page, browser, baseURL }) => {
    await openApp(page);
    const headers = await getAuthHeaders(page);
    const name = unique("e2e-share-db");
    const dbResp = await page.request.post("/api/draft-databases", {
      headers,
      data: {
        name,
        project_group: GROUP,
        columns: [{ name: "Status", type: "select", options: [{ name: "todo" }, { name: "done" }] }],
      },
    });
    expect(dbResp.ok(), await dbResp.text()).toBeTruthy();
    const db = (await dbResp.json()) as { id: string; views: Array<{ id: string; name: string; type: string }> };
    createdDbs.push(db.id);

    const visible = unique("Visible row");
    const hidden = unique("Hidden row");
    const rowsResp = await page.request.post(`/api/draft-databases/${db.id}/rows`, {
      headers,
      data: {
        rows: [
          { title: visible, properties: { Status: "todo" } },
          { title: hidden, properties: { Status: "done" } },
        ],
        on_conflict: "create",
      },
    });
    expect(rowsResp.ok(), await rowsResp.text()).toBeTruthy();

    const view = db.views[0];
    const patchResp = await page.request.patch(`/api/draft-databases/${db.id}`, {
      headers,
      data: { views: [{ ...view, filters: [{ column: "Status", op: "eq", value: "todo" }], sorts: [] }] },
    });
    expect(patchResp.ok(), await patchResp.text()).toBeTruthy();

    await openDrafts(page);
    await page.getByTestId("drafts-mode-databases").click();
    const listItem = page.getByTestId(`draftdb-list-item-${db.id}`);
    await expect(listItem).toBeVisible({ timeout: 15_000 });
    await listItem.click();
    await expect(page.getByTestId("draftdb-name")).toBeVisible();

    await page.getByTestId("draft-share-button").click();
    await expect(page.getByTestId("draft-share-panel")).toBeVisible();
    await expect(page.getByTestId("draft-share-mode-snapshot")).toHaveCount(0);
    await page.getByTestId("draft-share-create").click();
    const url = page.locator('[data-testid^="draft-share-url-"]').first();
    await expect(url).toBeVisible({ timeout: 15_000 });
    const path = new URL((await url.getAttribute("data-url"))!).pathname;

    const { context, page: pub } = await freshContextPage(browser, baseURL!);
    try {
      const resp = await pub.goto(path);
      expect(resp?.status()).toBe(200);
      expect(resp?.headers()["content-security-policy"] ?? "").toContain("sandbox");
      await expect(pub.getByText(visible)).toBeVisible({ timeout: 15_000 });
      await expect(pub.getByText(hidden)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});

test.describe("draft version history", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("view an older version and restore it", async ({ page }) => {
    await openApp(page);
    const title = unique("History title");
    const draft = await seedDraft(page, title, "version one");
    await patchDraft(page, draft.id, { content: "version two" });
    await patchDraft(page, draft.id, { content: "version three" });

    const listResp = await page.request.get(`/api/drafts/${draft.id}/versions`, { headers: await getAuthHeaders(page) });
    expect(listResp.ok(), await listResp.text()).toBeTruthy();
    const versions = (await listResp.json()) as Array<{ id: string }>;
    expect(versions.length).toBeGreaterThanOrEqual(2);
    // Newest first: the last entry is the original "version one".
    const oldest = versions[versions.length - 1];

    await openDraftDetail(page, draft.id);
    await page.getByTestId("draft-history-button").click();
    await expect(page.getByTestId("draft-history-panel")).toBeVisible();
    await page.getByTestId(`draft-history-item-${oldest.id}`).click();

    await expect(page.getByTestId("draft-history-banner")).toBeVisible();
    await expect(page.getByTestId("draft-artifact-preview")).toContainText("version one");

    await page.getByTestId("draft-history-restore").click();
    await expect(page.getByTestId("draft-history-banner")).toHaveCount(0);
    await expect.poll(async () => (await getDraft(page, draft.id)).content).toBe("version one");
    await expect(page.getByTestId("draft-artifact-preview")).toContainText("version one");
  });
});
