import { useCallback, useEffect, useRef, useState } from "react";

import {
  createWebhook,
  deleteWebhook,
  listWebhooks,
  setWebhookEnabled,
  testWebhook,
  type NewWebhook,
  type Webhook,
} from "@/lib/api";
import { colors } from "@/lib/colors";
import { CONTENT_LEVELS } from "@/lib/tokenAccess";

/** The events a webhook can get, as the hub names them. */
export const WEBHOOK_EVENTS: { type: string; label: string }[] = [
  { type: "run.request", label: "Waits on you" },
  { type: "run.ended", label: "Ended" },
  { type: "run.started", label: "Started" },
  { type: "run.request_resolved", label: "Answered" },
  { type: "run.report", label: "Notes and reports" },
  { type: "run.status", label: "Status changes" },
  { type: "run.progress", label: "Progress" },
];

const inputStyle: React.CSSProperties = {
  background: colors.bg1,
  border: `1px solid ${colors.line}`,
  borderRadius: 4,
  color: colors.fg0,
  padding: "8px 12px",
  fontFamily: "var(--font-display)",
  fontSize: 13,
  outline: "none",
};

const smallButton: React.CSSProperties = {
  background: "none",
  border: `1px solid ${colors.border}`,
  borderRadius: 4,
  color: colors.foregroundSecondary,
  cursor: "pointer",
  padding: "6px 10px",
  fontSize: 12,
  whiteSpace: "nowrap",
};

const emptyForm = (): NewWebhook => ({
  name: "",
  url: "",
  events: ["run.request", "run.ended"],
  content: "metadata",
  include_production: false,
});

function when(ms: number | null): string {
  return ms ? new Date(ms).toLocaleString() : "never";
}

/** Settings › Webhooks: agent run events POSTed to a URL, signed with a secret. */
export function WebhooksPanel() {
  const [hooks, setHooks] = useState<Webhook[] | null>(null);
  const [form, setForm] = useState<NewWebhook>(emptyForm);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fail = (what: string) => (err: unknown) =>
    setError(`${what}: ${err instanceof Error ? err.message : String(err)}`);

  useEffect(() => {
    listWebhooks()
      .then((all) => setHooks(all.filter((h) => h.kind === "webhook")))
      .catch((err) => {
      setHooks([]);
      fail("Failed to load webhooks")(err);
    });
  }, []);

  const create = useCallback(() => {
    setError(null);
    createWebhook({ ...form, name: form.name.trim(), url: form.url.trim() })
      .then(({ integration, secret }) => {
        setHooks((list) => [...(list ?? []), integration]);
        setSecret(secret);
        setForm(emptyForm());
      })
      .catch(fail("Failed to add the webhook"));
  }, [form]);

  const replace = (hook: Webhook) =>
    setHooks((list) => (list ?? []).map((h) => (h.id === hook.id ? hook : h)));

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setConfirming(null), 3000);
      return;
    }
    setConfirming(null);
    deleteWebhook(id)
      .then(() => setHooks((list) => (list ?? []).filter((h) => h.id !== id)))
      .catch(fail("Failed to remove the webhook"));
  };

  const ready = form.name.trim() !== "" && form.url.trim() !== "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 11, color: colors.foregroundMuted }}>
        Agent run events, POSTed to a URL and signed the Standard Webhooks
        way: to your own service, or to ntfy through the example in
        examples/webhooks. A webhook only tells; it can't answer or start
        anything.
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          padding: 12,
          border: `1px solid ${colors.border}`,
          borderRadius: 4,
          fontSize: 12,
          color: colors.foregroundSecondary,
        }}
      >
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            type="text"
            aria-label="Webhook name"
            placeholder="Name (e.g. phone)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={{ ...inputStyle, flex: "1 1 140px", minWidth: 0 }}
          />
          <input
            type="url"
            aria-label="Webhook URL"
            placeholder="https://…"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            style={{ ...inputStyle, flex: "3 1 240px", minWidth: 0 }}
          />
        </div>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          {WEBHOOK_EVENTS.map(({ type, label }) => (
            <label key={type} style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
              <input
                type="checkbox"
                checked={form.events.includes(type)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    events: e.target.checked
                      ? [...form.events, type]
                      : form.events.filter((t) => t !== type),
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
        <label style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ whiteSpace: "nowrap" }}>It sees</span>
          <select
            aria-label="What the webhook sees"
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value as NewWebhook["content"] })}
            style={{ ...inputStyle, padding: "4px 8px" }}
          >
            {CONTENT_LEVELS.map(({ level, label }) => (
              <option key={level} value={level}>
                {label}
              </option>
            ))}
          </select>
          <span style={{ color: colors.foregroundMuted, whiteSpace: "nowrap" }}>
            never terminal output
          </span>
        </label>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", whiteSpace: "nowrap" }}>
            <input
              type="checkbox"
              checked={form.include_production}
              onChange={(e) => setForm({ ...form, include_production: e.target.checked })}
            />
            Production machines too
          </label>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={create}
            disabled={!ready}
            style={{
              background: colors.primary,
              border: "none",
              borderRadius: 4,
              color: colors.onPrimary,
              cursor: ready ? "pointer" : "default",
              opacity: ready ? 1 : 0.5,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: 500,
              whiteSpace: "nowrap",
            }}
          >
            Add webhook
          </button>
        </div>
      </div>

      {secret && (
        <div
          style={{
            padding: 12,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 4,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="text"
              readOnly
              aria-label="Signing secret"
              value={secret}
              onFocus={(e) => e.target.select()}
              style={{ ...inputStyle, flex: 1, minWidth: 0, fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
            <button type="button" style={smallButton} onClick={() => navigator.clipboard?.writeText(secret)}>
              Copy
            </button>
            <button type="button" style={smallButton} onClick={() => setSecret(null)}>
              Done
            </button>
          </div>
          <div style={{ fontSize: 11, color: colors.foregroundMuted }}>
            The signing secret: give it to the receiver to check each request.
            It won't be shown again.
          </div>
        </div>
      )}

      {hooks === null ? (
        <div style={{ fontSize: 12, color: colors.foregroundMuted }}>Loading…</div>
      ) : hooks.length === 0 ? (
        <div style={{ fontSize: 12, color: colors.foregroundMuted }}>No webhooks yet.</div>
      ) : (
        hooks.map((hook) => {
          const events = hook.events.length
            ? WEBHOOK_EVENTS.filter((e) => hook.events.includes(e.type)).map((e) => e.label.toLowerCase()).join(", ")
            : "every event";
          const level = CONTENT_LEVELS.find((l) => l.level === (hook.access.content ?? "metadata"));
          return (
            <div
              key={hook.id}
              role="group"
              aria-label={`Webhook ${hook.name}`}
              style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}
            >
              <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                <div style={{ fontSize: 13, color: hook.enabled ? colors.foreground : colors.foregroundMuted }}>
                  {hook.name}
                  {!hook.enabled && " · off"}
                </div>
                <div style={{ fontSize: 11, color: colors.foregroundMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {hook.url}
                </div>
                <div style={{ fontSize: 11, color: colors.foregroundSecondary }}>
                  {events} · {level?.label.toLowerCase()}
                </div>
                <div style={{ fontSize: 11, color: hook.last_error ? colors.danger : colors.foregroundMuted }}>
                  {hook.last_error
                    ? `last attempt failed: ${hook.last_error} · retrying`
                    : `last delivered ${when(hook.last_delivery_at)}`}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6 }}>
                <button
                  type="button"
                  style={smallButton}
                  disabled={!hook.enabled}
                  onClick={() => {
                    setNotice(null);
                    testWebhook(hook.id)
                      .then(() => setNotice(`Sent a test event to ${hook.name}`))
                      .catch(fail("Failed to send a test"));
                  }}
                >
                  Test
                </button>
                <button
                  type="button"
                  style={smallButton}
                  onClick={() => setWebhookEnabled(hook.id, !hook.enabled).then(replace).catch(fail("Failed to change it"))}
                >
                  {hook.enabled ? "Turn off" : "Turn on"}
                </button>
                <button
                  type="button"
                  style={{
                    ...smallButton,
                    borderColor: confirming === hook.id ? colors.danger : colors.border,
                    color: confirming === hook.id ? colors.danger : colors.foregroundSecondary,
                  }}
                  onClick={() => remove(hook.id)}
                  onBlur={() => setConfirming(null)}
                >
                  {confirming === hook.id ? "Confirm?" : "Remove"}
                </button>
              </div>
            </div>
          );
        })
      )}

      {notice && <div style={{ fontSize: 12, color: colors.foregroundSecondary }}>{notice}</div>}
      {error && <div style={{ fontSize: 12, color: colors.danger }}>{error}</div>}
    </div>
  );
}
