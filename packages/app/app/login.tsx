import { ConnectionRoutesPanel } from "../components/ConnectionRoutesPanel";
import { isPairingUri, pairSecureConnection, isSecureConnection, secureConnectionStatus, secureConnectionError, forgetSecureConnection } from "../lib/secureTransport";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { getAuthProviders, redeemLoginCode, type AuthProviders } from "../lib/api";
import { useAuth } from "../lib/auth";
import { codeFromLink, tokenFromLink } from "../lib/desktopHub";
import { isBundledOrigin, isTauri, isTauriMobile } from "../lib/platform";
import { getServerUrl, setServerUrl } from "../lib/serverUrl";
import { useMobileHubSwitch } from "../lib/useMobileHubSwitch";
import { Body, Button, Card, Display, Eyebrow, Wordmark, fontDisplay, inputStyle } from "../components/Warm.web";
import { colors } from "../lib/colors";

type OAuthProvider = "github" | "google";

const PROVIDERS: { value: OAuthProvider; label: string }[] = [
  { value: "github", label: "Sign in with GitHub" },
  { value: "google", label: "Sign in with Google" },
];

export default function LoginScreen({
  onBecomeHub,
}: {
  /** Desktop app only: the other answer to the first-run question. */
  onBecomeHub?: () => void;
} = {}) {
  const { login, loginWithToken } = useAuth();
  const [connecting, setConnecting] = useState(false);
  const [activeProvider, setActiveProvider] = useState<OAuthProvider | null>(
    null,
  );
  const [serverUrlInput, setServerUrlInput] = useState(
    getServerUrl(Platform.OS),
  );
  const [hubError, setHubError] = useState<string | null>(null);
  // Tauri-on-mobile (Android/iOS WebView) takes the same provider-button
  // path as plain mobile-web; only Tauri desktop uses the loopback flow.
  const isDesktop = isTauri() && !isTauriMobile();
  // The mobile app boots into its own bundled screens and knows no hub until
  // someone names one. Once it has, it navigates to the hub and this screen
  // is never seen again — the sign-in below is served by the hub itself.
  const needsHub = isTauriMobile() && isBundledOrigin();

  // Reaching this screen with a hub already stored means the app tried it on
  // launch and could not get there. Offer it back rather than making someone
  // retype an address on a phone.
  const [savedHub, setSavedHub] = useState<string | null>(null);
  useEffect(() => {
    if (!needsHub) return;
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("mobile_hub_url"))
      .then((url) => {
        if (!url) return;
        setSavedHub(url);
        setServerUrlInput(url);
      })
      .catch(() => {});
  }, [needsHub]);

  // What this hub can actually sign you in with. Until the answer arrives
  // nothing is drawn: a button that appears and then vanishes is worse than a
  // moment of nothing, and a button that fails when pressed is worse still.
  const [providers, setProviders] = useState<AuthProviders | null>(null);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [providersAttempt, setProvidersAttempt] = useState(0);
  useEffect(() => {
    if (isDesktop || needsHub) return;
    let cancelled = false;
    setProvidersError(null);
    getAuthProviders()
      .then((result) => {
        if (!cancelled) setProviders(result);
      })
      .catch(() => {
        // No answer means no hub behind this page (a dev server, a hub
        // that is down) — not "assume GitHub and Google", which drew two
        // buttons that could not work.
        if (!cancelled) {
          setProviders({ github: false, google: false, link: false });
          setProvidersError("Could not ask this hub how it signs people in. Is it running?");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, needsHub, providersAttempt]);

  const pair = async (uri: string) => {
    setConnecting(true); setHubError(null); setDesktopLinkError(null);
    try {
      const status = await pairSecureConnection(uri);
      await loginWithToken(status.endpoint.hub_url, "secure-session");
    } catch (error) { setHubError(String(error)); setDesktopLinkError(String(error)); setConnecting(false); }
  };
  const handleHubConnect = () => {
    if (isPairingUri(serverUrlInput)) { void pair(serverUrlInput.trim()); return; }
    setConnecting(true);
    setHubError(null);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) =>
        invoke("set_mobile_hub_url", { url: serverUrlInput.trim() }),
      )
      // On success the WebView is already loading the hub, so there is
      // nothing to do here but wait for it.
      .catch((error: unknown) => {
        setHubError(String(error));
        setConnecting(false);
      });
  };

  // The link the hub printed, pasted here. Same origin as this page means
  // this hub: loading it is the sign-in — the app reads `?token=`, stores it
  // and strips it. A link for another hub cannot be followed from a page the
  // first hub served; the mobile app can let go of this hub and take the
  // whole link on its own setup screen instead.
  const inMobileApp = isTauriMobile() && !isBundledOrigin();
  const [pastedLink, setPastedLink] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const handleOpenLink = () => openLink(pastedLink.trim());
  const openLink = (raw: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      setLinkError("That is not a link. Paste the whole thing, starting with http.");
      return;
    }
    if (!url.searchParams.has("token") && !url.searchParams.has("code")) {
      setLinkError("That link has no ?token= or ?code= in it. Copy the whole line the hub printed.");
      return;
    }
    if (url.origin === window.location.origin) {
      window.location.assign(url.toString());
      return;
    }
    setLinkError(
      inMobileApp
        ? `That link is for ${url.origin}, not this hub. Switch hub, then paste it there.`
        : `That link is for ${url.origin}, not this hub. Open it in the browser instead.`,
    );
  };
  // iOS keeps the local-network switch in the app's Settings page; the
  // scanner plugin already knows how to open it, and the app's own origin
  // is allowed to ask.
  const openSettings = async () => {
    try {
      const { openAppSettings } = await import("@tauri-apps/plugin-barcode-scanner");
      await openAppSettings();
    } catch {
      // Nothing to do: the message already says where the switch is.
    }
  };
  const { switchHub: handleSwitchHub, switching: switchingHub, error: switchHubError } = useMobileHubSwitch();

  // The phone's camera, in the app: reads the code the hub's page shows —
  // the sign-in link, with the token on it — so nothing is typed. Only the
  // app has a camera to offer; a browser tab uses the system camera app,
  // which opens the link by itself.
  const [scanError, setScanError] = useState<string | null>(null);
  // Errors from the plugin arrive as objects, not Error instances; String()
  // on those is "[object Object]", which tells nobody anything.
  const describe = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "message" in error) {
      return String((error as { message: unknown }).message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return "unknown error";
    }
  };
  const scanCode = async (): Promise<string | null> => {
    setScanError(null);
    try {
      const { scan, Format, checkPermissions, requestPermissions, openAppSettings } =
        await import("@tauri-apps/plugin-barcode-scanner");
      // The camera has to be asked for before it is used; scan() alone does
      // not put the system prompt up. Denied once, the prompt is gone for
      // good on Android and only the app's settings page can undo it.
      let permission = await checkPermissions();
      if (permission !== "granted") {
        permission = await requestPermissions();
      }
      if (permission !== "granted") {
        setScanError(
          "The camera is off for this app. Allow it in the app's settings, then try again.",
        );
        void openAppSettings().catch(() => {});
        return null;
      }
      const result = await scan({ windowed: false, formats: [Format.QRCode] });
      return result.content?.trim() || null;
    } catch (error) {
      const text = describe(error);
      setScanError(
        /cancel/i.test(text) ? null : `Could not scan: ${text}`,
      );
      return null;
    }
  };
  const handleScanForHub = async () => {
    const content = await scanCode();
    if (!content) return;
    setServerUrlInput(content);
    if (isPairingUri(content)) { await pair(content); return; }
    setConnecting(true);
    setHubError(null);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke("set_mobile_hub_url", { url: content }))
      .catch((error: unknown) => {
        setHubError(String(error));
        setConnecting(false);
      });
  };
  const handleScanForLink = async () => {
    const content = await scanCode();
    if (!content) return;
    setPastedLink(content);
    openLink(content);
  };

  const handleDesktopConnect = () => {
    setServerUrl(serverUrlInput.trim());
    setConnecting(true);
    void login().catch(() => {
      setConnecting(false);
    });
  };

  // The desktop app, handed the link the hub printed: the origin is the hub,
  // and the token (or the code the QR carries) is the sign-in. Nothing else
  // to type, and no browser round-trip.
  const [desktopLink, setDesktopLink] = useState("");
  const [desktopLinkError, setDesktopLinkError] = useState<string | null>(null);
  const handleDesktopLink = () => {
    const raw = desktopLink.trim();
    if (isPairingUri(raw)) { void pair(raw); return; }
    let origin: string;
    try {
      origin = new URL(raw).origin;
    } catch {
      setDesktopLinkError("That is not a link. Paste the whole thing, starting with http.");
      return;
    }
    const token = tokenFromLink(raw);
    const code = codeFromLink(raw);
    if (!token && !code) {
      setDesktopLinkError("That link has no ?token= or ?code= in it. Copy the whole line the hub printed.");
      return;
    }
    setDesktopLinkError(null);
    setConnecting(true);
    const signIn = token
      ? loginWithToken(origin, token)
      : redeemLoginCode(origin, code as string).then((redeemed) => loginWithToken(origin, redeemed));
    signIn.catch((error: unknown) => {
      setDesktopLinkError(String(error));
      setConnecting(false);
    });
  };

  const handleWebLogin = (provider: OAuthProvider) => {
    setActiveProvider(provider);
    void login(provider)
      .then(() => {
        if (Platform.OS !== "web") {
          setActiveProvider(null);
        }
      })
      .catch(() => {
        setActiveProvider(null);
      });
  };

  // One frame for every sign-in: sand, a cream card, the wordmark.
  const frame = (children: React.ReactNode) => (
    <div
      style={{
        flex: 1,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: colors.bg0,
        boxSizing: "border-box",
        overflow: "auto",
      }}
    >
      <div style={{ margin: "auto", width: "100%", maxWidth: 520, padding: "32px 20px", boxSizing: "border-box" }}>
        <Card style={{ display: "flex", flexDirection: "column", gap: 20, padding: 32 }}>{children}</Card>
      </div>
    </div>
  );
  const note = (text: string, tone: "muted" | "error" = "muted") => (
    <Body size={13} style={{ color: tone === "error" ? colors.err : colors.fg2 }}>
      {text}
    </Body>
  );

  // The phone app with a hub it could not reach: name what is in the way
  // before offering the address field again. iOS answers a refused Local
  // Network permission with "no route to host", which mobile_hub.rs turns
  // into a message naming the switches; anything else is the hub or the
  // network.
  const [retyping, setRetyping] = useState(false);
  const blockedMessage = hubError ?? (savedHub && !retyping ? "launch" : null);
  const permissionBlocked = blockedMessage !== null && /Local Network/.test(blockedMessage);
  const handleRetry = () => {
    setHubError(null);
    handleHubConnect();
  };

  if (isSecureConnection()) {
    return frame(<>
      <Wordmark />
      <Display size={28}>Encrypted connection</Display>
      <Body>{secureConnectionStatus()?.endpoint.hub_url ?? "Your paired Hub"}</Body>
      <Body size={14}>{secureConnectionError() ?? "Could not reconnect. Check that your Hub is running, then try again."}</Body>
      <ConnectionRoutesPanel onSwitched={() => {
        const url = secureConnectionStatus()?.endpoint.hub_url;
        if (url) void loginWithToken(url, "secure-session").catch(error => setHubError(String(error)));
      }} />
      <Button onClick={() => window.location.reload()}>Try again</Button>
      <Button kind="ghost" disabled={connecting} onClick={() => {
        setConnecting(true);
        void forgetSecureConnection().then(async () => {
          localStorage.removeItem("offdesk:server_url");
          if (isTauriMobile()) { const { invoke } = await import("@tauri-apps/api/core"); await invoke("clear_mobile_hub_url"); }
          else window.location.reload();
        }).catch((error) => { setHubError(String(error)); setConnecting(false); });
      }}>Forget connection and pair again</Button>
      {hubError ? note(hubError, "error") : null}
    </>);
  }

  if (needsHub && blockedMessage && !retyping && !isPairingUri(serverUrlInput)) {
    const address = (() => {
      try {
        return new URL(serverUrlInput.includes("://") ? serverUrlInput : `http://${serverUrlInput}`).host;
      } catch {
        return serverUrlInput;
      }
    })();
    const step = (n: string, title: string, sub: string) => (
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", padding: 16, borderRadius: 20, background: colors.bg0, border: `1px solid ${colors.lineSoft}` }}>
        <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 34, height: 34, borderRadius: "50%", border: `5px solid ${colors.accent}`, background: colors.bg1, fontFamily: fontDisplay, fontSize: 14, fontWeight: 700, flexShrink: 0 }}>{n}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ fontFamily: fontDisplay, fontSize: 16, fontWeight: 600, color: colors.fg0 }}>{title}</div>
          <Body size={14}>{sub}</Body>
        </div>
      </div>
    );
    return frame(
      <>
        <Wordmark />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow>Can't reach the hub</Eyebrow>
          <Display size={28}>
            {permissionBlocked
              ? "The hub is there. This phone isn't allowed to see it yet."
              : "Nothing answered at that address."}
          </Display>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 12, background: colors.bg0, border: `1px solid ${colors.lineSoft}` }}>
            <span style={{ width: 9, height: 9, borderRadius: "50%", border: `2px dashed ${colors.fg3}`, flexShrink: 0 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: colors.fg2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{address}</span>
            <span style={{ fontFamily: fontDisplay, fontSize: 12, fontWeight: 600, color: colors.fg3, marginLeft: "auto", flexShrink: 0 }}>
              {blockedMessage === "launch" ? "not reached on launch" : "no answer"}
            </span>
          </div>
        </div>
        {permissionBlocked ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Body size={14} style={{ fontFamily: fontDisplay, fontWeight: 600 }}>Two switches on a phone can block a hub on your own Wi-Fi:</Body>
            {step("1", "Local Network", "Settings → Apps → offdesk → Local Network. iOS asks once, and a No sticks until you flip it here.")}
            {step("2", "Wireless Data", "On phones sold in China: Settings → offdesk → Wireless Data → WLAN & Cellular.")}
          </div>
        ) : (
          <Body size={14}>
            {blockedMessage === "launch"
              ? "Check that the hub is running and that this phone is on the same network as it."
              : blockedMessage}
          </Body>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {permissionBlocked ? (
            <Button onClick={() => void openSettings()}>Open Settings</Button>
          ) : null}
          <Button kind={permissionBlocked ? "sky" : "coral"} onClick={handleRetry} disabled={connecting}>
            {connecting ? "Trying…" : "Try again"}
          </Button>
          <Button kind="ghost" onClick={() => setRetyping(true)} style={{ alignSelf: "center", height: 40, fontSize: 14 }}>
            Use another address
          </Button>
        </div>
      </>,
    );
  }

  if (needsHub) {
    return frame(
      <>
        <Wordmark />
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow>Welcome</Eyebrow>
          <Display size={30}>Your terminal stays home.</Display>
          <Body>
            Point this at the code your hub shows: on the Mac's screen, or in its menu bar under Show the phone
            code. That's the sign-in, nothing to type.
          </Body>
        </div>
        <Button onClick={() => void handleScanForHub()} disabled={connecting}>
          Scan the code
        </Button>
        {scanError ? note(scanError, "error") : null}
        {hubError ? note(hubError, "error") : null}
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ flexGrow: 1, height: 1, background: colors.line }} />
          <span style={{ fontFamily: fontDisplay, fontSize: 13, fontWeight: 600, color: colors.fg3 }}>No code handy?</span>
          <div style={{ flexGrow: 1, height: 1, background: colors.line }} />
        </div>
        <input
          type="url"
          value={serverUrlInput}
          onChange={(event) => setServerUrlInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleHubConnect();
          }}
          placeholder="Hub address or offdesk://pair?…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          inputMode="url"
          style={inputStyle}
        />
        <Button kind="sky" onClick={handleHubConnect} disabled={connecting || !serverUrlInput.trim()}>
          {connecting ? "Connecting…" : "Connect"}
        </Button>
      </>,
    );
  }

  if (isDesktop) {
    const rule = (
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ flexGrow: 1, height: 1, background: colors.line }} />
        <span style={{ fontFamily: fontDisplay, fontSize: 13, fontWeight: 600, color: colors.fg3 }}>
          or, with a hub address and an account
        </span>
        <div style={{ flexGrow: 1, height: 1, background: colors.line }} />
      </div>
    );
    return (
      <div
        style={{
          flex: 1,
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 40,
          background: colors.bg0,
          boxSizing: "border-box",
          overflow: "auto",
        }}
      >
        <Card style={{ width: "100%", maxWidth: 560, display: "flex", flexDirection: "column", gap: 22, padding: 40 }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <Eyebrow color={colors.info}>Just connecting</Eyebrow>
            <Display size={34}>Point it at your hub</Display>
            <Body>Paste the link the hub printed. It has the sign-in on it, so nothing else to type.</Body>
          </div>
          <input
            type="text"
            value={desktopLink}
            onChange={(event) => {
              setDesktopLink(event.target.value);
              setDesktopLinkError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleDesktopLink();
            }}
            placeholder="Hub sign-in link or offdesk://pair?…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="desktop-link-input"
            style={inputStyle}
          />
          <Body size={13.5}>
            Where to find it again: on the hub's machine, the menu bar icon shows it, and so does{" "}
            <code style={{ background: "rgb(43 35 64 / 0.06)", padding: "2px 6px", borderRadius: 6 }}>offdesk link</code>{" "}
            in any terminal there.
          </Body>
          {desktopLinkError ? <Body size={13} style={{ color: colors.err }}>{desktopLinkError}</Body> : null}
          <Button onClick={handleDesktopLink} disabled={connecting || !desktopLink.trim()} testId="desktop-link-connect">
            {connecting ? "Connecting…" : "Connect"}
          </Button>

          {rule}

          <input
            type="text"
            value={serverUrlInput}
            onChange={(event) => setServerUrlInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") handleDesktopConnect();
            }}
            placeholder="https://hub.example.dev"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            data-testid="desktop-server-url"
            style={inputStyle}
          />
          <Button kind="sky" onClick={handleDesktopConnect} disabled={connecting || !serverUrlInput.trim()}>
            Sign in in the browser
          </Button>
          <div style={{ fontFamily: fontDisplay, fontSize: 12.5, fontWeight: 600, color: colors.fg3 }}>
            Only hubs reachable from outside your network have GitHub or Google sign-in. At home, the link is the sign-in.
          </div>
          {onBecomeHub ? (
            <Button kind="ghost" onClick={onBecomeHub} style={{ alignSelf: "center", height: 36, fontSize: 13 }} testId="login-become-hub">
              This is the machine that stays on, actually
            </Button>
          ) : null}
        </Card>
      </div>
    );
  }

  const link = providers?.link ? (
    <>
      <Body>
        This hub has no GitHub or Google sign-in, so the address alone does not get you in. It printed a link
        when it was installed — also under Settings → Mobile app on the computer that runs it, as a code for
        this phone's camera. Paste that link here:
      </Body>
      <input
        type="url"
        value={pastedLink}
        onChange={(event) => {
          setPastedLink(event.target.value);
          setLinkError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") handleOpenLink();
        }}
        placeholder="http://192.168.1.10:4317/?token=…"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        style={inputStyle}
      />
      {linkError ? note(linkError, "error") : null}
      <Button onClick={handleOpenLink} disabled={!pastedLink.trim()}>
        Open the link
      </Button>
      {inMobileApp ? (
        <Button kind="sky" onClick={() => void handleScanForLink()}>
          Scan the code instead
        </Button>
      ) : null}
      {scanError && inMobileApp ? note(scanError, "error") : null}
      {switchHubError && inMobileApp ? <div role="alert">{note(switchHubError, "error")}</div> : null}
      {inMobileApp ? (
        <Button kind="ghost" onClick={() => void handleSwitchHub()} disabled={switchingHub} style={{ alignSelf: "center", height: 36, fontSize: 13 }}>
          {switchingHub ? "Switching…" : "Use a different hub"}
        </Button>
      ) : null}
    </>
  ) : null;

  const oauth = PROVIDERS.filter((provider) => (providers === null ? false : providers[provider.value]));

  return frame(
    <>
      <Wordmark />
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Eyebrow>Sign in</Eyebrow>
        <Display size={30}>Your terminal stays home.</Display>
        {providers === null ? <Body>Asking this hub how it signs people in…</Body> : null}
        {providersError ? (
          <Body size={13} style={{ color: colors.err }}>
            {providersError}
          </Body>
        ) : providers && !providers.link && oauth.length === 0 ? (
          <Body size={13}>This hub offers no way to sign in here. Its owner can add GitHub or Google sign-in, or hand you its link.</Body>
        ) : null}
      </div>
      {providersError ? (
        <Button kind="sky" onClick={() => setProvidersAttempt((n) => n + 1)}>
          Try again
        </Button>
      ) : null}
      {link}
      {oauth.length > 0 ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {oauth.map((provider, index) => {
            const active = activeProvider === provider.value;
            return (
              <Button
                key={provider.value}
                kind={index === 0 ? "coral" : "sky"}
                onClick={() => handleWebLogin(provider.value)}
                disabled={activeProvider !== null}
              >
                {active ? "Opening…" : provider.label}
              </Button>
            );
          })}
        </div>
      ) : null}
    </>,
  );
}
