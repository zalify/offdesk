import { CloudConnectionPanel } from "./CloudConnectionPanel";
import { SecurePairingPanel } from "./SecureConnectionPanel";
import { isSecureConnection } from "../lib/secureTransport";
// The desktop app's first run, and the machine that stays on.
//
// One question — is this the machine that stays on? — and two answers. "Yes"
// runs the bundled hub install and lands on the code the phone scans; "no"
// is the client the app has always been. The Tauri side is role.rs; the
// typed calls are lib/desktopHub.ts. Design: docs/design/desktop-hub/.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import * as QRCode from "qrcode";
import { QrImage } from "./QrImage";

import { listSecureDevicesAt, type SecureDevice } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { colors } from "@/lib/colors";
import {
  hubAddressOptions,
  desktopRole,
  hubInstall,
  hubIsReady,
  hubLink,
  hubPortCheck,
  hubStatus,
  hubUninstall,
  setDesktopRole,
  tokenFromLink,
  type DesktopRole,
  type HubLink,
  type HubPortCheck,
  type HubStatus,
} from "@/lib/desktopHub";
import { portFailure, setupDiagnostics, setupFailure, setupProgress, SETUP_STEP_COUNT } from "@/lib/hubSetup";
import { detectOS } from "@/lib/platform";
import { getServerUrl, setServerUrl } from "@/lib/serverUrl";
import LoginScreen from "../app/login";
import { AppTitleBar } from "./AppTitleBar.web";
import { Body, Button, Card, Display, Eyebrow, Spinner, StatusEnd, StatusLine, StepBar, StepMark, fontDisplay } from "./Primitives.web";
import { rem } from "@/lib/rem";

const IPHONE_URL = "https://testflight.apple.com/join/rV4ktaGv";
const ANDROID_URL = "https://offdesk.dev/apk";
const SETUP_HELP_URL = "https://github.com/zalify/offdesk/blob/main/docs/setup-lan.md";

export async function openOutside(url: string) {
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
  const { isLoading, isAuthenticated, login, loginWithToken, logout } = useAuth();
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
  const windows = detectOS() === "windows";

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
        // The hub runs on macOS and Linux, so Windows has one answer (D1).
        if (windows) {
          setRole("client");
          return;
        }
        setRole(null);
      })
      .catch(() => setRole(null));
  }, [windows]);

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
          steps
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

  if (isLoading) {
    if (!reconnectExpired) return <DesktopSetupFrame><Spinner /></DesktopSetupFrame>;
    const hubUrl = getServerUrl();
    return <DesktopSetupFrame><Screen>
      <div role="status"><Body>Could not reach your Hub{hubUrl ? ` at ${hubUrl}` : ""}. Still trying…</Body></div>
      {/* The sign-in stays until someone leaves: this may only be a Hub
          restarting. Leaving drops it, so it never reaches another address,
          and an encrypted pairing is not forgotten from here. */}
      {!isSecureConnection() && <>
        <Body>If its address changed, connect again with the new one. You will need to sign in again.</Body>
        <Button kind="secondary" onClick={() => void logout()} testId="hub-unreachable-change">Connect to a different Hub</Button>
      </>}
    </Screen></DesktopSetupFrame>;
  }
  if (!isAuthenticated) return <DesktopSetupFrame><LoginScreen onBecomeHub={windows ? undefined : () => void pick("hub")} onBackToSetup={windows ? undefined : () => setRole(null)} /></DesktopSetupFrame>;
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

// ── The frame ─────────────────────────────────────────────────────

const HUB_STEPS = ["this machine", "set up", "your phone"];

/**
 * The workspace before it has tabs: the steps stand where the tab bar goes and
 * the status line carries live state. Without `step` it's the two columns
 * alone, for setup reopened from inside the app.
 */
function SetupFrame({
  step,
  stepDone,
  failed,
  status,
  children,
}: {
  step?: number;
  stepDone?: boolean;
  failed?: boolean;
  status?: ReactNode;
  children: ReactNode;
}) {
  const framed = step !== undefined;
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: colors.bg0, color: colors.fg0 }}>
      {framed ? <StepBar steps={HUB_STEPS} current={step} currentDone={stepDone} failed={failed} /> : null}
      <div className="odk-setup"><div className="odk-setup-grid">{children}</div></div>
      {framed ? <StatusLine testId="setup-status">{status}</StatusLine> : null}
    </div>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <span className="odk-status-muted">{children}</span>;
const Fill = () => <span className="odk-status-fill" />;

// ── First run ─────────────────────────────────────────────────────

const HUB_DIAGRAM = `phone  ──╮
laptop ──┼──▶ [ this mac ]
nas    ──╯      hub · tmux`;
const CLIENT_DIAGRAM = `[ this mac ] ──▶ your hub
                 mac, nas, server`;

function FirstRun({ onPick }: { onPick: (role: DesktopRole) => Promise<void> }) {
  const [busy, setBusy] = useState<DesktopRole | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = useCallback((role: DesktopRole) => {
    setBusy(role);
    setError(null);
    onPick(role).catch((e: unknown) => {
      setError(String(e));
      setBusy(null);
    });
  }, [onPick]);
  useEffect(() => {
    if (busy) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "1") choose("hub");
      if (event.key === "2") choose("client");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, choose]);
  return (
    <SetupFrame step={0} status={<><Muted>not set up yet</Muted><Fill /><StatusEnd>press 1 or 2</StatusEnd></>}>
      <div className="odk-setup-col">
        <Eyebrow prompt>first run</Eyebrow>
        <Display size={36} cursor>Which machine is this?</Display>
        <Body size={16}>Same app either way. Tell it what this machine does and it sets itself up.</Body>
      </div>
      <div className="odk-setup-col" style={{ gap: 16 }}>
        <RoleCard
          choice={1}
          accent
          title="The one that stays on"
          body="This Mac becomes your hub. Terminals and agents run here and keep running when you walk away."
          diagram={HUB_DIAGRAM}
          note="Installs the hub, the node and tmux here. No account, no cloud."
          action={
            <Button onClick={() => choose("hub")} disabled={busy !== null} testId="first-run-hub">
              {busy === "hub" ? "One moment…" : "Make this Mac the hub"}
            </Button>
          }
        />
        <RoleCard
          choice={2}
          title="Just connecting"
          body="Open terminals on a hub you already run: another Mac, a NAS or a server."
          diagram={CLIENT_DIAGRAM}
          note="Nothing installed. Needs the hub’s link or address."
          action={
            <Button kind="secondary" onClick={() => choose("client")} disabled={busy !== null} testId="first-run-client">
              Connect to a hub
            </Button>
          }
        />
        {error ? <div role="alert" style={errorBox}>{error}</div> : null}
        <div className="odk-setup-foot" style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <details style={{ flex: "1 1 240px", fontFamily: fontDisplay, fontSize: rem(12) }}>
            <summary style={{ cursor: "pointer" }}>which one do I need?</summary>
            <Body size={13} style={{ marginTop: 8 }}>Your hub is the machine that’s on when you’re away: a Mac mini, a desktop, your work machine. It stays awake by itself, but a closed laptop still sleeps. Everything else just connects to it.</Body>
          </details>
          <span style={{ fontFamily: fontDisplay, fontSize: rem(12), color: colors.fg3 }}>you can change this later in settings</span>
        </div>
      </div>
    </SetupFrame>
  );
}

function RoleCard({
  choice,
  accent = false,
  title,
  body,
  diagram,
  note,
  action,
}: {
  choice: number;
  accent?: boolean;
  title: string;
  body: string;
  diagram: string;
  note: string;
  action: ReactNode;
}) {
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span aria-hidden="true" style={{ fontFamily: fontDisplay, fontSize: rem(13), fontWeight: 500, color: accent ? colors.accent : colors.fg3 }}>[{choice}]</span>
        <Display size={20}>{title}</Display>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "12px 28px" }}>
        <Body size={15} style={{ flex: "1 1 240px" }}>{body}</Body>
        <pre className="odk-setup-diagram" aria-hidden="true">{diagram}</pre>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 10 }}>
        {action}
        <Body size={12} style={{ flex: "1 1 200px" }}>{note}</Body>
      </div>
    </Card>
  );
}

// ── Becoming the hub ──────────────────────────────────────────────

export function HubSetup({
  status,
  onReady,
  onGiveUp,
  onStart,
  steps: framed = false,
}: {
  status: HubStatus;
  onStart?: () => void;
  onReady: (link: HubLink, status: HubStatus) => void;
  onGiveUp: () => void;
  /** First run: inside the step bar and status line. */
  steps?: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<HubPortCheck | null>(null);
  const [port, setPort] = useState<number | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<HubStatus | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [copied, setCopied] = useState(false);
  const latest = progress ?? status;

  useEffect(() => {
    if (!status.supported) {
      setError("The hub runs on macOS and Linux. On this machine the app is a client.");
      return;
    }
    let cancelled = false;
    onStart?.();
    setError(null);
    setConflict(null);
    setSeconds(0);
    const prepare = async () => {
      const current = await hubStatus();
      if (cancelled) return;
      setProgress(current);
      // Reopening a completed installation verifies it without reinstalling.
      const ready = hubIsReady(current);
      if (!ready && port === undefined) {
        // Install counts anything on the port as the hub having started, so
        // a stranger there has to be caught before it runs.
        const check = await hubPortCheck();
        if (cancelled) return;
        if (check?.conflict) {
          setConflict(check);
          return;
        }
      }
      const link = ready ? await hubLink() : await hubInstall(undefined, port);
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

  const failure = conflict ? portFailure(conflict) : error ? setupFailure(error, latest) : null;

  useEffect(() => {
    if (failure) return;
    const timer = setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [failure === null, attempt]);

  const retry = (nextPort?: number) => {
    if (nextPort !== undefined) setPort(nextPort);
    setCopied(false);
    setAttempt((n) => n + 1);
  };
  const copyDiagnostics = async () => {
    if (!failure) return;
    const version = await import("@tauri-apps/api/app").then(({ getVersion }) => getVersion()).catch(() => null);
    await copyText(setupDiagnostics(latest, failure, version));
    setCopied(true);
  };

  const done = conflict ? [false, false, false, false] : setupProgress(latest);
  const active = failure ? failure.step : done.indexOf(false);
  const rows = [
    { title: "start your hub", meta: "offdesk-hub", sub: "Starts at login and restarts if it stops." },
    { title: "connect this Mac to your hub", sub: "Its node runs as a service too, so your first terminal is a shell right here." },
    { title: "wait for this Mac to come online", sub: "Checks the live connection, so your phone has a machine to open." },
    { title: "check terminal tools", meta: "tmux", sub: "Checks that tmux can run on this Mac." },
  ];

  return (
    <SetupFrame
      step={framed ? 1 : undefined}
      failed={failure !== null}
      status={failure
        ? <><span style={{ color: colors.err }}>setup stopped</span><Muted>step {failure.step + 1} of {SETUP_STEP_COUNT}</Muted></>
        : <><span>setting up</span><Muted>step {Math.max(active, 0) + 1} of {SETUP_STEP_COUNT}</Muted></>}
    >
      <div className="odk-setup-col">
        {failure ? <Eyebrow color={colors.err}>{failure.eyebrow}</Eyebrow> : <Eyebrow prompt>setting up the hub</Eyebrow>}
        <Display size={36}>{failure ? "Let’s finish setting up this Mac" : "Getting this Mac ready…"}</Display>
        <Body size={16}>{!failure ? "Takes about a minute. You can leave this window open." : failure.step === 0 ? "One step needs a hand. Nothing else on this Mac has changed." : "One step needs a hand. Everything before it is done and stays done."}</Body>
        {failure ? (
          <div className="odk-setup-foot" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
            <button type="button" className="odk-text-btn" onClick={() => void openOutside(SETUP_HELP_URL)}>open the troubleshooting guide ↗</button>
            <button type="button" className="odk-text-btn" onClick={onGiveUp}>use this Mac as a client instead</button>
          </div>
        ) : <Body size={14} style={{ marginTop: "auto" }}>This moves on by itself when all four are done.</Body>}
      </div>
      <div className="odk-setup-col" style={{ gap: 16 }}>
        <Card style={{ padding: "6px 24px" }}>
          {rows.map((row, index) => {
            if (failure?.step === index) {
              return (
                <div key={row.title} className="odk-setup-fail" role="alert">
                  <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: fontDisplay, fontSize: rem(14) }}>
                    <StepMark state="failed" />
                    <span style={{ flexGrow: 1 }}>{row.title}</span>
                    {row.meta ? <span style={{ fontSize: rem(12), color: colors.fg3 }}>{row.meta}</span> : null}
                  </div>
                  <div style={{ fontFamily: fontDisplay, fontSize: rem(13), overflowWrap: "anywhere" }}>{failure.title}</div>
                  {failure.detail ? <Body size={14}>{failure.detail}</Body> : null}
                  <div className="odk-setup-fail-actions">
                    {failure.fix ? <Button size="sm" onClick={() => retry(failure.fix?.port)} testId="hub-setup-fix">{failure.fix.label}</Button> : null}
                    {/* tmux's fix is the install again: a second button would do the same. */}
                    {status.supported && !(failure.fix && failure.fix.port === undefined) ? (
                      <Button size="sm" kind={failure.fix ? "secondary" : "primary"} onClick={() => retry()} testId="hub-setup-retry">Retry</Button>
                    ) : null}
                    <Button size="sm" kind="ghost" onClick={() => void copyDiagnostics()} testId="hub-setup-diagnostics">{copied ? "Copied" : "Copy diagnostics"}</Button>
                  </div>
                </div>
              );
            }
            const state = done[index] ? "done" : index === active && !failure ? "active" : "todo";
            return (
              <div key={row.title} className="odk-step" style={state === "active" ? { flexWrap: "wrap" } : undefined}>
                <StepMark state={state} />
                <span style={{ flexGrow: 1, color: state === "todo" ? colors.fg2 : colors.fg0 }}>{row.title}</span>
                {state === "active"
                  ? <span style={{ fontSize: rem(12), color: colors.accent }}>{seconds} s</span>
                  : row.meta ? <span style={{ fontSize: rem(12), color: colors.fg3 }}>{row.meta}</span> : null}
                {state === "active" ? <Body size={13} style={{ width: "100%", paddingLeft: 42 }}>{row.sub}</Body> : null}
              </div>
            );
          })}
        </Card>
        {!failure && latest.setup?.error ? (
          <div role="status" style={{ padding: "10px 14px", background: colors.termBg, border: `1px solid ${colors.lineSoft}`, borderRadius: 4, fontFamily: "'JetBrains Mono', var(--font-mono)", fontSize: rem(12.5), color: colors.termFg }}>
            {latest.setup.error}
          </div>
        ) : null}
        {!failure ? (
          <div className="odk-setup-foot" style={{ padding: "12px 16px", background: "rgb(var(--color-accent) / .07)", borderRadius: 4 }}>
            <Body size={13}>macOS may ask whether Offdesk Dev can accept incoming connections. Choose Allow so your phone can reach this Mac.</Body>
          </div>
        ) : null}
      </div>
    </SetupFrame>
  );
}

const errorBox = {
  boxSizing: "border-box",
  width: "100%",
  padding: "10px 12px",
  border: `1px solid ${colors.err}`,
  borderRadius: 4,
  color: colors.err,
  fontFamily: "var(--font-display)",
  fontSize: rem(12),
  overflowWrap: "anywhere",
} as const;

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

/**
 * The phone that pairs while this screen is open. D4 comes before this app
 * signs in, so it asks the hub directly with the link's own token. Browser
 * access pairs no device, and a hub with no link has no token: for those this
 * stays quiet and the screen is left with Skip for now.
 */
function usePairedPhone(link: HubLink | null) {
  const [phone, setPhone] = useState<SecureDevice | null>(null);
  const known = useRef<Set<string> | null>(null);
  const token = tokenFromLink(link?.link);
  const base = link?.local_url ?? link?.url;
  useEffect(() => {
    if (!token || !base || phone) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const devices = (await listSecureDevicesAt(base, token)).filter((device) => !device.revoked_at);
        if (cancelled) return;
        const fresh = known.current && devices.find((device) => !known.current?.has(device.id));
        if (fresh) { setPhone(fresh); return; }
        // Phones paired before this screen opened aren't news.
        known.current ??= new Set(devices.map((device) => device.id));
      } catch {
        // The hub restarts during setup; the next poll will reach it.
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 2000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [token, base, phone]);
  const pairAnother = () => {
    if (phone) known.current?.add(phone.id);
    setPhone(null);
  };
  return { phone, canSeePhone: Boolean(token), pairAnother };
}

// ── Hub ready: the code for the phone ─────────────────────────────

/** Hub ready (D4), turning into phone connected (D5) in the same frame. */
export function HubReadyScreen({
  initial,
  onOpen,
}: {
  initial: HubLink | null;
  onOpen: (link: HubLink) => Promise<void>;
}) {
  const { link, setLink, error, setError } = useHubPhoneLink(initial);
  const [opening, setOpening] = useState(false);
  const [purpose, setPurpose] = useState<PhonePurpose>("app");
  const [verified, setVerified] = useState<HubStatus | null>(null);
  const code = usePhoneCode(link, setLink, setError);
  const { phone, canSeePhone, pairAnother } = usePairedPhone(link);
  useEffect(() => {
    let cancelled = false;
    void hubStatus().then(value => { if (!cancelled) setVerified(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const open = () => {
    if (!link) return;
    setOpening(true);
    onOpen(link).catch((e: unknown) => {
      setError(String(e));
      setOpening(false);
    });
  };
  const checks = [
    { label: "hub", done: verified?.setup?.hub_running ?? verified?.listening ?? false },
    { label: "this Mac", done: verified?.setup?.node_online ?? false },
    { label: "tmux", done: verified?.setup?.tmux_available ?? false },
  ];
  const address = link ? new URL(link.url).host : "…";

  return (
    <SetupFrame
      step={2}
      stepDone={phone !== null}
      status={<><Muted>hub</Muted><span>{address}</span><Fill /><StatusEnd>{phone ? "1 phone" : "no phone yet"}</StatusEnd></>}
    >
      <div className="odk-setup-col">
        <Eyebrow prompt>hub ready</Eyebrow>
        <Display size={36}>Your terminals now stay home</Display>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontFamily: fontDisplay, fontSize: rem(12), color: colors.fg2 }}>
          {checks.map((check) => (
            <span key={check.label} style={{ display: "inline-flex", gap: 6 }}><StepMark state={check.done ? "done" : "todo"} />{check.label}</span>
          ))}
        </div>
        {error ? <div role="alert" style={errorBox}>{error}</div> : null}
        {phone ? null : purpose === "browser" || !link?.secure_url ? <AddressField link={link} code={code} /> : null}
      </div>
      <div className="odk-setup-col" style={{ gap: 16 }}>
        {phone ? (
          <Card style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 14, minHeight: 366, padding: 32 }}>
            <div style={{ fontFamily: fontDisplay, fontSize: rem(14), color: colors.accent }}>paired</div>
            <Display size={30}>{phone.name} is connected</Display>
            <Body size={14}>Anything you start on this Mac shows up on the phone, and the other way round. Next, start something worth checking on.</Body>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginTop: 8, fontFamily: fontDisplay, fontSize: rem(12), color: colors.fg2 }}>
              <span style={{ flexGrow: 1 }}>encrypted end to end · just now</span>
              <Button kind="secondary" size="sm" onClick={pairAnother}>Connect another phone</Button>
            </div>
          </Card>
        ) : (
          <PhonePairingCard link={link} purpose={purpose} onPurpose={setPurpose} code={code} />
        )}
        <div className="odk-setup-foot" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {!phone && purpose === "app" && canSeePhone ? <><StepMark state="active" /><span style={{ fontFamily: fontDisplay, fontSize: rem(13) }}>waiting for your phone…</span></> : null}
          <span style={{ flexGrow: 1 }} />
          <Button kind={phone ? "primary" : "ghost"} disabled={!link || opening} testId="hub-ready-open" onClick={open}>
            {opening ? "Opening…" : phone ? "Continue" : "Skip for now"}
          </Button>
        </div>
      </div>
    </SetupFrame>
  );
}

type PhonePurpose = "app" | "browser";

/** The address, its QR code and link: one state behind the panels that show them. */
function usePhoneCode(link: HubLink | null, onLink: (link: HubLink) => void, onError?: (message: string) => void) {
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);

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
  return { qr, qrError, copied, picking, options, pickAddress, copy };
}
type PhoneCode = ReturnType<typeof usePhoneCode>;

function PurposeSwitch({ purpose, onChange }: { purpose: PhonePurpose; onChange: (purpose: PhonePurpose) => void }) {
  return (
    <div role="group" aria-label="Connect using" style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", width: "100%", border: `1px solid ${colors.line}`, borderRadius: 4, overflow: "hidden" }}>
      {(["app", "browser"] as const).map((value) => (
        <button key={value} type="button" aria-pressed={purpose === value} onClick={() => onChange(value)}
          data-testid={`phone-purpose-${value}`}
          aria-label={value === "app" ? "Offdesk Dev app, recommended" : "Browser access"}
          style={{ minHeight: 36, padding: "0 10px", border: 0, cursor: "pointer",
            fontFamily: fontDisplay, fontSize: rem(12), fontWeight: purpose === value ? 600 : 500,
            background: purpose === value ? colors.primary : "transparent",
            color: purpose === value ? colors.onPrimary : colors.fg2 }}>
          {value === "app" ? "offdesk/dev app" : "browser access"}
        </button>
      ))}
    </div>
  );
}

function NoAppYet() {
  const link = { minHeight: 0, padding: 0, fontSize: rem(12), color: colors.fg0, textDecoration: "underline" };
  return (
    <div style={{ alignSelf: "stretch", display: "flex", gap: 8, justifyContent: "center", paddingTop: 12, borderTop: `1px solid ${colors.lineSoft}`, fontFamily: fontDisplay, fontSize: rem(12), color: colors.fg3 }}>
      no app yet?
      <button type="button" className="odk-text-btn" style={link} onClick={() => void openOutside(IPHONE_URL)} aria-label="iPhone app">iphone</button>
      ·
      <button type="button" className="odk-text-btn" style={link} onClick={() => void openOutside(ANDROID_URL)} aria-label="Android app">android</button>
    </div>
  );
}

function BrowserCode({ link, code, size }: { link: HubLink | null; code: PhoneCode; size: number }) {
  const { qr, qrError, picking } = code;
  return (
    <div style={{ flexShrink: 0, width: size + 26, height: size + 26, padding: 12, borderRadius: 4, background: "#ffffff", border: `1px solid ${colors.lineSoft}`, boxSizing: "border-box", display: "flex", alignItems: "center", justifyContent: "center", opacity: picking ? 0.5 : 1 }}>
      {qr ? <QrImage svg={qr} size={size} label="Phone sign-in QR code" /> : <span role={qrError ? "alert" : "status"} style={{ fontSize: rem(12), color: colors.fg3 }}>{qrError ? "Could not generate the QR code. Use Copy link below instead." : link ? "Generating QR code…" : "Waiting for the hub…"}</span>}
    </div>
  );
}

function CopyLink({ link, code }: { link: HubLink | null; code: PhoneCode }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 6px 6px 12px", boxSizing: "border-box", borderRadius: 4, background: colors.bg0, border: `1px solid ${colors.lineSoft}` }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: rem(12), color: colors.fg2, flexGrow: 1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
          {link?.link ? link.link.replace(/token=.{6}.*$/, "token=…") : link?.url ?? "…"}
        </span>
        <Button onClick={code.copy} disabled={!link} size="sm" kind="secondary" testId="hub-copy-link" ariaLabel={code.copied ? "Copied" : "Copy link"}>
          {code.copied ? "Copied" : "Copy link"}
        </Button>
      </div>
      {link ? (
        <div style={{ fontFamily: "var(--font-sans)", fontSize: rem(12), color: colors.fg3, textAlign: "center" }}>
          {link.link
            ? "The link signs in whoever has it. Keep it off shared screens."
            : "This hub signs in through GitHub or Google, so the code is just the address."}
        </div>
      ) : null}
    </>
  );
}

/** D4's left column: the address as a field, Change is the native menu over it. */
function AddressField({ link, code }: { link: HubLink | null; code: PhoneCode }) {
  const current = code.options.find((option) => option.url === link?.url);
  const internet = link?.public_url && link.public_url === link.url;
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
      <span className="odk-label">your phone reaches this Mac at</span>
      <span style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", height: 38, padding: "0 12px", boxSizing: "border-box", background: colors.bg1, border: `1px solid ${colors.line}`, borderRadius: 4, fontFamily: fontDisplay, fontSize: rem(13) }}>
        <span>{link ? new URL(link.url).host : "…"}</span>
        <span style={{ fontSize: rem(12), color: colors.fg3 }}>change ▾</span>
        <select
          value={link?.url ?? ""}
          onChange={(event) => code.pickAddress(event.target.value)}
          disabled={!link || code.picking}
          data-testid="hub-address-picker"
          style={{ position: "absolute", inset: 0, width: "100%", opacity: 0, cursor: "pointer" }}
        >
          {code.options.map((option) => (
            <option key={option.url} value={option.url}>{option.url} · {option.label}</option>
          ))}
        </select>
      </span>
      <span style={{ fontFamily: "var(--font-sans)", fontSize: rem(12), color: colors.fg3 }}>
        {internet ? "Internet address. Keep this Mac awake and online." : `${current?.label ? `${current.label}. ` : ""}Your phone has to be on this network.`}
      </span>
    </label>
  );
}

/** D4's right column. */
function PhonePairingCard({ link, purpose, onPurpose, code }: { link: HubLink | null; purpose: PhonePurpose; onPurpose: (purpose: PhonePurpose) => void; code: PhoneCode }) {
  return (
    <Card style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <PurposeSwitch purpose={purpose} onChange={onPurpose} />
      {purpose === "app" ? <>
        {link ? <SecurePairingPanel auto baseUrl={link.secure_url ?? link.url} managed={Boolean(link.secure_url)} /> : <Body>Waiting for the hub…</Body>}
        <NoAppYet />
      </> : <>
        <div className="odk-setup-pair">
          <BrowserCode link={link} code={code} size={184} />
          <div style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: 10 }}>
            <Display size={20}>No app needed</Display>
            <Body size={14}>Scan with your phone’s camera to sign in in a browser. This does not pair an encrypted device.</Body>
          </div>
        </div>
        <CopyLink link={link} code={code} />
      </>}
    </Card>
  );
}

/**
 * The code, the address picker, the link, and where to get the app: the body
 * of Settings → This machine and the Phone dialog, so it takes the link it is
 * given and asks for another when an address is picked.
 */
export function PhoneCodePanel({
  link,
  onLink,
  onError,
}: {
  link: HubLink | null;
  onLink: (link: HubLink) => void;
  onError?: (message: string) => void;
}) {
  const [purpose, setPurpose] = useState<PhonePurpose>("app");
  const code = usePhoneCode(link, onLink, onError);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16 }}>
      {/* D03: a two-way switch, the app first and recommended. */}
      <PurposeSwitch purpose={purpose} onChange={setPurpose} />
      {purpose === "app" ? <Body size={12} style={{ alignSelf: "stretch" }}>Recommended. End-to-end encrypted between the app and this hub.</Body> : null}
      {purpose === "browser" ? <>
        <Body size={14} style={{ textAlign: "center" }}>No app needed. Scan with your phone’s camera to sign in in a browser. This does not pair an encrypted device.</Body>
        <BrowserCode link={link} code={code} size={142} />
      </> : null}

      {purpose === "browser" || !link?.secure_url ? <label style={{ width: "100%", display: "flex", flexDirection: "column", gap: 6 }}>
        <span className="odk-label">your phone can reach it at</span>
        <select
          value={link?.url ?? ""}
          onChange={(event) => code.pickAddress(event.target.value)}
          disabled={!link || code.picking}
          data-testid="hub-address-picker"
          style={{
            height: 40,
            padding: "0 12px",
            borderRadius: 4,
            border: `1px solid ${colors.line}`,
            background: colors.bg1,
            color: colors.fg0,
            fontFamily: fontDisplay,
            fontSize: rem(13),
          }}
        >
          {code.options.map((option) => (
            <option key={option.url} value={option.url}>
              {option.url} · {option.label}
            </option>
          ))}
        </select>
        <span style={{ fontFamily: "var(--font-sans)", fontSize: rem(12), color: colors.fg3 }}>{link?.public_url === link?.url && link?.public_url ? "Internet address — keep this Mac awake and online." : "Local address — your phone must be on the same network."}</span>
      </label> : null}

      {purpose === "app" ? <>
        {link ? <SecurePairingPanel baseUrl={link.secure_url ?? link.url} managed={Boolean(link.secure_url)} /> : <Body>Waiting for the hub…</Body>}
        <NoAppYet />
      </> : <CopyLink link={link} code={code} />}
    </div>
  );
}

/** The hub's own code, fetched here: for Settings and the Phone dialog. */
export function HubPhoneCode() {
  const { link, setLink, error, setError } = useHubPhoneLink();
  return (
    <div style={{ width: "100%", maxWidth: 440, margin: "0 auto" }}>
      {error ? <Body size={12} style={{ color: colors.err, marginBottom: 8 }}>{error}</Body> : null}
      <PhoneCodePanel link={link} onLink={setLink} onError={setError} />
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
    <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: fontDisplay, fontSize: rem(14), color: ok ? colors.fg0 : colors.fg2 }}>
      <StepMark state={ok ? "done" : "todo"} />
      <span style={{ textTransform: "lowercase" }}>{label}</span>
    </div>
  );

  if (role === undefined) return null;

  if (role !== "hub") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Body size={13}>This app is a client: it opens terminals on a hub somewhere else.</Body>
        <div>
          <Button kind="secondary" onClick={() => void becomeHub()} disabled={busy} style={{ height: 36, fontSize: rem(13) }}>
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
        <Button kind="secondary" onClick={() => onPairPhone ? onPairPhone() : setShowCode((v) => !v)} style={{ height: 36, fontSize: rem(13) }} testId="settings-show-phone-code">
          {showCode ? "Hide the phone code" : "Show the phone code"}
        </Button>
        {confirmStop ? (
          <>
            <Button onClick={() => void stopBeingHub()} disabled={busy} style={{ height: 36, fontSize: rem(13) }}>
              {busy ? "Stopping…" : "Yes, remove both services"}
            </Button>
            <Button kind="ghost" onClick={() => setConfirmStop(false)} style={{ height: 36, fontSize: rem(13) }}>
              Keep it
            </Button>
          </>
        ) : (
          <Button kind="danger" onClick={() => setConfirmStop(true)} style={{ height: 36, fontSize: rem(12.5) }}>
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
