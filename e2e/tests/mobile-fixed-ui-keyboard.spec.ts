import { devices, expect, test, type Page } from '@playwright/test';
import { createTerminalViaApi, getImmersiveTerminal, listTerminals, openApp, releaseMachineControl, requestMachineControl, resetMachineState } from './helpers';

test.use({ ...devices['Pixel 7'], browserName: 'chromium' });
const fixture = `import os,signal,sys,time
sys.stdout.write('\\x1b[?1049h')
def draw(*args):
    w,h=os.get_terminal_size()
    sys.stdout.write('\\x1b[2J'+f'\\x1b[{h-3};1HINPUT-LINE-ONE'+f'\\x1b[{h-2};1HINPUT-LINE-TWO'+f'\\x1b[{h};1HFIXED-STATUS'+f'\\x1b[{h-2};15H')
    sys.stdout.flush()
signal.signal(signal.SIGWINCH,draw)
draw()
while True: time.sleep(.1)
`;
const shellQuote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function state(page: Page, id: string) {
  return page.evaluate(id => {
    const term=(window as any).__offdeskTerminals?.get(id);
    if(!term) return null;
    const buffer=term.buffer.active;
    const viewport=document.querySelector('[data-terminal-display-mode="immersive"]');
    const screen=viewport?.querySelector('.xterm-screen');
    return { rows:term.rows, lines:Array.from({length:term.rows},(_,i)=>buffer.getLine(buffer.baseY+i)?.translateToString(true) ?? '').join('\n'), fits:!!screen && !!viewport && screen.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().bottom+1 };
  },id);
}

test('mobile fixed UI keeps multiline input and footer visible after late keyboard layout',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await openApp(page);await resetMachineState(page);await requestMachineControl(page);
  const id=await createTerminalViaApi(page,{startupCommand:`python3 -u -c ${shellQuote(fixture)}`});
  await expect(getImmersiveTerminal(page)).toBeVisible();
  await expect.poll(async()=> (await state(page,id))?.lines).toContain('FIXED-STATUS');
  const expandedRows=(await state(page,id))!.rows;
  await page.setViewportSize({width:390,height:500});
  await expect.poll(async()=> (await state(page,id))?.rows ?? expandedRows).toBeLessThan(expandedRows);
  await expect.poll(async()=> (await state(page,id))?.fits).toBe(true);
  // Let the existing window-resize debounce finish so it cannot accidentally
  // satisfy the subsequent container-only resize assertion.
  await page.waitForTimeout(350);
  const before=(await state(page,id))!.rows;
  // A fixed bar settles after the window/IME event. There is deliberately
  // no second window resize; only the terminal's usable bounds change.
  const viewport=page.locator('[data-terminal-display-mode="immersive"]');
  await viewport.evaluate(el=>{(el as HTMLElement).style.height='calc(100% - 80px)';});
  await expect.poll(async()=> (await state(page,id))?.rows ?? before).toBeLessThan(before);
  await expect.poll(async()=> (await state(page,id))?.fits).toBe(true);
  for(const marker of ['INPUT-LINE-ONE','INPUT-LINE-TWO','FIXED-STATUS']) {
    await expect.poll(async()=> (await state(page,id))?.lines).toContain(marker);
  }
  await expect.poll(async()=> (await listTerminals(page)).find(t=>t.id===id)?.rows).toBe((await state(page,id))!.rows);
  const compact=(await state(page,id))!.rows;
  await viewport.evaluate(el=>{(el as HTMLElement).style.height='100%';});
  await page.setViewportSize({width:390,height:844});
  await expect.poll(async()=> (await state(page,id))?.rows ?? 0).toBeGreaterThan(compact);
  await expect.poll(async()=> (await state(page,id))?.fits).toBe(true);
  await releaseMachineControl(page);
  const viewerRows=(await state(page,id))!.rows;
  await viewport.evaluate(el=>{(el as HTMLElement).style.height='calc(100% - 80px)';});
  await page.waitForTimeout(400); // longer than the debounced fit; viewers must not resize the PTY
  expect((await listTerminals(page)).find(t=>t.id===id)?.rows).toBe(viewerRows);
});
