import { expect, test, devices } from "@playwright/test";

test.use({
  ...devices["iPhone 14"],
  browserName: "chromium",
});

// A phone browser at a home hub's bare address: it has to learn where the
// sign-in link comes from on this page, not by guessing.
test("the link sign-in page says where the link comes from and links the guide", async ({ page }) => {
  // The E2E hub runs in dev mode: it signs anyone in and offers no link
  // sign-in. Answer as a home hub (no GitHub or Google) does instead.
  await page.route("**/api/auth/dev", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/auth/providers", (route) =>
    route.fulfill({ json: { github: false, google: false, link: true } }),
  );
  await page.goto("/");

  const steps = page.getByTestId("sign-in-link-steps");
  await expect(steps).toBeVisible();
  await expect(steps).toContainText("Settings → Phone");
  await expect(steps).toContainText("browser access");
  await expect(steps).toContainText("offdesk-hub link");
  await expect(page.getByRole("link", { name: /how to sign in on your phone/ })).toHaveAttribute(
    "href",
    "https://github.com/zalify/offdesk/blob/main/docs/setup-lan.md#3-open-it-on-your-phone",
  );
  await expect(page.getByLabel("Sign-in link")).toBeVisible();
});
