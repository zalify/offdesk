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
});
