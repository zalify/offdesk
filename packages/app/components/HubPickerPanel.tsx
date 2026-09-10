import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ChevronRight, Globe, Plus, QrCode, RefreshCw, ShieldCheck, Wifi } from "lucide-react";
import { colors } from "../lib/colors";
import { isTauriMobile } from "../lib/platform";
import { scanWithCleanup } from "../lib/scanLifecycle";
import { checkSavedHub, openSavedHub, pairAndOpenHub, pairingIdentity, removeSavedHub, renameSavedHub, savedHubs, secureConnectionStatus, type RouteReport, type SavedHub, type SecureStatus } from "../lib/secureTransport";
import { Body, Button } from "./Warm.web";

const errorText = (error: unknown) => error instanceof Error ? error.message : typeof error === "string" ? error : "Could not complete this action. Try again.";
const card = { border: `1px solid ${colors.line}`, borderRadius: 16, padding: 16, minWidth: 0 };
const field = { width: "100%", minWidth: 0, boxSizing: "border-box" as const, fontSize: 16, padding: 12, color: colors.fg0, background: colors.bg0, border: `1px solid ${colors.line}`, borderRadius: 10 };
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
  return <div data-testid="hub-picker" style={{ padding: 16, display: "grid", gap: 16, color: colors.fg0 }}>
    {(adding || selected) && <Button kind="ghost" disabled={busy !== null} onClick={back} style={{ justifySelf: "start", padding: "0 4px" }}><ArrowLeft size={18} /> Saved Hubs</Button>}
    {!adding && !selected && <>
      <Body size={13}>Choose a Hub, then its connection. Your terminals keep running when you switch.</Body>
      {hubs.map(hub => <button type="button" key={hub.status.endpoint.public_key} disabled={busy !== null} onClick={() => { setSelected(hub); setName(hub.name); void check(hub); }} style={{ ...card, width: "100%", textAlign: "left", background: hub.status.endpoint.public_key === active ? colors.bg2 : colors.bg1, color: colors.fg0, display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 12, cursor: "pointer" }}>
        <span style={{ minWidth: 0 }}><strong style={{ display: "block", overflowWrap: "anywhere" }}>{hub.name === hub.status.endpoint.hub_url ? address(hub.name) : hub.name}</strong><span style={{ fontSize: 13, color: colors.fg3 }}>{hub.status.endpoint.public_key === active ? "Current Hub · " : "Saved · "}Encrypted pairing</span></span><ChevronRight size={18} />
      </button>)}
      {!hubs.length && !busy && <Body size={13}>No saved Hubs yet. Open Mobile app on your Hub’s computer to get its encrypted pairing code.</Body>}
      <Button kind="sky" disabled={busy !== null} onClick={() => setAdding(true)}><Plus size={18} /> Add a Hub</Button>
    </>}
    {selected && <>
      <div><strong style={{ fontSize: 18, overflowWrap: "anywhere" }}>{selected.name === selected.status.endpoint.hub_url ? address(selected.name) : selected.name}</strong><Body size={13}>Select a reachable connection. We verify the saved Hub identity before switching.</Body></div>
      {(["local", "remote"] as const).map(kind => {
        const routes = report?.routes.filter(route => route.kind === kind) ?? [];
        return <div key={kind} style={card}>
          <strong style={{ display: "flex", alignItems: "center", gap: 8 }}>{kind === "local" ? <Wifi size={18} /> : <Globe size={18} />}{kind === "local" ? "Local network" : "Remote connection"}</strong>
          <Body size={13}>{kind === "local" ? "Your phone and Hub must share a network." : "Use mobile data or another Wi-Fi network."}</Body>
          {!routes.length && <Body size={13}>{busy ? "Checking…" : !report ? "Check connections to see available addresses." : report.discovery_available ? "Not configured on this Hub." : "No saved address. Reconnect to your Hub to discover one."}</Body>}
          {routes.map(route => <button type="button" key={route.hub_url} disabled={busy !== null || !route.available} onClick={() => void run("Connecting to Hub…", () => openSavedHub(selected.status.endpoint.public_key, route.hub_url))} style={{ width: "100%", textAlign: "left", minHeight: 48, padding: "12px 0", background: "none", border: 0, color: route.available ? colors.fg0 : colors.fg3, cursor: route.available ? "pointer" : "default" }}>
            <span style={{ display: "block", overflowWrap: "anywhere", fontSize: 13 }}>{address(route.hub_url)}</span><strong style={{ fontSize: 13 }}>{route.available ? "Connect" : "Unreachable on this network"}</strong>
          </button>)}
        </div>;
      })}
      {report?.machines?.length ? <div style={card}><strong>Machines in this Hub</strong>{report.machines.map((machine, i) => <Body key={i} size={13}>{machine.name} · {machine.os}</Body>)}<Body size={12}>After connecting, choose a machine in the title menu.</Body></div> : null}
      <Button kind="sky" disabled={busy !== null} onClick={() => void check(selected)}><RefreshCw size={16} /> Check again</Button>
      <details><summary style={{ cursor: "pointer", padding: "12px 0" }}>Hub name and saved pairing</summary><div style={{ display: "grid", gap: 12 }}>
        <label>Hub name<input value={name} maxLength={60} onChange={e => setName(e.target.value)} style={field} /></label>
        <Button kind="sky" disabled={busy !== null || !name.trim()} onClick={() => void run("Saving name…", async () => { await renameSavedHub(selected.status.endpoint.public_key, name); const result = await savedHubs(); if (mounted.current) { setHubs(result); setSelected(result.find(h => h.status.endpoint.public_key === selected.status.endpoint.public_key) ?? null); } })}>Save name</Button>
        <Body size={12}>Hub identity: <span style={{ overflowWrap: "anywhere", fontFamily: "var(--font-mono)" }}>{selected.status.endpoint.public_key}</span></Body>
        {selected.status.endpoint.public_key !== active && <Button kind="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(true)}>Remove saved Hub</Button>}
        {confirmRemove && <><Body size={13}>Remove this pairing from this device? You’ll need to pair again to return. Running terminals and other devices stay connected.</Body><Button disabled={busy !== null} onClick={() => void run("Removing saved Hub…", async () => { await removeSavedHub(selected.status.endpoint.public_key); const result = await savedHubs(); if (mounted.current) { setHubs(result); back(); } })}>Remove from this device</Button><Button kind="ghost" disabled={busy !== null} onClick={() => setConfirmRemove(false)}>Keep Hub</Button></>}
      </div></details>
    </>}
    {adding && <>
      <strong style={{ fontSize: 18 }}>{identity ? "Confirm your Hub" : "Add a Hub"}</strong>
      {identity ? <>
        <div style={card}><ShieldCheck size={22} /><Body style={{ overflowWrap: "anywhere" }}>{identity.hub_url}</Body><Body size={12}>Hub identity</Body><code style={{ display: "block", overflowWrap: "anywhere", fontSize: 13 }}>{identity.public_key}</code></div>
        <Body size={13}>Check this address and identity against the pairing screen on your computer. Pairing gives this device access to its terminals.</Body>
        {hubs.some(hub => hub.status.endpoint.public_key === identity.public_key) && <Body size={13}>This Hub is already saved. Pairing again replaces its saved pairing on this device.</Body>}
        <Button disabled={busy !== null} onClick={() => void run("Pairing with Hub…", () => pairAndOpenHub(uri))}>Pair and connect</Button>
        <Button kind="ghost" disabled={busy !== null} onClick={() => { setIdentity(null); setUri(""); }}>Use another code</Button>
      </> : <>
        <Body size={13}>On the Hub computer, open Settings → Mobile app. Use the encrypted App code. Your existing Hubs stay saved.</Body>
        {isTauriMobile() && <Button disabled={busy !== null} onClick={() => void scan()}><QrCode size={18} /> Scan QR Code</Button>}
        <label>Or paste the pairing link<input type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={uri} onChange={e => setUri(e.target.value)} placeholder="offdesk://pair?…" style={{ ...field, marginTop: 8 }} /></label>
        <Button kind="sky" disabled={busy !== null || !uri.trim()} onClick={() => void run("Reading pairing code…", async () => { const result = await pairingIdentity(uri.trim()); if (mounted.current) { setUri(uri.trim()); setIdentity(result); } })}>Continue</Button>
      </>}
    </>}
    {busy && <Body size={13}><span role="status">{busy}</span></Body>}
    {error && <p role="alert" style={{ color: colors.err, margin: 0, overflowWrap: "anywhere" }}>{error}{active && " Your current Hub is still selected."}</p>}
  </div>;
}
