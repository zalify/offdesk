import { useEffect, useRef, useState } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import * as api from "@/lib/api";
import { openWebPreview, parseLocalPreview } from "@/lib/webPreview";

export function WebPreviewDialog({ machineId, terminalId, onClose }: { machineId: string; terminalId: string; onClose: () => void }) {
  const [address, setAddress] = useState("http://localhost:3000/");
  const [error, setError] = useState("");
  const [launcher, setLauncher] = useState("");
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [previews, setPreviews] = useState<api.WebPreviewInfo[]>([]);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let alive = true;
    input.current?.focus();
    api.listWebPreviews().then(result => { if (alive) { setConfigured(result.configured); setPreviews(result.previews.filter(p => p.machine_id === machineId)); } }).catch(() => { if (alive) setError("Could not load previews. Try again."); });
    return () => { alive = false; };
  }, [machineId]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  const submit = () => {
    const local = parseLocalPreview(address.trim());
    if (!local) { setError("Enter an HTTP localhost address, for example http://localhost:3127/"); return; }
    setBusy(true); setError("");
    void openWebPreview(machineId, terminalId, local).then(url => { if (url) setLauncher(url); else onClose(); }).catch(e => setError(e instanceof Error ? e.message : "Could not open preview")).finally(() => setBusy(false));
  };
  const button = { padding: "10px 14px", borderRadius: 6, border: `1px solid ${colors.border}`, cursor: "pointer", color: colors.foreground, background: colors.surface };
  return <div role="dialog" aria-modal="true" aria-labelledby="web-preview-title" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: colorAlpha.backgroundShadow, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <div onClick={e => e.stopPropagation()} style={{ background: colors.surface, color: colors.foreground, border: `1px solid ${colors.border}`, borderRadius: 10, padding: 20, width: "100%", maxWidth: 440, maxHeight: "85vh", overflowY: "auto" }}>
      <h2 id="web-preview-title" style={{ marginTop: 0 }}>Open web preview</h2>
      <p>View a website running on this machine in your browser.</p>
      {configured === false ? <p role="status">Web previews are not configured on this Hub.</p> : <form onSubmit={e => { e.preventDefault(); submit(); }}>
        <label htmlFor="web-preview-address">Local address</label>
        <input id="web-preview-address" ref={input} value={address} onChange={e => setAddress(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} style={{ width: "100%", boxSizing: "border-box", margin: "8px 0 16px", padding: 10, fontSize: 16, color: colors.foreground, background: colors.background, border: `1px solid ${colors.border}`, borderRadius: 6 }} />
        <button type="submit" disabled={busy || configured !== true} style={button}>{busy ? "Opening…" : "Open in browser"}</button>
      </form>}
      {launcher && <p role="status">If the preview did not open, <a href={launcher} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent }}>open preview here</a>.</p>}
      {error && <p role="alert">{error}</p>}
      {previews.length > 0 && <><h3>Active previews</h3>{previews.map(p => <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}><span>Port {p.port}</span><button style={button} onClick={() => { void api.closeWebPreview(p.id).then(() => setPreviews(all => all.filter(item => item.id !== p.id))).catch(() => setError("Could not close preview.")); }}>Close preview</button></div>)}</>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}><button style={button} onClick={onClose}>{launcher ? "Done" : "Cancel"}</button></div>
    </div>
  </div>;
}
