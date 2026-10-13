import { useEffect, useRef, useState } from "react";
import { colors } from "../lib/colors";
import { isTauriMobile } from "../lib/platform";
import { scanWithCleanup } from "../lib/scanLifecycle";
import { checkSavedHub, openSavedHub, pairAndOpenHub, pairingIdentity, removeSavedHub, renameSavedHub, savedHubs, secureConnectionStatus, type RouteReport, type SavedHub, type SecureStatus } from "../lib/secureTransport";
import { Body, Button } from "./Primitives.web";

const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "string" ? error : "Could not complete this action. Try again.";
const card = { border: `1px solid ${colors.lineSoft}`, borderRadius: 4, padding: "12px 14px", minWidth: 0, background: colors.bg1, fontFamily: "var(--font-display)" };
const field = { width: "100%", minWidth: 0, boxSizing: "border-box" as const, fontSize: 16, padding: "0 12px", minHeight: 44, color: colors.fg0, background: colors.bg1, border: `1px solid ${colors.line}`, borderRadius: 4, fontFamily: "var(--font-display)" };
function address(url: string) { try { return new URL(url).host; } catch { return url; } }

/** Bundled App only. The picker remains usable when the active Hub is offline. */
export function HubPickerPanel({ initialUri = "" }: { initialUri?: string }) {
  const [hubs, setHubs] = useState<SavedHub[]>([]);
  const [selected, setSelected] = useState<SavedHub | null>(null);
  const [adding, setAdding] = useState(Boolean(initialUri));
  const [uri, setUri] = useState(initialUri);
  const [identity, setIdentity] = useState<SecureStatus["endpoint"] | null>(null);
  const [report, setReport] = useState<RouteReport | null>(null);
  const [name, setName] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState<string | null>("Loading saved Hubs…");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const operation = useRef(false);
  const active = secureConnectionStatus()?.endpoint.public_key;
  const run = async (label: string, action: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true; setBusy(label); setError(null);
    try { await action(); }
    catch (cause) { if (mounted.current) setError(errorText(cause)); }
    finally { operation.current = false; if (mounted.current) setBusy(null); }
  };
  useEffect(() => {
    mounted.current = true;
    void run("Loading saved Hubs…", async () => {
      const result = await savedHubs();
      if (mounted.current) setHubs(result);
      if (initialUri) {
        const endpoint = await pairingIdentity(initialUri);
        if (mounted.current) setIdentity(endpoint);
      }
    });
    return () => { mounted.current = false; };
  }, []);
  const check = (hub: SavedHub) => run("Checking connections…", async () => {
    setReport(null);
    const result = await checkSavedHub(hub.status.endpoint.public_key);
    if (mounted.current) setReport(result);
  });
  const back = () => { setSelected(null); setAdding(false); setIdentity(null); setUri(""); setError(null); setReport(null); setConfirmRemove(false); };
  const scan = () => run("Opening camera…", async () => {
    const { scan, cancel, Format, checkPermissions, requestPermissions } = await import("@tauri-apps/plugin-barcode-scanner");
    let permission = await checkPermissions();
    if (permission !== "granted") permission = await requestPermissions();
    if (permission !== "granted") throw new Error("Allow Camera in your phone’s app settings, or paste the pairing link below.");
    const result = await scanWithCleanup(() => scan({ windowed: false, formats: [Format.QRCode] }), cancel);
    const scanned = result.content?.trim();
    if (!scanned || !mounted.current) return;
    setUri(scanned); setIdentity(null);
    const endpoint = await pairingIdentity(scanned);
    if (mounted.current) setIdentity(endpoint);
  });
  return <div data-testid="hub-picker" style={{ padding: 16, display: "grid", gap: 16, color: colors.fg0, fontFamily: "var(--font-display)" }}>
    {(adding || selected) && <Button kind="ghost" disabled={busy !== null} onClick={back} style={{ justifySelf: "start", padding: "0 4px" }}>← Saved Hubs</Button>}
    {!adding && !selected && <>
      <Body size={13}>Choose a Hub, then its connection. Your terminals keep running when you switch.</Body>
      {hubs.length > 0 && <div style={{ border: `1px solid ${colors.lineSoft}`, borderRadius: 6, overflow: "hidden" }}>
      {hubs.map((hub, index) => { const current = hub.status.endpoint.public_key === active; return <button type="button" key={hub.status.endpoint.public_key} disabled={busy !== null} onClick={() => { setSelected(hub); setName(hub.name); void check(hub); }} style={{ width: "100%", minHeight: 60, padding: "12px 16px", textAlign: "left", border: 0, borderTop: index ? `1px solid ${colors.lineSoft}` : 0, borderLeft: `2px solid ${current ? colors.accent : "transparent"}`, background: current ? colors.bg2 : "transparent", color: colors.fg0, display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 12, cursor: "pointer", fontFamily: "var(--font-display)" }}>
        <span aria-label={current ? "Current" : undefined} style={{ color: current ? colors.accent : colors.fg3 }}>{current ? "●" : "○"}</span>
        <span style={{ minWidth: 0 }}><span style={{ display: "block", overflowWrap: "anywhere", fontSize: 14, fontWeight: current ? 600 : 400 }}>{hub.name === hub.status.endpoint.hub_url ? address(hub.name) : hub.name}</span><span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: colors.fg2 }}>{current ? "Current hub · " : "Saved · "}encrypted pairing</span></span><span aria-hidden="true" style={{ color: colors.fg3 }}>›</span>
      </button>; })}
      </div>}
      {!hubs.length && !busy && <Body size={13}>No saved Hubs yet. Open Mobile app on your Hub’s computer to get its encrypted pairing code.</Body>}
      <Button kind="secondary" disabled={busy !== null} onClick={() => setAdding(true)}>Add a Hub</Button>
    </>}
    {selected && <>
      <div><strong style={{ display: "block", fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em", overflowWrap: "anywhere", marginBottom: 6 }}>{selected.name === selected.status.endpoint.hub_url ? address(selected.name) : selected.name}</strong><Body size={13}>Select a reachable connection. We verify the saved Hub identity before switching.</Body></div>
      {(["local", "remote"] as const).map(kind => {
        const routes = report?.routes.filter(route => route.kind === kind) ?? [];
        return <div key={kind} style={card}>
          <strong style={{ display: "block", fontSize: 13, fontWeight: 600 }}>{kind === "local" ? "local network" : "remote connection"}</strong>
          <Body size={13}>{kind === "local" ? "Your phone and Hub must share a network." : "Use mobile data or another Wi-Fi network."}</Body>
          {!routes.length && <Body size={13}>{busy ? "Checking…" : !report ? "Check connections to see available addresses." : report.discovery_available ? "Not configured on this Hub." : "No saved address. Reconnect to your Hub to discover one."}</Body>}
          {routes.map(route => <button type="button" key={route.hub_url} disabled={busy !== null || !route.available} onClick={() => void run("Connecting to Hub…", () => openSavedHub(selected.status.endpoint.public_key, route.hub_url))} style={{ width: "100%", textAlign: "left", minHeight: 48, padding: "12px 0", background: "none", border: 0, color: route.available ? colors.fg0 : colors.fg3, cursor: route.available ? "pointer" : "default" }}>
            <span style={{ display: "block", overflowWrap: "anywhere", fontSize: 12, color: colors.fg3 }}>{address(route.hub_url)}</span><span style={{ display: "inline-block", marginTop: 6, padding: "2px 8px", borderRadius: 3, fontSize: 11.5, fontWeight: 600, ...(route.available ? { background: colors.primary, color: colors.onPrimary } : { border: `1px solid ${colors.line}`, color: colors.fg3 }) }}>{route.available ? "connect" : "unreachable on this network"}</span>
          </button>)}
        </div>;
      })}
      {report?.machines?.length ? <div style={card}><strong style={{ fontSize: 12, fontWeight: 500, color: colors.fg3 }}>machines in this hub</strong>{report.machines.map((machine, i) => <Body key={i} size={13}>{machine.name} · {machine.os}</Body>)}<Body size={12}>After connecting, choose a machine in the title menu.</Body></div> : null}
      <Button kind="secondary" disabled={busy !== null} onClick={() => void check(selected)}>Check again</Button>
      <details><summary style={{ cursor: "pointer", padding: "12px 0", fontFamily: "var(--font-display)", fontSize: 13 }}>hub name and saved pairing</summary><div style={{ display: "grid", gap: 12 }}>
        <label className="odk-label" style={{ display: "grid", gap: 6 }}>hub name<input value={name} maxLength={60} onChange={e => setName(e.target.value)} style={field} /></label>
        <Button kind="secondary" disabled={busy !== null || !name.trim()} onClick={() => void run("Saving name…", async () => { await renameSavedHub(selected.status.endpoint.public_key, name); const result = await savedHubs(); if (mounted.current) { setHubs(result); setSelected(result.find(h => h.status.endpoint.public_key === selected.status.endpoint.public_key) ?? null); } })}>Save name</Button>
        <Body size={12}>Hub identity: <span style={{ overflowWrap: "anywhere", fontFamily: "var(--font-mono)" }}>{selected.status.endpoint.public_key}</span></Body>
        {selected.status.endpoint.public_key !== active && <Button kind="danger" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove saved Hub</Button>}
        {confirmRemove && <><Body size={13}>Remove this pairing from this device? You’ll need to pair again to return. Running terminals and other devices stay connected.</Body><Button disabled={busy !== null} onClick={() => void run("Removing saved Hub…", async () => { await removeSavedHub(selected.status.endpoint.public_key); const result = await savedHubs(); if (mounted.current) { setHubs(result); back(); } })}>Remove from this device</Button><Button kind="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep Hub</Button></>}
      </div></details>
    </>}
    {adding && <>
      <strong style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.02em" }}>{identity ? "Confirm your Hub" : "Add a Hub"}</strong>
      {identity ? <>
        <div style={card}><Body style={{ overflowWrap: "anywhere" }}>{identity.hub_url}</Body><Body size={12}>Hub identity</Body><code style={{ display: "block", overflowWrap: "anywhere", fontSize: 13 }}>{identity.public_key}</code></div>
        <Body size={13}>Check this address and identity against the pairing screen on your computer. Pairing gives this device access to its terminals.</Body>
        {hubs.some(hub => hub.status.endpoint.public_key === identity.public_key) && <Body size={13}>This Hub is already saved. Pairing again replaces its saved pairing on this device.</Body>}
        <Button disabled={busy !== null} onClick={() => void run("Pairing with Hub…", () => pairAndOpenHub(uri))}>Pair and connect</Button>
        <Button kind="ghost" disabled={busy !== null} onClick={() => { setIdentity(null); setUri(""); }}>Use another code</Button>
      </> : <>
        <Body size={13}>On the Hub computer, open Settings → Mobile app. Use the encrypted App code. Your existing Hubs stay saved.</Body>
        {isTauriMobile() && <Button disabled={busy !== null} onClick={() => void scan()}>Scan QR Code</Button>}
        <label className="odk-label" style={{ display: "grid", gap: 6 }}>or paste the pairing link<input type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={uri} onChange={e => setUri(e.target.value)} placeholder="offdesk://pair?…" style={{ ...field, marginTop: 8 }} /></label>
        <Button kind="secondary" disabled={busy !== null || !uri.trim()} onClick={() => void run("Reading pairing code…", async () => { const result = await pairingIdentity(uri.trim()); if (mounted.current) { setUri(uri.trim()); setIdentity(result); } })}>Continue</Button>
      </>}
    </>}
    {busy && <Body size={13}><span role="status">{busy}</span></Body>}
    {error && <p role="alert" style={{ color: colors.err, margin: 0, overflowWrap: "anywhere" }}>{error}{active && " Your current Hub is still selected."}</p>}
  </div>;
}
