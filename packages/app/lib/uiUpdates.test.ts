import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({invoke:vi.fn(),tauri:true}));
vi.mock('./platform',()=>({isTauri:()=>mocks.tauri}));
vi.mock('@tauri-apps/api/core',()=>({invoke:mocks.invoke}));
beforeEach(()=>{vi.resetModules();mocks.invoke.mockReset();mocks.tauri=true;vi.stubGlobal('window',{});});
it('old shells do not break when the UI update bridge is absent',async()=>{
  mocks.invoke.mockRejectedValue(new Error('Unknown command'));
  const ui=await import('./uiUpdates');await ui.acknowledgeUiReady();
  expect(ui.getUiUpdateState().status).toBeNull();
});
it('acknowledges the actual rendered version and keeps pending updates staged',async()=>{
  vi.stubGlobal('window',{__OFFDESK_UI_VERSION__:'rc-2'});
  mocks.invoke.mockResolvedValue({enabled:true,currentVersion:'rc-2',pendingVersion:'rc-3'});
  const ui=await import('./uiUpdates');await ui.acknowledgeUiReady();await ui.checkUiUpdate();
  expect(mocks.invoke).toHaveBeenCalledWith('ui_ready',{version:'rc-2'});
  expect(ui.getUiUpdateState().message).toContain('next time');
  expect(mocks.invoke.mock.calls.map(c=>c[0])).not.toContain('ui_recover');
});
it('reports download failures without losing current interface state',async()=>{
  const ui=await import('./uiUpdates');mocks.invoke.mockResolvedValue({enabled:true,currentVersion:'rc-1'});
  await ui.refreshUiStatus();mocks.invoke.mockRejectedValue(new Error('offline'));await ui.checkUiUpdate();
  expect(ui.getUiUpdateState().status?.currentVersion).toBe('rc-1');
  expect(ui.getUiUpdateState().busy).toBe(false);expect(ui.getUiUpdateState().message).toContain('offline');
});
it('does not call native code in browsers',async()=>{
  mocks.tauri=false;const ui=await import('./uiUpdates');await ui.acknowledgeUiReady();await ui.checkUiUpdate();
  expect(mocks.invoke).not.toHaveBeenCalled();
});
