import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e/tests",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  // A net, not a fix. A 91-test browser suite on a shared CI runner has a
  // timing tail, and with no retries a single unlucky test reddens the whole
  // run — main failed 7 of its last 12. Playwright still reports a test that
  // needed a retry as "flaky" rather than "passed", so this hides nothing;
  // it just stops one straggler from blocking every PR. Locally it stays 0,
  // so a flake you introduce fails in front of you.
  retries: process.env.CI ? 2 : 0,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:4317",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "e2e/artifacts/playwright-report" }],
  ],
  outputDir: "e2e/artifacts/test-results",
});
