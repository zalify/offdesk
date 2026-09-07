import { useEffect, useState } from "react";
import { desktopRole, hubStatus, isDesktopShell, type HubStatus } from "@/lib/desktopHub";
import { getServerUrl } from "@/lib/serverUrl";
import { isSecureConnection } from "@/lib/secureTransport";
import { isLocalHubAddress } from "@/lib/onboardingFlow";
import { Body, Button, Card, Display, Wordmark } from "./Warm.web";
import { colors } from "@/lib/colors";
import { HubSetup } from "./DesktopSetup.web";
import { OnboardingView } from "./OnboardingView.web";

/** Empty Hub state is different from deliberately adding another machine. */
export function EmptyMachinesView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const [localHub, setLocalHub] = useState(false);
  const [checking, setChecking] = useState(isDesktopShell());
  const [status, setStatus] = useState<HubStatus | null>(null);
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
  useEffect(() => {
    if (!localHub) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await hubStatus();
        if (!cancelled) { setStatus(next); setError(null); }
      } catch { if (!cancelled) setError("Could not check this Mac. Retrying…"); }
      finally { if (!cancelled) timer = setTimeout(() => void refresh(), 2000); }
    };
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [localHub]);
  if (localHub && !manual && status) return <div style={{ flex: 1, overflowY: "auto" }}>
    <HubSetup status={status} onReady={() => window.location.reload()} onGiveUp={onOpenSettings} />
    <details style={{ padding: 24 }}><summary>Advanced setup</summary>
      <Button kind="sky" onClick={() => setManual(true)}>Connect a machine manually</Button>
    </details>
  </div>;
  if (!checking && (manual || (!mobile && !localHub))) return <OnboardingView />;
  return (
    <div data-testid="empty-machines" style={{ flex: 1, overflowY: "auto", padding: "40px 24px", background: colors.bg0 }}>
      <div style={{ maxWidth: 600, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
        <Wordmark size={26} />
        {checking || localHub ? <><Body>{error ?? "Checking this Mac’s setup…"}</Body><Button kind="sky" onClick={onOpenSettings}>Connection settings</Button></> : <>
          <Display size={30}>{mobile ? "Connected to your Hub" : "Finish setting up this Mac"}</Display>
          <Body>{mobile
            ? "You’re signed in, but this Hub has no machines yet. Finish setup in Offdesk on the computer that runs your Hub. This screen will update when a machine connects."
            : "The Hub is running, but this Mac has not appeared in its machine list. Retry setup to register this Mac and start its node service."}</Body>
          <Card style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <Body>No need to scan again or generate a token on your phone.</Body>
            <Button kind="sky" onClick={onOpenSettings}>Connection settings</Button>
          </Card>
        </>}
      </div>
    </div>
  );
}
