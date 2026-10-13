import { CloudConnectionPanel } from "./CloudConnectionPanel";
import { SecurePairingPanel } from "./SecureConnectionPanel";
import { isSecureConnection } from "../lib/secureTransport";
// The desktop app's first run, and the machine that stays on.
//
// One question — is this the machine that stays on? — and two answers. "Yes"
// runs the bundled hub install and lands on the code the phone scans; "no"
// is the client the app has always been. The Tauri side is role.rs; the
// typed calls are lib/desktopHub.ts. Design: docs/design/desktop-hub/.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import * as QRCode from "qrcode";
import { QrImage } from "./QrImage";

import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/colors";
import {
  hubAddressOptions,
  desktopRole,
  hubInstall,
  hubIsReady,
  hubLink,
  hubStatus,
  hubUninstall,
  setDesktopRole,
  tokenFromLink,
  type DesktopRole,
  type HubLink,
  type HubStatus,
} from "@/lib/desktopHub";
import { getServerUrl, setServerUrl } from "@/lib/serverUrl";
import LoginScreen from "../app/login";
import { AppTitleBar } from "./AppTitleBar.web";
import { Body, Button, Card, Display, Eyebrow, Spinner, StepMark, Wordmark, fontDisplay } from "./Primitives.web";

const IPHONE_URL = "https://testflight.apple.com/join/rV4ktaGv";
const ANDROID_URL = "https://offdesk.dev/apk";

async function openOutside(url: string) {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}

async function copyText(text: string) {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
  } catch {
    await navigator.clipboard.writeText(text);
  }
}

// ── The gate ──────────────────────────────────────────────────────

/**
 * Wraps the desktop app's whole tree. Decides, from the stored role and the
 * hub's state on this machine, whether to show the first-run question, the
 * install, the code for the phone, the sign-in, or the app itself.
 */
export function DesktopGate({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, login, loginWithToken } = useAuth();
  // undefined: not read yet. null: never answered.
  const [role, setRole] = useState<DesktopRole | null | undefined>(undefined);
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [link, setLink] = useState<HubLink | null>(null);
  const [settingUp, setSettingUp] = useState(false);
  const [reconnectAfterSetup, setReconnectAfterSetup] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [reconnectExpired, setReconnectExpired] = useState(false);

  useEffect(() => {
    setReconnectExpired(false);
    if (!isLoading) return;
    const timer = setTimeout(() => setReconnectExpired(true), 10_000);
    return () => clearTimeout(timer);
  }, [isLoading, recovering]);

  useEffect(() => {
    // A bridge that does not know the command (an older shell, or a test's
    // stub) answers with nothing: that is "never answered", not "loading".
    desktopRole()
      .then((stored) => {
        if (stored) {
          setRole(stored);
          return;
        }
        // An install from before the question, already pointed at a hub:
        // it has answered "just connecting" by having one. Ask nobody.
        if (getServerUrl()) {
          setRole("client");
          void setDesktopRole("client").catch(() => {});
          return;
        }
        setRole(null);
      })
      .catch(() => setRole(null));
  }, []);

  useEffect(() => {
    if (role !== "hub") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await hubStatus();
        if (!cancelled) { setStatus(next); setStatusError(false); }
      } catch {
        // Keep retrying, but give the user an actionable state.
        if (!cancelled) setStatusError(true);
      } finally {
        if (!cancelled) timer = setTimeout(() => void refresh(), 2000);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [role]);

  const pick = useCallback(async (picked: DesktopRole) => {
    await setDesktopRole(picked);
    setStatus(null);
    setSettingUp(picked === "hub");
    setReconnectAfterSetup(false);
    setRole(picked);
  }, []);

  // Into the terminal: this app is now a client of the hub it just made,
  // signed in with the owner's own link. An OAuth hub has no link; the
  // browser sign-in the client path uses works for it.
  const openTerminal = useCallback(
    async (current: HubLink) => {
      const token = tokenFromLink(current.link);
      if (token) {
        await loginWithToken(current.local_url ?? current.url, token);
        return;
      }
      setServerUrl(current.local_url ?? current.url);
      await login();
    },
    [login, loginWithToken],
  );

  const reconnectLocalHub = async () => {
    // Obtain a fresh login from the native local Hub. Never send a saved
    // remote token to a guessed address or replace a pinned encrypted Hub.
    if (isSecureConnection()) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      const local = await hubLink();
      if (!isSecureConnection()) await openTerminal(local);
    } catch (error) {
      setRecoveryError(String(error));
    } finally {
      setRecovering(false);
    }
  };

  if (isSecureConnection() && !isLoading) return isAuthenticated ? <>{children}</> : <DesktopSetupFrame><LoginScreen /></DesktopSetupFrame>;
  if (role === undefined) return <DesktopSetupFrame><Spinner /></DesktopSetupFrame>;
  if (role === null) return <DesktopSetupFrame><FirstRun onPick={pick} /></DesktopSetupFrame>;

  if (role === "hub") {
    if (!status) return <DesktopSetupFrame><Screen><Spinner /><Body>{statusError ? "Could not check this Mac. Retrying…" : "Checking this Mac…"}</Body><Button kind="secondary" onClick={() => void pick("client")}>Connect to another Hub</Button></Screen></DesktopSetupFrame>;
    // Keep existing terminals visible through brief Hub restarts. A first-run
    // install owns this screen until its command AND readiness checks finish;
    // the background status poll must not unmount it halfway through.
    if (!settingUp && isAuthenticated) return <>{children}</>;
    // A saved login is still being checked during cold-start/restart. Do not
    // mistake a temporary auth request failure for an incomplete installation
    // and reinstall services while the existing Hub is recovering.
    if (!settingUp && status.hub_installed && status.node_installed && isLoading) {
      return <DesktopSetupFrame><Screen>
        <div role="status">{!reconnectExpired && <Spinner />}<Body>{reconnectExpired ? "Could not reconnect to your saved Hub address." : "Reconnecting to your hub…"}</Body></div>
        {!isSecureConnection() && <>
          <Body>This Mac’s network address may have changed. Reconnect using its local Hub to keep working.</Body>
          <Button disabled={recovering || !status.listening} onClick={() => void reconnectLocalHub()}>{recovering ? "Connecting…" : "Reconnect to this Mac"}</Button>
        </>}
        {recoveryError && <div role="alert">{recoveryError}</div>}
        <Button kind="secondary" disabled={recovering} onClick={() => { setReconnectAfterSetup(true); setSettingUp(true); }}>Check this Mac’s setup</Button>
      </Screen></DesktopSetupFrame>;
    }
    if (settingUp || !hubIsReady(status)) {
      return (
        <DesktopSetupFrame><HubSetup
          status={status}
          onStart={() => setSettingUp(true)}
          onReady={(ready, verified) => {
            setLink(ready);
            setSettingUp(false);
            setStatus(verified);
            if (reconnectAfterSetup) {
              setReconnectAfterSetup(false);
              void reconnectLocalHub();
            }
          }}
          onGiveUp={() => void pick("client")}
        /></DesktopSetupFrame>
      );
    }
    if (isLoading) return <DesktopSetupFrame><Spinner /></DesktopSetupFrame>;
    if (!isAuthenticated) {
      return <DesktopSetupFrame><HubReadyScreen initial={link} onOpen={openTerminal} /></DesktopSetupFrame>;
    }
    return <>{children}</>;
  }

  if (isLoading) return <DesktopSetupFrame><Spinner /></DesktopSetupFrame>;
  if (!isAuthenticated) return <DesktopSetupFrame><LoginScreen onBecomeHub={() => void pick("hub")} onBackToSetup={() => setRole(null)} /></DesktopSetupFrame>;
  return <>{children}</>;
}

function DesktopSetupFrame({ children }: { children: ReactNode }) {
  return (
    <div style={{ height: "100dvh", display: "flex", flexDirection: "column", overflow: "hidden", background: colors.bg0 }}>
      <AppTitleBar isMobile={false} />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {children}
      </div>
    </div>
  );
}

// ── First run ─────────────────────────────────────────────────────

function FirstRun({ onPick }: { onPick: (role: DesktopRole) => Promise<void> }) {
  const [busy, setBusy] = useState<DesktopRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = (role: DesktopRole) => {
    setBusy(role);
    setError(null);
    onPick(role).catch((e: unknown) => {
      setError(String(e));
      setBusy(null);
    });
  };
  return (
    <Screen>
      <div style={{ width: "100%", maxWidth: 880, display: "flex", flexDirection: "column", gap: 14 }}>
        <Wordmark size={18} />
        <div style={{ marginTop: 20 }}><Eyebrow prompt>first run</Eyebrow></div>
        <Display size={40} cursor>Which machine is this?</Display>
        <Body size={16}>Same app either way. Tell it what this machine does and it sets itself up.</Body>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 340px), 1fr))", gap: 16, width: "100%", maxWidth: 880 }}>
        <RoleCard
          label="hub"
          accent
          title="The one that stays on"
          body="The Mac mini under the desk, or your work machine. It runs the hub, keeps your terminals alive and is the address everything else connects to."
          note="Installs the hub, the node and tmux here. No account, no cloud."
          action={
            <Button onClick={() => choose("hub")} disabled={busy !== null} testId="first-run-hub">
              {busy === "hub" ? "One moment…" : "Set this machine up"}
            </Button>
          }
        />
        <RoleCard
          label="client"
          title="Just connecting"
          body="A laptop or a second machine. It opens the terminals that live on your hub."
          note="Paste the link the hub printed, or sign in."
          action={
            <Button kind="secondary" onClick={() => choose("client")} disabled={busy !== null} testId="first-run-client">
              Connect to a hub
            </Button>
          }
        />
      </div>
      {error ? <div role="alert" style={errorBox}>{error}</div> : null}
      <div style={{ width: "100%", maxWidth: 880 }}>
        <Body size={12} style={{ color: colors.fg3 }}>You can change this later in settings.</Body>
      </div>
    </Screen>
  );
}

function RoleCard({
  label,
  accent = false,
  title,
  body,
  note,
  action,
}: {
  label: string;
  accent?: boolean;
  title: string;
  body: string;
  note: string;
  action: ReactNode;
}) {
  return (
    <Card style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, padding: 24 }}>
      <span style={{ fontFamily: fontDisplay, fontSize: 12, fontWeight: 500, color: accent ? colors.accent : colors.fg3 }}>{label}</span>
      <Display size={22}>{title}</Display>
      <Body size={15} style={{ flexGrow: 1 }}>{body}</Body>
      <div style={{ marginTop: 8 }}>{action}</div>
      <Body size={12} style={{ color: colors.fg3 }}>{note}</Body>
    </Card>
  );
}

// ── Becoming the hub ──────────────────────────────────────────────

export function HubSetup({
  status,
  onReady,
  onGiveUp,
  onStart,
}: {
  status: HubStatus;
  onStart?: () => void;
  onReady: (link: HubLink, status: HubStatus) => void;
  onGiveUp: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<HubStatus | null>(null);
  const checked = progress?.setup ?? status.setup;

  useEffect(() => {
    if (!status.supported) {
      setError("The hub runs on macOS and Linux. On this machine the app is a client.");
      return;
    }
    let cancelled = false;
    onStart?.();
    setError(null);
    const prepare = async () => {
      const current = await hubStatus();
      // Reopening a completed installation verifies it without reinstalling.
      const link = hubIsReady(current) ? await hubLink() : await hubInstall();
      // launchd accepting a service does not mean the node has connected yet.
      const deadline = Date.now() + 30000;
      do {
        if (cancelled) return;
        const next = await hubStatus();
        if (cancelled) return;
        setProgress(next);
        if (hubIsReady(next)) { onReady(link, next); return; }
        await new Promise(resolve => setTimeout(resolve, 1500));
      } while (Date.now() < deadline);
      throw new Error("Setup has not finished. Keep this Mac online and try again. Your existing data is kept.");
    };
    void prepare().catch((e: unknown) => { if (!cancelled) setError(String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, status.supported]);

  const steps = [
    { done: checked?.hub_running ?? status.listening, title: "start your hub", meta: "offdesk-hub", sub: "Starts at login and restarts if it stops." },
    { done: checked?.machine_registered ?? false, title: "connect this Mac to your hub", sub: "Its node runs as a service too, so the first terminal you open is a shell right here." },
    { done: checked?.node_online ?? false, title: "wait for this Mac to come online", sub: "Checks the live connection, so your phone has a machine to open." },
    { done: checked?.tmux_available ?? false, title: "check terminal tools", meta: "tmux", sub: "Checks that tmux can run on this Mac." },
  ];
  const active = error ? -1 : steps.findIndex((step) => !step.done);

  return (
    <Screen>
      <div style={{ width: "100%", maxWidth: 600, display: "flex", flexDirection: "column", gap: 10 }}>
        <Eyebrow prompt>setting up the hub</Eyebrow>
        <Display size={36}>{error ? "Let’s finish setting up this Mac" : "Getting this Mac ready…"}</Display>
        <Body size={15}>Takes about a minute. You can leave this window open.</Body>
      </div>
      <StepList steps={steps} active={active} />
      {error ? (
        <div style={{ width: "100%", maxWidth: 600, display: "flex", flexDirection: "column", gap: 10, paddingTop: 12, borderTop: `1px dashed ${colors.lineSoft}` }}>
          <div style={{ fontFamily: fontDisplay, fontSize: 12, fontWeight: 500, color: colors.fg3 }}>if a step fails</div>
          <div role="alert" style={errorBox}>{error}</div>
          <div style={{ display: "flex", gap: 8 }}>
            {status.supported ? (
              <Button size="sm" onClick={() => setAttempt((n) => n + 1)} testId="hub-setup-retry">
                Try again
              </Button>
            ) : null}
            <Button size="sm" kind="secondary" onClick={onGiveUp}>
              Connect to another hub
            </Button>
          </div>
        </div>
      ) : (
        <div style={{ width: "100%", maxWidth: 600, boxSizing: "border-box", padding: "12px 16px", border: `1px solid ${colors.lineSoft}`, borderRadius: 4 }}>
          <Body size={13}>macOS may ask whether Offdesk DEV can accept incoming connections. Choose Allow so your phone can reach this Mac.</Body>
        </div>
      )}
    </Screen>
  );
}

const errorBox = {
  boxSizing: "border-box",
  width: "100%",
  maxWidth: 600,
  padding: "10px 12px",
  border: `1px solid ${colors.err}`,
  borderRadius: 4,
  color: colors.err,
  fontFamily: "var(--font-display)",
  fontSize: 12,
  overflowWrap: "anywhere",
} as const;

type Step = { done: boolean; title: string; sub: string; meta?: string };

/** The setup checklist: [✓] done, [~] the one in progress, [ ] still to come. */
function StepList({ steps, active, compact = false }: { steps: Step[]; active: number; compact?: boolean }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: compact ? undefined : 600,
        boxSizing: "border-box",
        padding: compact ? 0 : "6px 20px",
        background: compact ? "transparent" : colors.bg1,
        border: compact ? "none" : `1px solid ${colors.lineSoft}`,
        borderRadius: 6,
      }}
    >
      {steps.map((step, index) => (
        <div key={step.title} className="odk-step" title={step.sub} style={compact ? { padding: "4px 0", borderBottom: 0 } : undefined}>
          <StepMark state={step.done ? "done" : index === active ? "active" : "todo"} />
          <span style={{ flexGrow: 1, color: step.done || index === active ? colors.fg0 : colors.fg2 }}>{step.title}</span>
          {index === active ? (
            <span style={{ fontSize: 12, color: colors.accent }}>waiting…</span>
          ) : step.meta ? (
            <span style={{ fontSize: 12, color: colors.fg3 }}>{step.meta}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Retry pairing when the native hub is briefly unavailable during restart. */
function useHubPhoneLink(initial: HubLink | null = null) {
  const [link, setLink] = useState<HubLink | null>(initial);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (link) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await hubLink();
        if (!cancelled) { setError(null); setLink(next); }
      } catch {
        if (!cancelled) {
          setError("Waiting for the hub to reconnect…");
          retry = setTimeout(() => void read(), 2000);
        }
      }
    };
    void read();
    return () => { cancelled = true; clearTimeout(retry); };
  }, [link]);
  return { link, setLink, error, setError };
}

// ── Hub ready: the code for the phone ─────────────────────────────

/**
 * Hub ready: the code for the phone. On first run its button opens the
 * terminal; revisited from the Phone button or the menu bar, the same page
 * with a way back (`onClose`).
 */
export function HubReadyScreen({
  initial,
  onOpen,
  onClose,
}: {
  initial: HubLink | null;
  onOpen?: (link: HubLink) => Promise<void>;
  onClose?: () => void;
}) {
  const { link, setLink, error, setError } = useHubPhoneLink(initial);
  const [opening, setOpening] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [verified, setVerified] = useState<HubStatus | null>(null);
  useEffect(() => {
    let cancelled = false;
    void hubStatus().then(value => { if (!cancelled) setVerified(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const steps = [
    { done: verified?.setup?.hub_running ?? verified?.listening ?? false, title: "hub is running", sub: "Starts at login and restarts if it stops." },
    { done: verified?.setup?.node_online ?? false, title: "this Mac is online", sub: "Its node runs as a service too, so the first terminal you open is a shell right here." },
    { done: verified?.setup?.tmux_available ?? false, title: "terminal tools are available", sub: "Your sessions outlive the app, the network, and you walking away." },
  ];
  return (
    <Screen wide>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 380px), 1fr))", gap: 48, width: "100%", maxWidth: 940, alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <Eyebrow prompt>hub ready</Eyebrow>
          <Display size={36}>Your terminals now stay home</Display>
          <StepList steps={steps} active={verified ? -1 : steps.findIndex((step) => !step.done)} compact />
          {error ? <div role="alert" style={errorBox}>{error}</div> : null}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {onClose ? (
              <Button kind="secondary" onClick={onClose} testId="hub-ready-back">
                Back to the terminal
              </Button>
            ) : (
              <Button
                disabled={!link || opening}
                testId="hub-ready-open"
                onClick={() => {
                  if (!link || !onOpen) return;
                  setOpening(true);
                  onOpen(link).catch((e: unknown) => {
                    setError(String(e));
                    setOpening(false);
                  });
                }}
              >
                {opening ? "Opening…" : "Open my terminal"}
              </Button>
            )}
          </div>
          <div style={{ marginTop: 10, padding: 16, display: "flex", flexDirection: "column", gap: 8, background: colors.bg1, border: `1px solid ${colors.lineSoft}`, borderRadius: 6 }}>
            <div style={{ fontFamily: fontDisplay, fontSize: 14, fontWeight: 600 }}>Where will you connect from?</div>
            <Body size={13}>At home your phone reaches this Mac over Wi‑Fi. Away from home, turn on remote access with Offdesk Cloud or your own tunnel.</Body>
            <div>
              <Button kind="secondary" size="sm" onClick={() => setShowCloud(value => !value)}>{showCloud ? "Hide Cloud setup" : "Set up remote access"}</Button>
            </div>
            {showCloud && <CloudConnectionPanel onPairPhone={() => { setLink(null); setShowCloud(false); }} />}
          </div>
        </div>
        <PhoneCodePanel link={link} onLink={setLink} onError={setError} />
      </div>
    </Screen>
  );
}

/**
 * The code, the address picker, the link, and where to get the app. Also
 * the body of Settings → This machine, so it takes the link it is given
 * and asks for another when an address is picked.
 */
export function PhoneCodePanel({
  link,
  onLink,
  onError,
  compact = false,
}: {
  link: HubLink | null;
  onLink: (link: HubLink) => void;
  onError?: (message: string) => void;
  compact?: boolean;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  const [purpose, setPurpose] = useState<"app" | "browser">("app");

  const encoded = link?.short ?? link?.link ?? link?.url ?? "";
  useEffect(() => {
    let cancelled = false;
    setQr(null);
    setQrError(false);
    if (!encoded) return;
    QRCode.toString(encoded, {
      type: "svg",
      margin: 4,
      errorCorrectionLevel: "M",
      // Hex only — the encoder rejects CSS variables. Ink on white reads
      // best through a camera, in both themes.
      color: { dark: "#0c0c0b", light: "#ffffff" },
    })
      .then((svg) => {
        if (!cancelled) setQr(svg);
      })
      .catch(() => {
        if (!cancelled) { setQr(null); setQrError(true); }
      });
    return () => {
      cancelled = true;
    };
  }, [encoded]);

  const options = useMemo(() => link ? hubAddressOptions(link) : [], [link]);

  const pickAddress = (url: string) => {
    if (!url || url === link?.url) return;
    setPicking(true);
    hubLink(url)
      .then(onLink)
      .catch((e: unknown) => onError?.(String(e)))
      .finally(() => setPicking(false));
  };

  const copy = () => {
    const text = link?.link ?? link?.url;
    if (!text) return;
    void copyText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // On Hub ready this is the card beside the steps; inside a dialog
  // or a Settings section it sits flat, the surface around it is the card.
  const body = (
    <>
      {!compact ? <Display size={20} style={{ alignSelf: "stretch" }}>Connect your phone</Display> : null}
      {/* D03: a two-way switch, the app first and recommended. */}
      <div role="group" aria-label="Connect using" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", width: "100%", border: `1px solid ${colors.line}`, borderRadius: 4, overflow: "hidden" }}>
        {(["app", "browser"] as const).map((value) => (
          <button key={value} type="button" aria-pressed={purpose === value} onClick={() => setPurpose(value)}
            data-testid={`phone-purpose-${value}`}
            aria-label={value === "app" ? "Offdesk DEV app, recommended" : "Browser access"}
            style={{ minHeight: 36, padding: "0 10px", border: 0, cursor: "pointer",
              fontFamily: fontDisplay, fontSize: 12, fontWeight: purpose === value ? 600 : 500,
              background: purpose === value ? colors.primary : "transparent",
              color: purpose === value ? colors.onPrimary : colors.fg2 }}>
            {value === "app" ? "offdesk/dev app" : "browser access"}
          </button>
        ))}
      </div>
      {purpose === "app" ? <Body size={12} style={{ alignSelf: "stretch" }}>Recommended. End-to-end encrypted between the app and this hub.</Body> : null}
      {purpose === "browser" ? <>
      <Body size={14} style={{ textAlign: "center" }}>No app needed. Scan with your phone’s camera to sign in in a browser. This does not pair an encrypted device.</Body>
      <div
        style={{
          width: compact ? 168 : 212,
          height: compact ? 168 : 212,
          padding: 12,
          borderRadius: 4,
          background: "#ffffff",
          border: `1px solid ${colors.lineSoft}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: picking ? 0.5 : 1,
        }}
      >
        {qr ? <QrImage svg={qr} size={compact ? 142 : 186} label="Phone sign-in QR code" /> : <span role={qrError ? "alert" : "status"} style={{ fontSize: 12, color: colors.fg3 }}>{qrError ? "Could not generate the QR code. Use Copy link below instead." : link ? "Generating QR code…" : "Waiting for the hub…"}</span>}
      </div>
      </> : null}

      {purpose === "browser" || !link?.secure_url ? <label style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="odk-label">your phone can reach it at</span>
        <select
          value={link?.url ?? ""}
          onChange={(event) => pickAddress(event.target.value)}
          disabled={!link || picking}
          data-testid="hub-address-picker"
          style={{
            height: 40,
            padding: "0 12px",
            borderRadius: 4,
            border: `1px solid ${colors.line}`,
            background: colors.bg1,
            color: colors.fg0,
            fontFamily: fontDisplay,
            fontSize: 13,
          }}
        >
          {options.map((option) => (
            <option key={option.url} value={option.url}>
              {option.url} · {option.label}
            </option>
          ))}
        </select>
        <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: colors.fg3 }}>{link?.public_url === link?.url && link?.public_url ? "Internet address — keep this Mac awake and online." : "Local address — your phone must be on the same network."}</span>
      </label> : null}

      {purpose === "app" ? <>
        {link ? <SecurePairingPanel baseUrl={link.secure_url ?? link.url} managed={Boolean(link.secure_url)} /> : <Body>Waiting for the hub…</Body>}
      <div style={{ alignSelf: "stretch", display: "flex", gap: 8, justifyContent: "center", paddingTop: 12, borderTop: `1px solid ${colors.lineSoft}`, fontFamily: fontDisplay, fontSize: 12, color: colors.fg3 }}>
        no app yet?
        <button type="button" className="odk-text-btn" style={{ minHeight: 0, padding: 0, fontSize: 12, color: colors.fg0, textDecoration: "underline" }} onClick={() => void openOutside(IPHONE_URL)} aria-label="iPhone app">iphone</button>
        ·
        <button type="button" className="odk-text-btn" style={{ minHeight: 0, padding: 0, fontSize: 12, color: colors.fg0, textDecoration: "underline" }} onClick={() => void openOutside(ANDROID_URL)} aria-label="Android app">android</button>
      </div>
      </> : <>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          padding: "6px 6px 6px 12px",
          boxSizing: "border-box",
          borderRadius: 4,
          background: colors.bg0,
          border: `1px solid ${colors.lineSoft}`,
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: colors.fg2,
            flexGrow: 1,
            overflow: "hidden",
            whiteSpace: "nowrap",
            textOverflow: "ellipsis",
          }}
        >
          {link?.link ? link.link.replace(/token=.{6}.*$/, "token=…") : link?.url ?? "…"}
        </span>
        <Button onClick={copy} disabled={!link} size="sm" kind="secondary" testId="hub-copy-link" ariaLabel={copied ? "Copied" : "Copy link"}>
          {copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      {link ? (
        <div style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: colors.fg3, textAlign: "center" }}>
          {link.link
            ? "The link signs in whoever has it. Keep it off shared screens."
            : "This hub signs in through GitHub or Google, so the code is just the address."}
        </div>
      ) : null}
      </>}
    </>
  );
  const column = { display: "flex", flexDirection: "column", alignItems: "center", gap: 16 } as const;
  if (compact) return <div style={column}>{body}</div>;
  return (
    <Card style={{ ...column, padding: 24, maxWidth: 400 }}>
      {body}
    </Card>
  );
}

/** The hub's own code, fetched here: for Settings and the Phone dialog. */
export function HubPhoneCode() {
  const { link, setLink, error, setError } = useHubPhoneLink();
  return (
    <div style={{ width: "100%", maxWidth: 440, margin: "0 auto" }}>
      {error ? <Body size={12} style={{ color: colors.err, marginBottom: 8 }}>{error}</Body> : null}
      <PhoneCodePanel link={link} onLink={setLink} onError={setError} compact />
    </div>
  );
}

// ── Settings → This machine ───────────────────────────────────────

/** The desktop app's role, and the hub's state when it is the hub. */
export function ThisMachineSection({ onPairPhone, onConnectionChanged }: { onPairPhone?: () => void; onConnectionChanged?: () => void } = {}) {
  const { logout } = useAuth();
  const [role, setRole] = useState<DesktopRole | null | undefined>(undefined);
  const [status, setStatus] = useState<HubStatus | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    desktopRole().then(setRole).catch(() => setRole(null));
  }, []);
  useEffect(() => {
    if (role !== "hub") return;
    hubStatus().then(setStatus).catch(() => setStatus(null));
  }, [role]);

  const becomeHub = async () => {
    setBusy(true);
    setError(null);
    try {
      await setDesktopRole("hub");
      await logout();
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const stopBeingHub = async () => {
    setBusy(true);
    setError(null);
    try {
      await hubUninstall();
      await setDesktopRole("client");
      window.location.reload();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const row = (label: string, ok: boolean | null) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: colors.fg1 }}>
      <span
        style={{
          width: 9,
          height: 9,
          borderRadius: "50%",
          background: ok ? colors.ok : "transparent",
          border: ok ? "none" : `2px dashed ${colors.fg3}`,
          flexShrink: 0,
        }}
      />
      {label}
    </div>
  );

  if (role === undefined) return null;

  if (role !== "hub") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Body size={13}>This app is a client: it opens terminals on a hub somewhere else.</Body>
        <div>
          <Button kind="secondary" onClick={() => void becomeHub()} disabled={busy} style={{ height: 36, fontSize: 13 }}>
            Make this machine the hub instead
          </Button>
        </div>
        {error ? <Body size={12} style={{ color: colors.err }}>{error}</Body> : null}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {row("Hub service installed", status?.hub_installed ?? null)}
        {row("Node service installed", status?.node_installed ?? null)}
        {row("Answering on this machine", status?.listening ?? null)}
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Button kind="secondary" onClick={() => onPairPhone ? onPairPhone() : setShowCode((v) => !v)} style={{ height: 36, fontSize: 13 }} testId="settings-show-phone-code">
          {showCode ? "Hide the phone code" : "Show the phone code"}
        </Button>
        {confirmStop ? (
          <>
            <Button onClick={() => void stopBeingHub()} disabled={busy} style={{ height: 36, fontSize: 13 }}>
              {busy ? "Stopping…" : "Yes, remove both services"}
            </Button>
            <Button kind="ghost" onClick={() => setConfirmStop(false)} style={{ height: 36, fontSize: 13 }}>
              Keep it
            </Button>
          </>
        ) : (
          <Button kind="ghost" onClick={() => setConfirmStop(true)} style={{ height: 36, fontSize: 13 }}>
            Stop being the hub
          </Button>
        )}
      </div>
      {confirmStop ? (
        <Body size={12}>The database and your tmux sessions stay. Only the two services go.</Body>
      ) : null}
      {error ? <Body size={12} style={{ color: colors.err }}>{error}</Body> : null}
      <CloudConnectionPanel onPairPhone={onPairPhone ?? (() => setShowCode(true))} onConnectionChanged={() => { setShowCode(false); onConnectionChanged?.(); }} />
      {showCode && !onPairPhone ? <HubPhoneCode /> : null}
    </div>
  );
}

// ── Bits ──────────────────────────────────────────────────────────

function Screen({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  // The outer box scrolls; the inner one is centred with auto margins, which
  // — unlike justify-content: center — keeps the top reachable when the
  // window is shorter than the content.
  return (
    <div
      style={{
        flex: 1,
        minHeight: "100%",
        display: "flex",
        flexDirection: "column",
        background: colors.bg0,
        color: colors.fg0,
        boxSizing: "border-box",
        overflow: "auto",
      }}
    >
      <div
        style={{
          margin: "auto",
          width: "100%",
          maxWidth: wide ? 1040 : 980,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 24,
          padding: wide ? "40px 48px" : "32px 56px",
          boxSizing: "border-box",
        }}
      >
        {children}
      </div>
    </div>
  );
}

const icon = (paths: string, size = 22) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: paths }} />
);
const ServerIcon = () => icon('<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><path d="M7 7.5h.01M7 16.5h.01"/>');
const LaptopIcon = () => icon('<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M2 20h20"/>');
const LinkIcon = () => icon('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', 18);
const PhoneIcon = () => icon('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', 18);
const TerminalIcon = () => icon('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', 18);
