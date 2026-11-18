import { test, expect, devices, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  getAuthHeaders,
  mobileTakeControl,
  openApp,
  readTerminalBuffer,
  resetMachineState,
} from "./helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

const MACHINE = "e2e-node";

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="file-browser-row"][data-name="${name}"]`);
const browser = (page: Page) => page.getByTestId("file-browser");

async function namesIn(page: Page, path: string): Promise<string[]> {
  const resp = await page.request.get(
    `/api/machines/${MACHINE}/fs/list?path=${encodeURIComponent(path)}&show_hidden=true`,
    { headers: await getAuthHeaders(page) },
  );
  if (!resp.ok()) return [];
  return ((await resp.json()) as { name: string }[]).map((e) => e.name).sort();
}

/** Press and hold on a row; long-press does not filter on pointer type. */
async function longPress(page: Page, name: string) {
  const box = await row(page, name).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  // The hold itself is the behaviour under test (threshold is 450 ms).
  await page.waitForTimeout(650);
  await page.mouse.up();
}

async function openPhoneBrowserIn(page: Page, dir: string, setup: string) {
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand: `rm -rf ${dir}; mkdir -p ${dir}; cd ${dir}; ${setup}; printf 'FMM_READY\\n'; sleep 600`,
  });
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("FMM_READY");
  await page.getByTestId("mobile-title-bar-files").click();
  await expect(page.getByTestId("mobile-file-browser-surface")).toBeVisible();
  // The browser may restore its last folder: climb to /tmp, then tap in.
  await expect(async () => {
    const path = await browser(page).getAttribute("data-path");
    if (path !== "/tmp") await page.getByTestId("file-browser-up").tap();
    expect(path).toBe("/tmp");
  }).toPass({ timeout: 15_000 });
  await row(page, dir.replace("/tmp/", "")).tap();
  await expect(browser(page)).toHaveAttribute("data-path", dir);
}

test.describe("file manager on the phone", () => {
  test("long-press selects, tapping adds, Move then Paste moves both", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-1";
    await openPhoneBrowserIn(page, dir, "mkdir dest; printf 1 > one.txt; printf 2 > two.txt; printf 3 > stay.txt");

    await expect(page.getByTestId("file-browser-select-bar")).toHaveCount(0);
    await longPress(page, "one.txt");
    await expect(page.getByTestId("file-browser-select-bar")).toBeVisible();
    await expect(page.getByTestId("file-browser-action-bar")).toBeVisible();
    await expect(row(page, "one.txt")).toHaveAttribute("data-selected", "true");
    // Releasing the press did not open the file.
    await expect(page.getByTestId("file-browser-preview")).toHaveCount(0);

    await row(page, "two.txt").tap();
    await expect(row(page, "two.txt")).toHaveAttribute("data-selected", "true");
    await expect(row(page, "one.txt")).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("file-browser-select-count")).toContainText("2");

    await page.getByTestId("file-mobile-action-move").tap();
    await expect(page.getByTestId("file-browser-paste-bar")).toBeVisible();
    await row(page, "dest").tap();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/dest`);
    await page.getByTestId("file-browser-paste").tap();
    await expect(row(page, "one.txt")).toBeVisible();
    await expect(row(page, "two.txt")).toBeVisible();
    await expect.poll(() => namesIn(page, `${dir}/dest`)).toEqual(["one.txt", "two.txt"]);
    await expect.poll(() => namesIn(page, dir)).toEqual(["dest", "stay.txt"]);
    await expect(page.getByTestId("file-browser-paste-bar")).toHaveCount(0);
  });

  test("plus sheet creates a folder through inline rename", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-2";
    await openPhoneBrowserIn(page, dir, "printf x > keep.txt");
    await page.getByTestId("file-browser-add").tap();
    await expect(page.getByTestId("file-browser-add-sheet")).toBeVisible();
    await page.getByTestId("file-add-new-folder").tap();
    const input = page.getByTestId("file-browser-rename-input");
    await expect(input).toBeVisible();
    await input.fill("Made on phone");
    await input.press("Enter");
    await expect(row(page, "Made on phone")).toHaveAttribute("data-kind", "dir");
    await expect.poll(() => namesIn(page, dir)).toEqual(["Made on phone", "keep.txt"]);
  });

  test("Trash from the action bar", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-3";
    await openPhoneBrowserIn(page, dir, "printf bye > trash-me-e2e-fmm-3.txt; printf stay > stay.txt");
    await longPress(page, "trash-me-e2e-fmm-3.txt");
    await page.getByTestId("file-mobile-action-trash").tap();
    await expect(row(page, "trash-me-e2e-fmm-3.txt")).toHaveCount(0);
    await expect(row(page, "stay.txt")).toBeVisible();
    await expect.poll(() => namesIn(page, dir)).toEqual(["stay.txt"]);
  });

  test("Places sheet lists Home and navigates", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-4";
    await openPhoneBrowserIn(page, dir, "printf x > f.txt");
    await page.getByTestId("file-browser-places").tap();
    await expect(page.getByTestId("file-browser-places-sheet")).toBeVisible();
    const home = page.getByTestId("file-browser-place").filter({ hasText: "Home" });
    await expect(home).toBeVisible();
    await home.tap();
    await expect(page.getByTestId("file-browser-places-sheet")).toHaveCount(0);
    await expect(browser(page)).not.toHaveAttribute("data-path", dir);
    await expect(row(page, "f.txt")).toHaveCount(0);
  });

  test("a plain tap on a folder enters it and does not select", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-5";
    await openPhoneBrowserIn(page, dir, "mkdir inner; printf x > inner/in.txt");
    await row(page, "inner").tap();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/inner`);
    await expect(row(page, "in.txt")).toBeVisible();
    await expect(page.getByTestId("file-browser-select-bar")).toHaveCount(0);
  });

  test("download a 21 MiB file in chunks from the action bar", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-6";
    await openPhoneBrowserIn(page, dir, "head -c 22020096 /dev/zero > big.bin");
    await page.evaluate(() => {
      const w = window as unknown as { __sawTransfer?: boolean };
      w.__sawTransfer = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="file-browser-transfer"]')) w.__sawTransfer = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    await longPress(page, "big.bin");
    const downloading = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByTestId("file-mobile-action-download").tap();
    const download = await downloading;
    let length = 0;
    for await (const chunk of await download.createReadStream()) length += (chunk as Buffer).length;
    expect(length).toBe(22020096);
    expect(
      await page.evaluate(() => (window as unknown as { __sawTransfer?: boolean }).__sawTransfer),
    ).toBe(true);
  });

  test("real touch input: hold selects, a short tap navigates, a moving touch does not select", async ({ page }) => {
    const dir = "/tmp/e2e-fmm-7";
    await openPhoneBrowserIn(page, dir, "mkdir inner; printf x > inner/in.txt; printf 1 > a.txt; printf 2 > b.txt");
    const cdp = await page.context().newCDPSession(page);
    const center = async (name: string) => {
      const box = await row(page, name).boundingBox();
      expect(box).not.toBeNull();
      return { x: Math.round(box!.x + box!.width / 2), y: Math.round(box!.y + box!.height / 2) };
    };
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", point?: { x: number; y: number }) =>
      cdp.send("Input.dispatchTouchEvent", {
        type,
        touchPoints: type === "touchEnd" ? [] : [{ ...point!, id: 1 }],
      });

    // Moving 40px during the hold is a scroll/drag, not a long-press.
    const a = await center("a.txt");
    await touch("touchStart", a);
    await touch("touchMove", { x: a.x, y: a.y + 40 });
    await page.waitForTimeout(650);
    await touch("touchEnd");
    await expect(page.getByTestId("file-browser-select-bar")).toHaveCount(0);
    await expect(row(page, "a.txt")).toHaveAttribute("data-selected", "false");

    // A quick tap on a folder enters it, no selection mode.
    const inner = await center("inner");
    await touch("touchStart", inner);
    await page.waitForTimeout(50);
    await touch("touchEnd");
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/inner`);
    await expect(page.getByTestId("file-browser-select-bar")).toHaveCount(0);
    await page.getByTestId("file-browser-up").tap();
    await expect(browser(page)).toHaveAttribute("data-path", dir);

    // Holding still enters selection mode with the row selected.
    const b = await center("b.txt");
    await touch("touchStart", b);
    await page.waitForTimeout(650);
    await touch("touchEnd");
    await expect(page.getByTestId("file-browser-select-bar")).toBeVisible();
    await expect(row(page, "b.txt")).toHaveAttribute("data-selected", "true");
    await expect(page.getByTestId("file-browser-preview")).toHaveCount(0);
  });
});

// A folder taller than the screen: actions refresh it in place, no jump.
test.describe("file manager on the phone keeps its place after actions", () => {
  const MANY = 'for i in $(seq -w 1 200); do printf x > "f$i.txt"; done';
  const listBox = (page: Page) => page.getByTestId("file-browser-list");
  const scrollTopOf = (page: Page) => listBox(page).evaluate((el) => el.scrollTop);

  async function watchLoading(page: Page) {
    await page.evaluate(() => {
      const w = window as unknown as { __sawLoading?: boolean };
      w.__sawLoading = false;
      const sel = '[data-testid="file-browser-loading"]';
      new MutationObserver((records) => {
        for (const r of records) {
          for (const n of Array.from(r.addedNodes)) {
            if (n instanceof Element && (n.matches(sel) || n.querySelector(sel))) w.__sawLoading = true;
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
  }
  const sawLoading = (page: Page) =>
    page.evaluate(() => (window as unknown as { __sawLoading?: boolean }).__sawLoading === true);

  async function scrollDown(page: Page): Promise<number> {
    await expect(row(page, "f200.txt")).toBeAttached();
    await listBox(page).evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    const top = await scrollTopOf(page);
    expect(top, "list is taller than the screen").toBeGreaterThan(300);
    return top;
  }

  test("new file keeps the scroll position", async ({ page }) => {
    await openPhoneBrowserIn(page, "/tmp/e2e-fmm-smooth-1", MANY);
    const before = await scrollDown(page);
    await watchLoading(page);
    await page.getByTestId("file-browser-add").tap();
    await page.getByTestId("file-add-new-file").tap();
    const input = page.getByTestId("file-browser-rename-input");
    await expect(input).toBeVisible();
    await input.fill("zz-new.txt");
    await input.press("Enter");
    await expect(row(page, "zz-new.txt")).toBeVisible();
    expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
    expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
  });

  test("new folder does not flash the loading placeholder", async ({ page }) => {
    await openPhoneBrowserIn(page, "/tmp/e2e-fmm-smooth-2", MANY);
    await scrollDown(page);
    await watchLoading(page);
    await page.getByTestId("file-browser-add").tap();
    await page.getByTestId("file-add-new-folder").tap();
    const input = page.getByTestId("file-browser-rename-input");
    await expect(input).toBeVisible();
    await input.fill("Zeta");
    await input.press("Enter");
    await expect(row(page, "Zeta")).toHaveAttribute("data-kind", "dir");
    expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
  });

  test("rename keeps the scroll position", async ({ page }) => {
    await openPhoneBrowserIn(page, "/tmp/e2e-fmm-smooth-3", MANY);
    await scrollDown(page);
    await longPress(page, "f197.txt");
    const before = await scrollTopOf(page);
    await watchLoading(page);
    await page.getByTestId("file-mobile-action-rename").tap();
    const input = page.getByTestId("file-browser-rename-input");
    await expect(input).toBeVisible();
    await input.fill("g197.txt");
    await input.press("Enter");
    await expect(row(page, "g197.txt")).toBeVisible();
    expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
    expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
  });

  test("trash keeps the scroll position", async ({ page }) => {
    await openPhoneBrowserIn(page, "/tmp/e2e-fmm-smooth-4", MANY);
    await scrollDown(page);
    await longPress(page, "f197.txt");
    const before = await scrollTopOf(page);
    await watchLoading(page);
    await page.getByTestId("file-mobile-action-trash").tap();
    await expect(row(page, "f197.txt")).toHaveCount(0);
    await expect(page.getByTestId("file-browser-select-bar")).toHaveCount(0);
    expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
    expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
  });
});
