import { test, expect, devices } from '@playwright/test';
import { createTerminalViaApi, expandTerminalById, getAuthHeaders, mobileTakeControl, readTerminalBuffer, resetMachineState, takeControlFromHeader } from './helpers';

test.use({ ignoreHTTPSErrors: true });

test('web preview: browser launch, isolated native handoff, Vite and Next hot updates', async ({ page, browser }, testInfo) => {
  test.setTimeout(150_000);
  const base = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4317';
  const { token } = await (await page.request.get('/api/auth/dev')).json();
  // Do not use the older helper's unscoped init script: the preview origin
  // must demonstrably never receive a Hub Bearer in its localStorage.
  await page.addInitScript(({ token, base }) => {
    if (location.origin === base) { localStorage.setItem('offdesk:token', token); localStorage.setItem('offdesk:e2e', '1'); }
  }, { token, base });
  await page.goto('/');
  await expect(page.getByTestId('tab-bar')).toBeVisible();
  await resetMachineState(page);
  await takeControlFromHeader(page);
  const terminal = await createTerminalViaApi(page, { startupCommand: 'node /opt/offdesk/preview-fixture/server.mjs' });
  await expect.poll(() => readTerminalBuffer(page, terminal), { timeout: 60_000 }).toContain('PREVIEW_FIXTURE_READY');
  const headers = await getAuthHeaders(page);

  // Exercise the shipped manual entry and synchronous browser launcher.
  const pane = page.locator(`[data-testid="terminal-card-${terminal}"]`);
  await pane.click({ button: 'right', position: { x: 50, y: 50 } });
  await page.getByText('Open web preview', { exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByLabel('Local address').fill('http://localhost:5127/');
  await page.screenshot({ path: testInfo.outputPath('preview-dialog.png') });
  const opened = page.context().waitForEvent('page');
  await page.getByRole('button', { name: 'Open in browser' }).click();
  const vite = await opened;
  await expect(page.getByRole("link", { name: "open preview here" })).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(vite.getByRole('heading', { name: 'Vite preview ready' })).toBeVisible({ timeout: 20_000 });
  expect(new URL(vite.url()).hostname).toMatch(/^p-[a-f0-9]+\.preview\.test$/);
  expect(await vite.evaluate(() => localStorage.getItem('offdesk:token'))).toBeNull();
  expect(await vite.evaluate(() => document.cookie)).not.toContain('__Host-offdesk-preview');
  const proxyCookie = (await vite.context().cookies(vite.url())).find(c => c.name === '__Host-offdesk-preview');
  expect(proxyCookie?.httpOnly).toBe(true);
  expect(proxyCookie?.secure).toBe(true);
  await vite.getByRole('link', { name: 'Navigate' }).click();
  await expect(vite).toHaveURL(/\/nested\?from=preview$/);

  // Change the actual dev source via another node terminal. Vite accepts the
  // module over its real HMR WebSocket without a page navigation.
  await vite.evaluate(() => { (window as any).__previewMarker = 'same-document'; });
  await createTerminalViaApi(page, { startupCommand: `printf "export default 'Vite preview updated';\\n" > /opt/offdesk/preview-fixture/message.js` });
  await expect(vite.getByRole('heading', { name: 'Vite preview updated' })).toBeVisible();
  expect(await vite.evaluate(() => (window as any).__previewMarker)).toBe('same-document');
  await vite.screenshot({ path: testInfo.outputPath('preview-vite.png') });

  // A separate mobile browser has no Hub login. Exercise the same launch URL
  // handoff that the native opener receives, with a clean cookie jar.
  // Exercise localhost recognition through real xterm's link handler, then
  // emulate only the OS opener boundary. The native API runs after page load
  // so this does not turn the Web test's auth setup into a desktop-shell setup.
  const linkTerminal = await createTerminalViaApi(page, { startupCommand: "printf 'http://localhost:5128/\\n'" });
  await expandTerminalById(page, linkTerminal);
  await expect(page.getByTestId(`terminal-card-${linkTerminal}`)).toBeVisible();
  await expect.poll(() => readTerminalBuffer(page, linkTerminal)).toContain('http://localhost:5128/');
  await page.evaluate(() => {
    (window as any).__previewOpened = [];
    (window as any).__TAURI_INTERNALS__ = { invoke: async (cmd: string, args: any) => {
      if (cmd === 'plugin:opener|open_url') { (window as any).__previewOpened.push(args.url); return; }
      throw new Error('Unsupported test native command');
    } };
  });
  const target = await page.evaluate(id => {
    const term = (window as any).__offdeskTerminals?.get(id);
    const screen = document.querySelector(`[data-testid="terminal-card-${id}"] .xterm-screen`);
    if (!term || !screen) return null;
    const rect = screen.getBoundingClientRect();
    for (let row = 0; row < term.rows; row++) {
      const line = term.buffer.active.getLine(term.buffer.active.viewportY + row)?.translateToString(true) ?? '';
      const col = line.indexOf('http://localhost:5128/');
      if (col >= 0) return { x: rect.left + (col + 10) * rect.width / term.cols, y: rect.top + (row + 0.5) * rect.height / term.rows };
    }
    return null;
  }, linkTerminal);
  expect(target).not.toBeNull();
  await page.mouse.move(target!.x, target!.y);
  await page.mouse.click(target!.x, target!.y);
  await expect.poll(() => page.evaluate(() => (window as any).__previewOpened.length)).toBe(1);
  const launchUrl = await page.evaluate(() => (window as any).__previewOpened[0]);
  const previews = await (await page.request.get('/api/web-previews', { headers })).json();
  const created = { launch_url: launchUrl, preview: previews.previews.find((p: any) => p.port === 5128) };
  await page.evaluate(() => { delete (window as any).__TAURI_INTERNALS__; });
  const mobile = await browser.newContext({ ...devices['Pixel 7'], ignoreHTTPSErrors: true });
  const next = await mobile.newPage();
  await next.goto(created.launch_url);
  await expect(next.getByRole('heading', { name: 'Next preview ready' })).toBeVisible({ timeout: 30_000 });
  expect(next.url()).not.toContain('code=');
  expect(await next.evaluate(() => localStorage.getItem('offdesk:token'))).toBeNull();
  await next.reload();
  await expect(next.getByRole('heading', { name: 'Next preview ready' })).toBeVisible();
  await createTerminalViaApi(page, { startupCommand: `printf "export default function Page(){return <h1>Next preview updated</h1>;}\\n" > /opt/offdesk/preview-fixture/next/app/page.js` });
  await expect(next.getByRole('heading', { name: 'Next preview updated' })).toBeVisible({ timeout: 20_000 });
  await next.screenshot({ path: testInfo.outputPath('preview-next-mobile.png') });

  const anonymous = await browser.newContext({ ignoreHTTPSErrors: true });
  const stranger = await anonymous.newPage();
  const denied = await stranger.goto(next.url());
  expect(denied?.status()).toBe(401);
  await stranger.goto(created.launch_url);
  await expect(stranger.getByText(/expired or was already used/)).toBeVisible();
  const crossOriginStatus = await vite.evaluate(async (origin) => (await fetch(origin + '/api/nope', { method: 'POST', credentials: 'include' }).catch(() => null))?.status ?? 0, new URL(next.url()).origin);
  expect(crossOriginStatus).toBe(0); // CORS does not reveal a sibling preview response.
  const closed = await page.request.delete('/api/web-previews/' + created.preview.id, { headers });
  expect(closed.status()).toBe(204);
  expect((await next.reload())?.status()).toBe(410);
  await anonymous.close(); await mobile.close(); await vite.close();
  const all = await (await page.request.get('/api/web-previews', { headers })).json();
  for (const preview of all.previews) await page.request.delete('/api/web-previews/' + preview.id, { headers });
});

test('web preview: compact mobile menu opens and revokes a preview', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { openApp } = await import('./helpers');
  await openApp(page);
  await resetMachineState(page);
  await mobileTakeControl(page);
  const terminal = await createTerminalViaApi(page);
  await expandTerminalById(page, terminal);
  await page.getByTestId('mobile-title-bar').click();
  await page.getByTestId('mobile-host-button').click();
  await page.getByRole('button', { name: 'Open web preview', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Open web preview' });
  await expect(dialog).toBeVisible();
  await page.getByLabel('Local address').fill('http://localhost:5127/');
  // A blocked popup must leave a usable launcher, also in the compact shell.
  await page.evaluate(() => { window.open = () => null; });
  await page.getByRole('button', { name: 'Open in browser' }).click();
  await expect(page.getByRole('link', { name: 'open preview here' })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const headers = await getAuthHeaders(page);
  const created = await (await page.request.post(`/api/machines/e2e-node/web-previews`, {
    headers, data: { port: 5127, target: '/', terminal_id: terminal },
  })).json();
  await page.getByTestId('mobile-title-bar').click();
  await page.getByTestId('mobile-host-button').click();
  await page.getByRole('button', { name: 'Open web preview', exact: true }).click();
  await expect(page.getByText('Port 5127', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close preview', exact: true }).click();
  await expect(page.getByText('Port 5127', { exact: true })).toHaveCount(0);
  const remaining = await (await page.request.get('/api/web-previews', { headers })).json();
  expect(remaining.previews.some((p: { id: string }) => p.id === created.preview.id)).toBe(false);
});
