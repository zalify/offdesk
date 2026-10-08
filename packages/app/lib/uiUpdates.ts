import { isTauri } from './platform';
export interface UiStatus {
  enabled: boolean; checking: boolean; currentVersion: string; pendingVersion: string | null;
  bridgeVersion: number; channel: string; error: string | null;
}
interface UiState { status: UiStatus | null; busy: boolean; message: string | null; }
let state: UiState = { status: null, busy: false, message: null };
const listeners = new Set<() => void>();
const publish = (patch: Partial<UiState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
export const subscribeUiUpdates = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
export const getUiUpdateState = () => state;
async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core'); return invoke<T>(command, args);
}
export async function refreshUiStatus() {
  if (!isTauri()) return;
  try { publish({ status: await invoke<UiStatus>('ui_status') }); } catch { /* older shells remain supported */ }
}
export async function acknowledgeUiReady() {
  if (!isTauri()) return;
  const version = (window as Window & { __OFFDESK_UI_VERSION__?: string }).__OFFDESK_UI_VERSION__ ?? 'bundled';
  try { await invoke('ui_ready', { version }); } catch { /* unavailable on older shells */ }
  await refreshUiStatus();
}
export async function checkUiUpdate() {
  if (!isTauri() || state.busy) return;
  publish({busy:true, message:null});
  try {
    const status = await invoke<UiStatus>('ui_check');
    publish({status,message:status.pendingVersion ? 'Interface update ready. It will apply the next time the app starts.' : 'Your interface is up to date.'});
  } catch (error) { publish({message:`Could not check for interface updates: ${String(error)}`}); }
  finally { publish({busy:false}); }
}
export const recoverUi = () => invoke<void>('ui_recover');
