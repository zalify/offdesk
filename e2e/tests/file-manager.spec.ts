import { createHash, randomBytes } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  createTerminalViaApi,
  expandTerminalById,
  getAuthHeaders,
  openApp,
  readTerminalBuffer,
  requestMachineControl,
  resetMachineState,
} from "./helpers";

const MACHINE = "e2e-node";

interface Entry {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number;
}

/**
 * Delays every request matching `url` by `delayMs` (the real request runs
 * after the delay) and records how many were in flight at once.
 */
async function trackConcurrency(page: Page, url: string, delayMs: number, minBodyBytes = 0) {
  const stats = { inFlight: 0, max: 0, total: 0 };
  await page.route(url, async (route) => {
    if ((route.request().postDataBuffer()?.length ?? 0) < minBodyBytes) {
      await route.continue();
      return;
    }
    stats.inFlight++;
    stats.total++;
    stats.max = Math.max(stats.max, stats.inFlight);
    try {
      await new Promise((r) => setTimeout(r, delayMs));
      const response = await route.fetch();
      await route.fulfill({ response });
    } catch {
      // the page cancelled the request
    } finally {
      stats.inFlight--;
    }
  });
  return stats;
}

/** SHA-256 of a file on the node, read through read_range. */
async function remoteSha256(page: Page, path: string, size: number): Promise<string> {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += 4 * 1024 * 1024) {
    const resp = await page.request.get(
      `/api/machines/${MACHINE}/fs/read_range?path=${encodeURIComponent(path)}&offset=${offset}&length=${4 * 1024 * 1024}`,
      { headers: await getAuthHeaders(page) },
    );
    const body = (await resp.json()) as { data_base64: string };
    hash.update(Buffer.from(body.data_base64, "base64"));
  }
  return hash.digest("hex");
}

const row = (page: Page, name: string) =>
  page.locator(`[data-testid="file-browser-row"][data-name="${name}"]`);
const browser = (page: Page) => page.getByTestId("file-browser");
const menuItem = (page: Page, id: string) => page.getByTestId(`file-action-${id}`);

async function listDir(page: Page, path: string): Promise<Entry[]> {
  const resp = await page.request.get(
    `/api/machines/${MACHINE}/fs/list?path=${encodeURIComponent(path)}&show_hidden=true`,
    { headers: await getAuthHeaders(page) },
  );
  if (!resp.ok()) return [];
  return (await resp.json()) as Entry[];
}

const namesIn = async (page: Page, path: string) =>
  (await listDir(page, path)).map((e) => e.name).sort();

/** Builds `dir` on the node via a terminal, opens the file browser in it. */
async function openBrowserIn(page: Page, dir: string, setup: string, extra = "") {
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, {
    cwd: "/tmp",
    startupCommand:
      `rm -rf ${dir}; mkdir -p ${dir}; cd ${dir}; ${setup}; ${extra}` +
      `printf 'FM_READY\\n'; sleep 600`,
  });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("FM_READY");
  await page.getByTestId("tab-bar-files").click();
  await expect(page.getByTestId("file-browser-overlay")).toBeVisible();
  await gotoDir(page, dir);
  return id;
}

/** Types a path into the location bar (the browser may restore its last folder). */
async function gotoDir(page: Page, dir: string) {
  await expect(browser(page)).toHaveAttribute("data-path", /^\//);
  await browser(page).focus();
  await page.keyboard.press("Control+l");
  const input = page.getByTestId("file-browser-path-input");
  await input.fill(dir);
  await input.press("Enter");
  await expect(browser(page)).toHaveAttribute("data-path", dir);
}

async function selectRows(page: Page, names: string[]) {
  await row(page, names[0]).click();
  for (const name of names.slice(1)) await row(page, name).click({ modifiers: ["Control"] });
  for (const name of names) await expect(row(page, name)).toHaveAttribute("data-selected", "true");
}

test.describe("file manager on desktop", () => {
  test("new folder is created through inline rename", async ({ page }) => {
    const dir = "/tmp/e2e-fm-1";
    await openBrowserIn(page, dir, "printf x > keep.txt");
    await page.getByTestId("file-browser-new-folder").click();
    const input = page.getByTestId("file-browser-rename-input");
    await expect(input).toBeVisible();
    await input.fill("Projects");
    await input.press("Enter");
    await expect(page.getByTestId("file-browser-rename-input")).toHaveCount(0);
    await expect(row(page, "Projects")).toHaveAttribute("data-kind", "dir");
    await expect(row(page, "Projects")).toHaveAttribute("data-selected", "true");
    await expect.poll(() => namesIn(page, dir)).toEqual(["Projects", "keep.txt"]);
  });

  test("rename via context menu and F2, conflicts and Escape", async ({ page }) => {
    const dir = "/tmp/e2e-fm-2";
    await openBrowserIn(page, dir, "printf a > a.txt; printf b > b.txt; printf c > c.txt");

    // Context menu rename.
    await row(page, "a.txt").click({ button: "right" });
    await expect(page.getByTestId("file-browser-context-menu")).toBeVisible();
    await menuItem(page, "rename").click();
    const input = page.getByTestId("file-browser-rename-input");
    await expect(input).toBeVisible();
    await input.fill("alpha.txt");
    await input.press("Enter");
    await expect(row(page, "alpha.txt")).toBeVisible();
    await expect.poll(() => namesIn(page, dir)).toEqual(["alpha.txt", "b.txt", "c.txt"]);

    // F2 rename onto an existing name keeps editing and flags the error.
    await row(page, "b.txt").click();
    await page.keyboard.press("F2");
    await expect(input).toBeVisible();
    await input.fill("c.txt");
    await input.press("Enter");
    await expect(input).toBeVisible();
    await expect(input).toHaveAttribute("aria-invalid", "true");
    expect(await namesIn(page, dir)).toEqual(["alpha.txt", "b.txt", "c.txt"]);

    // Escape cancels and leaves everything untouched.
    await input.press("Escape");
    await expect(page.getByTestId("file-browser-rename-input")).toHaveCount(0);
    await expect(page.getByTestId("file-browser-overlay")).toBeVisible();
    await expect(row(page, "b.txt")).toBeVisible();
    expect(await namesIn(page, dir)).toEqual(["alpha.txt", "b.txt", "c.txt"]);

    // F2 then a valid name.
    await row(page, "b.txt").click();
    await page.keyboard.press("F2");
    await input.fill("beta.txt");
    await input.press("Enter");
    await expect.poll(() => namesIn(page, dir)).toEqual(["alpha.txt", "beta.txt", "c.txt"]);
  });

  test("copy, paste into a folder, and keep both on conflict", async ({ page }) => {
    const dir = "/tmp/e2e-fm-3";
    await openBrowserIn(
      page,
      dir,
      "mkdir dest; printf 1 > one.txt; printf 2 > two.txt; printf 3 > three.txt",
    );
    // Ctrl-click adds, Shift-click extends from the anchor.
    await selectRows(page, ["one.txt", "three.txt"]);
    await expect(row(page, "two.txt")).toHaveAttribute("data-selected", "false");
    await row(page, "one.txt").click();
    await row(page, "two.txt").click({ modifiers: ["Shift"] });
    await expect(row(page, "one.txt")).toHaveAttribute("data-selected", "true");
    await expect(row(page, "two.txt")).toHaveAttribute("data-selected", "true");

    await selectRows(page, ["one.txt", "two.txt"]);
    await page.keyboard.press("Control+c");
    await row(page, "dest").dblclick();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/dest`);
    await page.keyboard.press("Control+v");
    await expect(row(page, "one.txt")).toBeVisible();
    await expect(row(page, "two.txt")).toBeVisible();
    await expect.poll(() => namesIn(page, `${dir}/dest`)).toEqual(["one.txt", "two.txt"]);
    // The originals are still there.
    expect(await namesIn(page, dir)).toEqual(["dest", "one.txt", "three.txt", "two.txt"]);

    // Paste again: both names collide.
    await page.keyboard.press("Control+v");
    const dialog = page.getByTestId("file-conflict-dialog");
    await expect(dialog).toBeVisible();
    const applyAll = page.getByTestId("file-conflict-apply-all");
    if (await applyAll.count()) await applyAll.check();
    await page.getByTestId("file-conflict-keep-both").click();
    await expect(dialog).toHaveCount(0);
    await expect
      .poll(() => namesIn(page, `${dir}/dest`))
      .toEqual(["one copy.txt", "one.txt", "two copy.txt", "two.txt"]);
  });

  test("cut and paste moves the item", async ({ page }) => {
    const dir = "/tmp/e2e-fm-4";
    await openBrowserIn(page, dir, "mkdir dest; printf moved > mv.txt; printf stay > stay.txt");
    await row(page, "mv.txt").click();
    await page.keyboard.press("Control+x");
    await row(page, "dest").dblclick();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/dest`);
    await page.keyboard.press("Control+v");
    await expect(row(page, "mv.txt")).toBeVisible();
    await expect.poll(() => namesIn(page, `${dir}/dest`)).toEqual(["mv.txt"]);
    await expect.poll(() => namesIn(page, dir)).toEqual(["dest", "stay.txt"]);
  });

  test("Delete moves to the freedesktop trash", async ({ page }) => {
    const dir = "/tmp/e2e-fm-5";
    const name = "trash-me-e2e-fm-5.txt";
    const id = await openBrowserIn(
      page,
      dir,
      `printf bye > ${name}; printf stay > stay.txt; ` +
        `printf 'TRASHDIR=%s\\n' "\${XDG_DATA_HOME:-$HOME/.local/share}/Trash/files"`,
    );
    const buffer = await readTerminalBuffer(page, id);
    const trashDir = /TRASHDIR=(\/\S+)/.exec(buffer.split("\n").filter((l) => !l.includes("printf")).join("\n"))?.[1];
    expect(trashDir, "trash dir on node").toBeTruthy();

    await row(page, name).click();
    await page.keyboard.press("Delete");
    await expect(row(page, name)).toHaveCount(0);
    await expect(row(page, "stay.txt")).toBeVisible();
    await expect.poll(() => namesIn(page, dir)).toEqual(["stay.txt"]);
    await expect
      .poll(async () => (await namesIn(page, trashDir!)).some((n) => n.startsWith("trash-me-e2e-fm-5")))
      .toBe(true);
  });

  test("upload in chunks", async ({ page }) => {
    const dir = "/tmp/e2e-fm-6";
    await openBrowserIn(page, dir, "printf x > existing.txt");
    const big = Buffer.alloc(2 * 1024 * 1024 + 4321, 0x61);
    const small = Buffer.from("hello upload\n");
    await page.getByTestId("file-browser-upload-input").setInputFiles([
      { name: "big-upload.bin", mimeType: "application/octet-stream", buffer: big },
      { name: "small-upload.txt", mimeType: "text/plain", buffer: small },
    ]);
    await expect(row(page, "big-upload.bin")).toBeVisible({ timeout: 30_000 });
    await expect(row(page, "small-upload.txt")).toBeVisible();
    await expect
      .poll(async () => {
        const sizes = Object.fromEntries((await listDir(page, dir)).map((e) => [e.name, e.size]));
        return [sizes["big-upload.bin"], sizes["small-upload.txt"]];
      }, { timeout: 30_000 })
      .toEqual([big.length, small.length]);
    await expect(page.getByTestId("file-browser-transfer")).toHaveCount(0, { timeout: 15_000 });
  });

  test("download a folder as zip", async ({ page }) => {
    const dir = "/tmp/e2e-fm-7";
    await openBrowserIn(page, dir, "mkdir -p pack/inner; printf a > pack/a.txt; printf b > pack/inner/b.txt");
    await row(page, "pack").click({ button: "right" });
    await menuItem(page, "download").click();
    const download = await page.waitForEvent("download", { timeout: 20_000 });
    expect(download.suggestedFilename()).toMatch(/\.zip$/);
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const bytes = Buffer.concat(chunks);
    expect(bytes.subarray(0, 2).toString("latin1")).toBe("PK");
    // Entries are stored with their names in the zip directory.
    expect(bytes.toString("latin1")).toContain("pack/inner/b.txt");
  });

  test("sort by size and icon view", async ({ page }) => {
    const dir = "/tmp/e2e-fm-8";
    await openBrowserIn(
      page,
      dir,
      "head -c 10 /dev/zero > small.bin; head -c 5000 /dev/zero > large.bin; head -c 300 /dev/zero > mid.bin",
    );
    const order = () =>
      page
        .getByTestId("file-browser-row")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-name")));
    const sizeHeader = page.locator('[data-testid="file-browser-sort"][data-key="size"]');
    await sizeHeader.click();
    await expect(sizeHeader).toHaveAttribute("aria-sort", /ascending|descending/);
    const first = await order();
    await sizeHeader.click();
    const second = await order();
    const sorted = ["small.bin", "mid.bin", "large.bin"];
    expect([first, second].map((o) => JSON.stringify(o))).toContain(JSON.stringify(sorted));
    expect([first, second].map((o) => JSON.stringify(o))).toContain(
      JSON.stringify([...sorted].reverse()),
    );
    expect(second).toEqual([...first].reverse());

    await expect(page.getByTestId("file-browser-grid")).toHaveCount(0);
    await page.getByTestId("file-browser-view-icons").click();
    await expect(page.getByTestId("file-browser-grid")).toBeVisible();
    await expect(row(page, "mid.bin")).toBeVisible();
    await page.getByTestId("file-browser-view-list").click();
    await expect(page.getByTestId("file-browser-grid")).toHaveCount(0);
    await expect(row(page, "mid.bin")).toBeVisible();
  });

  test("back and forward through visited folders", async ({ page }) => {
    const dir = "/tmp/e2e-fm-9";
    await openBrowserIn(page, dir, "mkdir -p one/two; printf x > one/in-one.txt; printf y > one/two/in-two.txt");
    const back = page.getByTestId("file-browser-back");
    const forward = page.getByTestId("file-browser-forward");
    await row(page, "one").dblclick();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/one`);
    await row(page, "two").dblclick();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/one/two`);
    await expect(row(page, "in-two.txt")).toBeVisible();

    await back.click();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/one`);
    await expect(row(page, "in-one.txt")).toBeVisible();
    await back.click();
    await expect(browser(page)).toHaveAttribute("data-path", dir);
    await expect(forward).toBeEnabled();
    await forward.click();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/one`);
    await forward.click();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/one/two`);
    await expect(forward).toBeDisabled();
  });

  test("view-only session cannot mutate", async ({ page, browser: pw }) => {
    const dir = "/tmp/e2e-fm-10";
    const id = await openBrowserIn(page, dir, "printf x > file.txt");
    // A second session with the view-only lock engaged (same key the app's
    // lock toggle writes) shows Files read-only.
    const ctx = await pw.newContext({ viewport: { width: 1440, height: 960 } });
    await ctx.addInitScript(() => localStorage.setItem("offdesk:view-only-lock", "1"));
    const viewer = await ctx.newPage();
    try {
      await openApp(viewer);
      await expandTerminalById(viewer, id);
      await viewer.getByTestId("tab-bar-files").click();
      await gotoDir(viewer, dir);
      await expect(row(viewer, "file.txt")).toBeVisible();
      await expect(viewer.getByTestId("file-browser-new-folder")).toHaveCount(0);
      await expect(viewer.getByTestId("file-browser-upload")).toHaveCount(0);
      await row(viewer, "file.txt").click({ button: "right" });
      await expect(viewer.getByTestId("file-browser-context-menu")).toBeVisible();
      await expect(menuItem(viewer, "download")).toBeVisible();
      for (const id of ["rename", "cut", "copy", "paste", "trash", "duplicate"]) {
        await expect(menuItem(viewer, id)).toHaveCount(0);
      }
      await viewer.keyboard.press("Escape");
      await row(viewer, "file.txt").click();
      await viewer.keyboard.press("Delete");
      await expect(row(viewer, "file.txt")).toBeVisible();
      expect(await namesIn(page, dir)).toEqual(["file.txt"]);
    } finally {
      await ctx.close();
    }
  });

  test("download a 21 MiB file in chunks", async ({ page }) => {
    const dir = "/tmp/e2e-fm-11";
    await openBrowserIn(page, dir, "head -c 22020096 /dev/zero > big.bin");
    const ranges = await trackConcurrency(page, "**/fs/read_range?*", 150);
    // The strip can be short-lived on a fast link: record that it ever mounted.
    await page.evaluate(() => {
      const w = window as unknown as { __sawTransfer?: boolean };
      w.__sawTransfer = false;
      const check = () => {
        if (document.querySelector('[data-testid="file-browser-transfer"]')) w.__sawTransfer = true;
      };
      new MutationObserver(check).observe(document.body, { childList: true, subtree: true });
    });
    // aria-disabled (over 20 MB) makes Playwright treat the row as not enabled.
    await row(page, "big.bin").click({ button: "right", force: true });
    const downloading = page.waitForEvent("download", { timeout: 60_000 });
    await menuItem(page, "download").click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("big.bin");
    let length = 0;
    for await (const chunk of await download.createReadStream()) length += (chunk as Buffer).length;
    expect(length).toBe(22020096);
    expect(
      await page.evaluate(() => (window as unknown as { __sawTransfer?: boolean }).__sawTransfer),
    ).toBe(true);
    // 6 ranges of 4 MiB: several are fetched at once.
    expect(ranges.max).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("file-browser-transfer")).toHaveCount(0, { timeout: 15_000 });
  });

  test("drag a row onto a folder moves it; Alt-drag copies", async ({ page }) => {
    const dir = "/tmp/e2e-fm-12";
    await openBrowserIn(page, dir, "mkdir dest other; printf 1 > move.txt; printf 2 > copy.txt");
    await row(page, "move.txt").dragTo(row(page, "dest"));
    await expect(row(page, "move.txt")).toHaveCount(0);
    await expect.poll(() => namesIn(page, `${dir}/dest`)).toEqual(["move.txt"]);

    await page.keyboard.down("Alt");
    try {
      await row(page, "copy.txt").dragTo(row(page, "other"), { force: true });
    } finally {
      await page.keyboard.up("Alt");
    }
    await expect.poll(() => namesIn(page, `${dir}/other`)).toEqual(["copy.txt"]);
    // A copy leaves the source behind.
    expect(await namesIn(page, dir)).toEqual(["copy.txt", "dest", "other"]);
  });

  test("dropping files from the OS uploads them", async ({ page }) => {
    const dir = "/tmp/e2e-fm-13";
    await openBrowserIn(page, dir, "printf x > existing.txt");
    await page.getByTestId("file-browser-list").evaluate((list) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["dropped body"], "dropped.txt", { type: "text/plain" }));
      list.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      list.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await expect(row(page, "dropped.txt")).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(async () => (await listDir(page, dir)).find((e) => e.name === "dropped.txt")?.size)
      .toBe("dropped body".length);
  });

  test("paste onto an existing name and Replace sends the old one to the trash", async ({ page }) => {
    const dir = "/tmp/e2e-fm-14";
    const name = "replace-me-e2e-fm-14.txt";
    const id = await openBrowserIn(
      page,
      dir,
      `mkdir dest; printf 'new' > ${name}; printf 'old old old old' > dest/${name}; ` +
        `printf 'TRASHDIR=%s\\n' "\${XDG_DATA_HOME:-$HOME/.local/share}/Trash/files"`,
    );
    const trashDir = /TRASHDIR=(\/\S+)/.exec(
      (await readTerminalBuffer(page, id)).split("\n").filter((l) => !l.includes("printf")).join("\n"),
    )?.[1];
    expect(trashDir).toBeTruthy();

    await row(page, name).click();
    await page.keyboard.press("Control+c");
    await row(page, "dest").dblclick();
    await expect(browser(page)).toHaveAttribute("data-path", `${dir}/dest`);
    await page.keyboard.press("Control+v");
    await expect(page.getByTestId("file-conflict-dialog")).toBeVisible();
    await page.getByTestId("file-conflict-replace").click();
    await expect(page.getByTestId("file-conflict-dialog")).toHaveCount(0);
    await expect
      .poll(async () => (await listDir(page, `${dir}/dest`)).find((e) => e.name === name)?.size)
      .toBe(3);
    await expect
      .poll(async () => (await listDir(page, trashDir!)).filter((e) => e.name.startsWith("replace-me-e2e-fm-14")).map((e) => e.size))
      .toContain("old old old old".length);
  });

  test("a big upload sends chunks in parallel and arrives intact", async ({ page }) => {
    const dir = "/tmp/e2e-fm-30";
    await openBrowserIn(page, dir, "printf x > existing.txt");
    const chunks = await trackConcurrency(page, "**/fs/upload/chunk", 300);
    const big = randomBytes(9 * 1024 * 1024 + 123);
    const started = Date.now();
    await page.getByTestId("file-browser-upload-input").setInputFiles([
      { name: "parallel.bin", mimeType: "application/octet-stream", buffer: big },
    ]);
    await expect(row(page, "parallel.bin")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("file-browser-transfer")).toHaveCount(0, { timeout: 30_000 });
    console.log(`parallel upload of 9 MiB took ${Date.now() - started} ms (${chunks.total} chunks, max ${chunks.max} in flight)`);
    expect(chunks.max).toBeGreaterThanOrEqual(2);
    expect(chunks.max).toBeLessThanOrEqual(3);
    const size = (await listDir(page, dir)).find((e) => e.name === "parallel.bin")?.size;
    expect(size).toBe(big.length);
    expect(await remoteSha256(page, `${dir}/parallel.bin`, big.length)).toBe(
      createHash("sha256").update(big).digest("hex"),
    );
  });

  test("files added mid-upload queue, appear as they finish, and the strip shows progress", async ({ page }) => {
    const dir = "/tmp/e2e-fm-31";
    await openBrowserIn(page, dir, "printf x > existing.txt");
    await trackConcurrency(page, "**/fs/upload/chunk", 1000, 100_000);
    const input = page.getByTestId("file-browser-upload-input");
    await input.setInputFiles([
      { name: "big-queued.bin", mimeType: "application/octet-stream", buffer: randomBytes(24 * 1024 * 1024) },
    ]);
    const strip = page.getByTestId("file-browser-transfer");
    await expect(strip).toBeVisible();
    // More files while the big one runs: queued, not refused.
    await input.setInputFiles([
      { name: "q1.txt", mimeType: "text/plain", buffer: Buffer.from("one") },
      { name: "q2.txt", mimeType: "text/plain", buffer: Buffer.from("two") },
      { name: "q3.txt", mimeType: "text/plain", buffer: Buffer.from("three") },
    ]);
    await expect(page.getByText("Another transfer is still running")).toHaveCount(0);
    await expect(page.getByTestId("file-browser-transfer-files")).toContainText(/\d+ of 4 files/);
    await expect(page.getByTestId("file-browser-transfer-speed")).toContainText("/s", { timeout: 15_000 });
    // The small files land (and are listed) while the big one is still going.
    await expect(row(page, "q3.txt")).toBeVisible({ timeout: 15_000 });
    await expect(row(page, "q1.txt")).toBeVisible();
    await expect(strip).toBeVisible();
    await expect(row(page, "big-queued.bin")).toHaveCount(0);
    // Mid-queue the user's own selection is left alone.
    await expect(row(page, "q3.txt")).not.toHaveAttribute("data-selected", "true");
    await expect(row(page, "big-queued.bin")).toBeVisible({ timeout: 60_000 });
    await expect(strip).toHaveCount(0, { timeout: 30_000 });
    // On drain what landed is selected.
    await expect(row(page, "big-queued.bin")).toHaveAttribute("data-selected", "true");
    await expect
      .poll(async () => (await namesIn(page, dir)).filter((n) => /^(q\d\.txt|big-queued\.bin)$/.test(n)))
      .toEqual(["big-queued.bin", "q1.txt", "q2.txt", "q3.txt"]);
  });

  test("cancel stops the whole queue and leaves no part files", async ({ page }) => {
    const dir = "/tmp/e2e-fm-32";
    await openBrowserIn(page, dir, "printf x > existing.txt");
    await trackConcurrency(page, "**/fs/upload/chunk", 1500, 100_000);
    const input = page.getByTestId("file-browser-upload-input");
    await input.setInputFiles([
      { name: "cancel-a.bin", mimeType: "application/octet-stream", buffer: randomBytes(24 * 1024 * 1024) },
      { name: "cancel-b.bin", mimeType: "application/octet-stream", buffer: randomBytes(24 * 1024 * 1024) },
      { name: "cancel-c.txt", mimeType: "text/plain", buffer: Buffer.from("never") },
    ]);
    await expect(page.getByTestId("file-browser-transfer-files")).toContainText("of 3 files");
    // Wait until the node has begun writing part files.
    await expect
      .poll(async () => (await namesIn(page, dir)).some((n) => n.includes(".offdesk-part-")), { timeout: 15_000 })
      .toBe(true);
    await page.getByTestId("file-browser-transfer-cancel").click();
    await expect(page.getByTestId("file-browser-transfer")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => namesIn(page, dir), { timeout: 15_000 }).toEqual(["existing.txt"]);
  });

  test("upload conflicts: apply to all keeps both once", async ({ page }) => {
    const dir = "/tmp/e2e-fm-15";
    await openBrowserIn(page, dir, "printf 1 > a.txt; printf 2 > b.txt");
    await page.getByTestId("file-browser-upload-input").setInputFiles([
      { name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("new a") },
      { name: "b.txt", mimeType: "text/plain", buffer: Buffer.from("new b") },
    ]);
    const dialog = page.getByTestId("file-conflict-dialog");
    await expect(dialog).toBeVisible();
    await page.getByTestId("file-conflict-apply-all").check();
    await page.getByTestId("file-conflict-keep-both").click();
    // A second prompt would stall the second file: both copies appearing means one dialog.
    await expect
      .poll(() => namesIn(page, dir))
      .toEqual(["a copy.txt", "a.txt", "b copy.txt", "b.txt"]);
    await expect(dialog).toHaveCount(0);
    const sizes = Object.fromEntries((await listDir(page, dir)).map((e) => [e.name, e.size]));
    expect(sizes["a.txt"]).toBe(1);
    expect(sizes["a copy.txt"]).toBe("new a".length);
  });
});

// A folder taller than the viewport: actions must refresh it in place, keeping
// the scroll position and landing the selection on the affected row.
const MANY = 'for i in $(seq -w 1 200); do printf x > "f$i.txt"; done';

const listBox = (page: Page) => page.getByTestId("file-browser-list");
const scrollTopOf = (page: Page) => listBox(page).evaluate((el) => el.scrollTop);

/** Records whether the "reading…" placeholder ever mounts from now on. */
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

/** Scrolls to the bottom and selects a late row; returns the scroll offset. */
async function scrollDownAndSelect(page: Page, name: string): Promise<number> {
  await expect(row(page, "f200.txt")).toBeAttached();
  await listBox(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await row(page, name).click();
  await expect(row(page, name)).toHaveAttribute("data-selected", "true");
  const top = await scrollTopOf(page);
  expect(top, "list is taller than the viewport").toBeGreaterThan(300);
  return top;
}

async function expectRowVisibleInList(page: Page, name: string) {
  await expect(row(page, name)).toBeVisible();
  await expect
    .poll(async () => {
      const r = await row(page, name).boundingBox();
      const l = await listBox(page).boundingBox();
      return !!r && !!l && r.y >= l.y - 1 && r.y + r.height <= l.y + l.height + 1;
    })
    .toBe(true);
}

for (const { label, dir } of [
  { label: "home-relative", dir: "~/e2e-fm-smooth-home" },
  { label: "absolute", dir: "/tmp/e2e-fm-smooth-abs" },
]) {
  test.describe(`file manager keeps its place after actions (${label} path)`, () => {
    test("rename keeps scroll and selects the renamed row", async ({ page }) => {
      await openBrowserIn(page, dir, MANY);
      const before = await scrollDownAndSelect(page, "f190.txt");
      await watchLoading(page);
      await page.keyboard.press("F2");
      const input = page.getByTestId("file-browser-rename-input");
      await input.fill("g190.txt");
      await input.press("Enter");
      await expectRowVisibleInList(page, "g190.txt");
      await expect(row(page, "g190.txt")).toHaveAttribute("data-selected", "true");
      expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
      expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
    });

    test("trash keeps scroll and selects the neighbour", async ({ page }) => {
      await openBrowserIn(page, dir, MANY);
      const before = await scrollDownAndSelect(page, "f190.txt");
      await watchLoading(page);
      await page.keyboard.press("Delete");
      await expect(row(page, "f190.txt")).toHaveCount(0);
      await expect(row(page, "f191.txt")).toHaveAttribute("data-selected", "true");
      expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
      expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
    });

    test("duplicate selects the copy without jumping", async ({ page }) => {
      await openBrowserIn(page, dir, MANY);
      const before = await scrollDownAndSelect(page, "f190.txt");
      await watchLoading(page);
      await row(page, "f190.txt").click({ button: "right" });
      await menuItem(page, "duplicate").click();
      await expectRowVisibleInList(page, "f190 copy.txt");
      await expect(row(page, "f190 copy.txt")).toHaveAttribute("data-selected", "true");
      expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
      expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
    });

    test("new folder selects the committed folder without a loading flash", async ({ page }) => {
      await openBrowserIn(page, dir, MANY);
      await scrollDownAndSelect(page, "f190.txt");
      await watchLoading(page);
      await page.getByTestId("file-browser-new-folder").click();
      const input = page.getByTestId("file-browser-rename-input");
      await expect(input).toBeVisible();
      await input.fill("Zeta");
      await input.press("Enter");
      await expectRowVisibleInList(page, "Zeta");
      await expect(row(page, "Zeta")).toHaveAttribute("data-kind", "dir");
      await expect(row(page, "Zeta")).toHaveAttribute("data-selected", "true");
      expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
    });

    test("an upload finishing keeps scroll and selects the new file", async ({ page }) => {
      await openBrowserIn(page, dir, MANY);
      const before = await scrollDownAndSelect(page, "f190.txt");
      await watchLoading(page);
      await page.getByTestId("file-browser-upload-input").setInputFiles([
        { name: "zz-upload.txt", mimeType: "text/plain", buffer: Buffer.from("up") },
      ]);
      await expect(row(page, "zz-upload.txt")).toBeVisible({ timeout: 15_000 });
      await expect(row(page, "zz-upload.txt")).toHaveAttribute("data-selected", "true");
      expect(await scrollTopOf(page)).toBeGreaterThan(before - 200);
      expect(await sawLoading(page), "list unmounted for the loading placeholder").toBe(false);
    });
  });
}
