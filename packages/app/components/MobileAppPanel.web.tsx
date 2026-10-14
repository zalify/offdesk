import { isSecureConnection, savedHubs, secureConnectionStatus } from "@/lib/secureTransport";
import { useEffect, useState, type ReactNode } from "react";
import * as QRCode from "qrcode";
import { QrImage } from "./QrImage";

import { getAuthProviders, mintLoginCode } from "@/lib/api";
import { colors } from "@/lib/colors";
import { desktopRole, isDesktopShell } from "@/lib/desktopHub";
import { getServerUrl } from "@/lib/serverUrl";
import { detectOS } from "@/lib/platform";
import { openSettings } from "@/lib/openSettings";
import { hostOf, hubWarning, useVersions } from "@/lib/hubVersions";
import { HubPhoneCode } from "./DesktopSetup.web";
import { Button, fontDisplay, fontProse, TextButton } from "./Primitives.web";

/**
 * Getting offdesk onto a phone: the hub's address as a QR code, and where to
 * get the app.
 *
 * Shown on the onboarding page — where someone setting up a hub actually is —
 * and in Settings, which is where they will look for it later. The desktop
 * app on a node sends the phone to the hub instead (wireframe U03): only the
 * hub makes encrypted pairing codes, and the browser code is the fallback.
 */
export function MobileAppPanel() {
  // The desktop app on the machine that is the hub has the hub's own code,
  // with the addresses a phone can reach; that panel is the one to show.
  const [isHub, setIsHub] = useState<boolean | null>(() => (isDesktopShell() ? null : false));
  useEffect(() => {
    if (!isDesktopShell()) return;
    desktopRole()
      .then((role) => setIsHub(role === "hub"))
      .catch(() => setIsHub(false));
  }, []);

  // Defaults to the hub this app is connected to, else the address this page
  // came from — right whenever the browser reached the hub the way a phone
  // would, and wrong on a laptop looking at localhost, so it stays editable.
  const [shareUrl, setShareUrl] = useState(() =>
    getServerUrl() || (typeof window === "undefined" ? "" : window.location.origin),
  );
  const [qrSvg, setQrSvg] = useState<string | null>(null);

  // On a hub with no OAuth, a phone that opens the bare address lands on a
  // login screen with nothing to press. So the code carries the session of
  // whoever is looking at it — this panel is only ever shown to someone
  // signed in — and scanning it is signing in. With OAuth configured the
  // phone can sign in on its own, and the code stays a plain address.
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  useEffect(() => {
    if (isSecureConnection()) return;
    let cancelled = false;
    getAuthProviders()
      .then((providers) => (providers.link ? mintLoginCode() : null))
      .then((result) => {
        if (!cancelled && result) setSessionToken(result.code);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const encoded = sessionToken
    ? `${shareUrl.trim().replace(/\/+$/, "")}/?code=${sessionToken}`
    : shareUrl.trim();

  const isLoopback = /^(localhost|127\.0\.0\.1|\[?::1\]?)$/i.test(
    (() => {
      try {
        return new URL(shareUrl).hostname;
      } catch {
        return "";
      }
    })(),
  );

  useEffect(() => {
    let cancelled = false;
    if (!shareUrl.trim()) {
      setQrSvg(null);
      return;
    }
    QRCode.toString(encoded, {
      type: "svg",
      margin: 4,
      errorCorrectionLevel: "M",
      // Hex only — the theme's colours are `rgb(var(--color-…))`, which the
      // encoder rejects. Black on white also reads most reliably through a
      // phone camera, so the code sits on its own white tile rather than
      // borrowing the page's palette.
      color: { dark: "#000000", light: "#ffffff" },
    })
      .then((svg) => {
        if (!cancelled) setQrSvg(svg);
      })
      .catch((error) => {
        console.error("[offdesk] could not encode the hub address", error);
        if (!cancelled) setQrSvg(null);
      });
    return () => {
      cancelled = true;
    };
  }, [shareUrl, encoded]);

  if (isHub === null) return null;
  if (isHub) return <HubPhoneCode />;

  // A browser on the phone, signed in by scanning: the whole panel in a
  // browser, the fallback on a node's desktop app.
  const browserCode = (
    <div>
      <div
        style={{ fontSize: 12, fontFamily: "var(--font-sans)", color: colors.fg3, marginBottom: 12 }}
      >
        Browser sign-in · No app needed. Scan with your phone’s camera to
        open this Hub in a browser. For end-to-end encrypted App pairing,
        open the phone connection screen on the Mac running the Hub and
        choose Offdesk App.
      </div>

      <div
        style={{
          display: "flex",
          gap: 20,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <div
          style={{
            width: 168,
            height: 168,
            padding: 12,
            borderRadius: 4,
            background: "#ffffff",
            border: `1px solid ${colors.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          {qrSvg ? <QrImage svg={qrSvg} size={142} label="Phone sign-in QR code" /> : (
            <span style={{ fontSize: 11, color: colors.foregroundMuted }}>QR code unavailable. Copy a sign-in link from the Hub’s screen.</span>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 240 }}>
          <div
            style={{ fontSize: 12, fontWeight: 500, color: colors.fg0, marginBottom: 4 }}
          >
            address the phone should open
          </div>
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              color: colors.fg3,
              marginBottom: 8,
            }}
          >
            Whatever your phone can reach — a LAN address, a tunnel hostname, a
            tailnet name.
          </div>
          <input
            type="text"
            value={shareUrl}
            onChange={(event) => setShareUrl(event.target.value)}
            placeholder="http://192.168.1.10:4317"
            aria-label="Address the phone should open"
            className="odk-input"
          />

          {sessionToken && (
            <div
              style={{
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                color: colors.fg2,
                marginTop: 8,
              }}
            >
              This hub has no GitHub or Google sign-in, so the code also carries
              your session: scanning it signs the phone in as you. Treat it like
              a password.
            </div>
          )}

          {isLoopback && (
            <div
              style={{
                fontSize: 12,
                fontFamily: "var(--font-sans)",
                color: colors.fg2,
                marginTop: 8,
              }}
            >
              This page is open on a loopback address, which no phone can reach.
              Put the hub's LAN address or public hostname here instead.
            </div>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
            {[
              { label: "iPhone · TestFlight", href: "https://testflight.apple.com/join/rV4ktaGv" },
              { label: "Android APK", href: "https://offdesk.dev/apk" },
            ].map(({ label, href }) => (
              <a key={href} href={href} target="_blank" rel="noreferrer"
                className="odk-btn odk-btn--secondary odk-btn--sm">
                {label}
              </a>
            ))}
          </div>
          <div
            style={{
              fontSize: 12,
              fontFamily: "var(--font-sans)",
              color: colors.fg3,
              marginTop: 8,
            }}
          >
            Install the iPhone app through TestFlight, or allow installation of
            the Android APK. Then use Scan QR Code in the app. For a local
            connection, keep your phone and computer on the same Wi-Fi.
          </div>
        </div>
      </div>
    </div>
  );

  if (isDesktopShell()) return <NodePhonePanel browserCode={isSecureConnection() ? null : browserCode} />;
  if (isSecureConnection()) return <p style={{ color: colors.foregroundMuted, fontSize: 13 }}>To pair another encrypted App, create a new pairing code on the Hub’s own screen.</p>;
  return browserCode;
}

/** The desktop app on a node (wireframe U03): the phone pairs on the hub,
 *  with a warning when that hub is behind, and the browser code demoted to
 *  a fallback behind a button. */
function NodePhonePanel({ browserCode }: { browserCode: ReactNode | null }) {
  const versions = useVersions();
  const [showBrowserCode, setShowBrowserCode] = useState(false);
  const address = secureConnectionStatus()?.endpoint.hub_url || getServerUrl() || (typeof window === "undefined" ? "" : window.location.origin);
  // An encrypted hub has the name it was saved under; otherwise its host.
  const [hubName, setHubName] = useState(() => hostOf(address));
  useEffect(() => {
    const key = secureConnectionStatus()?.endpoint.public_key;
    if (!key) return;
    let cancelled = false;
    savedHubs()
      .then((hubs) => {
        const name = hubs.find((hub) => hub.status.endpoint.public_key === key)?.name?.trim();
        if (!cancelled && name) setHubName(name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  const warning = hubWarning(versions.hub, hubName);
  const shownAddress = address.replace(/^[a-z]+:\/\//i, "").replace(/\/+$/, "");

  return (
    <div data-testid="node-phone-panel" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>
        This {detectOS() === "macos" ? "Mac" : "computer"} is a node. Your phone pairs with the hub, and only the hub makes pairing codes.
      </div>
      <section aria-label="Pair on the hub" style={{ boxSizing: "border-box", padding: 24, display: "flex", flexWrap: "wrap", gap: "20px 32px", alignItems: "center", background: colors.bg1, border: `1px solid ${colors.line}`, borderRadius: 6 }}>
        <div style={{ flex: "1 1 280px", minWidth: 0, display: "flex", flexDirection: "column", gap: 14 }}>
          <span style={{ fontFamily: fontDisplay, fontSize: 16, fontWeight: 600, color: colors.fg0 }}>Pair your phone on {hubName}</span>
          <ol style={{ margin: 0, padding: "0 0 0 20px", listStyle: "decimal", display: "flex", flexDirection: "column", gap: 8, fontFamily: fontProse, fontSize: 14, lineHeight: "21px", color: colors.fg1 }}>
            <li>On {hubName}, open Offdesk DEV › settings › phone.</li>
            <li>In the phone app, tap scan and point it at the encrypted code.</li>
            <li>The app keeps its own interface and stays encrypted at home or away.</li>
          </ol>
        </div>
        <div style={{ width: 220, maxWidth: "100%", flexShrink: 0, display: "flex", flexDirection: "column", gap: 8, fontFamily: fontDisplay, fontSize: 12, color: colors.fg3 }}>
          <div style={{ display: "flex", gap: 12 }}><span style={{ flex: 1 }}>hub</span><span style={{ color: colors.fg0, overflowWrap: "anywhere", textAlign: "right" }}>{hubName}</span></div>
          <div style={{ display: "flex", gap: 12 }}><span style={{ flex: 1 }}>address</span><span style={{ color: colors.fg0, overflowWrap: "anywhere", textAlign: "right" }}>{shownAddress}</span></div>
        </div>
      </section>
      {warning ? (
        <div data-testid="node-phone-hub-behind" style={{ boxSizing: "border-box", padding: "14px 16px", display: "flex", gap: 12, alignItems: "center", background: colors.bg1, border: `1px solid ${colors.err}`, borderRadius: 6 }}>
          <span aria-hidden="true" style={{ color: colors.err, fontFamily: fontDisplay, fontSize: 13, fontWeight: 600 }}>!</span>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontFamily: fontDisplay, fontSize: 13, fontWeight: 600, color: colors.fg0 }}>{warning}</span>
            <span style={{ fontFamily: fontProse, fontSize: 13, lineHeight: "20px", color: colors.fg2 }}>
              Update {hubName} first, or the phone's browser code shows the hub's older interface.
            </span>
          </div>
          <TextButton strong onClick={() => openSettings("Versions")}>versions ›</TextButton>
        </div>
      ) : null}
      {browserCode ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px 24px", flexWrap: "wrap", padding: "12px 0", borderBottom: `1px solid ${colors.lineSoft}` }}>
            <div style={{ flex: "1 1 240px", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ fontFamily: fontDisplay, fontSize: 14, color: colors.fg0 }}>phone browser without the app</span>
              <span style={{ fontFamily: fontProse, fontSize: 12.5, color: colors.fg3 }}>A sign-in code for a browser. It shows the interface built into the hub.</span>
            </div>
            <Button size="sm" kind="secondary" onClick={() => setShowBrowserCode((shown) => !shown)}>
              {showBrowserCode ? "hide browser code" : "show browser code"}
            </Button>
          </div>
          {showBrowserCode ? browserCode : null}
        </div>
      ) : null}
    </div>
  );
}
