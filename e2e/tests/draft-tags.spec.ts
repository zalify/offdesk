import { test, expect, devices, type Page } from "@playwright/test";
import { getAuthHeaders, openApp } from "./helpers";

// Draft tags: flomo-style tag tree + card stream. Data is seeded through the hub
// REST API; the tree, filters and the tag editor are driven through the drafts drawer.

interface DraftRow {
  id: string;
  title: string;
  content: string;
  project_group: string;
  tags?: string[];
  inline_tags?: string[];
}

const createdDrafts: string[] = [];

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Tag roots must be a valid tag segment (letters and digits). */
function uniqueRoot(): string {
  return `e2etag${Math.random().toString(36).slice(2, 8)}`;
}

async function seedDraft(
  page: Page,
  data: { title: string; content?: string; project_group: string; tags?: string[] },
): Promise<DraftRow> {
  const resp = await page.request.post("/api/drafts", {
    headers: await getAuthHeaders(page),
    data: { content: "", force_new: true, ...data },
  });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const draft = (await resp.json()) as DraftRow;
  createdDrafts.push(draft.id);
  return draft;
}

async function getDraft(page: Page, id: string): Promise<DraftRow> {
  const resp = await page.request.get("/api/drafts?include_archived=true", { headers: await getAuthHeaders(page) });
  expect(resp.ok(), await resp.text()).toBeTruthy();
  const found = ((await resp.json()) as DraftRow[]).find((d) => d.id === id);
  expect(found, `draft ${id} should exist`).toBeTruthy();
  return found!;
}

interface Seeded {
  root: string;
  p1: string;
  p2: string;
  alphaP1: DraftRow;
  betaP1: DraftRow;
  inlineP1: DraftRow;
  alphaP2: DraftRow;
}

async function seedFixture(page: Page): Promise<Seeded> {
  const root = uniqueRoot();
  const p1 = unique("e2e-tags-p1");
  const p2 = unique("e2e-tags-p2");
  const alphaP1 = await seedDraft(page, { title: unique("Alpha one"), project_group: p1, tags: [`${root}/alpha`] });
  const betaP1 = await seedDraft(page, { title: unique("Beta one"), project_group: p1, tags: [`${root}/beta`] });
  const inlineP1 = await seedDraft(page, {
    title: unique("Inline one"),
    project_group: p1,
    content: `Notes about things #${root}/inline-sub and more text.`,
  });
  const alphaP2 = await seedDraft(page, { title: unique("Alpha two"), project_group: p2, tags: [`${root}/alpha`] });
  return { root, p1, p2, alphaP1, betaP1, inlineP1, alphaP2 };
}

const nodeId = (path: string) => `drafts-tag-node-${path.replace(/\//g, "__")}`;

async function openDraftsWide(page: Page): Promise<void> {
  await page.getByTestId("status-drafts").click();
  await expect(page.getByTestId("drafts-drawer")).toBeVisible();
  await page.getByRole("button", { name: "Expand panel" }).click();
  await expect(page.getByTestId("drafts-tag-tree")).toBeVisible();
}

test.afterEach(async ({ page }) => {
  const headers = await getAuthHeaders(page).catch(() => null);
  const drafts = createdDrafts.splice(0);
  if (!headers) return;
  for (const id of drafts) await page.request.delete(`/api/drafts/${id}`, { headers }).catch(() => undefined);
});

test.describe("draft tags", () => {
  test.describe("desktop", () => {
    test.use({ viewport: { width: 1400, height: 900 } });

    test("tree shows nested nodes with counts and selection filters the stream", async ({ page }) => {
      await openApp(page);
      const s = await seedFixture(page);
      await openDraftsWide(page);

      // Parent counts include every descendant; children count their own drafts.
      const parent = page.getByTestId(nodeId(s.root));
      await expect(parent).toBeVisible({ timeout: 15_000 });
      await expect(parent).toHaveAttribute("data-count", "4");
      await expect(page.getByTestId(nodeId(`${s.root}/alpha`))).toHaveAttribute("data-count", "2");
      await expect(page.getByTestId(nodeId(`${s.root}/beta`))).toHaveAttribute("data-count", "1");
      // The inline #tag from the body is part of the tree too.
      await expect(page.getByTestId(nodeId(`${s.root}/inline-sub`))).toHaveAttribute("data-count", "1");
      await expect(page.getByTestId(`drafts-project-node-${s.p1}`)).toHaveAttribute("data-count", "3");
      await expect(page.getByTestId(`drafts-project-node-${s.p2}`)).toHaveAttribute("data-count", "1");

      // Selecting the parent shows drafts of every child.
      await parent.click();
      for (const d of [s.alphaP1, s.betaP1, s.inlineP1, s.alphaP2]) {
        await expect(page.getByTestId(`draft-card-${d.id}`)).toBeVisible();
      }

      // A child narrows it.
      await page.getByTestId(nodeId(`${s.root}/alpha`)).click();
      await expect(page.getByTestId(`draft-card-${s.alphaP1.id}`)).toBeVisible();
      await expect(page.getByTestId(`draft-card-${s.alphaP2.id}`)).toBeVisible();
      await expect(page.getByTestId(`draft-card-${s.betaP1.id}`)).toHaveCount(0);

      // Project AND tag.
      await page.getByTestId(`drafts-project-node-${s.p1}`).click();
      await expect(page.getByTestId(`draft-card-${s.alphaP1.id}`)).toBeVisible();
      await expect(page.getByTestId(`draft-card-${s.alphaP2.id}`)).toHaveCount(0);

      // Clicking a chip on a card selects that tag.
      await page.getByTestId("drafts-tag-all").click();
      await expect(page.getByTestId(`draft-card-${s.betaP1.id}`)).toBeVisible();
      await page.getByTestId(`draft-card-tag-${s.betaP1.id}-${s.root}/beta`).click();
      await expect(page.getByTestId(`draft-card-${s.alphaP1.id}`)).toHaveCount(0);
      await expect(page.getByTestId(`draft-card-${s.betaP1.id}`)).toBeVisible();

      // Collapsing a parent hides its children.
      await page.getByTestId("drafts-tag-all").click();
      await page.getByTestId(`drafts-tag-toggle-${s.root}`).click();
      await expect(page.getByTestId(nodeId(`${s.root}/alpha`))).toHaveCount(0);
      await page.getByTestId(`drafts-tag-toggle-${s.root}`).click();
      await expect(page.getByTestId(nodeId(`${s.root}/alpha`))).toBeVisible();
    });

    test("add and remove an explicit tag; inline tags cannot be removed", async ({ page }) => {
      await openApp(page);
      const s = await seedFixture(page);
      await openDraftsWide(page);

      await page.getByTestId(`draft-card-${s.alphaP1.id}`).click();
      await expect(page.getByTestId("draft-tag-editor")).toBeVisible();
      await expect(page.getByTestId(`draft-tag-chip-${s.root}/alpha`)).toBeVisible();

      // Validation shows before any request.
      await page.getByTestId("draft-tag-input").fill("bad tag");
      await page.getByTestId("draft-tag-input").press("Enter");
      await expect(page.getByTestId("draft-tag-error")).toBeVisible();

      const added = `${s.root}/extra`;
      await page.getByTestId("draft-tag-input").fill(`#${added}`);
      await page.getByTestId("draft-tag-input").press("Enter");
      await expect(page.getByTestId(`draft-tag-chip-${added}`)).toBeVisible();
      await expect.poll(async () => (await getDraft(page, s.alphaP1.id)).tags).toContain(added);

      await page.getByTestId(`draft-tag-remove-${added}`).click();
      await expect(page.getByTestId(`draft-tag-chip-${added}`)).toHaveCount(0);
      await expect.poll(async () => (await getDraft(page, s.alphaP1.id)).tags).not.toContain(added);
      // The tag it started with is untouched.
      expect((await getDraft(page, s.alphaP1.id)).tags).toContain(`${s.root}/alpha`);

      // Back to the list, then into the draft whose tag comes from its body.
      await page.getByRole("button", { name: "← Back" }).click();
      await page.getByTestId(`draft-card-${s.inlineP1.id}`).click();
      const inlineTag = `${s.root}/inline-sub`;
      await expect(page.getByTestId(`draft-tag-chip-${inlineTag}`)).toBeVisible();
      await expect(page.getByTestId(`draft-tag-chip-${inlineTag}`)).toHaveAttribute("data-inline", "true");
      await expect(page.getByTestId(`draft-tag-remove-${inlineTag}`)).toHaveCount(0);
    });
  });

  test.describe("phone", () => {
    // Same device as the other phone specs; browserName cannot be set inside a describe,
    // so drop the device's WebKit default and keep the project's browser.
    const { defaultBrowserType: _unused, ...phone } = devices["iPhone 14"];
    void _unused;
    test.use(phone);

    test("tags live in a sheet and active filters show as removable chips", async ({ page }) => {
      await openApp(page);
      const s = await seedFixture(page);
      await page.getByTestId("mobile-title-bar-drafts").tap();
      await expect(page.getByTestId("drafts-drawer")).toBeVisible();

      await expect(page.getByTestId("drafts-tag-tree")).toHaveCount(0);
      await expect(page.getByTestId(`draft-card-${s.alphaP1.id}`)).toBeVisible({ timeout: 15_000 });
      await page.getByTestId("drafts-tags-button").tap();
      await expect(page.getByTestId("drafts-tag-tree")).toBeVisible();

      await page.getByTestId(nodeId(`${s.root}/alpha`)).tap();
      // Picking a node closes the sheet and leaves a removable chip above the stream.
      await expect(page.getByTestId("drafts-tag-tree")).toHaveCount(0);
      await expect(page.getByTestId("drafts-active-filter-tag")).toBeVisible();
      await expect(page.getByTestId(`draft-card-${s.alphaP1.id}`)).toBeVisible();
      await expect(page.getByTestId(`draft-card-${s.betaP1.id}`)).toHaveCount(0);

      await page.getByTestId("drafts-active-filter-tag").getByRole("button").tap();
      await expect(page.getByTestId("drafts-active-filter-tag")).toHaveCount(0);
      await expect(page.getByTestId(`draft-card-${s.betaP1.id}`)).toBeVisible();
    });
  });
});
