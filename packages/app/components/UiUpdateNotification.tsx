import { useEffect, useState, useSyncExternalStore } from 'react';
import { acknowledgeUiReady, checkUiUpdate, getUiUpdateState, refreshUiStatus, subscribeUiUpdates } from '../lib/uiUpdates';
import { isTauri } from '../lib/platform';

/** Only this successfully mounted subtree acknowledges the new UI, not its error boundary. */
export function UiUpdateLifecycle() {
  useEffect(() => {
    if (!isTauri()) return;
    // A background/occluded WebView may suspend animation frames. Mount + IPC
    // is our startup check; it must not require the user to focus the window.
    void acknowledgeUiReady();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refreshUiStatus(); }, 15000);
    const refresh = () => { if (document.visibilityState === 'visible') void refreshUiStatus(); };
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return <UiUpdateNotification />;
}
export function UiUpdateNotification({inline=false}: {inline?: boolean}) {
  const {status,busy,message} = useSyncExternalStore(subscribeUiUpdates,getUiUpdateState,getUiUpdateState);
  const [dismissed,setDismissed] = useState<string | null>(null);
  if (!status?.enabled) return null;
  if (!inline && (!status.pendingVersion || dismissed === status.pendingVersion)) return null;
  return <div style={inline ? {fontSize:12,marginTop:12} : {position:'fixed',bottom:24,right:16,maxWidth:340,padding:16,borderRadius:12,background:'#222',color:'#fff',zIndex:10000}}>
    {inline && <div>Interface: {status.currentVersion} · {status.channel}</div>}
    <div role="status" aria-live="polite">{busy || status.checking ? 'Checking for interface updates…' : status.pendingVersion ? `Interface ${status.pendingVersion} is ready. It will apply the next time the app starts.` : message ?? 'Interface updates install without replacing the app.'}</div>
    {inline ? <button type="button" disabled={busy || status.checking} onClick={() => void checkUiUpdate()} style={{marginTop:8}}>Check interface updates</button> : <button type="button" onClick={() => setDismissed(status.pendingVersion)} style={{marginTop:8}}>Got it</button>}
  </div>;
}
