import { useEffect, useRef, useState } from "react";
import { Body, Button } from "./Primitives.web";
import { SecurePairingPanel } from "./SecureConnectionPanel";
import { colors } from "../lib/colors";
import { rem } from "../lib/rem";

type CloudStatus = {
  id?: string; state: "unregistered" | "pending" | "approved" | "expired" | "provisioning" | "active" | "revoking" | "revoked";
  url?: string; local_enabled?: boolean; verified?: boolean; needs_attention?: boolean;
  user_code?: string; verification_uri?: string; expires_at?: number;
};
type Action = "status" | "login" | "login-status" | "enable" | "check" | "disable";
async function cloud(action: Action): Promise<CloudStatus> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<CloudStatus>("cloud_action", { action });
}
async function openCloud(url: string) {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

export function CloudConnectionPanel({ onPairPhone, onConnectionChanged }: { onPairPhone?: () => void; onConnectionChanged?: () => void }) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [login, setLogin] = useState<CloudStatus | null>(null);
  const [busy, setBusy] = useState<string | null>("Loading…");
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const sequence = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const id = ++sequence.current;
    void cloud("status").then(result => { if (mounted.current && id === sequence.current) setStatus(result); })
      .catch(cause => { if (mounted.current && id === sequence.current) setError(message(cause)); })
      .finally(() => { if (mounted.current && id === sequence.current) setBusy(null); });
    return () => { mounted.current = false; sequence.current++; };
  }, []);

  useEffect(() => {
    if (login?.state !== "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (login.expires_at && Date.now() >= login.expires_at * 1000) { setLogin({ ...login, state: "expired" }); return; }
      try {
        const result = await cloud("login-status");
        if (cancelled) return;
        if (result.state === "approved") { const current = await cloud("status"); if (!cancelled) { setLogin(null); setError(null); setStatus(current); void run("enable"); } return; }
        if (result.state === "expired") { setLogin({ ...login, state: "expired" }); return; }
      } catch (cause) { if (!cancelled) setError(message(cause)); }
      if (!cancelled) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [login]);

  // Recheck while this panel stays open. Never let an old success survive a
  // failed refresh, and don't race sign-in, disable or an explicit check.
  useEffect(() => {
    if (busy !== null || login?.state === "pending") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const id = sequence.current;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const result = await cloud("status");
          if (!cancelled && mounted.current && id === sequence.current) {
            setStatus(result); setStale(false); setError(null);
          }
        } catch (cause) {
          if (!cancelled && mounted.current && id === sequence.current) {
            setStale(true); setError(message(cause));
          }
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 30000);
    };
    timer = setTimeout(() => void poll(), 30000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [busy, login?.state]);

  const run = async (action: Action) => {
    const id = ++sequence.current;
    setError(null); setConfirmDisable(false);
    if (["status", "enable", "check", "disable"].includes(action)) { setStale(true); onConnectionChanged?.(); }
    setBusy(action === "login" ? "Opening sign-in…" : action === "enable" ? "Setting up remote access…" : action === "check" ? "Verifying encryption…" : action === "disable" ? "Turning off remote access…" : "Checking…");
    try {
      const result = await cloud(action);
      if (!mounted.current || id !== sequence.current) return;
      if (action === "login" && result.state === "pending") {
        setLogin(result);
        if (result.verification_uri) await openCloud(result.verification_uri);
      } else if (action === "login") { setLogin(null); setStatus(await cloud("status")); void run("enable"); }
      else {
        setStatus(result); setStale(false);
        if (action === "enable") {
          setBusy("Verifying encrypted remote access…");
          for (let attempt = 0; attempt < 12; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 5000));
            if (!mounted.current || id !== sequence.current) return;
            try {
              const verified = await cloud("check");
              if (mounted.current && id === sequence.current) { setStatus(verified); setStale(false); }
              if (verified.state === "active" && verified.local_enabled && verified.verified) break;
              if (attempt === 11) throw new Error("Remote access is not verified yet. Keep this Mac online and try Verify connection again.");
            } catch (cause) { if (attempt === 11) throw cause; }
          }
        }
      }
    } catch (cause) { if (mounted.current && id === sequence.current) setError(message(cause)); }
    finally { if (mounted.current && id === sequence.current) setBusy(null); }
  };
  const connected = !stale && status?.state === "active" && status.local_enabled && status.verified;
  const registered = status && status.state !== "unregistered";
  return <section data-testid="cloud-connection-panel" style={{ padding: 16, background: colors.bg1, border: `1px solid ${colors.lineSoft}`, borderRadius: 6, display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <strong style={{ fontFamily: "var(--font-display)", fontSize: rem(14), fontWeight: 600 }}>Offdesk</strong>
      <span style={{ fontFamily: "var(--font-display)", fontSize: rem(12), color: colors.fg3 }}>offdesk.so</span>
      {connected ? <span style={{ fontFamily: "var(--font-display)", fontSize: rem(11.5), fontWeight: 500, padding: "2px 8px", border: `1px solid ${colors.line}`, borderRadius: 3, color: colors.accent }}>remote access ready</span> : null}
    </div>
    <Body size={13}>Reach this computer from mobile data or another Wi-Fi network. Your terminal content stays end-to-end encrypted.</Body>
    <ol aria-label="Remote access setup progress" style={{ display: "flex", flexWrap: "wrap", gap: "8px 20px", listStyle: "none", padding: 0, margin: "8px 0" }}>
      {["Sign in", "Verify connection", "Pair phone"].map((label, index) => {
        const step = connected ? 2 : registered ? 1 : 0;
        return <li key={label} aria-current={step === index ? "step" : undefined} style={{ fontFamily: "var(--font-display)", fontSize: rem(12.5), fontWeight: step === index ? 600 : 400, color: step === index ? colors.fg0 : colors.fg3 }}>{index < step ? "[✓]" : step === index ? "[~]" : "[ ]"} {label.toLowerCase()}</li>;
      })}
    </ol>
    {!registered && !login && <Body size={13}>Invitation beta · one Hub per account. Sign in to enable remote access for this Mac. Local network access works without an Offdesk account.</Body>}
    {busy ? <Body size={13}><span role="status">{busy}</span></Body> : null}
    {connected ? <>
      <Body size={13}><span role="status">Remote connection ready · Encryption verified</span></Body>
      <Body size={12} style={{ overflowWrap: "anywhere" }}>{status.url}</Body>
      {onPairPhone ? <Button size="sm" onClick={onPairPhone}>Connect your phone</Button> : <SecurePairingPanel baseUrl={status.url} managed />}
    </> : null}
    {!busy && !connected && status?.state === "active" && status.local_enabled ? <Body size={13}><span role="status">Remote connection is not verified. Keep this Mac online; Offdesk retries automatically.</span></Body> : null}
    {status?.state === "revoking" ? <Body size={13}>Remote access is being removed. Check again to confirm it has finished.</Body> : null}
    {login?.state === "pending" ? <div style={{ padding: 16, background: colors.bg0, border: `1px solid ${colors.lineSoft}`, borderRadius: 4 }}>
      <Body size={13}>Continue in your browser. Check that it shows this same code before approving:</Body>
      <p style={{ fontFamily: "var(--font-display)", fontSize: rem(22), letterSpacing: 3, margin: "12px 0" }}>{login.user_code}</p>
      <Button size="sm" kind="secondary" onClick={() => void openCloud(login.verification_uri!).catch(cause => setError(message(cause)))}>Open sign-in page</Button>
    </div> : null}
    {login?.state === "expired" ? <Body size={13}>Sign-in expired. Start again to get a new code.</Body> : null}
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
      {!registered && login?.state !== "pending" ? <Button size="sm" disabled={busy !== null} onClick={() => void run("login")}>Sign in with GitHub</Button> : null}
      {registered && !status.local_enabled && status.state !== "revoking" ? <Button size="sm" disabled={busy !== null} onClick={() => void run("enable")}>Enable remote connection</Button> : null}
      {registered && status.local_enabled && !connected && status.state !== "revoking" ? <Button size="sm" disabled={busy !== null} onClick={() => void run("check")}>Verify connection</Button> : null}
      <Button size="sm" kind="ghost" disabled={busy !== null} onClick={() => void run("status")}>Check again</Button>
      <Button size="sm" kind="ghost" onClick={() => void openCloud("https://offdesk.so").catch(cause => setError(message(cause)))}>Offdesk account</Button>
      {status?.local_enabled ? <Button size="sm" kind="danger" disabled={busy !== null} onClick={() => setConfirmDisable(true)}>Turn off remote access</Button> : null}
    </div>
    {confirmDisable ? <div>
      <Body size={13}>Disconnect phones that connect through your Offdesk account? Local connections and running terminals stay available.</Body>
      <Button size="sm" disabled={busy !== null} onClick={() => void run("disable")}>Turn off</Button>{" "}<Button size="sm" kind="ghost" onClick={() => setConfirmDisable(false)}>Keep connected</Button>
    </div> : null}
    {stale && !busy ? <Body size={13}>Connection status could not be confirmed. Check again before relying on remote access.</Body> : null}
    {error ? <Body size={13} style={{ color: colors.err }}><span role="alert">{error}</span></Body> : null}
    {!connected ? <Body size={12}>The first setup may download Cloudflare’s connector from its official release. This Mac must stay awake and online.</Body> : null}
  </section>;
}
