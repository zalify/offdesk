import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers';
async function bridge(page:Page, pending:string|null='rc-next') {
  await page.setViewportSize({width:390,height:844});
  await page.addInitScript(({pending})=>{
    Object.defineProperty(navigator,'userAgent',{value:'Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'});
    const state={calls:[] as string[],pending,fail:false};
    Object.assign(window,{__uiUpdatesTest:state,__OFFDESK_UI_VERSION__:'rc-current',__TAURI_INTERNALS__:{
      metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>1,unregisterCallback:()=>{},
      invoke:async(command:string,args?:any)=>{
        state.calls.push(command);
        if(command==='ui_ready') {if(args.version!=='rc-current') throw new Error('Wrong UI version');return null;}
        if(command==='ui_check' && state.fail) throw new Error('Offline');
        if(command==='ui_status'||command==='ui_check')return {enabled:true,checking:false,currentVersion:'rc-current',pendingVersion:state.pending,channel:'rc',bridgeVersion:1,error:null};
        if(command==='plugin:app|version')return '0.7.6';
        return null;
      }
    }});
  },{pending});
}
test('UI updates stage without reloading the active page',async({page})=>{
  await bridge(page);await page.goto('/login');
  await expect(page.getByText('Interface rc-next is ready.',{exact:false})).toBeVisible();
  await page.getByRole('button',{name:'Got it',exact:true}).click();
  await expect(page.getByText('Interface rc-next is ready.',{exact:false})).toHaveCount(0);
  expect(await page.evaluate(()=>(window as any).__uiUpdatesTest.calls)).toContain('ui_ready');
  expect(await page.evaluate(()=>(window as any).__uiUpdatesTest.calls)).not.toContain('ui_recover');
});
test('UI updates offer manual checks and retain the current version on failure',async({page})=>{
  await bridge(page,null);await openApp(page);
  await page.getByTestId('mobile-title-bar-label').click();await page.getByTestId('mobile-host-button').click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await expect(page.getByText('Interface: rc-current · rc')).toBeVisible();
  await page.evaluate(()=>{(window as any).__uiUpdatesTest.fail=true;});
  await page.getByRole('button',{name:'Check interface updates',exact:true}).click();
  await expect(page.getByText('Could not check for interface updates:',{exact:false})).toContainText('Offline');
  await expect(page.getByText('Interface: rc-current · rc')).toBeVisible();
});
test('UI updates stay hidden in ordinary browsers',async({page})=>{
  await page.goto('/login');await expect(page.getByRole('button',{name:'Check interface updates'})).toHaveCount(0);
});
