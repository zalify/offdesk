// P01: a browser code scanned for a hub older than this app. The phone would
// show the interface built into that hub, so say so before it happens and
// offer encrypted pairing, which keeps the app's own interface.

import { colors } from "@/lib/colors";
import { hubInterfaceLabel } from "@/lib/hubVersionCheck";
import { Body, Button, Display, Eyebrow, TextButton, fontDisplay } from "./Primitives.web";

export function OldHubNotice({
  host,
  appVersion,
  hub,
  target,
  busy,
  error,
  onBack,
  onScanEncrypted,
  onOpenAnyway,
}: {
  host: string;
  /** This app's own version; the row is left out until it is known. */
  appVersion: string | null;
  /** The hub's version, null for a hub from before 0.23. */
  hub: string | null;
  /** The hub version to update to (built with, capped at the newest release). */
  target: string;
  busy: boolean;
  error: string | null;
  /** Back to the welcome screen, nothing opened. */
  onBack: () => void;
  onScanEncrypted: () => void;
  onOpenAnyway: () => void;
}) {
  const hubLabel = hubInterfaceLabel(hub);
  const row = (label: string, value: string, attention = false) => (
    <div style={{ display: "flex", gap: 12, alignItems: "baseline" }}>
      <span style={{ flexGrow: 1, minWidth: 0, color: colors.fg2 }}>{label}</span>
      <span style={{ flexShrink: 0, whiteSpace: "nowrap", color: attention ? colors.err : colors.fg0 }}>{value}</span>
    </div>
  );
  return (
    <div
      data-testid="old-hub-notice"
      style={{
        minHeight: "100vh",
        boxSizing: "border-box",
        background: colors.bg0,
        display: "flex",
        justifyContent: "center",
        padding: "calc(env(safe-area-inset-top) + 40px) 24px calc(env(safe-area-inset-bottom) + 36px)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 480, display: "flex", flexDirection: "column", gap: 20 }}>
        <TextButton label="back" onClick={onBack} disabled={busy} testId="old-hub-back" style={{ alignSelf: "flex-start", marginLeft: -8 }}>
          ← back
        </TextButton>
        <Eyebrow prompt>connect {host}</Eyebrow>
        <Display size={28}>This hub is older than your app</Display>
        <Body>
          You scanned a browser code. With it, the phone shows the interface built into the hub, not the one in this app.
        </Body>
        <div
          style={{
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10,
            background: colors.bg1,
            border: `1px solid ${colors.lineSoft}`,
            borderRadius: 6,
            fontFamily: fontDisplay,
            fontSize: 13,
          }}
        >
          {appVersion ? row("this app", appVersion) : null}
          {row(`${host} hub`, hubLabel, true)}
          {row("you would see", hub ? `${hub} interface` : "an older interface", true)}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <span style={{ fontFamily: fontDisplay, fontSize: 14, fontWeight: 600, color: colors.fg0 }}>to get the new interface</span>
          <Body size={14}>
            Pair encrypted: on {host} open settings › phone and scan the encrypted code. Or update the hub on {host}
            {` to ${target}`}.
          </Body>
        </div>
        {error ? <Body size={13} style={{ color: colors.err }}><span role="alert">{error}</span></Body> : null}
        <span style={{ flexGrow: 1 }} />
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <Button onClick={onScanEncrypted} disabled={busy} style={{ height: 48 }} testId="old-hub-scan-encrypted">
            scan the encrypted code
          </Button>
          <Button kind="secondary" onClick={onOpenAnyway} disabled={busy} style={{ height: 48 }} testId="old-hub-open-anyway">
            {hub ? `open the ${hub} interface anyway` : "open the older interface anyway"}
          </Button>
        </div>
      </div>
    </div>
  );
}
