import { expect, test, devices, type WebSocketRoute } from "@playwright/test";

test("a signed-in phone waits for computer setup without another QR or token", async ({ browser }) => {
  const context = await browser.newContext({ ...devices["iPhone 14"] });
  const page = await context.newPage();
  const response = await page.request.get("/api/auth/dev");
  const { token } = await response.json();
  await page.addInitScript(token => localStorage.setItem("offdesk:token", token), token);
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    snapshot_seq: 1, machines: [], terminals: [], workspace_groups: [],
    workspace_layouts: [], machine_stats: [], control_leases: [],
  } }));
  let events: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/ws\/events/, socket => { events = socket; });
  await page.goto("/");
  await expect(page.getByText("Connected to your Hub", { exact: true })).toBeVisible();
  await expect(page.getByText("No need to scan again or generate a token on your phone.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Generate a token", exact: true })).toHaveCount(0);
  await expect(page.getByText("And on your phone", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connection settings", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "UI Font", exact: true })).toBeVisible();
  await page.getByTitle("Back", { exact: true }).click();
  await expect.poll(() => !!events).toBe(true);
  events!.send(JSON.stringify({ seq: 2, event: { type: "machine_online", machine: {
    id: "new-mac", name: "New Mac", os: "macos", home_dir: "/tmp",
  } } }));
  await expect(page.getByTestId("empty-machines")).toHaveCount(0);
  await expect(page.getByTestId("mobile-workbench")).toBeVisible();
  await context.close();
});
