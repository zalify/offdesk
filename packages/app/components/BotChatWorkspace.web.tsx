import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Hash,
  KeyRound,
  Play,
  Plus,
  Send,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { MachineInfo } from "@offdesk/shared";
import { DraftArtifactPreview } from "./DraftArtifactPreview.web";
import {
  cancelBotSession,
  createBotSession,
  createVaultSecret,
  deleteBotSession,
  deleteVaultSecret,
  getBotSessionEvents,
  listBotSessions,
  listChannelMessages,
  listChatChannels,
  listVaultSecrets,
  promptBotSession,
  resumeBotSession,
  revealVaultSecret,
  sendChannelMessage,
  type AgentMessageInfo,
  type BotAgentKind,
  type BotEventEntry,
  type BotSessionInfo,
  type VaultCategory,
  type VaultSecretSummary,
} from "@/lib/api";
import { colors, colorAlpha } from "@/lib/colors";

interface BotChatWorkspaceProps {
  open: boolean;
  isCompact: boolean;
  machines: MachineInfo[];
  machineOnline: Record<string, boolean>;
  activeMachineId: string | null;
  defaultCwd?: string;
  deviceId: string | null;
  onClose: () => void;
}

type ActiveSelection =
  | { kind: "bot"; sessionId: string }
  | { kind: "channel"; channel: string }
  | { kind: "vault" };

interface RenderedTurnItem {
  key: string;
  kind: "user" | "assistant" | "thought" | "tool" | "error";
  text: string;
  title?: string;
  status?: string;
}

function coalesceBotEvents(entries: BotEventEntry[]): RenderedTurnItem[] {
  const items: RenderedTurnItem[] = [];
  const toolIndex = new Map<string, number>();

  for (const entry of entries) {
    const ev = entry.event as Record<string, unknown>;
    const type = typeof ev.type === "string" ? ev.type : "";
    if (type === "user_message" && typeof ev.text === "string") {
      items.push({ key: `u-${entry.seq}`, kind: "user", text: ev.text });
    } else if (type === "agent_message_chunk" && typeof ev.text === "string") {
      const last = items[items.length - 1];
      if (last && last.kind === "assistant") {
        last.text += ev.text;
      } else {
        items.push({ key: `a-${entry.seq}`, kind: "assistant", text: ev.text });
      }
    } else if (type === "thought_chunk" && typeof ev.text === "string") {
      const last = items[items.length - 1];
      if (last && last.kind === "thought") {
        last.text += ev.text;
      } else {
        items.push({ key: `th-${entry.seq}`, kind: "thought", text: ev.text });
      }
    } else if (type === "tool_call") {
      const id = String(ev.tool_call_id ?? entry.seq);
      const title = String(ev.title ?? "Tool");
      const status = String(ev.status ?? "running");
      toolIndex.set(id, items.length);
      items.push({ key: `tc-${entry.seq}`, kind: "tool", title, status, text: "" });
    } else if (type === "tool_call_update") {
      const id = String(ev.tool_call_id ?? "");
      const idx = toolIndex.get(id);
      if (idx !== undefined && items[idx]) {
        if (typeof ev.status === "string") items[idx].status = ev.status;
        if (typeof ev.content === "string") items[idx].text = ev.content;
      }
    } else if (type === "error" && typeof ev.message === "string") {
      items.push({ key: `e-${entry.seq}`, kind: "error", text: ev.message });
    }
  }
  return items;
}

function handleSlug(title: string): string {
  return title
    .trim()
    .replace(/^@+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function relativeTime(ms: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diff < 60) return "just now";
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function BotChatWorkspace({
  open,
  isCompact,
  machines,
  machineOnline,
  activeMachineId,
  defaultCwd,
  deviceId,
  onClose,
}: BotChatWorkspaceProps) {
  const [bots, setBots] = useState<BotSessionInfo[]>([]);
  const [channels, setChannels] = useState<string[]>(["#general"]);
  const [selection, setSelection] = useState<ActiveSelection>({
    kind: "channel",
    channel: "#general",
  });
  const [sidebarOpenMobile, setSidebarOpenMobile] = useState(false);

  // Bot 1v1 state
  const [botEvents, setBotEvents] = useState<BotEventEntry[]>([]);
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newBotMachineId, setNewBotMachineId] = useState(activeMachineId ?? machines[0]?.id ?? "");
  const [newBotKind, setNewBotKind] = useState<BotAgentKind>("claude");
  const [newBotName, setNewBotName] = useState("");
  const [newBotCwd, setNewBotCwd] = useState(defaultCwd ?? "");
  const [newBotAutoRun, setNewBotAutoRun] = useState(true);
  const [creatingBot, setCreatingBot] = useState(false);

  // Channel state
  const [channelMessages, setChannelMessages] = useState<AgentMessageInfo[]>([]);
  const [newChannelOpen, setNewChannelOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");
  const [routedNotice, setRoutedNotice] = useState<string | null>(null);

  // Vault state
  const [secrets, setSecrets] = useState<VaultSecretSummary[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [newSecretOpen, setNewSecretOpen] = useState(false);
  const [secName, setSecName] = useState("");
  const [secCategory, setSecCategory] = useState<VaultCategory>("api_key");
  const [secScope, setSecScope] = useState("*");
  const [secEnvVar, setSecEnvVar] = useState("");
  const [secUsername, setSecUsername] = useState("");
  const [secValue, setSecValue] = useState("");
  const [secNotes, setSecNotes] = useState("");
  const [savingSecret, setSavingSecret] = useState(false);

  // Shared composer state
  const [draftInput, setDraftInput] = useState("");
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!newBotMachineId && machines.length > 0) {
      setNewBotMachineId(activeMachineId ?? machines[0].id);
    }
  }, [activeMachineId, machines, newBotMachineId]);

  useEffect(() => {
    if (defaultCwd && !newBotCwd) setNewBotCwd(defaultCwd);
  }, [defaultCwd, newBotCwd]);

  const refreshSidebar = useCallback(async () => {
    try {
      const [botRows, chRows] = await Promise.all([
        listBotSessions(),
        listChatChannels(),
      ]);
      setBots(botRows);
      setChannels((prev) => {
        const merged = [...chRows];
        for (const p of prev) {
          if (!merged.some((c) => c.toLowerCase() === p.toLowerCase())) merged.push(p);
        }
        return merged.length > 0 ? merged : ["#general"];
      });
    } catch {
      /* ignore transient offline */
    }
  }, []);

  const activeBot = useMemo(
    () =>
      selection.kind === "bot"
        ? bots.find((b) => b.id === selection.sessionId) ?? null
        : null,
    [bots, selection],
  );

  const refreshActivePane = useCallback(async () => {
    if (!open) return;
    try {
      if (selection.kind === "bot" && activeBot) {
        const page = await getBotSessionEvents(activeBot.machine_id, activeBot.id, 0, 500);
        setBotEvents(page.events);
      } else if (selection.kind === "channel") {
        const rows = await listChannelMessages(selection.channel, 100);
        setChannelMessages(rows);
      } else if (selection.kind === "vault") {
        const rows = await listVaultSecrets();
        setSecrets(rows);
      }
    } catch {
      /* ignore transient */
    }
  }, [open, selection, activeBot]);

  useEffect(() => {
    if (!open) return;
    void refreshSidebar();
    void refreshActivePane();
    const timer = window.setInterval(() => {
      void refreshSidebar();
      void refreshActivePane();
    }, 1500);
    return () => window.clearInterval(timer);
  }, [open, refreshSidebar, refreshActivePane]);

  const renderedBotItems = useMemo(() => coalesceBotEvents(botEvents), [botEvents]);

  useEffect(() => {
    timelineEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [renderedBotItems.length, channelMessages.length]);

  if (!open) return null;

  const handleCreateBot = async () => {
    if (!newBotMachineId) return;
    setCreatingBot(true);
    setErrorMsg(null);
    try {
      const machine = machines.find((m) => m.id === newBotMachineId);
      const cwd = newBotCwd.trim() || machine?.home_dir || "~";
      const created = await createBotSession(newBotMachineId, {
        agent_kind: newBotKind,
        cwd,
        title: newBotName.trim() || undefined,
        auto_run: newBotAutoRun,
        device_id: deviceId ?? undefined,
      });
      setBots((prev) => [...prev, created]);
      setSelection({ kind: "bot", sessionId: created.id });
      setNewBotOpen(false);
      setNewBotName("");
      setSidebarOpenMobile(false);
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingBot(false);
    }
  };

  const handleSend = async () => {
    const text = draftInput.trim();
    if (!text || sending) return;
    setSending(true);
    setErrorMsg(null);
    setRoutedNotice(null);
    try {
      if (selection.kind === "bot" && activeBot) {
        await promptBotSession(activeBot.machine_id, activeBot.id, {
          text,
          device_id: deviceId ?? undefined,
        });
        setDraftInput("");
        void refreshActivePane();
      } else if (selection.kind === "channel") {
        const res = await sendChannelMessage(selection.channel, { body: text });
        setDraftInput("");
        if (res.routed_bots.length > 0) {
          setRoutedNotice(`Routed to ${res.routed_bots.map((b) => `@${handleSlug(b)}`).join(", ")}`);
        }
        void refreshActivePane();
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const handleCreateSecret = async () => {
    if (!secName.trim() || !secValue) return;
    setSavingSecret(true);
    setErrorMsg(null);
    try {
      await createVaultSecret({
        name: secName.trim(),
        category: secCategory,
        project_group: secScope.trim() || "*",
        env_var: secEnvVar.trim() || undefined,
        username: secUsername.trim() || undefined,
        secret_value: secValue,
        notes: secNotes.trim() || undefined,
      });
      setSecName("");
      setSecEnvVar("");
      setSecUsername("");
      setSecValue("");
      setSecNotes("");
      setNewSecretOpen(false);
      void refreshActivePane();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingSecret(false);
    }
  };

  const handleRevealOrHide = async (id: string) => {
    if (revealed[id] !== undefined) {
      setRevealed((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const res = await revealVaultSecret(id);
      setRevealed((prev) => ({ ...prev, [id]: res.value }));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCopySecret = async (id: string) => {
    try {
      const val = revealed[id] ?? (await revealVaultSecret(id)).value;
      await navigator.clipboard.writeText(val);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1500);
    } catch {
      /* ignore clipboard error */
    }
  };

  const workingBots = bots.filter((b) => b.status === "working");

  const sidebarContent = (
    <aside
      style={{
        width: isCompact ? "100%" : 260,
        flexShrink: 0,
        borderRight: isCompact ? "none" : `1px solid ${colors.border}`,
        background: colors.bg1,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "12px 14px",
          borderBottom: `1px solid ${colors.border}`,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Bot size={16} color={colors.accent} />
          <span style={{ fontWeight: 600, fontSize: 13, color: colors.fg0 }}>
            Bots &amp; Rooms
          </span>
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 999,
              background: colorAlpha.accentSoft,
              color: colors.accent,
              fontWeight: 600,
            }}
          >
            BETA
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Back to Terminals"
          style={{
            border: `1px solid ${colors.border}`,
            background: "transparent",
            color: colors.fg2,
            borderRadius: 6,
            padding: "3px 8px",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          Terminals ✕
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "10px 8px", display: "flex", flexDirection: "column", gap: 16 }}>
        {/* Group Chat Channels */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 6px 6px",
              fontSize: 11,
              fontWeight: 600,
              color: colors.fg3,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <span>Group Channels</span>
            <button
              type="button"
              onClick={() => setNewChannelOpen((v) => !v)}
              style={{
                border: "none",
                background: "transparent",
                color: colors.fg2,
                cursor: "pointer",
                padding: 2,
              }}
              title="New channel"
            >
              <Plus size={13} />
            </button>
          </div>
          {newChannelOpen && (
            <div style={{ display: "flex", gap: 4, padding: "0 4px 6px" }}>
              <input
                value={newChannelName}
                onChange={(e) => setNewChannelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newChannelName.trim()) {
                    const ch = newChannelName.trim().startsWith("#")
                      ? newChannelName.trim()
                      : `#${newChannelName.trim()}`;
                    setChannels((prev) =>
                      prev.includes(ch) ? prev : [...prev, ch],
                    );
                    setSelection({ kind: "channel", channel: ch });
                    setNewChannelName("");
                    setNewChannelOpen(false);
                    setSidebarOpenMobile(false);
                  }
                }}
                placeholder="#project-room"
                style={{
                  flex: 1,
                  minWidth: 0,
                  background: colors.bg0,
                  color: colors.fg0,
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  padding: "4px 8px",
                  fontSize: 12,
                }}
              />
            </div>
          )}
          {channels.map((ch) => {
            const active = selection.kind === "channel" && selection.channel === ch;
            return (
              <button
                key={ch}
                type="button"
                onClick={() => {
                  setSelection({ kind: "channel", channel: ch });
                  setSidebarOpenMobile(false);
                }}
                style={{
                  width: "100%",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "7px 8px",
                  borderRadius: 7,
                  border: "none",
                  background: active ? colorAlpha.accentSoft : "transparent",
                  color: active ? colors.fg0 : colors.fg2,
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  textAlign: "left",
                }}
              >
                <Hash size={14} color={active ? colors.accent : colors.fg3} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {ch.replace(/^#/, "")}
                </span>
              </button>
            );
          })}
        </div>

        {/* 1v1 Headless Bots */}
        <div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "0 6px 6px",
              fontSize: 11,
              fontWeight: 600,
              color: colors.fg3,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            <span>Bots ({bots.length})</span>
            <button
              type="button"
              onClick={() => setNewBotOpen(true)}
              data-testid="chat-new-bot-btn"
              style={{
                border: "none",
                background: colorAlpha.accentSoft,
                color: colors.accent,
                borderRadius: 5,
                cursor: "pointer",
                padding: "2px 6px",
                fontSize: 11,
                fontWeight: 600,
                display: "flex",
                alignItems: "center",
                gap: 3,
              }}
            >
              <Plus size={12} /> New
            </button>
          </div>
          {bots.length === 0 ? (
            <div style={{ padding: "6px 8px", fontSize: 12, color: colors.fg3 }}>
              No bots yet. Create a Claude or Codex bot to chat or mention in #channels.
            </div>
          ) : (
            bots.map((bot) => {
              const active = selection.kind === "bot" && selection.sessionId === bot.id;
              const statusColor =
                bot.status === "working"
                  ? "#f59e0b"
                  : bot.status === "idle"
                    ? "#22c55e"
                    : bot.status === "error"
                      ? "#ef4444"
                      : colors.fg3;
              const machineName =
                machines.find((m) => m.id === bot.machine_id)?.name ?? "node";
              return (
                <button
                  key={bot.id}
                  type="button"
                  onClick={() => {
                    setSelection({ kind: "bot", sessionId: bot.id });
                    setSidebarOpenMobile(false);
                  }}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "7px 8px",
                    borderRadius: 7,
                    border: "none",
                    background: active ? colorAlpha.accentSoft : "transparent",
                    color: active ? colors.fg0 : colors.fg2,
                    fontSize: 13,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      background: statusColor,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: active ? 600 : 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      @{handleSlug(bot.title) || bot.title}
                    </div>
                    <div style={{ fontSize: 11, color: colors.fg3 }}>
                      {bot.agent_kind} · {machineName}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Encrypted Secrets / Accounts / API Keys Vault */}
        <div>
          <div
            style={{
              padding: "0 6px 6px",
              fontSize: 11,
              fontWeight: 600,
              color: colors.fg3,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            Credentials
          </div>
          <button
            type="button"
            data-testid="chat-vault-tab"
            onClick={() => {
              setSelection({ kind: "vault" });
              setSidebarOpenMobile(false);
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 8px",
              borderRadius: 7,
              border: "none",
              background:
                selection.kind === "vault"
                  ? colorAlpha.accentSoft
                  : "transparent",
              color: selection.kind === "vault" ? colors.fg0 : colors.fg2,
              fontSize: 13,
              fontWeight: selection.kind === "vault" ? 600 : 400,
              cursor: "pointer",
              textAlign: "left",
            }}
          >
            <KeyRound
              size={14}
              color={selection.kind === "vault" ? colors.accent : colors.fg3}
            />
            <span>Secrets &amp; Keys Vault</span>
          </button>
        </div>
      </div>
    </aside>
  );

  return (
    <div
      data-testid="bot-chat-workspace"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 60,
        background: colors.bg0,
        color: colors.fg0,
        display: "flex",
        flexDirection: "row",
      }}
    >
      {(!isCompact || sidebarOpenMobile) && sidebarContent}

      {/* Main Content */}
      {(!isCompact || !sidebarOpenMobile) && (
        <section style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          {/* Header */}
          <header
            style={{
              height: 48,
              flexShrink: 0,
              borderBottom: `1px solid ${colors.border}`,
              padding: "0 16px",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              background: colors.bg1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              {isCompact && (
                <button
                  type="button"
                  onClick={() => setSidebarOpenMobile(true)}
                  style={{
                    border: `1px solid ${colors.border}`,
                    background: "transparent",
                    color: colors.fg1,
                    borderRadius: 6,
                    padding: "4px 8px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  ☰
                </button>
              )}
              {selection.kind === "channel" && (
                <>
                  <Hash size={16} color={colors.accent} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    {selection.channel.replace(/^#/, "")}
                  </span>
                  <span style={{ fontSize: 12, color: colors.fg3 }}>
                    Multi-Agent Room · @mention any bot
                  </span>
                </>
              )}
              {selection.kind === "bot" && activeBot && (
                <>
                  <Bot size={16} color={colors.accent} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    @{handleSlug(activeBot.title) || activeBot.title}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      padding: "2px 7px",
                      borderRadius: 999,
                      background: colors.bg0,
                      border: `1px solid ${colors.border}`,
                      color: colors.fg2,
                    }}
                  >
                    {activeBot.agent_kind} · {activeBot.status}
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: colors.fg3,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {activeBot.cwd}
                  </span>
                </>
              )}
              {selection.kind === "vault" && (
                <>
                  <KeyRound size={16} color={colors.accent} />
                  <span style={{ fontWeight: 600, fontSize: 14 }}>
                    Secrets, Accounts &amp; API Keys Vault
                  </span>
                </>
              )}
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {selection.kind === "bot" && activeBot && (
                <>
                  {activeBot.status === "working" && (
                    <button
                      type="button"
                      onClick={() =>
                        void cancelBotSession(
                          activeBot.machine_id,
                          activeBot.id,
                          deviceId ?? undefined,
                        )
                      }
                      style={{
                        border: `1px solid ${colors.border}`,
                        background: "transparent",
                        color: "#f59e0b",
                        borderRadius: 6,
                        padding: "4px 10px",
                        fontSize: 12,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Square size={12} /> Stop
                    </button>
                  )}
                  {(activeBot.status === "disconnected" ||
                    activeBot.status === "error") && (
                    <button
                      type="button"
                      onClick={() =>
                        void resumeBotSession(
                          activeBot.machine_id,
                          activeBot.id,
                          deviceId ?? undefined,
                        ).then(() => refreshSidebar())
                      }
                      style={{
                        border: "none",
                        background: colors.accent,
                        color: colors.bg0,
                        borderRadius: 6,
                        padding: "4px 10px",
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <Play size={12} /> Resume
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      void deleteBotSession(
                        activeBot.machine_id,
                        activeBot.id,
                        deviceId ?? undefined,
                      ).then(() => {
                        setSelection({ kind: "channel", channel: channels[0] ?? "#general" });
                        void refreshSidebar();
                      })
                    }
                    title="Delete bot"
                    style={{
                      border: `1px solid ${colors.border}`,
                      background: "transparent",
                      color: colors.fg3,
                      borderRadius: 6,
                      padding: "4px 8px",
                      cursor: "pointer",
                    }}
                  >
                    <Trash2 size={13} />
                  </button>
                </>
              )}
              {selection.kind === "vault" && (
                <button
                  type="button"
                  onClick={() => setNewSecretOpen(true)}
                  style={{
                    border: "none",
                    background: colors.accent,
                    color: colors.bg0,
                    borderRadius: 6,
                    padding: "5px 12px",
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Plus size={13} /> Add Secret
                </button>
              )}
              {isCompact && (
                <button
                  type="button"
                  onClick={onClose}
                  style={{
                    border: `1px solid ${colors.border}`,
                    background: "transparent",
                    color: colors.fg2,
                    borderRadius: 6,
                    padding: "4px 8px",
                    cursor: "pointer",
                  }}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </header>

          {errorMsg && (
            <div
              style={{
                padding: "8px 16px",
                background: colorAlpha.dangerSoft,
                color: "#fca5a5",
                fontSize: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>{errorMsg}</span>
              <button
                type="button"
                onClick={() => setErrorMsg(null)}
                style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          )}

          {/* Body: Vault OR Chat Timeline */}
          {selection.kind === "vault" ? (
            <div style={{ flex: 1, overflowY: "auto", padding: 20, maxWidth: 920, width: "100%", margin: "0 auto" }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: `1px solid ${colors.border}`,
                  background: colors.bg1,
                  fontSize: 12,
                  color: colors.fg2,
                  marginBottom: 16,
                }}
              >
                Encrypted at rest (ChaCha20-Poly1305). Secrets with an <code>Env Var</code> are
                automatically injected into Bots matching the scope (<code>*</code> = Global or
                project folder name) and auto-redacted from chat output.
              </div>

              {newSecretOpen && (
                <div
                  style={{
                    padding: 16,
                    borderRadius: 10,
                    border: `1px solid ${colors.border}`,
                    background: colors.bg1,
                    marginBottom: 16,
                    display: "grid",
                    gridTemplateColumns: isCompact ? "1fr" : "1fr 1fr",
                    gap: 10,
                  }}
                >
                  <input
                    placeholder="Name (e.g. OpenAI Prod Key)"
                    value={secName}
                    onChange={(e) => setSecName(e.target.value)}
                    style={inputStyle}
                  />
                  <select
                    value={secCategory}
                    onChange={(e) => setSecCategory(e.target.value as VaultCategory)}
                    style={inputStyle}
                  >
                    <option value="api_key">API Key</option>
                    <option value="account">Account / Password</option>
                    <option value="token">Access Token</option>
                    <option value="ssh">SSH / Server</option>
                    <option value="other">Other</option>
                  </select>
                  <input
                    placeholder="Env Var (optional, e.g. OPENAI_API_KEY)"
                    value={secEnvVar}
                    onChange={(e) => setSecEnvVar(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    placeholder="Project Scope (* for Global, or e.g. webmux)"
                    value={secScope}
                    onChange={(e) => setSecScope(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    placeholder="Username / Account (optional)"
                    value={secUsername}
                    onChange={(e) => setSecUsername(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    type="password"
                    placeholder="Secret Value / Password"
                    value={secValue}
                    onChange={(e) => setSecValue(e.target.value)}
                    style={inputStyle}
                  />
                  <input
                    placeholder="Notes (optional)"
                    value={secNotes}
                    onChange={(e) => setSecNotes(e.target.value)}
                    style={{ ...inputStyle, gridColumn: isCompact ? undefined : "1 / -1" }}
                  />
                  <div
                    style={{
                      gridColumn: isCompact ? undefined : "1 / -1",
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => setNewSecretOpen(false)}
                      style={secondaryBtnStyle}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={savingSecret || !secName.trim() || !secValue}
                      onClick={() => void handleCreateSecret()}
                      style={primaryBtnStyle}
                    >
                      {savingSecret ? "Saving…" : "Save Encrypted"}
                    </button>
                  </div>
                </div>
              )}

              {secrets.length === 0 ? (
                <div style={{ textAlign: "center", padding: 48, color: colors.fg3, fontSize: 13 }}>
                  No secrets saved yet. Click <strong>+ Add Secret</strong> to store an API key,
                  token, or account password securely.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {secrets.map((s) => (
                    <div
                      key={s.id}
                      style={{
                        padding: "12px 14px",
                        borderRadius: 10,
                        border: `1px solid ${colors.border}`,
                        background: colors.bg1,
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <div style={{ minWidth: 200, flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</span>
                          <span style={badgeStyle}>{s.category}</span>
                          <span style={badgeStyle}>
                            {s.project_group === "*" ? "Global (*)" : s.project_group}
                          </span>
                          {s.env_var && (
                            <code
                              style={{
                                fontSize: 11,
                                color: colors.accent,
                                background: colorAlpha.accentSoft,
                                padding: "1px 6px",
                                borderRadius: 4,
                              }}
                            >
                              ${s.env_var}
                            </code>
                          )}
                        </div>
                        <div style={{ fontSize: 12, color: colors.fg3, marginTop: 4, fontFamily: "monospace" }}>
                          {s.username ? `${s.username} · ` : ""}
                          {revealed[s.id] ?? s.masked_preview}
                        </div>
                        {s.notes && (
                          <div style={{ fontSize: 12, color: colors.fg2, marginTop: 3 }}>
                            {s.notes}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => void handleRevealOrHide(s.id)}
                          style={secondaryBtnStyle}
                          title={revealed[s.id] ? "Hide" : "Reveal"}
                        >
                          {revealed[s.id] ? <EyeOff size={13} /> : <Eye size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleCopySecret(s.id)}
                          style={secondaryBtnStyle}
                          title="Copy secret"
                        >
                          {copiedId === s.id ? <Check size={13} color={colors.accent} /> : <Copy size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void deleteVaultSecret(s.id).then(() => refreshActivePane())
                          }
                          style={secondaryBtnStyle}
                          title="Delete"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {/* Chat Timeline */}
              <div
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "16px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                  maxWidth: 940,
                  width: "100%",
                  margin: "0 auto",
                }}
              >
                {selection.kind === "bot" && activeBot ? (
                  renderedBotItems.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 48, color: colors.fg3, fontSize: 13 }}>
                      Start chatting with <strong>@{handleSlug(activeBot.title)}</strong>.
                      <div style={{ marginTop: 6, fontSize: 12 }}>
                        This Bot runs headlessly (not bound to a terminal) and can orchestrate
                        sub-agents, worker terminals, and Vault credentials.
                      </div>
                    </div>
                  ) : (
                    renderedBotItems.map((item) => {
                      if (item.kind === "user") {
                        return (
                          <div key={item.key} style={{ alignSelf: "flex-end", maxWidth: "82%" }}>
                            <div
                              style={{
                                background: colorAlpha.accentSoft,
                                border: `1px solid ${colorAlpha.accentLine}`,
                                borderRadius: 12,
                                padding: "10px 14px",
                                fontSize: 13.5,
                                whiteSpace: "pre-wrap",
                              }}
                            >
                              {item.text}
                            </div>
                          </div>
                        );
                      }
                      if (item.kind === "thought") {
                        const openT = Boolean(expandedTools[item.key]);
                        return (
                          <div key={item.key} style={{ maxWidth: "88%" }}>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedTools((p) => ({ ...p, [item.key]: !p[item.key] }))
                              }
                              style={{
                                border: `1px solid ${colors.border}`,
                                background: colors.bg1,
                                color: colors.fg3,
                                borderRadius: 8,
                                padding: "4px 10px",
                                fontSize: 11.5,
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 5,
                              }}
                            >
                              {openT ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                              Thinking ({item.text.length} chars)
                            </button>
                            {openT && (
                              <pre
                                style={{
                                  marginTop: 6,
                                  padding: 10,
                                  borderRadius: 8,
                                  background: colors.bg1,
                                  border: `1px solid ${colors.border}`,
                                  color: colors.fg2,
                                  fontSize: 12,
                                  whiteSpace: "pre-wrap",
                                  overflowX: "auto",
                                }}
                              >
                                {item.text}
                              </pre>
                            )}
                          </div>
                        );
                      }
                      if (item.kind === "tool") {
                        const openT = Boolean(expandedTools[item.key]);
                        return (
                          <div key={item.key} style={{ maxWidth: "88%" }}>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedTools((p) => ({ ...p, [item.key]: !p[item.key] }))
                              }
                              style={{
                                border: `1px solid ${colors.border}`,
                                background: colors.bg1,
                                color: colors.fg2,
                                borderRadius: 8,
                                padding: "5px 10px",
                                fontSize: 12,
                                cursor: "pointer",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 6,
                              }}
                            >
                              <Wrench size={12} color={colors.accent} />
                              <span>{item.title}</span>
                              <span style={{ fontSize: 11, color: colors.fg3 }}>
                                · {item.status}
                              </span>
                            </button>
                            {openT && item.text && (
                              <pre
                                style={{
                                  marginTop: 6,
                                  padding: 10,
                                  borderRadius: 8,
                                  background: colors.bg1,
                                  border: `1px solid ${colors.border}`,
                                  color: colors.fg2,
                                  fontSize: 11.5,
                                  maxHeight: 240,
                                  overflow: "auto",
                                  whiteSpace: "pre-wrap",
                                }}
                              >
                                {item.text}
                              </pre>
                            )}
                          </div>
                        );
                      }
                      if (item.kind === "error") {
                        return (
                          <div
                            key={item.key}
                            style={{
                              padding: "8px 12px",
                              borderRadius: 8,
                              background: colorAlpha.dangerSoft,
                              color: "#fca5a5",
                              fontSize: 12.5,
                            }}
                          >
                            {item.text}
                          </div>
                        );
                      }
                      return (
                        <div
                          key={item.key}
                          style={{
                            borderRadius: 12,
                            border: `1px solid ${colors.border}`,
                            background: colors.bg1,
                            padding: "12px 16px",
                          }}
                        >
                          <DraftArtifactPreview content={item.text} />
                        </div>
                      );
                    })
                  )
                ) : selection.kind === "channel" ? (
                  channelMessages.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 48, color: colors.fg3, fontSize: 13 }}>
                      Welcome to <strong>{selection.channel}</strong>.
                      <div style={{ marginTop: 6, fontSize: 12 }}>
                        Send a message or click a <code>@bot</code> chip below to collaborate with
                        multiple headless Bots in one room.
                      </div>
                    </div>
                  ) : (
                    channelMessages.map((m) => {
                      const isHuman = m.from_label === "you" || !m.from_terminal_id;
                      return (
                        <div
                          key={m.id}
                          style={{
                            borderRadius: 12,
                            border: `1px solid ${isHuman ? colorAlpha.accentLine : colors.border}`,
                            background: isHuman ? colorAlpha.accentSoft : colors.bg1,
                            padding: "10px 14px",
                          }}
                        >
                          <div
                            style={{
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              marginBottom: 6,
                              fontSize: 12,
                            }}
                          >
                            <span
                              style={{
                                fontWeight: 600,
                                color: isHuman ? colors.accent : colors.fg0,
                              }}
                            >
                              @{handleSlug(m.from_label) || m.from_label}
                            </span>
                            <span style={{ color: colors.fg3, fontSize: 11 }}>
                              {relativeTime(m.created_at)}
                            </span>
                          </div>
                          <DraftArtifactPreview content={m.body} />
                        </div>
                      );
                    })
                  )
                ) : null}

                {selection.kind === "channel" && workingBots.length > 0 && (
                  <div style={{ fontSize: 12, color: "#f59e0b", padding: "4px 6px" }}>
                    ● {workingBots.map((b) => `@${handleSlug(b.title)}`).join(", ")} working…
                  </div>
                )}
                <div ref={timelineEndRef} />
              </div>

              {/* Composer */}
              <div
                style={{
                  borderTop: `1px solid ${colors.border}`,
                  background: colors.bg1,
                  padding: "10px 16px 14px",
                }}
              >
                <div style={{ maxWidth: 940, margin: "0 auto" }}>
                  {selection.kind === "channel" && bots.length > 0 && (
                    <div
                      style={{
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 6,
                        marginBottom: 8,
                        alignItems: "center",
                      }}
                    >
                      <span style={{ fontSize: 11, color: colors.fg3 }}>Mention:</span>
                      {bots.map((b) => {
                        const slug = `@${handleSlug(b.title)}`;
                        return (
                          <button
                            key={b.id}
                            type="button"
                            onClick={() =>
                              setDraftInput((prev) =>
                                prev.trim().length === 0 ? `${slug} ` : `${prev.trimEnd()} ${slug} `,
                              )
                            }
                            style={{
                              border: `1px solid ${colors.border}`,
                              background: colors.bg0,
                              color: colors.fg1,
                              borderRadius: 999,
                              padding: "2px 9px",
                              fontSize: 11.5,
                              cursor: "pointer",
                            }}
                          >
                            {slug}
                          </button>
                        );
                      })}
                      {routedNotice && (
                        <span style={{ fontSize: 11, color: colors.accent, marginLeft: "auto" }}>
                          {routedNotice}
                        </span>
                      )}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                    <textarea
                      rows={2}
                      value={draftInput}
                      onChange={(e) => setDraftInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSend();
                        }
                      }}
                      placeholder={
                        selection.kind === "channel"
                          ? `Message ${selection.channel} (use @bot to route, Enter to send)…`
                          : activeBot
                            ? `Message @${handleSlug(activeBot.title)} (Enter to send, Shift+Enter for newline)…`
                            : "Select or create a Bot…"
                      }
                      style={{
                        flex: 1,
                        resize: "none",
                        background: colors.bg0,
                        color: colors.fg0,
                        border: `1px solid ${colors.border}`,
                        borderRadius: 10,
                        padding: "10px 12px",
                        fontSize: 13.5,
                        fontFamily: "inherit",
                      }}
                    />
                    <button
                      type="button"
                      disabled={sending || !draftInput.trim()}
                      onClick={() => void handleSend()}
                      style={{
                        ...primaryBtnStyle,
                        height: 44,
                        padding: "0 16px",
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      <Send size={14} /> Send
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      )}

      {/* New Bot Modal */}
      {newBotOpen && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 70,
            background: "rgba(0,0,0,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: 440,
              borderRadius: 12,
              border: `1px solid ${colors.border}`,
              background: colors.bg1,
              padding: 20,
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontWeight: 600, fontSize: 15 }}>New Headless Bot</span>
              <button
                type="button"
                onClick={() => setNewBotOpen(false)}
                style={{ border: "none", background: "transparent", color: colors.fg2, cursor: "pointer" }}
              >
                <X size={16} />
              </button>
            </div>
            <label style={labelStyle}>
              Machine
              <select
                value={newBotMachineId}
                onChange={(e) => setNewBotMachineId(e.target.value)}
                style={inputStyle}
              >
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} {machineOnline[m.id] ? "(online)" : "(offline)"}
                  </option>
                ))}
              </select>
            </label>
            <label style={labelStyle}>
              Engine
              <select
                value={newBotKind}
                onChange={(e) => setNewBotKind(e.target.value as BotAgentKind)}
                style={inputStyle}
              >
                <option value="claude">Claude Code (stream-json)</option>
                <option value="codex">Codex CLI (exec --json)</option>
              </select>
            </label>
            <label style={labelStyle}>
              Bot Name / @Handle
              <input
                placeholder="e.g. architect, backend, reviewer"
                value={newBotName}
                onChange={(e) => setNewBotName(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={labelStyle}>
              Working Directory
              <input
                placeholder="/home/user/projects/my-app"
                value={newBotCwd}
                onChange={(e) => setNewBotCwd(e.target.value)}
                style={inputStyle}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: colors.fg2 }}>
              <input
                type="checkbox"
                checked={newBotAutoRun}
                onChange={(e) => setNewBotAutoRun(e.target.checked)}
              />
              Auto-run tools (bypass interactive permission prompts)
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 }}>
              <button
                type="button"
                onClick={() => setNewBotOpen(false)}
                style={secondaryBtnStyle}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={creatingBot || !newBotMachineId}
                onClick={() => void handleCreateBot()}
                style={primaryBtnStyle}
              >
                {creatingBot ? "Starting…" : "Create Bot"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: colors.bg0,
  color: colors.fg0,
  border: `1px solid ${colors.border}`,
  borderRadius: 7,
  padding: "8px 10px",
  fontSize: 13,
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  fontSize: 12,
  color: colors.fg2,
};

const primaryBtnStyle: React.CSSProperties = {
  border: "none",
  background: colors.accent,
  color: colors.bg0,
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 12.5,
  fontWeight: 600,
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  border: `1px solid ${colors.border}`,
  background: "transparent",
  color: colors.fg1,
  borderRadius: 7,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
};

const badgeStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "1px 7px",
  borderRadius: 999,
  background: colors.bg0,
  border: `1px solid ${colors.border}`,
  color: colors.fg2,
};
