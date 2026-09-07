import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { colors } from "../lib/colors";
import { connectionRoutesSnapshot, refreshConnectionRoutes, secureConnectionStatus, subscribeConnectionRoutes, switchConnectionRoute } from "../lib/secureTransport";

/** Also lives on recovery: a dead LAN connection must not hide remote access. */
export function ConnectionRoutesPanel({ onSwitched }: { onSwitched?: () => void }) {
  const report = useSyncExternalStore(subscribeConnectionRoutes, connectionRoutesSnapshot, () => null);
  const [checking, setChecking] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const refresh = async () => {
    if (busy.current) return;
    busy.current = true; setChecking(true); setError(null);
    try { await refreshConnectionRoutes(); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { busy.current = false; if (mounted.current) setChecking(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const visible = () => { if (document.visibilityState === "visible") void refresh(); };
    const online = () => void refresh();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted.current = false;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", online);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);
  const current = report?.status.endpoint.hub_url ?? secureConnectionStatus()?.endpoint.hub_url;
  const routes = report?.routes ?? (secureConnectionStatus()?.routes ?? []).map(route => ({ ...route, available: false }));
  const choose = async (url: string) => {
    if (busy.current) return;
    busy.current = true; setSwitching(true); setError(null);
    try { await switchConnectionRoute(url); onSwitched?.(); }
    catch (e) { if (mounted.current) setError(String(e)); }
    finally { busy.current = false; if (mounted.current) setSwitching(false); }
  };
  return <div data-testid="connection-routes" style={{ display: "flex", flexDirection: "column", gap: 12, color: colors.foreground }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
      <strong>Connection method</strong>
      <button type="button" disabled={checking || switching} onClick={() => void refresh()} style={{ color: colors.foreground, background: "none", border: `1px solid ${colors.border}`, borderRadius: 8, padding: "10px 12px" }}>{checking ? "Checking…" : "Check again"}</button>
    </div>
    {(["local", "remote"] as const).map(kind => {
      const candidates = routes.filter(route => route.kind === kind);
      const label = kind === "local" ? "Local network" : "Remote connection";
      return <div key={kind} style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12 }}>
        <strong>{label}</strong>
        <p style={{ color: colors.foregroundMuted, fontSize: 13, margin: "6px 0 10px" }}>{kind === "local" ? "Use when your phone and computer are on the same network." : "Use with mobile data or another Wi-Fi network."}</p>
        {candidates.length === 0 ? <span style={{ color: colors.foregroundMuted, fontSize: 13 }}>{checking ? "Checking…" : report?.discovery_available ? "Not configured" : "No saved address"}</span> : candidates.map(route => {
          const active = route.hub_url.replace(/\/$/, "") === current?.replace(/\/$/, "");
          return <button key={route.hub_url} type="button" disabled={checking || switching || !!error || !route.available || (active && !onSwitched)} onClick={() => void choose(route.hub_url)} aria-label={`${label}: ${route.hub_url}`} aria-current={active ? "true" : undefined} style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center", width: "100%", minHeight: 44, textAlign: "left", background: "none", border: 0, color: route.available ? colors.foreground : colors.foregroundMuted, padding: "8px 0", cursor: "pointer" }}>
            <span style={{ overflowWrap: "anywhere", minWidth: 0, fontSize: 13 }}>{route.hub_url}</span>
            <span style={{ flexShrink: 0, fontSize: 13 }}>{checking ? "Checking…" : !route.available ? active ? "Selected · Unreachable" : "Unreachable" : active ? "Current" : "Available"}</span>
          </button>;
        })}
      </div>;
    })}
    <p role="status" style={{ margin: 0, fontSize: 13, color: colors.foregroundMuted }}>{switching ? "Switching connection…" : "Switch without pairing again. Your terminals stay running."}</p>
    {report && !report.discovery_available && <p style={{ margin: 0, fontSize: 13, color: colors.foregroundMuted }}>Showing saved addresses. To find new connections, make sure your Hub is reachable and up to date.</p>}
    {error && <p role="alert" style={{ margin: 0, color: colors.err, fontSize: 13 }}>{error}</p>}
  </div>;
}
