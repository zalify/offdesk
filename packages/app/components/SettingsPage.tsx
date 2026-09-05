import { ConnectionRoutesPanel } from "./ConnectionRoutesPanel";
import { notifyFontPreferencesChanged } from "@/lib/fontPreferences";
import { SecureDevicesPanel } from "./SecureConnectionPanel";
import { isSecureConnection, useSecureConnectionStatus } from "../lib/secureTransport";
import { useState, useCallback, useEffect, useRef } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import { useMobileHubSwitch } from "@/lib/useMobileHubSwitch";
import { useTheme, type Theme } from "@/lib/theme";
import { MobileAppPanel } from "./MobileAppPanel.web";
import { ThisMachineSection } from "./DesktopSetup.web";
import { UpdateNotification } from "./UpdateNotification";
import { useAuth } from "@/lib/auth";
import { isTauri, isTauriMobile } from "@/lib/platform";
import { getServerUrl, setServerUrl } from "@/lib/serverUrl";
import {
  getSettings,
  updateSettings,
  listApiTokens,
  createApiToken,
  deleteApiToken,
  type ApiToken,
  type CreatedApiToken,
} from "@/lib/api";
import {
  DEFAULT_PREFIX_BINDINGS,
  PREFIX_ACTION_DEFINITIONS,
  type PrefixActionId,
  formatPrefixBinding,
  getPrefixBindingConflict,
  loadPrefixBindings,
  normalizePrefixKey,
  resetPrefixBindings,
  savePrefixBinding,
} from "@/lib/prefixKey";
import { ArrowLeft } from "lucide-react";

// Frontend build id stamped into index.html by the Docker build
// (window.__OFFDESK_BUILD__). "dev" when running unstamped (local dev).
function getFrontendBuildId(): string {
  if (typeof window === "undefined") return "dev";
  const id = (window as unknown as { __OFFDESK_BUILD__?: string })
    .__OFFDESK_BUILD__;
  return id || "dev";
}

// Native shell version (Tauri only), via the core app plugin. Direct
// __TAURI_INTERNALS__ invoke — Metro's dynamic import of @tauri-apps/api has
// been observed to resolve without reaching the native side.
async function getShellVersion(): Promise<string> {
  const internals = (
    window as unknown as {
      __TAURI_INTERNALS__?: {
        invoke: <T>(cmd: string) => Promise<T>;
      };
    }
  ).__TAURI_INTERNALS__;
  if (!internals?.invoke) throw new Error("no Tauri internals");
  return internals.invoke<string>("plugin:app|version");
}

// Common UI (proportional) fonts
const UI_FONTS = [
  "App Default",
  "System UI",
  "Nunito Variable",
  "Fredoka Variable",
  "Inter",
  "Roboto",
  "Segoe UI",
  "Helvetica Neue",
  "Arial",
  "SF Pro",
  "Noto Sans",
  "Open Sans",
  "Lato",
  "Source Sans Pro",
];

// Common monospace / terminal fonts
const TERMINAL_FONTS = [
  "Auto Detect",
  "Maple Mono NF CN",
  "Noto Sans Mono CJK SC",
  "JetBrains Mono",
  "Fira Code",
  "Cascadia Code",
  "Source Code Pro",
  "Inconsolata",
  "IBM Plex Mono",
  "Hack",
  "Ubuntu Mono",
  "Menlo",
  "Consolas",
  "Monaco",
  "Courier New",
];

interface QuickCommand {
  label: string;
  command: string;
}

interface SettingsPageProps {
  onClose: () => void;
}

// Reusable select with custom input fallback
function FontSelect({
  label,
  value,
  options,
  emptyLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  emptyLabel: string;
  onChange: (value: string) => void;
}) {
  const [custom, setCustom] = useState(false);
  const isCustom = custom || (value !== "" && !options.includes(value));

  if (isCustom) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-label={label}
          placeholder="Enter font name..."
          style={{
            flex: 1,
            background: colors.surface,
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            color: colors.foreground,
            padding: "8px 12px",
            fontSize: 13,
            outline: "none",
          }}
        />
        <button
          onClick={() => {
            setCustom(false);
            onChange("");
          }}
          style={{
            background: "none",
            border: `1px solid ${colors.border}`,
            borderRadius: 6,
            color: colors.foregroundSecondary,
            cursor: "pointer",
            padding: "8px 10px",
            fontSize: 12,
          }}
        >
          List
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
      <select
        aria-label={label}
        value={value || options[0]}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === options[0] ? "" : v);
        }}
        style={{
          flex: 1,
          background: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          color: colors.foreground,
          padding: "8px 12px",
          fontSize: 13,
          outline: "none",
          cursor: "pointer",
          appearance: "auto",
        }}
      >
        {options.map((opt) => (
          <option key={opt} value={opt}>
            {opt === options[0] ? emptyLabel : ["Nunito Variable", "Fredoka Variable", "JetBrains Mono"].includes(opt) ? `${opt} (included)` : opt}
          </option>
        ))}
      </select>
      <button
        onClick={() => setCustom(true)}
        title="Enter custom font name"
        style={{
          background: "none",
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          color: colors.foregroundSecondary,
          cursor: "pointer",
          padding: "8px 10px",
          fontSize: 12,
        }}
      >
        Custom
      </button>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: colors.foregroundMuted,
        textTransform: "uppercase",
        letterSpacing: 1,
        marginBottom: 16,
        marginTop: 0,
      }}
    >
      {children}
    </h3>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          color: colors.foreground,
          marginBottom: description ? 2 : 8,
        }}
      >
        {label}
      </div>
      {description && (
        <div
          style={{
            fontSize: 11,
            color: colors.foregroundMuted,
            marginBottom: 8,
          }}
        >
          {description}
        </div>
      )}
      {children}
    </div>
  );
}

// Copy fallback for environments without the async clipboard API
// (e.g. Tauri WebViews, insecure contexts).
function fallbackCopyText(text: string) {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore */
  }
  document.body.removeChild(ta);
}

function formatTokenDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toISOString().slice(0, 10);
}

export function SettingsPage({ onClose }: SettingsPageProps) {
  const secureStatus = useSecureConnectionStatus();
  const { logout } = useAuth();
  const { theme, setTheme } = useTheme();
  // Terminal font settings
  const [terminalFont, setTerminalFont] = useState(
    () => localStorage.getItem("offdesk:terminal-font-family") || "",
  );
  const [terminalFontSize, setTerminalFontSize] = useState(
    () => localStorage.getItem("offdesk:terminal-font-size") || "",
  );

  // UI font settings
  const [uiFont, setUiFont] = useState(
    () => localStorage.getItem("offdesk:ui-font-family") || "",
  );
  const [uiFontSize, setUiFontSize] = useState(
    () => localStorage.getItem("offdesk:ui-font-size") || "",
  );

  // Quick commands
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [quickCommandsLoaded, setQuickCommandsLoaded] = useState(false);

  // About: native shell version (Tauri only; null = not applicable)
  const [shellVersion, setShellVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    getShellVersion()
      .then((v) => {
        if (!cancelled) setShellVersion(v);
      })
      .catch((err) => {
        if (!cancelled) setShellVersion(`unavailable (${String(err)})`);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // API tokens
  const [apiTokens, setApiTokens] = useState<ApiToken[]>([]);
  const [apiTokensLoaded, setApiTokensLoaded] = useState(false);
  const [apiTokensError, setApiTokensError] = useState<string | null>(null);
  const [newTokenName, setNewTokenName] = useState("");
  const [createdToken, setCreatedToken] = useState<CreatedApiToken | null>(
    null,
  );
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  const deleteConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // Server URL (desktop only)
  const [serverUrl, setServerUrlState] = useState(() => getServerUrl());
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [prefixBindings, setPrefixBindings] = useState(() =>
    loadPrefixBindings(),
  );
  const [recordingAction, setRecordingAction] = useState<PrefixActionId | null>(
    null,
  );
  const [bindingConflict, setBindingConflict] = useState<string | null>(null);

  // Load quick commands
  useEffect(() => {
    getSettings()
      .then((res) => {
        try {
          const cmds = JSON.parse(res.settings.quick_commands || "[]");
          setQuickCommands(cmds);
        } catch {
          /* ignore */
        }
        setQuickCommandsLoaded(true);
      })
      .catch(() => setQuickCommandsLoaded(true));
  }, []);

  // Load API tokens
  useEffect(() => {
    listApiTokens()
      .then((tokens) => {
        setApiTokens(tokens);
        setApiTokensLoaded(true);
      })
      .catch((err) => {
        setApiTokensError(
          `Failed to load tokens: ${err instanceof Error ? err.message : String(err)}`,
        );
        setApiTokensLoaded(true);
      });
  }, []);

  // Clear pending delete-confirm timer on unmount
  useEffect(
    () => () => {
      if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
    },
    [],
  );

  // Save terminal font
  const handleTerminalFontChange = useCallback((value: string) => {
    setTerminalFont(value);
    if (value) {
      localStorage.setItem("offdesk:terminal-font-family", value);
    } else {
      localStorage.removeItem("offdesk:terminal-font-family");
    }
    notifyFontPreferencesChanged();
  }, []);

  const handleTerminalFontSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setTerminalFontSize(v);
      const size = parseInt(v, 10);
      if (size >= 10 && size <= 24) {
        localStorage.setItem("offdesk:terminal-font-size", String(size));
      } else if (!v) {
        localStorage.removeItem("offdesk:terminal-font-size");
      }
      notifyFontPreferencesChanged();
    },
    [],
  );

  // Save UI font
  const handleUiFontChange = useCallback((value: string) => {
    setUiFont(value);
    if (value) {
      localStorage.setItem("offdesk:ui-font-family", value);
    } else {
      localStorage.removeItem("offdesk:ui-font-family");
    }
    notifyFontPreferencesChanged();
  }, []);

  const handleUiFontSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value;
      setUiFontSize(v);
      const size = parseInt(v, 10);
      if (size >= 10 && size <= 20) {
        localStorage.setItem("offdesk:ui-font-size", String(size));
      } else if (!v) {
        localStorage.removeItem("offdesk:ui-font-size");
      }
      notifyFontPreferencesChanged();
    },
    [],
  );

  // Quick commands
  const saveQuickCommands = useCallback((cmds: QuickCommand[]) => {
    setQuickCommands(cmds);
    updateSettings({ quick_commands: JSON.stringify(cmds) });
  }, []);

  const handleAddCommand = useCallback(() => {
    saveQuickCommands([...quickCommands, { label: "", command: "" }]);
  }, [quickCommands, saveQuickCommands]);

  const handleRemoveCommand = useCallback(
    (index: number) => {
      saveQuickCommands(quickCommands.filter((_, i) => i !== index));
    },
    [quickCommands, saveQuickCommands],
  );

  const handleUpdateCommand = useCallback(
    (index: number, field: "label" | "command", value: string) => {
      const updated = quickCommands.map((cmd, i) =>
        i === index ? { ...cmd, [field]: value } : cmd,
      );
      setQuickCommands(updated);
    },
    [quickCommands],
  );

  const handleBlurSaveCommands = useCallback(() => {
    saveQuickCommands(quickCommands);
  }, [quickCommands, saveQuickCommands]);

  // API tokens
  const handleCreateToken = useCallback(() => {
    const name = newTokenName.trim();
    if (!name) return;
    setApiTokensError(null);
    createApiToken(name)
      .then((created) => {
        setCreatedToken(created);
        setNewTokenName("");
        setApiTokens((tokens) => [
          {
            id: created.id,
            name: created.name,
            created_at: created.created_at,
            last_used_at: null,
            expires_at: null,
          },
          ...tokens,
        ]);
      })
      .catch((err) =>
        setApiTokensError(
          `Failed to create token: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [newTokenName]);

  const handleDeleteToken = useCallback(
    (id: string) => {
      if (confirmingDeleteId !== id) {
        setConfirmingDeleteId(id);
        if (deleteConfirmTimer.current)
          clearTimeout(deleteConfirmTimer.current);
        deleteConfirmTimer.current = setTimeout(
          () => setConfirmingDeleteId(null),
          3000,
        );
        return;
      }
      if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
      setConfirmingDeleteId(null);
      setApiTokensError(null);
      deleteApiToken(id)
        .then(() =>
          setApiTokens((tokens) => tokens.filter((t) => t.id !== id)),
        )
        .catch((err) =>
          setApiTokensError(
            `Failed to delete token: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    },
    [confirmingDeleteId],
  );

  const handleDeleteConfirmBlur = useCallback(() => {
    if (deleteConfirmTimer.current) clearTimeout(deleteConfirmTimer.current);
    setConfirmingDeleteId(null);
  }, []);

  const handleCopyCreatedToken = useCallback(() => {
    if (!createdToken) return;
    const text = createdToken.token;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopyText(text));
    } else {
      fallbackCopyText(text);
    }
  }, [createdToken]);

  // Server URL
  const handleServerUrlSave = useCallback(async () => {
    try {
      const parsed = new URL(serverUrl.trim());
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("Enter an http:// or https:// hub address without sign-in credentials.");
      }
      const next = parsed.toString().replace(/\/+$/, "");
      if (next === getServerUrl()) return;
      // A saved login belongs to the old hub. Never send it to the new one.
      await logout();
      setServerUrl(next);
      window.location.reload();
    } catch (e) {
      setServerUrlError(e instanceof TypeError ? "Enter a valid http:// or https:// hub address." : String(e));
    }
  }, [serverUrl, logout]);

  // The mobile app is pointed at one hub at a time. Letting go of it drops
  // the app back to its own setup screen, where the next address is typed by
  // hand — this page is served by a hub, and a hub does not get to choose the
  // next one.
  const { switchHub: handleSwitchHub, switching: switchingHub, error: switchHubError } = useMobileHubSwitch();

  const handlePrefixRecordKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (!recordingAction) return;
      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setRecordingAction(null);
        setBindingConflict(null);
        return;
      }

      if (event.key === "Backspace" || event.key === "Delete") {
        const next = savePrefixBinding(
          recordingAction,
          DEFAULT_PREFIX_BINDINGS[recordingAction],
        );
        setPrefixBindings(next);
        setRecordingAction(null);
        setBindingConflict(null);
        return;
      }

      // Single-key capture: the prefix (⌃B) is fixed, only the second key is
      // recorded. Modifier-only presses keep the recorder waiting.
      const key = normalizePrefixKey(event.key);
      if (!key) return;
      const conflict = getPrefixBindingConflict(
        recordingAction,
        key,
        prefixBindings,
      );
      if (conflict) {
        const conflictLabel =
          PREFIX_ACTION_DEFINITIONS.find(
            (definition) => definition.id === conflict,
          )?.label ?? "another action";
        setBindingConflict(`Already used by ${conflictLabel}`);
        return;
      }
      const next = savePrefixBinding(recordingAction, key);
      setPrefixBindings(next);
      setRecordingAction(null);
      setBindingConflict(null);
    },
    [recordingAction, prefixBindings],
  );

  const handleResetBinding = useCallback((id: PrefixActionId) => {
    const next = savePrefixBinding(id, DEFAULT_PREFIX_BINDINGS[id]);
    setPrefixBindings(next);
    setRecordingAction(null);
    setBindingConflict(null);
  }, []);

  const handleResetAllBindings = useCallback(() => {
    setPrefixBindings(resetPrefixBindings());
    setRecordingAction(null);
    setBindingConflict(null);
  }, []);

  const inputStyle: React.CSSProperties = {
    background: colors.surface,
    border: `1px solid ${colors.border}`,
    borderRadius: 6,
    color: colors.foreground,
    padding: "8px 12px",
    fontSize: 13,
    outline: "none",
    width: 80,
  };

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        background: colors.background,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "16px 24px",
          borderBottom: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: colors.foregroundSecondary,
            cursor: "pointer",
            padding: 4,
            display: "flex",
            alignItems: "center",
          }}
          title="Back"
        >
          <ArrowLeft size={18} />
        </button>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            color: colors.foreground,
            margin: 0,
          }}
        >
          Settings
        </h2>
      </div>

      {/* Content */}
      <div
        style={{
          flex: 1,
          overflow: "auto",
          padding: "24px 24px 48px",
          maxWidth: 560,
        }}
      >
        {/* Appearance Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Appearance</SectionTitle>

          <SettingRow label="Theme" description="Saved on this device. Terminal colors stay the same.">
            <div role="group" aria-label="Theme" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {([
                ["light", "Light"],
                ["dark", "Dark"],
                ["system", "System"],
              ] as const).map(([value, label]: readonly [Theme, string]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={theme === value}
                  onClick={() => setTheme(value)}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    padding: "10px 16px",
                    borderRadius: 8,
                    border: `1px solid ${theme === value ? colors.accent : colors.border}`,
                    background: theme === value ? colorAlpha.accentSoft : colors.surface,
                    color: theme === value ? colors.accent : colors.foregroundSecondary,
                    font: "inherit",
                    fontSize: 13,
                    fontWeight: theme === value ? 700 : 500,
                    cursor: "pointer",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </SettingRow>

          <SettingRow
            label="UI Font"
            description="Applies immediately to the interface. Included fonts work on every device; other fonts must be installed locally."
          >
            <FontSelect
              label="UI Font"
              value={uiFont}
              options={UI_FONTS}
              emptyLabel="App Default"
              onChange={handleUiFontChange}
            />
          </SettingRow>

          <SettingRow label="UI Font Size">
            <input
              type="number"
              value={uiFontSize}
              onChange={handleUiFontSizeChange}
              placeholder="14"
              min={10}
              max={20}
              style={inputStyle}
            />
          </SettingRow>
        </section>

        {/* Terminal Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Terminal</SectionTitle>

          <SettingRow
            label="Terminal Font"
            description="Applies to open terminals immediately. JetBrains Mono is included; other fonts must be installed on this device. Chinese characters use a system fallback."
          >
            <FontSelect
              label="Terminal Font"
              value={terminalFont}
              options={TERMINAL_FONTS}
              emptyLabel="Auto Detect"
              onChange={handleTerminalFontChange}
            />
          </SettingRow>

          <SettingRow label="Terminal Font Size">
            <input
              type="number"
              aria-label="Terminal Font Size"
              value={terminalFontSize}
              onChange={handleTerminalFontSizeChange}
              placeholder="14"
              min={10}
              max={24}
              style={inputStyle}
            />
          </SettingRow>

        </section>

        {/* Prefix Shortcuts Section */}
        <section style={{ marginBottom: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <SectionTitle>Prefix Shortcuts</SectionTitle>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={handleResetAllBindings}
              style={{
                background: "none",
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                color: colors.foregroundSecondary,
                cursor: "pointer",
                padding: "6px 10px",
                fontSize: 12,
              }}
            >
              Reset all
            </button>
          </div>
          <div
            style={{
              fontSize: 11,
              color: colors.foregroundMuted,
              marginBottom: 12,
            }}
          >
            Every shortcut starts with the fixed prefix ⌃B (Ctrl+B); all other
            keys pass through to the terminal. Click a key, then press the new
            second key. Backspace restores the default.
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {PREFIX_ACTION_DEFINITIONS.map((action) => {
              const recording = recordingAction === action.id;
              return (
                <div
                  key={action.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) minmax(110px, auto) 58px",
                    alignItems: "center",
                    gap: 8,
                  }}
                >
                  <div
                    style={{
                      minWidth: 0,
                      fontSize: 13,
                      color: colors.foreground,
                    }}
                  >
                    {action.label}
                  </div>
                  <button
                    type="button"
                    data-testid={`prefix-binding-recorder-${action.id}`}
                    onClick={() => {
                      setRecordingAction(action.id);
                      setBindingConflict(null);
                    }}
                    onKeyDown={handlePrefixRecordKeyDown}
                    style={{
                      minHeight: 32,
                      borderRadius: 6,
                      border: `1px solid ${
                        recording ? colors.accent : colors.border
                      }`,
                      background: recording ? colorAlpha.accentSoft : colors.surface,
                      color: recording
                        ? colors.accent
                        : colors.foregroundSecondary,
                      cursor: "pointer",
                      padding: "6px 10px",
                      fontSize: 12,
                      fontFamily: "var(--font-mono)",
                      textAlign: "center",
                    }}
                  >
                    {recording
                      ? "⌃B + key..."
                      : formatPrefixBinding(action.id, prefixBindings)}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResetBinding(action.id)}
                    style={{
                      background: "none",
                      border: "none",
                      color: colors.foregroundMuted,
                      cursor: "pointer",
                      padding: "6px 4px",
                      fontSize: 12,
                    }}
                  >
                    Reset
                  </button>
                </div>
              );
            })}
          </div>
          {bindingConflict && (
            <div
              data-testid="prefix-binding-conflict"
              style={{
                marginTop: 10,
                fontSize: 12,
                color: colors.danger,
              }}
            >
              {bindingConflict}
            </div>
          )}
        </section>

        {/* Quick Commands Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Quick Commands</SectionTitle>
          <div
            style={{
              fontSize: 11,
              color: colors.foregroundMuted,
              marginBottom: 12,
            }}
          >
            Shortcuts shown under each bookmark for quick terminal launch
          </div>

          {quickCommandsLoaded &&
            quickCommands.map((cmd, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  marginBottom: 8,
                  alignItems: "center",
                }}
              >
                <input
                  type="text"
                  value={cmd.label}
                  onChange={(e) =>
                    handleUpdateCommand(i, "label", e.target.value)
                  }
                  onBlur={handleBlurSaveCommands}
                  placeholder="Label"
                  style={{ ...inputStyle, width: 80 }}
                />
                <input
                  type="text"
                  value={cmd.command}
                  onChange={(e) =>
                    handleUpdateCommand(i, "command", e.target.value)
                  }
                  onBlur={handleBlurSaveCommands}
                  placeholder="Command"
                  style={{ ...inputStyle, flex: 1, width: "auto" }}
                />
                <button
                  onClick={() => handleRemoveCommand(i)}
                  style={{
                    background: "none",
                    border: "none",
                    color: colors.foregroundMuted,
                    cursor: "pointer",
                    padding: "4px 6px",
                    fontSize: 14,
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
          <button
            onClick={handleAddCommand}
            style={{
              background: "none",
              border: `1px dashed ${colors.border}`,
              borderRadius: 6,
              color: colors.foregroundMuted,
              cursor: "pointer",
              padding: "8px 16px",
              fontSize: 12,
              width: "100%",
            }}
          >
            + Add command
          </button>
        </section>

        {!isTauriMobile() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>Mobile app</SectionTitle>
            <MobileAppPanel />
          </section>
        )}

        {/* Which hub the mobile app opens — mobile app only */}
        {isTauriMobile() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>Hub</SectionTitle>

            <SettingRow
              label="Connected hub"
              description="This app opens one hub. Switching returns to the setup screen."
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span
                  style={{
                    flex: 1,
                    fontSize: 13,
                    color: colors.foreground,
                    overflowWrap: "anywhere",
                  }}
                >
                  {secureStatus?.endpoint.hub_url ?? (typeof window !== "undefined" ? window.location.origin : "")}
                </span>
                <button
                  onClick={() => void handleSwitchHub()}
                  disabled={switchingHub}
                  style={{
                    background: "none",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    color: colors.foreground,
                    cursor: "pointer",
                    padding: "8px 16px",
                    fontSize: 13,
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {switchingHub ? "Switching…" : "Switch hub"}
                </button>
              </div>
            </SettingRow>
            {switchHubError && <p role="alert" style={{ color: colors.err, fontSize: 13, margin: "8px 0 0" }}>{switchHubError}</p>}
          </section>
        )}

        {isSecureConnection() && <section style={{ marginBottom: 32 }}><ConnectionRoutesPanel /></section>}

        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Encrypted devices</SectionTitle>
          <SecureDevicesPanel />
        </section>

        {/* This machine — the desktop app's role, and the hub when it is one */}
        {isTauri() && !isTauriMobile() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>This machine</SectionTitle>
            <ThisMachineSection />
          </section>
        )}

        {/* Connection Section — Tauri desktop only */}
        {isTauri() && !isTauriMobile() && !isSecureConnection() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>Connection</SectionTitle>

            <SettingRow
              label="Server URL"
              description="Changing hubs signs this app out. Paste an http:// or https:// address."
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  aria-label="Server URL"
                  value={serverUrl}
                  onChange={(e) => { setServerUrlState(e.target.value); setServerUrlError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleServerUrlSave();
                  }}
                  placeholder="https://your-server:4317"
                  style={{ ...inputStyle, flex: 1, width: "auto" }}
                />
                <button
                  onClick={handleServerUrlSave}
                  style={{
                    background: colors.accent,
                    border: "none",
                    borderRadius: 6,
                    color: colors.onAccent,
                    cursor: "pointer",
                    padding: "8px 16px",
                    fontSize: 13,
                    fontWeight: 500,
                  }}
                >
                  Save
                </button>
              </div>
            </SettingRow>
            {serverUrlError && <div role="alert" style={{ color: colors.err, fontSize: 12 }}>{serverUrlError}</div>}
          </section>
        )}

        {/* API Tokens Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>API Tokens</SectionTitle>
          <div
            style={{
              fontSize: 11,
              color: colors.foregroundMuted,
              marginBottom: 12,
            }}
          >
            Tokens (odk_…) used to authenticate the offdesk CLI
          </div>

          {/* Create */}
          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "center",
              marginBottom: 16,
            }}
          >
            <input
              type="text"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreateToken();
              }}
              placeholder="Token name (e.g. cli)"
              style={{ ...inputStyle, flex: 1, width: "auto" }}
            />
            <button
              onClick={handleCreateToken}
              disabled={!newTokenName.trim()}
              style={{
                background: colors.accent,
                border: "none",
                borderRadius: 6,
                color: colors.onAccent,
                cursor: newTokenName.trim() ? "pointer" : "default",
                opacity: newTokenName.trim() ? 1 : 0.5,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Create
            </button>
          </div>

          {/* Newly created token — shown once */}
          {createdToken && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
              }}
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="text"
                  readOnly
                  value={createdToken.token}
                  onFocus={(e) => e.target.select()}
                  style={{
                    ...inputStyle,
                    flex: 1,
                    width: "auto",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={handleCopyCreatedToken}
                  style={{
                    background: "none",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    color: colors.foregroundSecondary,
                    cursor: "pointer",
                    padding: "8px 12px",
                    fontSize: 12,
                  }}
                >
                  Copy
                </button>
                <button
                  onClick={() => setCreatedToken(null)}
                  style={{
                    background: "none",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 6,
                    color: colors.foregroundSecondary,
                    cursor: "pointer",
                    padding: "8px 12px",
                    fontSize: 12,
                  }}
                >
                  Done
                </button>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: colors.foregroundMuted,
                  marginTop: 8,
                }}
              >
                Copy it now — it won't be shown again.
              </div>
            </div>
          )}

          {/* Token list */}
          {!apiTokensLoaded ? (
            <div style={{ fontSize: 12, color: colors.foregroundMuted }}>
              Loading…
            </div>
          ) : apiTokens.length === 0 ? (
            <div style={{ fontSize: 12, color: colors.foregroundMuted }}>
              No tokens yet.
            </div>
          ) : (
            apiTokens.map((token) => {
              const confirming = confirmingDeleteId === token.id;
              return (
                <div
                  key={token.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, color: colors.foreground }}>
                      {token.name}
                    </div>
                    <div
                      style={{ fontSize: 11, color: colors.foregroundMuted }}
                    >
                      created {formatTokenDate(token.created_at)} · last used{" "}
                      {formatTokenDate(token.last_used_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => handleDeleteToken(token.id)}
                    onBlur={handleDeleteConfirmBlur}
                    style={{
                      background: "none",
                      border: `1px solid ${confirming ? colors.danger : colors.border}`,
                      borderRadius: 6,
                      color: confirming
                        ? colors.danger
                        : colors.foregroundSecondary,
                      cursor: "pointer",
                      padding: "6px 10px",
                      fontSize: 12,
                    }}
                  >
                    {confirming ? "Confirm?" : "Delete"}
                  </button>
                </div>
              );
            })
          )}

          {apiTokensError && (
            <div
              style={{
                marginTop: 10,
                fontSize: 12,
                color: colors.danger,
              }}
            >
              {apiTokensError}
            </div>
          )}
        </section>

        {/* About Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>About</SectionTitle>
          <div
            style={{
              fontSize: 12,
              color: colors.foregroundSecondary,
              fontFamily: "monospace",
              lineHeight: 1.8,
              userSelect: "text",
            }}
          >
            <div>Frontend build: {getFrontendBuildId()}</div>
            {isTauri() && (
              <div>Shell version: {shellVersion ?? "loading…"}</div>
            )}
          </div>
          <UpdateNotification inline />
        </section>

        {/* Reload notice */}
        <div
          style={{
            fontSize: 11,
            color: colors.foregroundMuted,
            marginTop: 8,
          }}
        >
          Font changes are saved on this device and apply without reloading.
        </div>
      </div>
    </div>
  );
}
