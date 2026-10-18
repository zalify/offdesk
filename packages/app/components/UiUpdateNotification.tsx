import { useEffect, useState, useSyncExternalStore } from 'react';
import { acknowledgeUiReady, checkUiUpdate, getUiUpdateState, refreshUiStatus, subscribeUiUpdates } from '../lib/uiUpdates';
import { isTauri } from '../lib/platform';
import { colors } from '../lib/colors';
import { Button } from './Primitives.web';
import { rem } from "../lib/rem";

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
  const text = busy || status.checking ? 'Checking for interface updates…' : status.pendingVersion ? `Interface ${status.pendingVersion} is ready. It will apply the next time the app starts.` : message ?? 'Interface updates install without replacing the app.';
  if (inline) return <div style={{fontSize:rem(12),marginTop:12,display:'flex',flexDirection:'column',gap:8,alignItems:'flex-start'}}>
    <div style={{color:colors.fg3,textTransform:'lowercase'}}>Interface: {status.currentVersion} · {status.channel}</div>
    <div role="status" aria-live="polite" style={{fontFamily:'var(--font-sans)',fontSize:rem(13),color:colors.fg2}}>{text}</div>
    <Button size="sm" kind="secondary" disabled={busy || status.checking} onClick={() => void checkUiUpdate()} ariaLabel="Check interface updates">check interface updates</Button>
  </div>;
  return <div className="odk-float" style={{position:'fixed',bottom:50,right:16,maxWidth:340,padding:'14px 16px',zIndex:10000,display:'flex',flexDirection:'column',gap:10,fontSize:rem(13)}}>
    <div role="status" aria-live="polite" style={{fontFamily:'var(--font-sans)',lineHeight:1.5}}>{text}</div>
    <div><Button size="xs" kind="secondary" ariaLabel="Got it" onClick={() => setDismissed(status.pendingVersion)}>got it</Button></div>
  </div>;
}
