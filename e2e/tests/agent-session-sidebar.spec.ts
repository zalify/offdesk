import { expect, test } from '@playwright/test';
import { openApp, getAuthHeaders, requestMachineControl, expectControlState } from './helpers';

test('agent history reads real node metadata and supports folder/date sorting and agent filters', async ({page}) => {
  await page.setViewportSize({width:1280,height:820}); await openApp(page);
  const sidebar = page.getByTestId('agent-session-sidebar');
  const rows = sidebar.getByTestId('history-session');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Codex implement sidebar');
  await expect(rows.nth(1)).toContainText('Claude sidebar plan');
  await expect(rows.nth(2)).toContainText('Claude review tests');
  await sidebar.getByRole('button',{name:'Claude',exact:true}).click();
  await expect(rows).toHaveCount(2); await expect(rows.first()).toContainText('Claude review tests');
  await sidebar.getByRole('button',{name:'Codex',exact:true}).click(); await expect(rows).toHaveCount(1);
  await sidebar.getByRole('button',{name:'All',exact:true}).click();
  await sidebar.getByRole('button',{name:'Group by date'}).click();
  await expect(rows.nth(1)).toContainText('Claude review tests');
  await sidebar.getByRole('button',{name:'Sort conversations'}).click();
  await expect(rows.first()).toContainText('Claude sidebar plan');
  await sidebar.getByLabel('Search conversations').fill('/tmp/beta'); await expect(rows).toHaveCount(1);
  await sidebar.getByRole('button',{name:'Clear search'}).click(); await expect(rows).toHaveCount(3);
  await page.screenshot({path:'e2e/artifacts/agent-sidebar-desktop.png'});
  await page.reload(); await expect(sidebar.getByRole('button',{name:'Sort conversations'})).toHaveAttribute('data-order','oldest');
  await expect(sidebar.getByRole('button',{name:'Group by date'})).toHaveAttribute('aria-pressed','true');
  const auth = await getAuthHeaders(page);
  const denied = await page.request.get('/api/machines/not-owned/conversation-history',{headers:auth}); expect(denied.status()).toBe(404);
  const anonymous = await page.request.get('/api/machines/e2e-node/conversation-history'); expect(anonymous.status()).toBe(401);
});

test('agent history retains previously loaded sessions after a failed refresh and resumes explicit session IDs', async ({page}) => {
  await page.setViewportSize({width:1280,height:820}); await openApp(page);
  const sidebar=page.getByTestId('agent-session-sidebar'); await expect(sidebar.getByTestId('history-session')).toHaveCount(3);
  await page.route('**/conversation-history',route=>route.fulfill({status:503,body:'Node offline'}));
  await sidebar.getByRole('button',{name:'Refresh conversations'}).click();
  await expect(sidebar.getByText('History unavailable',{exact:false})).toBeVisible();
  await expect(sidebar.getByTestId('history-session')).toHaveCount(3);
  await requestMachineControl(page); await expectControlState(page,'controlling');
  let body: any;
  await page.route('**/api/machines/e2e-node/terminals',async route=>{
    if(route.request().method()!=='POST') return route.continue();
    body=route.request().postDataJSON();
    await route.fulfill({status:409,body:'Resume fixture: no agent process started'});
  });
  await sidebar.getByTestId('history-session').filter({hasText:'Codex implement sidebar'}).click();
  await expect(sidebar.getByRole('alert')).toContainText('Resume fixture');
  expect(body.startup_command).toBe('codex resume 33333333-3333-4333-8333-333333333333'); expect(body.cwd).toBe('/tmp/alpha');
});

test('agent history mobile drawer filters and closes without changing the terminal layout',async({page})=>{
  await page.setViewportSize({width:390,height:844}); await openApp(page);
  await expect(page.getByTestId('agent-session-sidebar')).not.toBeVisible();
  await page.getByRole('button',{name:'Open conversations',exact:true}).click();
  const sidebar=page.getByTestId('agent-session-sidebar'); await expect(sidebar).toBeVisible();
  await expect(sidebar.getByTestId('history-session')).toHaveCount(3);
  await sidebar.getByRole('button',{name:'Codex',exact:true}).click(); await expect(sidebar.getByTestId('history-session')).toHaveCount(1);
  await page.screenshot({path:'e2e/artifacts/agent-sidebar-mobile.png'});
  await page.keyboard.press('Escape'); await expect(sidebar).not.toBeVisible();
  await expect(page.getByTestId('mobile-title-bar')).toBeVisible();
  await expect(page.getByRole('button',{name:'Open conversations',exact:true})).toBeFocused();
});
