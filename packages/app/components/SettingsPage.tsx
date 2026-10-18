import { UiUpdateNotification } from "./UiUpdateNotification";
import { KeyBarSettings } from "./KeyBarSettings";
import { HubPickerPanel } from "./HubPickerPanel";
import { notifyFontPreferencesChanged } from "@/lib/fontPreferences";
import { BUNDLED_TERMINAL_FONTS, BUNDLED_UI_FONTS, DEFAULT_TERMINAL_FONT, availableTerminalFonts, availableUiFonts, resolveTerminalFontFamily } from "@/lib/terminalFonts";
import { SecureDevicesPanel } from "./SecureConnectionPanel";
import { WebhooksPanel } from "./WebhooksPanel";
import { BridgesPanel, TokenActivityPanel } from "./BridgesPanel";
import { isSecureConnection, useSecureConnectionStatus } from "../lib/secureTransport";
import { useState, useCallback, useEffect, useRef } from "react";
import { colors, colorAlpha } from "@/lib/colors";
import { useMobileHubSwitch } from "@/lib/useMobileHubSwitch";
import { FollowSystem, ThemeGrid } from "./ThemePicker";
import { MobileAppPanel } from "./MobileAppPanel.web";
import { ThisMachineSection } from "./DesktopSetup.web";
import { VersionsPanel } from "./VersionsPanel";
import { AndroidUpdateNotification } from "./AndroidUpdateNotification";
import { useAuth } from "@/lib/auth";
import { isTauri, isTauriMobile } from "@/lib/platform";
import { getServerUrl, setServerUrl } from "@/lib/serverUrl";
import { useDesktopUpdate } from "@/lib/desktopUpdate";
import { useBundledServices } from "@/lib/bundledServices";
import { subscribeOpenSettings, takeRequestedSection } from "@/lib/openSettings";
import { hostOf, partsBehind, useVersions } from "@/lib/hubVersions";
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
  CONTENT_LEVELS,
  RUN_SCOPES,
  accessFromForm,
  defaultTokenAccessForm,
  describeAccess,
  type TokenAccessForm,
} from "@/lib/tokenAccess";
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
import { rem } from "@/lib/rem";

// Frontend build id stamped into index.html by release builds
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

// The font lists: what ships with the app, then what this device has
// (lib/terminalFonts.ts), so no choice silently falls back to the default.
const INCLUDED_FONTS = new Set([...BUNDLED_TERMINAL_FONTS, ...BUNDLED_UI_FONTS.filter((font) => font !== "System UI")]);
const uiFontOptions = () => ["App Default", ...availableUiFonts()];
const terminalFontOptions = () => ["App Default", ...availableTerminalFonts().filter((font) => font !== DEFAULT_TERMINAL_FONT)];

interface QuickCommand {
  label: string;
  command: string;
}

interface SettingsPageProps {
  onClose: () => void;
}

// Reusable select with custom input fallback
const CUSTOM_FONT = "__custom__";

// A compact select (`app default ▾`); "custom font…" inside it switches to a
// text field for any installed font, with `list` to go back.
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
          placeholder="font name"
          autoFocus
          style={{ ...compactControl, width: 180, cursor: "text" }}
        />
        <button
          type="button"
          className="odk-text-btn"
          onClick={() => {
            setCustom(false);
            onChange("");
          }}
        >
          list
        </button>
      </div>
    );
  }

  return (
    <select
      aria-label={label}
      value={value || options[0]}
      onChange={(e) => {
        const v = e.target.value;
        if (v === CUSTOM_FONT) { setCustom(true); return; }
        onChange(v === options[0] ? "" : v);
      }}
      style={{ ...compactControl, width: "auto", maxWidth: 240 }}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {opt === options[0] ? emptyLabel.toLowerCase() : INCLUDED_FONTS.has(opt) ? `${opt} (included)` : opt}
        </option>
      ))}
      <option value={CUSTOM_FONT}>custom font…</option>
    </select>
  );
}

// D09's compact control: 30px, the control edge, a ▾ drawn in.
const compactControl: React.CSSProperties = {
  boxSizing: "border-box",
  height: 32,
  padding: "0 28px 0 12px",
  border: `1px solid ${colors.line}`,
  borderRadius: 4,
  background: `${colors.bg1} url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%238f8d87' stroke-width='1.5'/%3E%3C/svg%3E") no-repeat right 10px center`,
  color: colors.fg0,
  fontFamily: "var(--font-display)",
  fontSize: rem(12.5),
  appearance: "none",
  WebkitAppearance: "none",
  outline: "none",
  cursor: "pointer",
};

export function sectionId(title: string): string {
  return `settings-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** `behind`: parts behind, which the nav shows beside the title ("2 ↑"). */
function SectionTitle({ children, behind }: { children: React.ReactNode; behind?: number }) {
  const title = typeof children === "string" ? children : "";
  return (
    <h2
      id={title ? sectionId(title) : undefined}
      data-nav-behind={behind || undefined}
      style={{
        fontFamily: "var(--font-display)",
        fontSize: rem(20),
        lineHeight: rem(26),
        fontWeight: 600,
        letterSpacing: "-0.02em",
        color: colors.fg0,
        marginBottom: 12,
        marginTop: 0,
        scrollMarginTop: 24,
      }}
    >
      {children}
    </h2>
  );
}

function SettingRow({
  label,
  description,
  stacked = false,
  children,
}: {
  label: string;
  description?: string;
  /** Wide controls (an address field) go under the label instead. */
  stacked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: stacked ? "column" : "row",
        alignItems: stacked ? "stretch" : "center",
        justifyContent: "space-between",
        flexWrap: stacked ? "nowrap" : "wrap",
        gap: stacked ? 8 : "8px 24px",
        padding: "12px 0",
        borderBottom: `1px solid ${colors.lineSoft}`,
      }}
    >
      <div style={{ minWidth: 0, flex: stacked ? "none" : "1 1 240px" }}>
        <div
          style={{
            fontFamily: "var(--font-display)",
            fontSize: rem(14),
            color: colors.fg0,
            textTransform: "lowercase",
          }}
        >
          {label}
        </div>
        {description && (
          <div
            style={{
              marginTop: 4,
              fontFamily: "var(--font-sans)",
              fontSize: rem(12),
              lineHeight: rem(18),
              color: colors.fg3,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <div style={{ flexShrink: 0, minWidth: 0, display: "flex", justifyContent: stacked ? "stretch" : "flex-end" }}>{children}</div>
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
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let frame = 0;
    const revealFocusedInput = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const field = document.activeElement;
        if (!(field instanceof HTMLElement) || !content.contains(field) ||
            !field.matches("input, textarea, select, [contenteditable=true]")) return;
        const bounds = content.getBoundingClientRect();
        const rect = field.getBoundingClientRect();
        // The keyboard (including its accessory bar) shrinks this scroller
        // after focus. Scroll only its contents, never the whole app chrome.
        if (rect.bottom > bounds.bottom - 12) content.scrollTop += rect.bottom - bounds.bottom + 12;
        else if (rect.top < bounds.top + 12) content.scrollTop += rect.top - bounds.top - 12;
      });
    };
    const observer = new ResizeObserver(revealFocusedInput);
    observer.observe(content);
    content.addEventListener("focusin", revealFocusedInput);
    return () => {
      observer.disconnect();
      content.removeEventListener("focusin", revealFocusedInput);
      cancelAnimationFrame(frame);
    };
  }, []);
  const secureStatus = useSecureConnectionStatus();
  const { logout } = useAuth();
  // Terminal font settings
  // Measured once per visit to Settings: which listed fonts this device draws.
  const [uiFonts] = useState(uiFontOptions);
  const [terminalFonts] = useState(terminalFontOptions);
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
  const [tokenForm, setTokenForm] = useState<TokenAccessForm>(
    defaultTokenAccessForm,
  );
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
    const { access, error } = accessFromForm(tokenForm);
    if (error) {
      setApiTokensError(error);
      return;
    }
    setApiTokensError(null);
    createApiToken(name, access)
      .then((created) => {
        setCreatedToken(created);
        setNewTokenName("");
        setTokenForm(defaultTokenAccessForm());
        setApiTokens((tokens) => [
          {
            id: created.id,
            name: created.name,
            created_at: created.created_at,
            last_used_at: null,
            expires_at: null,
            access: created.access ?? null,
          },
          ...tokens,
        ]);
      })
      .catch((err) =>
        setApiTokensError(
          `Failed to create token: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
  }, [newTokenName, tokenForm]);

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
  const [phonePanelVersion, setPhonePanelVersion] = useState(0);
  const phonePanelRef = useRef<HTMLElement | null>(null);
  const showPhonePairing = () => {
    setPhonePanelVersion(version => version + 1);
    requestAnimationFrame(() => phonePanelRef.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  };
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

  const wideSettings = useMinWidth(900);
  // The sections the nav lists, in page order, as their titles read, with
  // any count a section shows there.
  const [navSections, setNavSections] = useState<NavSection[]>([]);
  useEffect(() => {
    const root = contentRef.current;
    if (!root) return;
    const read = () => {
      const sections = Array.from(root.querySelectorAll<HTMLHeadingElement>("h2[id^='settings-']"), (h) => ({ title: h.textContent ?? "", behind: Number(h.dataset.navBehind) || 0 })).filter((section) => section.title);
      const key = (list: NavSection[]) => list.map((section) => `${section.title}:${section.behind}`).join("|");
      setNavSections((previous) => (key(previous) === key(sections) ? previous : sections));
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-nav-behind"] });
    return () => observer.disconnect();
  }, []);

  // Opened for one section (the update card's "what's new", the phone
  // panel's "versions ›"): scroll to it once it has rendered.
  useEffect(() => {
    const reveal = (section: string | null) => {
      if (!section) return;
      let tries = 0;
      const attempt = () => {
        const heading = document.getElementById(sectionId(section));
        if (heading) heading.scrollIntoView({ block: "start" });
        else if (++tries < 20) setTimeout(attempt, 50);
      };
      attempt();
    };
    reveal(takeRequestedSection());
    return subscribeOpenSettings((section) => {
      takeRequestedSection();
      reveal(section);
    });
  }, []);

  // Settings › versions: how many parts are behind, for the nav.
  const versions = useVersions();
  const desktopUpdate = useDesktopUpdate();
  const services = useBundledServices();
  const behind = partsBehind(desktopUpdate.available, versions.hub, versions.nodes, services?.bundled ? services : null);
  const hubAddress = hostOf(secureStatus?.endpoint.hub_url || getServerUrl() || (typeof window === "undefined" ? "" : window.location.origin));

  const inputStyle: React.CSSProperties = {
    background: colors.bg1,
    border: `1px solid ${colors.line}`,
    borderRadius: 4,
    color: colors.fg0,
    padding: "8px 12px",
    fontFamily: "var(--font-display)",
    fontSize: rem(13),
    outline: "none",
    width: 80,
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
        background: colors.background,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* D09: a thin bar with the way back; the title lives with the nav. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          minHeight: 40,
          padding: "0 16px",
          background: colors.bg1,
          borderBottom: `1px solid ${colors.lineSoft}`,
          flexShrink: 0,
        }}
      >
        <button
          onClick={onClose}
          className="odk-text-btn"
          style={{ fontSize: rem(12.5), color: colors.fg2 }}
          title="Back"
          aria-label="Back"
        >
          ← back to terminals
        </button>
      </div>

      {/* D09: the section nav as a full-height column at the window edge,
          the settings beside it, left-aligned. */}
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
      {wideSettings ? <SettingsNav wide sections={navSections} scroller={contentRef} /> : null}
      <div
        ref={contentRef}
        data-testid="settings-content"
        style={{
          flex: 1,
          overflow: "auto",
          minHeight: 0,
          minWidth: 0,
          // Keep headings clear of the pinned section bar when jumping.
          scrollPaddingTop: wideSettings ? 0 : NARROW_NAV_HEIGHT,
        }}
      >
        <div data-testid="settings-column" style={{ width: "100%", maxWidth: 736, padding: wideSettings ? "32px 48px 48px" : "24px 16px 48px", boxSizing: "border-box" }}>
        {!wideSettings ? <SettingsNav wide={false} sections={navSections} scroller={contentRef} /> : null}
        <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 0 }}>
        {/* Appearance Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Appearance</SectionTitle>

          <SettingRow label="Theme" description="Saved on this device. The terminal follows the theme." stacked>
            <ThemeGrid />
          </SettingRow>
          <SettingRow label="Follow the system" description="Switch between two themes when your device switches between light and dark." stacked>
            <FollowSystem />
          </SettingRow>

          <SettingRow
            label="Interface font"
            description="Applies immediately to the interface. Geist and Geist Mono come with the app; the others listed are installed on this device."
          >
            <FontSelect
              label="UI Font"
              value={uiFont}
              options={uiFonts}
              emptyLabel="App Default"
              onChange={handleUiFontChange}
            />
          </SettingRow>

          <SettingRow label="Interface text size">
            <label style={pxField}>
              <input
                type="number"
                aria-label="UI Font Size"
                value={uiFontSize}
                onChange={handleUiFontSizeChange}
                placeholder="14"
                min={10}
                max={20}
                style={pxInput}
              />
              px
            </label>
          </SettingRow>
        </section>

        {/* Terminal Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Terminal</SectionTitle>

          <SettingRow
            label="Terminal font"
            description="JetBrains Mono (the default), Geist Mono, Fira Code, IBM Plex Mono and Source Code Pro come with the app, so they look the same on every device; the others listed are installed on this one. Changes apply immediately; Chinese characters use a system fallback."
          >
            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <FontSelect
                label="Terminal Font"
                value={terminalFont}
                options={terminalFonts}
                emptyLabel="App Default"
                onChange={handleTerminalFontChange}
              />
              {/* A line in the chosen font, so the difference is visible here. */}
              <span
                data-testid="terminal-font-preview"
                style={{ fontFamily: resolveTerminalFontFamily(terminalFont), fontSize: rem(13), color: colors.fg1, whiteSpace: "nowrap" }}
              >
                0O 1lI {"{}[]"} =&gt; != -&gt; 中文
              </span>
            </div>
          </SettingRow>

          <SettingRow label="Terminal text size">
            <label style={pxField}>
              <input
                type="number"
                aria-label="Terminal Font Size"
                value={terminalFontSize}
                onChange={handleTerminalFontSizeChange}
                placeholder="14"
                min={10}
                max={24}
                style={pxInput}
              />
              px
            </label>
          </SettingRow>

        </section>

        <KeyBarSettings />

        {/* Shortcuts Section */}
        <section style={{ marginBottom: 32 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 16,
            }}
          >
            <SectionTitle>Shortcuts</SectionTitle>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              onClick={handleResetAllBindings}
              style={{
                background: "none",
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
                color: colors.foregroundSecondary,
                cursor: "pointer",
                padding: "6px 10px",
                fontSize: rem(12),
              }}
            >
              Reset all
            </button>
          </div>
          <div
            style={{
              fontSize: rem(11),
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
                      fontSize: rem(13),
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
                      borderRadius: 4,
                      border: `1px solid ${
                        recording ? colors.accent : colors.border
                      }`,
                      background: recording ? colorAlpha.accentSoft : colors.surface,
                      color: recording
                        ? colors.accent
                        : colors.foregroundSecondary,
                      cursor: "pointer",
                      padding: "6px 10px",
                      fontSize: rem(12),
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
                      fontSize: rem(12),
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
                fontSize: rem(12),
                color: colors.danger,
              }}
            >
              {bindingConflict}
            </div>
          )}
        </section>

        {/* Quick Commands Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Quick commands</SectionTitle>
          <div
            style={{
              fontSize: rem(11),
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
                    fontSize: rem(14),
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
              borderRadius: 4,
              color: colors.foregroundMuted,
              cursor: "pointer",
              padding: "8px 16px",
              fontSize: rem(12),
              width: "100%",
            }}
          >
            + Add command
          </button>
        </section>

        {!isTauriMobile() && (
          <section ref={phonePanelRef} style={{ marginBottom: 32 }}>
            <SectionTitle>Phone</SectionTitle>
            <MobileAppPanel key={phonePanelVersion} />
          </section>
        )}

        {/* Which hub the mobile app opens — mobile app only */}
        {isTauriMobile() && !isSecureConnection() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>Hubs & connections</SectionTitle>

            <SettingRow
              stacked
              label="Connected hub"
              description="This app opens one hub. Switching returns to the setup screen."
            >
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span
                  style={{
                    flex: 1,
                    fontSize: rem(13),
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
                    borderRadius: 4,
                    color: colors.foreground,
                    cursor: "pointer",
                    padding: "8px 16px",
                    fontSize: rem(13),
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {switchingHub ? "Switching…" : "Switch hub"}
                </button>
              </div>
            </SettingRow>
            {switchHubError && <p role="alert" style={{ color: colors.err, fontSize: rem(13), margin: "8px 0 0" }}>{switchHubError}</p>}
          </section>
        )}

        {isSecureConnection() && <section style={{ marginBottom: 32 }}><SectionTitle>Hubs & connections</SectionTitle><HubPickerPanel /></section>}

        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Encrypted devices</SectionTitle>
          <SecureDevicesPanel />
        </section>

        {/* This machine — the desktop app's role, and the hub when it is one */}
        {isTauri() && !isTauriMobile() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>This machine</SectionTitle>
            <ThisMachineSection onPairPhone={showPhonePairing} onConnectionChanged={() => setPhonePanelVersion(version => version + 1)} />
          </section>
        )}

        {/* Connection Section — Tauri desktop only */}
        {isTauri() && !isTauriMobile() && !isSecureConnection() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle>Connection</SectionTitle>

            <SettingRow
              stacked
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
                    background: colors.primary,
                    border: "none",
                    borderRadius: 4,
                    color: colors.onPrimary,
                    cursor: "pointer",
                    padding: "8px 16px",
                    fontSize: rem(13),
                    fontWeight: 500,
                  }}
                >
                  Save
                </button>
              </div>
            </SettingRow>
            {serverUrlError && <div role="alert" style={{ color: colors.err, fontSize: rem(12) }}>{serverUrlError}</div>}
          </section>
        )}

        {/* API Tokens Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>API tokens</SectionTitle>
          <div
            style={{
              fontSize: rem(11),
              color: colors.foregroundMuted,
              marginBottom: 12,
            }}
          >
            Tokens (odk_…) for the offdesk CLI and other programs. Give a
            program only what it needs: a token with full access can type
            into every terminal on every machine.
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
                background: colors.primary,
                border: "none",
                borderRadius: 4,
                color: colors.onPrimary,
                cursor: newTokenName.trim() ? "pointer" : "default",
                opacity: newTokenName.trim() ? 1 : 0.5,
                padding: "8px 16px",
                fontSize: rem(13),
                fontWeight: 500,
              }}
            >
              Create
            </button>
          </div>

          {/* What the new token may do */}
          <div
            role="group"
            aria-label="New token access"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 10,
              marginBottom: 16,
              padding: 12,
              border: `1px solid ${colors.border}`,
              borderRadius: 4,
              fontSize: rem(12),
              color: colors.foregroundSecondary,
            }}
          >
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
              {(
                [
                  ["runs", "Agent runs only"],
                  ["full", "Full access"],
                ] as const
              ).map(([kind, label]) => (
                <label
                  key={kind}
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    type="radio"
                    name="token-kind"
                    checked={tokenForm.kind === kind}
                    onChange={() => setTokenForm({ ...tokenForm, kind })}
                  />
                  <span
                    style={{
                      color:
                        kind === "full" ? colors.danger : colors.foreground,
                    }}
                  >
                    {label}
                  </span>
                </label>
              ))}
            </div>
            {tokenForm.kind === "full" ? (
              <div style={{ color: colors.danger }}>
                Terminals, input and machines: remote code execution on every
                machine. Use it for your own CLI only.
              </div>
            ) : (
              <>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  {RUN_SCOPES.map(({ scope, label }) => (
                    <label
                      key={scope}
                      style={{ display: "flex", gap: 6, alignItems: "center" }}
                    >
                      <input
                        type="checkbox"
                        checked={tokenForm.scopes.includes(scope)}
                        onChange={(e) =>
                          setTokenForm({
                            ...tokenForm,
                            scopes: e.target.checked
                              ? [...tokenForm.scopes, scope]
                              : tokenForm.scopes.filter((s) => s !== scope),
                          })
                        }
                      />
                      {label}
                    </label>
                  ))}
                </div>
                <label
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <span style={{ whiteSpace: "nowrap" }}>It sees</span>
                  <select
                    value={tokenForm.content}
                    onChange={(e) =>
                      setTokenForm({
                        ...tokenForm,
                        content: e.target.value as TokenAccessForm["content"],
                      })
                    }
                    style={{ ...inputStyle, width: "auto", padding: "4px 8px" }}
                  >
                    {CONTENT_LEVELS.map(({ level, label }) => (
                      <option key={level} value={level}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <span
                    style={{
                      color: colors.foregroundMuted,
                      whiteSpace: "nowrap",
                    }}
                  >
                    never terminal output
                  </span>
                </label>
                {tokenForm.scopes.includes("runs:start") && (
                  <label
                    style={{ display: "flex", flexDirection: "column", gap: 6 }}
                  >
                    Folders it may start agents in, one per line
                    <textarea
                      value={tokenForm.dirs}
                      onChange={(e) =>
                        setTokenForm({ ...tokenForm, dirs: e.target.value })
                      }
                      rows={2}
                      placeholder="~/work"
                      style={{
                        ...inputStyle,
                        fontFamily: "var(--font-mono)",
                        fontSize: rem(12),
                      }}
                    />
                  </label>
                )}
                <label
                  style={{ display: "flex", gap: 6, alignItems: "center" }}
                >
                  <input
                    type="checkbox"
                    checked={tokenForm.includeProduction}
                    onChange={(e) =>
                      setTokenForm({
                        ...tokenForm,
                        includeProduction: e.target.checked,
                      })
                    }
                  />
                  Production machines too
                </label>
              </>
            )}
          </div>

          {/* Newly created token — shown once */}
          {createdToken && (
            <div
              style={{
                marginBottom: 16,
                padding: 12,
                background: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: 4,
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
                    fontSize: rem(12),
                  }}
                />
                <button
                  onClick={handleCopyCreatedToken}
                  style={{
                    background: "none",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 4,
                    color: colors.foregroundSecondary,
                    cursor: "pointer",
                    padding: "8px 12px",
                    fontSize: rem(12),
                  }}
                >
                  Copy
                </button>
                <button
                  onClick={() => setCreatedToken(null)}
                  style={{
                    background: "none",
                    border: `1px solid ${colors.border}`,
                    borderRadius: 4,
                    color: colors.foregroundSecondary,
                    cursor: "pointer",
                    padding: "8px 12px",
                    fontSize: rem(12),
                  }}
                >
                  Done
                </button>
              </div>
              <div
                style={{
                  fontSize: rem(11),
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
            <div style={{ fontSize: rem(12), color: colors.foregroundMuted }}>
              Loading…
            </div>
          ) : apiTokens.length === 0 ? (
            <div style={{ fontSize: rem(12), color: colors.foregroundMuted }}>
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
                    <div style={{ fontSize: rem(13), color: colors.foreground }}>
                      {token.name}
                    </div>
                    <div
                      style={{
                        fontSize: rem(11),
                        color: token.access
                          ? colors.foregroundSecondary
                          : colors.danger,
                      }}
                    >
                      {describeAccess(token.access)}
                    </div>
                    <div
                      style={{ fontSize: rem(11), color: colors.foregroundMuted }}
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
                      borderRadius: 4,
                      color: confirming
                        ? colors.danger
                        : colors.foregroundSecondary,
                      cursor: "pointer",
                      padding: "6px 10px",
                      fontSize: rem(12),
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
                fontSize: rem(12),
                color: colors.danger,
              }}
            >
              {apiTokensError}
            </div>
          )}
        </section>

        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Webhooks</SectionTitle>
          <WebhooksPanel />
        </section>

        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Bridges</SectionTitle>
          <BridgesPanel />
        </section>

        <section style={{ marginBottom: 32 }}>
          <SectionTitle>Activity</SectionTitle>
          <TokenActivityPanel />
        </section>

        {/* Versions: the app, the hub, its interface and its nodes */}
        {!isTauriMobile() && (
          <section style={{ marginBottom: 32 }}>
            <SectionTitle behind={behind}>Versions</SectionTitle>
            <VersionsPanel hubAddress={hubAddress} />
          </section>
        )}

        {/* About Section */}
        <section style={{ marginBottom: 32 }}>
          <SectionTitle>About</SectionTitle>
          <div
            style={{
              fontSize: rem(12),
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
          <AndroidUpdateNotification inline />
          <UiUpdateNotification inline />
        </section>

        {/* Reload notice */}
        <div
          style={{
            fontSize: rem(11),
            color: colors.foregroundMuted,
            marginTop: 8,
          }}
        >
          Font changes are saved on this device and apply without reloading.
        </div>
        </div>
        </div>
      </div>
      </div>
    </div>
  );
}

/** D09's left column: ~ $ settings, the title, and the sections as lowercase
 *  links that scroll to them; the one in view is lime. On narrow windows
 *  only the title shows. */
interface NavSection {
  title: string;
  /** Parts behind, shown as "2 ↑" (versions). */
  behind: number;
}

/** Height of the narrow layout's pinned section bar. */
const NARROW_NAV_HEIGHT = 48;

function SettingsNav({ wide, sections, scroller }: {
  wide: boolean;
  sections: NavSection[];
  scroller: React.RefObject<HTMLDivElement | null>;
}) {
  const [current, setCurrent] = useState(sections[0]?.title ?? "");
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const update = () => {
      const top = root.getBoundingClientRect().top + 48 + (wide ? 0 : NARROW_NAV_HEIGHT);
      let active = sections[0]?.title ?? "";
      for (const { title } of sections) {
        const el = document.getElementById(sectionId(title));
        if (el && el.getBoundingClientRect().top <= top) active = title;
      }
      setCurrent(active);
    };
    update();
    root.addEventListener("scroll", update, { passive: true });
    return () => root.removeEventListener("scroll", update);
  }, [scroller, sections, wide]);
  // Narrow: keep the current section's link in view in the sideways bar.
  useEffect(() => {
    if (wide) return;
    const link = bar.current?.querySelector<HTMLElement>("[aria-current='true']");
    const row = bar.current;
    if (!link || !row) return;
    const left = link.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + link.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollTo({ left: left - 16, behavior: "smooth" });
    }
  }, [current, wide]);
  const heading = (
    <>
      <div style={{ margin: wide ? "0 12px 6px" : "0 0 6px", fontSize: rem(12), color: colors.fg3, fontFamily: "var(--font-display)" }}>
        <span aria-hidden="true" style={{ color: colors.accent }}>~</span> $ settings
      </div>
      <h1 style={{ margin: wide ? "0 12px 16px" : "0 0 12px", fontSize: rem(28), lineHeight: rem(34), fontWeight: 600, letterSpacing: "-0.035em", color: colors.fg0, fontFamily: "var(--font-display)" }}>Settings</h1>
    </>
  );
  const links = sections.map(({ title, behind }) => (
    <button
      aria-label={behind ? `${title}, ${behind} behind` : undefined}
      key={title}
      type="button"
      aria-current={title === current ? "true" : undefined}
      onClick={() => {
        document.getElementById(sectionId(title))?.scrollIntoView({ block: "start", behavior: "smooth" });
        setCurrent(title);
      }}
      style={{
        textAlign: "left",
        padding: wide ? "8px 12px" : "6px 10px",
        border: 0,
        borderRadius: 3,
        background: title === current ? colors.primary : "transparent",
        color: title === current ? colors.onPrimary : colors.fg2,
        fontFamily: "var(--font-display)",
        fontSize: rem(wide ? 13 : 12.5),
        fontWeight: title === current ? 600 : 400,
        textTransform: "lowercase",
        whiteSpace: "nowrap",
        flexShrink: 0,
        cursor: "pointer",
        display: "flex",
        gap: 8,
      }}
    >
      <span style={{ flex: 1 }}>{title}</span>
      {behind ? <span aria-hidden="true" style={{ color: title === current ? colors.onPrimary : colors.err }}>{behind} ↑</span> : null}
    </button>
  ));
  if (wide) {
    return (
      <nav
        aria-label="Settings sections"
        style={{ width: 240, flexShrink: 0, boxSizing: "border-box", overflowY: "auto", padding: "24px 12px", display: "flex", flexDirection: "column", gap: 2, background: colors.bg1, borderRight: `1px solid ${colors.lineSoft}`, fontFamily: "var(--font-display)" }}
      >
        {heading}
        {links}
      </nav>
    );
  }
  // Narrow (phones, unfolded foldables): the title, then the sections as one
  // row that scrolls sideways and stays pinned while the settings scroll.
  return (
    <>
      {heading}
      <nav
        aria-label="Settings sections"
        style={{ position: "sticky", top: 0, zIndex: 1, margin: "0 -16px 8px", background: colors.background, borderBottom: `1px solid ${colors.lineSoft}` }}
      >
        <div
          ref={bar}
          data-testid="settings-section-bar"
          style={{ height: NARROW_NAV_HEIGHT, boxSizing: "border-box", display: "flex", alignItems: "center", gap: 4, padding: "0 16px", overflowX: "auto", scrollbarWidth: "none" }}
        >
          {links}
        </div>
      </nav>
    </>
  );
}

function useMinWidth(width: number): boolean {
  const query = `(min-width: ${width}px)`;
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const pxField: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  height: 32,
  padding: "0 10px 0 4px",
  boxSizing: "border-box",
  border: `1px solid ${colors.line}`,
  borderRadius: 4,
  background: colors.bg1,
  color: colors.fg3,
  fontFamily: "var(--font-display)",
  fontSize: rem(12.5),
};

const pxInput: React.CSSProperties = {
  width: 44,
  border: 0,
  background: "transparent",
  color: colors.fg0,
  fontFamily: "var(--font-display)",
  fontSize: rem(12.5),
  textAlign: "right",
  outline: "none",
};
