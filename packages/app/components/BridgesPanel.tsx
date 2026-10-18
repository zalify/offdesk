import { useCallback, useEffect, useRef, useState } from "react";

import {
  createBridge,
  deleteWebhook,
  listBridges,
  listTokenAudit,
  setWebhookEnabled,
  type AuditEntry,
  type Bridge,
} from "@/lib/api";
import { colors } from "@/lib/colors";
import {
  CONTENT_LEVELS,
  RUN_SCOPES,
  accessFromForm,
  defaultTokenAccessForm,
  describeAccess,
  type TokenAccessForm,
} from "@/lib/tokenAccess";
import { rem } from "@/lib/rem";

const inputStyle: React.CSSProperties = {
  background: colors.bg1,
  border: `1px solid ${colors.line}`,
  borderRadius: 4,
  color: colors.fg0,
  padding: "8px 12px",
  fontFamily: "var(--font-display)",
  // The same size as the form's labels around it.
  fontSize: "inherit",
  outline: "none",
};

const smallButton: React.CSSProperties = {
  background: "none",
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  color: colors.foregroundSecondary,
  cursor: "pointer",
  padding: "6px 10px",
  fontSize: rem(12),
  whiteSpace: "nowrap",
};

function ago(ms: number | null): string {
  if (!ms) return "";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** How a bridge's connection is doing, in a few words. */
export function bridgeState(bridge: Bridge): { text: string; bad: boolean } {
  if (!bridge.enabled) return { text: "off", bad: false };
  const { connected, since_ms, last_error } = bridge.connection;
  if (connected) return { text: `connected ${ago(since_ms)}`, bad: false };
  if (last_error) {
    return { text: `${bridge.paired ? "reconnecting" : "not paired"}: ${last_error}`, bad: true };
  }
  return { text: "connecting", bad: false };
}

/** Settings › Bridges: servers the hub keeps a connection to, which see agent runs and,
 *  within what you allow here, answer them and start agents. */
export function BridgesPanel() {
  const [bridges, setBridges] = useState<Bridge[] | null>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [form, setForm] = useState<TokenAccessForm>(defaultTokenAccessForm);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = (what: string) => (err: unknown) =>
    setError(`${what}: ${err instanceof Error ? err.message : String(err)}`);

  const load = useCallback(() => {
    listBridges().then(setBridges).catch((err) => {
      setBridges([]);
      fail("Failed to load bridges")(err);
    });
  }, []);
  useEffect(() => {
    load();
    // Connections change on their own: look again now and then
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const add = () => {
    const { access, error: invalid } = accessFromForm({ ...form, kind: "runs" });
    if (invalid || !access) {
      setError(invalid ?? "Choose what it may do");
      return;
    }
    setError(null);
    createBridge({
      name: name.trim(),
      url: url.trim(),
      pairing_code: code.trim(),
      scopes: access.scopes,
      content: access.content ?? "metadata",
      include_production: access.include_production ?? false,
      dirs: access.dirs,
    })
      .then(() => {
        setName("");
        setUrl("");
        setCode("");
        setForm(defaultTokenAccessForm());
        load();
      })
      .catch(fail("Failed to add the bridge"));
  };

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(null), 3000);
      return;
    }
    setConfirming(null);
    deleteWebhook(id).then(load).catch(fail("Failed to remove the bridge"));
  };

  const ready = name.trim() !== "" && url.trim() !== "" && code.trim() !== "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: rem(11), color: colors.foregroundMuted }}>
        A server this hub keeps a connection to (it always dials out). It sees
        agent runs at the level you choose, not end-to-end encrypted, and acts
        only within what you allow here. Never terminal output; never your
        terminals. Turning one off hangs up at once.
      </div>

      <div
        role="group"
        aria-label="New bridge"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 12,
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          fontSize: rem(12),
          color: colors.foregroundSecondary,
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input aria-label="Bridge name" placeholder="Name (e.g. cloud)" value={name}
            onChange={(e) => setName(e.target.value)} style={{ ...inputStyle, flex: "1 1 160px", minWidth: 0 }} />
          <input aria-label="Bridge URL" placeholder="wss://…" value={url}
            onChange={(e) => setUrl(e.target.value)} style={{ ...inputStyle, flex: "3 1 220px", minWidth: 0 }} />
          <input aria-label="Pairing code" placeholder="Pairing code" value={code}
            onChange={(e) => setCode(e.target.value)} style={{ ...inputStyle, flex: "1 1 120px", minWidth: 0, fontFamily: "var(--font-mono)" }} />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {RUN_SCOPES.map(({ scope, label }) => (
            <label key={scope} style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={form.scopes.includes(scope)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    scopes: e.target.checked ? [...form.scopes, scope] : form.scopes.filter((s) => s !== scope),
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ whiteSpace: "nowrap" }}>It sees</span>
          <select aria-label="What the bridge sees" value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value as TokenAccessForm["content"] })}
            style={{ ...inputStyle, padding: "4px 8px" }}>
            {CONTENT_LEVELS.map(({ level, label }) => (
              <option key={level} value={level}>{label}</option>
            ))}
          </select>
          <span style={{ color: colors.foregroundMuted, whiteSpace: "nowrap" }}>never terminal output</span>
        </label>
        {form.scopes.includes("runs:start") && (
          <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            Folders it may start agents in, one per line
            <textarea aria-label="Bridge start folders" rows={2} placeholder="~/work" value={form.dirs}
              onChange={(e) => setForm({ ...form, dirs: e.target.value })}
              style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: rem(12) }} />
          </label>
        )}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
            <input type="checkbox" checked={form.includeProduction}
              onChange={(e) => setForm({ ...form, includeProduction: e.target.checked })} />
            Production machines too
          </label>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={add}
            disabled={!ready}
            style={{
              background: colors.primary,
              border: "none",
              borderRadius: 4,
              color: colors.onPrimary,
              cursor: ready ? "pointer" : "default",
              opacity: ready ? 1 : 0.5,
              padding: "8px 16px",
              fontSize: rem(13),
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            Pair bridge
          </button>
        </div>
      </div>

      {bridges === null ? (
        <div style={{ fontSize: rem(12), color: colors.foregroundMuted }}>Loading…</div>
      ) : bridges.length === 0 ? (
        <div style={{ fontSize: rem(12), color: colors.foregroundMuted }}>No bridges yet.</div>
      ) : (
        bridges.map((bridge) => {
          const state = bridgeState(bridge);
          return (
            <div key={bridge.id} role="group" aria-label={`Bridge ${bridge.name}`}
              style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <div style={{ fontSize: rem(13), color: bridge.enabled ? colors.foreground : colors.foregroundMuted }}>{bridge.name}</div>
                <div style={{ fontSize: rem(11), color: colors.foregroundMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{bridge.url}</div>
                <div style={{ fontSize: rem(11), color: colors.foregroundSecondary }}>{describeAccess(bridge.access)}</div>
                <div style={{ fontSize: rem(11), color: state.bad ? colors.danger : colors.foregroundMuted }}>{state.text}</div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" style={smallButton}
                  onClick={() => setWebhookEnabled(bridge.id, !bridge.enabled).then(load).catch(fail("Failed to change it"))}>
                  {bridge.enabled ? "Turn off" : "Turn on"}
                </button>
                <button
                  type="button"
                  style={{
                    ...smallButton,
                    borderColor: confirming === bridge.id ? colors.danger : colors.border,
                    color: confirming === bridge.id ? colors.danger : colors.foregroundSecondary,
                  }}
                  onClick={() => remove(bridge.id)}
                  onBlur={() => setConfirming(null)}
                >
                  {confirming === bridge.id ? "Confirm?" : "Remove"}
                </button>
              </div>
            </div>
          );
        })
      )}
      {error && <div style={{ fontSize: rem(12), color: colors.danger }}>{error}</div>}
    </div>
  );
}

/** Settings › Activity: what tokens and bridges did (answers, approvals, starts) and
 *  what they were refused, newest first. */
export function TokenActivityPanel() {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    listTokenAudit()
      .then((all) => setEntries(all.slice(0, 50)))
      .catch((err) => {
        setEntries([]);
        setError(`Failed to load activity: ${err instanceof Error ? err.message : String(err)}`);
      });
  }, []);
  useEffect(load, [load]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ fontSize: rem(11), color: colors.foregroundMuted, flex: 1 }}>
          What tokens and bridges did with agent runs, and what they were
          refused. Your own actions in the app aren't listed.
        </div>
        <button type="button" style={smallButton} onClick={load}>Refresh</button>
      </div>
      {entries === null ? (
        <div style={{ fontSize: rem(12), color: colors.foregroundMuted }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ fontSize: rem(12), color: colors.foregroundMuted }}>Nothing yet.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: rem(12) }}>
          {entries.map((entry, i) => {
            const ok = entry.result === "ok";
            return (
              <div key={`${entry.at_ms}-${i}`} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ color: colors.foregroundMuted, minWidth: 36 }}>{ago(entry.at_ms)}</span>
                <span style={{ color: colors.foreground }}>{entry.token_name}</span>
                <span style={{ color: ok ? colors.foregroundSecondary : colors.danger }}>{entry.action}</span>
                <span style={{ color: colors.foregroundMuted, fontFamily: "var(--font-mono)", fontSize: rem(11), overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>
                  {entry.target}
                </span>
                {!ok && <span style={{ color: colors.danger, flexBasis: "100%", paddingLeft: 44 }}>{entry.result}</span>}
              </div>
            );
          })}
        </div>
      )}
      {error && <div style={{ fontSize: rem(12), color: colors.danger }}>{error}</div>}
    </div>
  );
}
