import { expect, test, type Page, type WebSocket } from "@playwright/test";

import {
  createTerminalViaApi,
  expandTerminalById,
  getImmersiveTerminal,
  readTerminalBuffer,
  openApp,
  resetMachineState,
  selectHomeWorkpath,
  takeControlFromHeader,
} from "./helpers";

test("duplicate browser image paste events send one image_paste frame", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const imagePasteFrames: unknown[] = [];

  page.on("websocket", (socket: WebSocket) => {
    if (!socket.url().includes("/ws/terminal/")) return;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const payload = JSON.parse(frame.payload) as { type?: string };
      if (payload.type === "image_paste") {
        imagePasteFrames.push(payload);
      }
    });
  });

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  const terminalId = await createTerminalViaApi(page, { cwd: "/root" });
  await expandTerminalById(page, terminalId);
  await expect(getImmersiveTerminal(page)).toBeVisible();

  await focusTerminal(page, terminalId);
  await dispatchClipboardImagePaste(page);
  await expect.poll(() => imagePasteFrames.length).toBe(1);
  await dispatchClipboardImagePaste(page);

  await page.waitForTimeout(500);
  expect(imagePasteFrames).toHaveLength(1);

  await context.close();
});

test("single browser image paste injects one image path into the terminal", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  const readyNonce = String(Date.now());
  const readyMarker = `IMAGE_PASTE_CAPTURE_READY_${readyNonce}`;
  const terminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    startupCommand: buildRawInputCaptureCommand(readyNonce),
  });
  await expandTerminalById(page, terminalId);
  await expect(getImmersiveTerminal(page)).toBeVisible();
  await expect
    .poll(() => readTerminalBuffer(page, terminalId), { timeout: 20_000 })
    .toContain(readyMarker);

  await focusTerminal(page, terminalId);
  await dispatchClipboardImagePaste(page);

  await expect
    .poll(() => readTerminalBuffer(page, terminalId), { timeout: 20_000 })
    .toContain("CAPTURE_HEX:");

  const capture = await readTerminalBuffer(page, terminalId);
  expect(capture.match(/70617374652e706e67/g) ?? []).toHaveLength(1);

  await context.close();
});

test("dropping a document sends it once and injects one remote path", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  const filePasteFrames: Array<{
    type?: string;
    filename?: string;
    mime?: string;
  }> = [];

  page.on("websocket", (socket: WebSocket) => {
    if (!socket.url().includes("/ws/terminal/")) return;
    socket.on("framesent", (frame) => {
      if (typeof frame.payload !== "string") return;
      const payload = JSON.parse(frame.payload) as {
        type?: string;
        filename?: string;
        mime?: string;
      };
      // Dropped files go over the chunked upload; one upload_begin per drop.
      if (payload.type === "upload_begin") {
        filePasteFrames.push(payload);
      }
    });
  });

  await openApp(page);
  await resetMachineState(page);
  await takeControlFromHeader(page);
  await selectHomeWorkpath(page);

  const readyNonce = String(Date.now());
  const readyMarker = `IMAGE_PASTE_CAPTURE_READY_${readyNonce}`;
  const terminalId = await createTerminalViaApi(page, {
    cwd: "/root",
    startupCommand: buildRawInputCaptureCommand(readyNonce),
  });
  await expandTerminalById(page, terminalId);
  await expect(getImmersiveTerminal(page)).toBeVisible();
  await expect
    .poll(() => readTerminalBuffer(page, terminalId), { timeout: 20_000 })
    .toContain(readyMarker);

  await dispatchDocumentDrop(page);

  await expect.poll(() => filePasteFrames.length).toBe(1);
  expect(filePasteFrames[0]).toMatchObject({
    filename: "brief.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
  await expect
    .poll(() => readTerminalBuffer(page, terminalId), { timeout: 20_000 })
    .toContain("CAPTURE_HEX:");

  const capture = await readTerminalBuffer(page, terminalId);
  // "brief.docx" in hex: the dropped file's remote path must reach the PTY
  // exactly once, not once through DOM drop plus again through image handling.
  expect(capture.match(/62726965662e646f6378/g) ?? []).toHaveLength(1);

  await context.close();
});

async function focusTerminal(page: Page, terminalId: string): Promise<void> {
  await page.evaluate((tid) => {
    const map = (
      window as unknown as { __offdeskTerminals?: Map<string, { focus: () => void }> }
    ).__offdeskTerminals;
    map?.get(tid)?.focus();
  }, terminalId);
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          document
            .querySelector("[data-terminal-display-mode='immersive']")
            ?.contains(document.activeElement),
      ),
    )
    .toBe(true);
}

async function dispatchClipboardImagePaste(page: Page): Promise<void> {
  await page.evaluate(() => {
    const immersive = document.querySelector(
      "[data-terminal-display-mode='immersive']",
    );
    if (!immersive) throw new Error("immersive terminal is not mounted");

    const target =
      immersive.querySelector(".xterm-helper-textarea") ??
      immersive.querySelector(".xterm") ??
      immersive;

    const data = new DataTransfer();
    data.items.add(
      new File(["offdesk-image-paste"], "paste.png", { type: "image/png" }),
    );
    target.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

async function dispatchDocumentDrop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const immersive = document.querySelector(
      "[data-terminal-display-mode='immersive']",
    );
    if (!immersive) throw new Error("immersive terminal is not mounted");

    const target = immersive.querySelector(".xterm") ?? immersive;
    const data = new DataTransfer();
    data.items.add(
      new File(["offdesk-document"], "brief.docx", {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    );
    target.dispatchEvent(
      new DragEvent("dragover", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
    target.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

function buildRawInputCaptureCommand(readyNonce: string): string {
  const script = [
    "ready_prefix=IMAGE_PASTE_CAPTURE_READY",
    `ready_nonce=${readyNonce}`,
    `printf '\\033[?2004h%s_%s\\n' "$ready_prefix" "$ready_nonce"`,
    "stty raw -echo",
    "data=''",
    "end=$((SECONDS + 3))",
    "while [ \"$SECONDS\" -lt \"$end\" ]; do if IFS= read -rsn 1 -t 0.05 ch; then data+=\"$ch\"; fi; done",
    "stty sane",
    "printf '\\033[?2004l'",
    "hex=$(printf '%s' \"$data\" | od -An -tx1 -v | tr -d ' \\n')",
    "done_prefix=CAPTURE_",
    "printf '%sHEX:%s\\n' \"$done_prefix\" \"$hex\"",
    "sleep 600",
  ].join("; ");

  return `bash -lc ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
