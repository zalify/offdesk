import { useEffect, useState } from "react";
import { desktopRole, hubInstall, isDesktopShell } from "@/lib/desktopHub";
import { getServerUrl } from "@/lib/serverUrl";
import { isSecureConnection } from "@/lib/secureTransport";
import { isLocalHubAddress } from "@/lib/onboardingFlow";
import { Body, Button, Card, Display, Wordmark } from "./Warm.web";
import { colors } from "@/lib/colors";
import { OnboardingView } from "./OnboardingView.web";

/** Empty Hub state is different from deliberately adding another machine. */
export function EmptyMachinesView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const [localHub, setLocalHub] = useState(false);
  const [checking, setChecking] = useState(isDesktopShell());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState(false);
  useEffect(() => {
    if (!isDesktopShell()) return;
    let cancelled = false;
    desktopRole().then((role) => {
      if (!cancelled) setLocalHub(role === "hub" && !isSecureConnection() && isLocalHubAddress(getServerUrl()));
    }).catch(() => {}).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, []);
  const repair = async () => {
    setWorking(true);
    setError(null);
    try {
      await hubInstall();
      // Refresh the authenticated snapshot even if the node connected before
      // the browser's WebSocket subscribed. No pairing or account is cleared.
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setWorking(false);
    }
  };
  if (!checking && (manual || (!mobile && !localHub))) return <OnboardingView />;
  return (
    <div data-testid="empty-machines" style={{ flex: 1, overflowY: "auto", padding: "40px 24px", background: colors.bg0 }}>
      <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
        <Wordmark size={26} />
        {checking ? <Body>Checking this Mac’s setup…</Body> : <>
          <Display size={30}>{mobile ? "Connected to your Hub" : "Finish setting up this Mac"}</Display>
          <Body>{mobile
            ? "You’re signed in, but this Hub has no machines yet. Finish setup in Offdesk on the computer that runs your Hub. This screen will update when a machine connects."
            : "The Hub is running, but this Mac has not appeared in its machine list. Retry setup to register this Mac and start its node service."}</Body>
          <Card style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            {mobile ? <Body>No need to scan again or generate a token on your phone.</Body> :
              <Button onClick={() => void repair()} disabled={working} testId="repair-local-machine">{working ? "Setting up this Mac…" : "Finish setup on this Mac"}</Button>}
            {error && <p role="alert" style={{ color: colors.err, overflowWrap: "anywhere" }}>{error}</p>}
            <Button kind="sky" onClick={onOpenSettings}>Connection settings</Button>
            {!mobile && <Button kind="sky" onClick={() => setManual(true)} disabled={working}>Connect a machine manually</Button>}
          </Card>
        </>}
      </div>
    </div>
  );
}
