import { isSecureConnection } from "@/lib/secureTransport";
import { useEffect, useState } from "react";
import * as QRCode from "qrcode";
import { QrImage } from "./QrImage";

import { getAuthProviders, mintLoginCode } from "@/lib/api";
import { colors } from "@/lib/colors";
import { desktopRole, isDesktopShell } from "@/lib/desktopHub";
import { getServerUrl } from "@/lib/serverUrl";
import { HubPhoneCode } from "./DesktopSetup.web";

/**
 * Getting offdesk onto a phone: the hub's address as a QR code, and where to
 * get the app.
 *
 * Shown on the onboarding page — where someone setting up a hub actually is —
 * and in Settings, which is where they will look for it later.
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

  if (isSecureConnection() && !isHub) return <p style={{ color: colors.foregroundMuted, fontSize: 13 }}>To pair another encrypted App, create a new pairing code on the Hub’s own screen.</p>;
  if (isHub === null) return null;
  if (isHub) return <HubPhoneCode />;

  return (
    <div>
      <div
        style={{ fontSize: 11, color: colors.foregroundMuted, marginBottom: 12 }}
      >
        Scan this code with your phone's camera and the hub opens in its
        browser, signed in. In the iPhone or Android app, tap "Scan the code
        instead" on its first screen and point it here — same result, with
        the same terminal interface.
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
            borderRadius: 8,
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
            style={{ fontSize: 13, color: colors.foreground, marginBottom: 4 }}
          >
            Address the phone should open
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.foregroundMuted,
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
            style={{
              width: "100%",
              background: colors.background,
              border: `1px solid ${colors.border}`,
              borderRadius: 6,
              color: colors.foreground,
              padding: "8px 10px",
              fontSize: 13,
            }}
          />

          {sessionToken && (
            <div
              style={{
                fontSize: 11,
                color: colors.foreground,
                opacity: 0.8,
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
                fontSize: 11,
                color: colors.foreground,
                opacity: 0.8,
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
                style={{ display: "inline-block", background: colors.accent, borderRadius: 6,
                  color: colors.onAccent, padding: "8px 16px", fontSize: 13, fontWeight: 600, textDecoration: "none" }}>
                {label}
              </a>
            ))}
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.foregroundMuted,
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
}
