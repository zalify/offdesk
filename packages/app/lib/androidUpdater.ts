import { isTauri } from "./platform";

export const isAndroidApp = () => isTauri() && typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);
export interface AndroidUpdateState {
  version: string | null;
  busy: "checking" | "installing" | null;
  message: string | null;
  error: string | null;
  dismissed: boolean;
}
let state: AndroidUpdateState = { version: null, busy: null, message: null, error: null, dismissed: false };
const listeners = new Set<() => void>();
let lastCheck = 0;
export const getAndroidUpdateState = () => state;
export const subscribeAndroidUpdates = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function set(patch: Partial<AndroidUpdateState>) { state = { ...state, ...patch }; listeners.forEach(listener => listener()); }
async function invoke<T>(command: string): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(`plugin:offdesk-android-updater|${command}`);
}
export async function checkAndroidUpdate(silent = false) {
  if (state.busy || (silent && Date.now() - lastCheck < 6 * 60 * 60 * 1000)) return;
  lastCheck = Date.now();
  set({ busy: "checking", error: null, message: null });
  try {
    const update = await invoke<{ version: string | null }>("check");
    set({ version: update.version, dismissed: false, message: !update.version && !silent ? "You’re up to date." : null });
  } catch (error) {
    // Old APKs do not have this plugin. Automatic checks must stay unobtrusive.
    set({ version: null, error: silent ? null : `Could not check for updates: ${String(error)}` });
  } finally { set({ busy: null }); }
}
export async function installAndroidUpdate() {
  if (state.busy || !state.version) return;
  set({ busy: "installing", error: null, message: null });
  try {
    const result = await invoke<{ status: string }>("install");
    set({ message: result.status === "permission-required"
      ? "Allow Offdesk to install apps, return here, then tap Install update again."
      : result.status === "installer-opened" ? "Finish the update in the Android installer." : null });
  } catch (error) { set({ error: `Update failed: ${String(error)}` }); }
  finally { set({ busy: null }); }
}
export function dismissAndroidUpdate() { set({ dismissed: true }); }
