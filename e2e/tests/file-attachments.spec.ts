import { createHash } from "node:crypto";
import { test, expect, devices } from "@playwright/test";
import { openApp, resetMachineState, requestMachineControl, createTerminalViaApi, expandTerminalById, readTerminalBuffer } from "./helpers";

test.use({ ...devices["iPhone 14"], browserName: "chromium" });

test("uploads a named document intact through the system file picker", async ({ page }) => {
  const script = [
    "import os,sys,tty,termios,hashlib,pathlib,shutil,shlex,time",
    "old=termios.tcgetattr(0);tty.setraw(0)",
    "sys.stdout.write('\\x1b[?2004h\\x1b[2J\\x1b[H'+'FILE_'+'READY\\r\\n');sys.stdout.flush()",
    "data=b''",
    `while not data.endswith(b'\\x1b[201~'): data+=os.read(0,65536)`,
    "body=data.split(b'\\x1b[200~',1)[1].split(b'\\x1b[201~',1)[0].decode()",
    "path=pathlib.Path(shlex.split(body.rsplit('\\n',1)[-1])[0])",
    "contents=path.read_bytes()",
    "sys.stdout.write('\\r\\nFILE_SHA256='+hashlib.sha256(contents).hexdigest()+'\\r\\nFILE_NAME='+path.name+'\\r\\n');sys.stdout.flush()",
    "shutil.rmtree(path.parent);termios.tcsetattr(0,termios.TCSANOW,old);time.sleep(600)",
  ].join("\n");
  const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
  await openApp(page);
  await resetMachineState(page);
  await requestMachineControl(page);
  const id = await createTerminalViaApi(page, { cwd: "/tmp", startupCommand: `python3 -u -c ${quote(script)}` });
  await expandTerminalById(page, id);
  await expect.poll(() => readTerminalBuffer(page, id)).toContain("FILE_READY");
  await page.getByTestId("extended-keybar-attach").click();
  const dialog = page.getByRole("dialog", { name: "Add attachment" });
  await expect(dialog.getByRole("button", { name: "Choose photos" })).toBeVisible();
  const chooserEvent = page.waitForEvent("filechooser");
  await dialog.getByRole("button", { name: "Choose files" }).click();
  const chooser = await chooserEvent;
  expect(await chooser.element().getAttribute("accept")).toBeNull();
  const file = { name: "customer report's.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7\nBinary document \0\xff\n客户资料", "utf8") };
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([file, { name: "remove-me.txt", mimeType: "text/plain", buffer: Buffer.from("not sent") }]);
  const review = page.getByRole("dialog", { name: "Review attachments" });
  await expect(review).toContainText("Attachments · 2");
  await review.getByRole("button", { name: "Remove remove-me.txt", exact: true }).click();
  await expect(review).not.toContainText("remove-me.txt");
  await review.getByRole("button", { name: "Send attachment", exact: true }).click();
  await expect(page.getByTestId("attachment-status")).toContainText(`Submitted ${file.name}`);
  await expect.poll(async () => (await readTerminalBuffer(page, id)).replaceAll("\n", ""))
    .toContain(`FILE_SHA256=${createHash("sha256").update(file.buffer).digest("hex")}`);
  await expect.poll(async () => (await readTerminalBuffer(page, id)).replaceAll("\n", ""))
    .toContain(`FILE_NAME=${file.name}`);
  await expect(page.getByTestId("attachment-status")).toBeHidden({ timeout: 8_000 });
});


for (const source of ["photos", "files"] as const) {
  test(`reviews, cancels and sends multiple ${source} once`, async ({ page }) => {
    await openApp(page);
    await resetMachineState(page);
    await requestMachineControl(page);
    const id = await createTerminalViaApi(page, { cwd: "/tmp" });
    await expandTerminalById(page, id);
    const sent: { filename: string; data: string }[] = [];
    page.on("websocket", socket => socket.on("framesent", frame => {
      if (typeof frame.payload !== "string") return;
      try { const message = JSON.parse(frame.payload); if (message.type === "image_paste") sent.push(message); } catch {}
    }));
    // Reload to attach the frame listener to the terminal's new connection.
    await page.reload();
    const pick = async () => {
      await page.getByTestId("extended-keybar-attach").click();
      const chooserEvent = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: `Choose ${source}`, exact: true }).click();
      const chooser = await chooserEvent;
      expect(chooser.isMultiple()).toBe(true);
      const ext = source === "photos" ? "png" : "txt";
      await chooser.setFiles([1, 2].map(n => ({ name: `file-${n}.${ext}`, mimeType: source === "photos" ? "image/png" : "text/plain", buffer: Buffer.from(`attachment ${n}`) })));
    };
    const review = page.getByRole("dialog", { name: "Review attachments" });
    await pick();
    await expect(review).toContainText("Attachments · 2");
    expect(sent).toHaveLength(0);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toHaveCount(0);
    expect(sent).toHaveLength(0);
    await pick();
    await review.getByRole("button", { name: "Send attachments", exact: true }).click();
    await expect(review).toHaveCount(0);
    await expect.poll(() => sent.length).toBe(2);
    expect(sent.map(file => Buffer.from(file.data, "base64").toString())).toEqual(["attachment 1", "attachment 2"]);
    expect(new Set(sent.map(file => file.filename)).size).toBe(2);
  });
}
