import { useEffect, useRef, useState } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import * as api from "@/lib/api";
import { openWebPreview, parseLocalPreview } from "@/lib/webPreview";
import { rem } from "@/lib/rem";

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
  return <div role="dialog" aria-modal="true" aria-labelledby="web-preview-title" onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 1000, background: colorAlpha.overlay, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
    <div onClick={e => e.stopPropagation()} className="odk-float" style={{ padding: 24, width: "100%", maxWidth: 460, maxHeight: "85vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: rem(13), color: colors.fg3 }}><span aria-hidden style={{ color: colors.accent }}>~</span> $ web preview</div>
      <h2 id="web-preview-title" style={{ margin: 0, fontSize: rem(20), fontWeight: 600, letterSpacing: "-0.02em" }}>Open web preview</h2>
      <p style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: rem(14), lineHeight: 1.55, color: colors.fg2 }}>View a website running on this machine in your browser.</p>
      {configured === false ? <p role="status" style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: rem(14), color: colors.fg2 }}>Web previews are not configured on this Hub.</p> : <form onSubmit={e => { e.preventDefault(); submit(); }} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="web-preview-address" className="odk-label">local address</label>
        <input id="web-preview-address" ref={input} value={address} onChange={e => setAddress(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="http://localhost:3127/" className="odk-input" />
        <div style={{ marginTop: 10 }}><button type="submit" disabled={busy || configured !== true} className="odk-btn odk-btn--primary odk-btn--sm">{busy ? "opening…" : "open in browser"}</button></div>
      </form>}
      {launcher && <p role="status" style={{ margin: 0, fontFamily: "var(--font-sans)", fontSize: rem(14) }}>If the preview did not open, <a href={launcher} target="_blank" rel="noopener noreferrer" style={{ color: colors.accent }}>open preview here</a>.</p>}
      {error && <p role="alert" style={{ margin: 0, color: colors.err, fontSize: rem(12) }}>{error}</p>}
      {previews.length > 0 && <><div style={{ marginTop: 8, fontSize: rem(11.5), fontWeight: 500, color: colors.fg3 }}>active previews</div>{previews.map(p => <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: rem(13) }}><span style={{ textTransform: "lowercase" }}>Port {p.port}</span><button className="odk-btn odk-btn--secondary odk-btn--sm" aria-label="Close preview" onClick={() => { void api.closeWebPreview(p.id).then(() => setPreviews(all => all.filter(item => item.id !== p.id))).catch(() => setError("Could not close preview.")); }}>close preview</button></div>)}</>}
      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}><button className="odk-btn odk-btn--secondary odk-btn--sm" aria-label={launcher ? "Done" : "Cancel"} onClick={onClose}>{launcher ? "done" : "cancel"}</button></div>
    </div>
  </div>;
}
