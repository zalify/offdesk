import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { expect, test } from "@playwright/test";
import { getAuthHeaders, mobileOpenHostSheet, openApp } from "./helpers";

/** A receiver in the runner container; the hub reaches it as http://runner:<port>. */
async function receiver(port: number) {
  const got: { headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  return { got, close: () => new Promise((resolve) => server.close(resolve)) };
}

function signature(secret: string, headers: IncomingHttpHeaders, body: string) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const mac = createHmac("sha256", key)
    .update(`${headers["webhook-id"]}.${headers["webhook-timestamp"]}.${body}`)
    .digest("base64");
  return `v1,${mac}`;
}

for (const [width, port] of [[1280, 18787], [390, 18788]] as const) {
  test(`a webhook added in Settings gets signed events at ${width}px`, async ({ page }) => {
    const hook = await receiver(port);
    try {
      await page.setViewportSize({ width, height: 900 });
      await openApp(page);
      if (await page.getByTestId("mobile-workbench").isVisible()) await mobileOpenHostSheet(page);
      await page.getByRole("button", { name: "Settings", exact: true }).click();

      const name = page.getByLabel("Webhook name");
      await name.scrollIntoViewIfNeeded();
      // Waiting on you and ended, by default; nothing beyond status
      await expect(page.getByRole("checkbox", { name: "Waits on you" })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Ended" })).toBeChecked();
      await expect(page.getByRole("checkbox", { name: "Progress" })).not.toBeChecked();
      await name.fill(`receiver-${width}`);
      await page.getByLabel("Webhook URL").fill(`http://runner:${port}/hook`);
      await page.getByRole("button", { name: "Add webhook" }).click();

      const secretField = page.getByLabel("Signing secret");
      await expect(secretField).toHaveValue(/^whsec_/);
      const secret = await secretField.inputValue();
      await expect(page.getByText("waits on you, ended · status only").first()).toBeVisible();
      await page.screenshot({ path: `e2e/artifacts/webhooks-${width}.png` });

      // Test: a signed event reaches the receiver
      const row = page.getByRole("group", { name: `Webhook receiver-${width}` });
      await row.getByRole("button", { name: "Test" }).click();
      await expect(page.getByText(`Sent a test event to receiver-${width}`)).toBeVisible();
      await expect.poll(() => hook.got.length, { timeout: 15_000 }).toBeGreaterThan(0);
      const [first] = hook.got;
      expect(JSON.parse(first.body)).toMatchObject({ type: "integration.test", data: { integration: `receiver-${width}` } });
      expect(first.headers["webhook-signature"]).toBe(signature(secret, first.headers, first.body));

      // The hub marks it delivered; listed without its secret
      const headers = await getAuthHeaders(page);
      const listed = await page.evaluate(async (auth) => (await fetch("/api/integrations", { headers: auth })).text(), headers);
      expect(listed).not.toContain("whsec_");
      expect(JSON.parse(listed).find((h: { name: string }) => h.name === `receiver-${width}`).last_delivery_at).toBeGreaterThan(0);

      // Removed, it's gone
      await row.getByRole("button", { name: "Remove" }).click();
      await row.getByRole("button", { name: "Confirm?" }).click();
      await expect(row).toHaveCount(0);
    } finally {
      await hook.close();
    }
  });
}
