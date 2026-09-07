import { openSocket } from "@/lib/secureTransport";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  TerminalInfo,
  Bookmark,
  WorkspaceGroupInfo,
  WorkspaceLayoutInfo,
  WorkspaceLayoutNode,
} from "@offdesk/shared";
import { AppTitleBar } from "./AppTitleBar.web";
import { TabBar } from "./TabBar.web";
import {
  CommandPalette,
  type PaletteFilter,
  type PaletteRow,
} from "./CommandPalette.web";
import { TerminalWorkspace, type WorkspaceCommandChannel } from "./TerminalWorkspace.web";
import { MobileWorkbench } from "./MobileWorkbench.web";
import { HandoffBanner } from "./HandoffBanner";
import { MachineOnboardingDialog, MobileAppDialog } from "./OnboardingView.web";
import { Terminal as TerminalIcon } from "lucide-react";
import {
  createTerminal,
  createWorkspaceGroup,
  deleteMachine,
  deleteWorkspaceGroup,
  destroyTerminal,
  checkForegroundProcess,
  assignTerminalWorkspaceGroup,
  eventsWsUrl,
  getBootstrap,
  listBookmarks,
  listWorkspaceGroups,
  putFocus,
  requestControl,
  reorderWorkspaceGroups,
  releaseControl,
  renameWorkspaceGroup,
  saveWorkspaceLayout,
} from "@/lib/api";
import {
  estimateInitialTerminalDimensions,
  estimateMobileInitialTerminalDimensions,
} from "@/lib/terminalViewModel";
import {
  applyBootstrapSnapshot,
  applyBrowserEventEnvelope,
  EMPTY_BROWSER_SESSION_STATE,
  shouldResyncForEnvelope,
} from "@/lib/bootstrapState";
import { getPersistentDeviceId } from "@/lib/deviceId";
import { colors } from "@/lib/colors";
import { isTauri, isTauriMobile } from "@/lib/platform";
import { useDisplayMode, useVisualViewport } from "@/lib/hooks";
import { KeyBarSlotProvider, WorkspaceKeyBarSlot } from "@/lib/keyBarSlot";
import {
  formatPrefixBinding,
  isEditableShortcutTarget,
  loadPrefixBindings,
  type PrefixActionId,
} from "@/lib/prefixKey";
import { PrefixKeyProvider, usePrefixKey } from "@/lib/prefixKeyContext";
import { CheatSheetOverlay } from "./CheatSheetOverlay.web";
import { UpdateNotification } from "./UpdateNotification";
import { useAuth } from "@/lib/auth";
import { showWorkspaceToast } from "@/lib/workspaceToast";
import {
  MAX_PANES_PER_TAB,
  buildReorderPersistentGroupIds,
  collectGroupPaneTerminalIds,
  createTerminalWorkspace,
  planNewTerminalPlacement,
  type WorkspaceGroup,
  type WorkspaceSplitIntent,
} from "@/lib/terminalWorkspaceLayout";
import {
  createInitialMainLayout,
  mainLayoutReducer,
} from "@/lib/mainLayoutReducer";
import {
  storePendingControlRelease,
  takePendingControlRelease,
} from "@/lib/unloadControlRelease";
import { TerminalPreviewMuxProvider } from "@/lib/terminalPreviewMuxReact";
import { createTerminalReconnectController } from "@/lib/terminalReconnect";
import { readViewOnlyLock, writeViewOnlyLock } from "@/lib/viewOnlyLock";
import { lazyWithReload } from "@/lib/lazyWithReload";
import { LazyLoadingFallback } from "./LazyLoadingFallback";
import { ConfirmDialog } from "./ConfirmDialog";

const OnboardingView = lazy(() =>
  lazyWithReload(() =>
    import("./OnboardingView.web").then((module) => ({
      default: module.OnboardingView,
    })),
  ),
);
const SettingsPage = lazy(() =>
  lazyWithReload(() =>
    import("./SettingsPage").then((module) => ({ default: module.SettingsPage })),
  ),
);
const RenameGroupDialog = lazy(() =>
  lazyWithReload(() =>
    import("./RenameGroupDialog").then((module) => ({
      default: module.RenameGroupDialog,
    })),
  ),
);

// Prefix actions owned by TerminalCanvas (workspace-owned actions are
// registered by TerminalWorkspace).
const CANVAS_PREFIX_ACTIONS: PrefixActionId[] = [
  "newTerminal",
  "cheatSheet",
  "sessionSwitcher",
  "switchHost",
  "commandPalette",
  "copyMode",
];

interface CreateTerminalOptions {
  selectWorkpath?: boolean;
  workspaceGroupId?: string | null;
}

interface DestroyTerminalOptions {
  keepWorkspaceOpen?: boolean;
  afterAccepted?: () => void;
}

type DestroyTerminalRequestResult = "accepted" | "pending";

const LAST_FOCUS_PUT_KEY = "offdesk:last-focus-put";
const SAME_SESSION_FOCUS_WINDOW_MS = 2 * 60_000;

function recordLastFocusPut(terminalId: string): void {
  try {
    window.sessionStorage.setItem(
      LAST_FOCUS_PUT_KEY,
      JSON.stringify({ terminalId, atMs: Date.now() }),
    );
  } catch {
    /* ignore unavailable browser storage */
  }
}

function wasRecentlyFocusedByThisSession(terminalId: string): boolean {
  try {
    const raw = window.sessionStorage.getItem(LAST_FOCUS_PUT_KEY);
    if (!raw) return false;
    const record = JSON.parse(raw) as { terminalId?: unknown; atMs?: unknown };
    return (
      record.terminalId === terminalId &&
      typeof record.atMs === "number" &&
      Date.now() - record.atMs >= 0 &&
      Date.now() - record.atMs < SAME_SESSION_FOCUS_WINDOW_MS
    );
  } catch {
    return false;
  }
}

function upsertTerminalInfo(
  terminals: TerminalInfo[],
  terminal: TerminalInfo,
): TerminalInfo[] {
  const index = terminals.findIndex((item) => item.id === terminal.id);
  if (index === -1) return [...terminals, terminal];
  const next = terminals.slice();
  next[index] = terminal;
  return next;
}

function replaceMachineWorkspaceGroups(
  groups: WorkspaceGroupInfo[],
  machineId: string,
  nextGroups: WorkspaceGroupInfo[],
): WorkspaceGroupInfo[] {
  const otherGroups = groups.filter((group) => group.machine_id !== machineId);
  return [...otherGroups, ...nextGroups].sort(
    (a, b) =>
      a.machine_id.localeCompare(b.machine_id) ||
      a.sort_order - b.sort_order ||
      a.name.localeCompare(b.name),
  );
}

function upsertWorkspaceLayoutInfo(
  layouts: WorkspaceLayoutInfo[],
  layout: WorkspaceLayoutInfo,
): WorkspaceLayoutInfo[] {
  const index = layouts.findIndex(
    (item) =>
      item.machine_id === layout.machine_id && item.group_key === layout.group_key,
  );
  const next =
    index === -1
      ? [...layouts, layout]
      : layouts.map((item) =>
          item.machine_id === layout.machine_id &&
          item.group_key === layout.group_key
            ? layout
            : item,
        );
  return next.sort(
    (a, b) =>
      a.machine_id.localeCompare(b.machine_id) ||
      a.group_key.localeCompare(b.group_key),
  );
}

export function TerminalCanvas() {
  return (
    <PrefixKeyProvider>
      <TerminalCanvasInner />
    </PrefixKeyProvider>
  );
}

function TerminalCanvasInner() {
  const [browserState, setBrowserState] = useState(EMPTY_BROWSER_SESSION_STATE);
  const [layout, dispatchLayout] = useReducer(
    mainLayoutReducer,
    undefined,
    createInitialMainLayout,
  );
  const { isCompact, isTouch } = useDisplayMode();
  const viewport = useVisualViewport();
  const viewportHeight = viewport?.height ?? null;
  const rootHeight: string =
    viewport !== null ? `${viewport.height * viewport.scale}px` : "100dvh";
  const { logout } = useAuth();

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [bootstrapReady, setBootstrapReady] = useState(false);
  const [eventsReconnecting, setEventsReconnecting] = useState(false);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [viewOnlyLocked, setViewOnlyLocked] = useState(() =>
    typeof window === "undefined"
      ? false
      : readViewOnlyLock(window.localStorage),
  );
  const [showHandoffBanner, setShowHandoffBanner] = useState(false);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [activeMachineId, setActiveMachineId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [addMachineOpen, setAddMachineOpen] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);

  useEffect(() => {
    if (!isTauri() || isTauriMobile()) return;
    const openSettings = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "," && !event.altKey && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        setShowSettings(true);
      }
    };
    window.addEventListener("keydown", openSettings, true);
    return () => window.removeEventListener("keydown", openSettings, true);
  }, []);

  // The menu bar item on the hub machine opens the window and says what it
  // wants shown; see packages/desktop/src-tauri/src/tray.rs.
  useEffect(() => {
    if (!isTauri() || isTauriMobile()) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void import("@tauri-apps/api/event").then(({ listen }) => {
      if (disposed) return;
      void listen("offdesk://show-phone-code", () => setPhoneOpen(true)).then((un) => unlisteners.push(un));
      void listen("offdesk://add-machine", () => setAddMachineOpen(true)).then((un) => unlisteners.push(un));
      void listen("offdesk://settings", () => setShowSettings(true)).then((un) => unlisteners.push(un));
    });
    return () => {
      disposed = true;
      unlisteners.forEach((un) => un());
    };
  }, []);
  // A one-time nudge on the desk: the phone is the point of the product,
  // and nothing on this screen said where it was.
  const PHONE_HINT_KEY = "offdesk:phone-hint-dismissed";
  const [phoneHintDismissed, setPhoneHintDismissed] = useState(() => {
    try {
      return window.localStorage.getItem(PHONE_HINT_KEY) === "1";
    } catch {
      return true;
    }
  });
  const dismissPhoneHint = useCallback(() => {
    setPhoneHintDismissed(true);
    try {
      window.localStorage.setItem(PHONE_HINT_KEY, "1");
    } catch {
      /* no storage, no memory of it */
    }
  }, []);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const lastSeqRef = useRef(0);
  const keepWorkspaceOpenDestroyedTerminalIdsRef = useRef(new Set<string>());
  const [workspaceAnchorTerminal, setWorkspaceAnchorTerminal] =
    useState<TerminalInfo | null>(null);
  const handoffLandingHandledRef = useRef(false);
  const lastSentFocusTerminalIdRef = useRef<string | null>(null);

  const [closeConfirmation, setCloseConfirmation] = useState<
    | {
        terminal: TerminalInfo;
        processName: string;
        options?: DestroyTerminalOptions;
      }
    | null
  >(null);
  const [groupDeleteConfirmation, setGroupDeleteConfirmation] =
    useState<WorkspaceGroup | null>(null);
  const [groupRenameTarget, setGroupRenameTarget] =
    useState<WorkspaceGroup | null>(null);
  const [hostRemoveTarget, setHostRemoveTarget] = useState<{
    machineId: string;
    name: string;
    online: boolean;
  } | null>(null);

  const machines = browserState.machines;
  const terminals = browserState.terminals;
  const workspaceGroups = browserState.workspaceGroups;
  const workspaceLayouts = browserState.workspaceLayouts;
  const machineStats = browserState.machineStats;
  const controlLeases = browserState.controlLeases;
  const workspaceLayoutsRef = useRef(workspaceLayouts);
  useEffect(() => {
    workspaceLayoutsRef.current = workspaceLayouts;
  }, [workspaceLayouts]);

  const isMachineController = useCallback(
    (machineId: string) =>
      deviceId !== null && controlLeases[machineId] === deviceId,
    [controlLeases, deviceId],
  );
  const canTypeOnMachine = useCallback(
    (machineId: string) =>
      isMachineController(machineId) || !viewOnlyLocked,
    [isMachineController, viewOnlyLocked],
  );
  const updateViewOnlyLock = useCallback((locked: boolean) => {
    setViewOnlyLocked(locked);
    writeViewOnlyLock(window.localStorage, locked);
  }, []);
  const hideHandoffBanner = useCallback(() => {
    setShowHandoffBanner(false);
  }, []);
  const isActiveController = activeMachineId
    ? isMachineController(activeMachineId)
    : false;

  const machineOnline = useMemo(
    () =>
      Object.fromEntries(
        machines.map((machine) => [
          machine.id,
          Boolean(machineStats[machine.id]) ||
            terminals.some((terminal) =>
              terminal.machine_id === machine.id && terminal.reachable,
            ),
        ]),
      ),
    [machines, machineStats, terminals],
  );
  const handleRemoveHost = useCallback(
    (machineId: string) => {
      const machine = machines.find((item) => item.id === machineId);
      setHostRemoveTarget({
        machineId,
        name: machine?.name ?? machineId,
        online: Boolean(machineOnline[machineId]),
      });
    },
    [machineOnline, machines],
  );
  const confirmRemoveHost = useCallback(() => {
    const target = hostRemoveTarget;
    setHostRemoveTarget(null);
    if (!target) return;
    void (async () => {
      try {
        await deleteMachine(target.machineId);
      } catch (error) {
        console.error("Failed to remove host", error);
        showWorkspaceToast(
          error instanceof Error ? error.message : "Failed to remove host",
        );
      }
    })();
  }, [hostRemoveTarget]);

  // ---- device id, bootstrap, events WS ----

  useEffect(() => {
    let cancelled = false;
    void getPersistentDeviceId().then((id) => {
      if (!cancelled) setDeviceId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    lastSeqRef.current = browserState.lastSeq;
  }, [browserState.lastSeq]);

  useEffect(() => {
    if (machines.length === 0) {
      if (activeMachineId !== null) setActiveMachineId(null);
      return;
    }
    const stillExists =
      activeMachineId && machines.some((m) => m.id === activeMachineId);
    if (!stillExists) setActiveMachineId(machines[0].id);
  }, [machines, activeMachineId]);

  // Load bookmarks per machine, with a synthetic ~ fallback so the rail is
  // never empty when the server returns no workpaths. Matches the prior
  // behaviour in WorkpathPanel.
  useEffect(() => {
    if (machines.length === 0) {
      setBookmarks([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      machines.map((m) => {
        const fallback: Bookmark[] = [
          {
            id: "local-home",
            machine_id: m.id,
            path: m.home_dir || "/",
            label: "~",
            sort_order: 0,
          },
        ];
        return listBookmarks(m.id)
          .then((bms) => (bms.length > 0 ? bms : fallback))
          .catch(() => fallback);
      }),
    ).then((all) => {
      if (!cancelled) setBookmarks(all.flat());
    });
    return () => {
      cancelled = true;
    };
  }, [machines, terminals.length]);

  // URL hash <-> zoom-state sync.
  useEffect(() => {
    const hash = window.location.hash;
    if (hash.startsWith("#/t/")) {
      const id = hash.slice(4);
      if (id) dispatchLayout({ type: "ZOOM_TERMINAL", terminalId: id });
    }
  }, []);
  useEffect(() => {
    const onPopState = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/t/")) {
        dispatchLayout({ type: "ZOOM_TERMINAL", terminalId: hash.slice(4) });
      } else {
        dispatchLayout({ type: "UNZOOM" });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!deviceId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    setBootstrapReady(false);

    getBootstrap()
      .then((snapshot) => {
        if (cancelled) return;
        lastSeqRef.current = snapshot.snapshot_seq;
        setBrowserState(applyBootstrapSnapshot(snapshot));
        setBootstrapReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        retryTimer = setTimeout(() => {
          setReconnectGeneration((value) => value + 1);
        }, 1000);
      });

    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [deviceId, reconnectGeneration]);

  // Re-request control after a same-tab reload clears pending releases.
  useEffect(() => {
    if (!deviceId) return;
    const pending = takePendingControlRelease(window.sessionStorage);
    if (viewOnlyLocked) return;
    if (pending.length === 0) return;
    let cancelled = false;
    void Promise.allSettled(
      pending.map((machineId) => requestControl(machineId, deviceId)),
    ).finally(() => {
      if (!cancelled) setReconnectGeneration((value) => value + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [deviceId, viewOnlyLocked]);

  useEffect(() => {
    if (!deviceId) return;
    // Just remember which machines the user was controlling so the next boot
    // can re-assert via `requestControl` as a belt-and-suspenders. Do NOT
    // send `releaseControlKeepalive` here: the hub already auto-releases on
    // WS disconnect (after a 10s grace period — see
    // `DEVICE_DISCONNECT_GRACE_PERIOD` in crates/hub/src/ws.rs) and restores
    // the lease when the same device reconnects. A beacon-fired release
    // races the reconnect and can wipe `released_leases` before restore
    // runs, leaving the user stuck in "viewing" after a reload.
    const stashControlled = () => {
      const ids = Object.entries(controlLeases)
        .filter(([, cid]) => cid === deviceId)
        .map(([machineId]) => machineId);
      storePendingControlRelease(window.sessionStorage, ids);
    };
    const onPageHide = (event: PageTransitionEvent) => {
      if (event.persisted) return;
      stashControlled();
    };
    window.addEventListener("beforeunload", stashControlled);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("beforeunload", stashControlled);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [controlLeases, deviceId]);

  const zoomedTerminalIdRef = useRef<string | null>(layout.zoomedTerminalId);
  useEffect(() => {
    zoomedTerminalIdRef.current = layout.zoomedTerminalId;
  }, [layout.zoomedTerminalId]);

  useEffect(() => {
    if (!bootstrapReady || !deviceId) return;
    const ws = openSocket(eventsWsUrl(deviceId, lastSeqRef.current));
    let disposed = false;
    let pingTimer: ReturnType<typeof window.setInterval> | null = null;

    const clearPingTimer = () => {
      if (pingTimer !== null) {
        window.clearInterval(pingTimer);
        pingTimer = null;
      }
    };

    const sendPing = () => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "ping", t: Math.round(performance.now()) }));
    };

    const reconnect = () => {
      if (disposed) return;
      setBootstrapReady(false);
      setReconnectGeneration((value) => value + 1);
    };

    const reconnectController = createTerminalReconnectController<
      ReturnType<typeof setTimeout>
    >({
      delayMs: 1000,
      openReadyState: WebSocket.OPEN,
      onReconnect: reconnect,
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    });

    ws.onmessage = (event) => {
      try {
        const envelope = JSON.parse(event.data);
        if (envelope?.type === "pong" && typeof envelope.t === "number") {
          const sample = performance.now() - envelope.t;
          if (Number.isFinite(sample) && sample >= 0) {
            setRttMs((current) =>
              current === null ? sample : current * 0.7 + sample * 0.3,
            );
          }
          return;
        }
        let needsResync = false;
        setBrowserState((prev) => {
          if (shouldResyncForEnvelope(prev, envelope)) {
            needsResync = true;
            return prev;
          }
          const next = applyBrowserEventEnvelope(prev, envelope);
          if (
            next !== prev &&
            envelope.event?.type === "terminal_destroyed"
          ) {
            const keepWorkspaceOpen =
              keepWorkspaceOpenDestroyedTerminalIdsRef.current.delete(
                envelope.event.terminal_id,
              );
            if (!keepWorkspaceOpen) {
              dispatchLayout({
                type: "TERMINAL_DESTROYED",
                terminalId: envelope.event.terminal_id,
              });
            }
            if (zoomedTerminalIdRef.current === envelope.event.terminal_id) {
              window.history.replaceState(null, "", window.location.pathname);
            }
          }
          return next;
        });
        if (needsResync) ws.close();
      } catch {
        /* ignore malformed events */
      }
    };

    ws.onopen = () => {
      reconnectController.handleSocketOpen();
      setEventsReconnecting(false);
      clearPingTimer();
      sendPing();
      pingTimer = window.setInterval(sendPing, 5000);
    };

    ws.onclose = () => {
      if (disposed) return;
      clearPingTimer();
      setEventsReconnecting(true);
      reconnectController.scheduleReconnect();
    };

    const onVisibility = () => {
      reconnectController.handleVisibilityChange(
        document.visibilityState,
        ws.readyState,
      );
      setEventsReconnecting(reconnectController.hasPendingReconnect());
    };
    const onPageShow = () => {
      reconnectController.handleVisibilityChange("visible", ws.readyState);
      setEventsReconnecting(reconnectController.hasPendingReconnect());
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      clearPingTimer();
      reconnectController.cancelReconnect();
      ws.onclose = null;
      ws.close();
    };
  }, [bootstrapReady, deviceId]);

  // ---- handlers ----

  const activeMachine = activeMachineId
    ? machines.find((m) => m.id === activeMachineId) ?? null
    : machines[0] ?? null;
  const activeStats = activeMachine ? machineStats[activeMachine.id] : undefined;

  const scopeBookmark =
    layout.selectedWorkpathId === "all" || !activeMachine
      ? null
      : bookmarks.find(
          (b) =>
            b.id === layout.selectedWorkpathId &&
            b.machine_id === activeMachine.id,
        ) ?? null;

  useEffect(() => {
    if (layout.selectedWorkpathId === "all" || !activeMachine) return;
    const selectedExistsOnActiveMachine = bookmarks.some(
      (bookmark) =>
        bookmark.id === layout.selectedWorkpathId &&
        bookmark.machine_id === activeMachine.id,
    );
    if (!selectedExistsOnActiveMachine) {
      dispatchLayout({ type: "SELECT_WORKPATH", workpathId: "all" });
    }
  }, [activeMachine, bookmarks, layout.selectedWorkpathId]);

  const scopedTerminals = useMemo<TerminalInfo[]>(() => {
    if (!activeMachine) return [];
    return terminals.filter((t) => t.machine_id === activeMachine.id);
  }, [terminals, activeMachine]);

  const activeMachineWorkspaceGroups = useMemo<WorkspaceGroupInfo[]>(() => {
    if (!activeMachine) return [];
    return workspaceGroups.filter((group) => group.machine_id === activeMachine.id);
  }, [workspaceGroups, activeMachine]);

  const activeMachineWorkspaceLayouts = useMemo<WorkspaceLayoutInfo[]>(() => {
    if (!activeMachine) return [];
    return workspaceLayouts.filter(
      (layout) => layout.machine_id === activeMachine.id,
    );
  }, [workspaceLayouts, activeMachine]);

  // ---- desktop TabBar / command palette state (Phase 2) ----
  // Same grouping the workspace computes (persistent groups + cwd fallback),
  // derived here so the TabBar can render above the workspace.
  const scopedTerminalsById = useMemo(
    () => new Map(scopedTerminals.map((t) => [t.id, t])),
    [scopedTerminals],
  );
  const tabGroups = useMemo(
    () =>
      createTerminalWorkspace(
        scopedTerminals,
        null,
        activeMachineWorkspaceGroups,
        activeMachineWorkspaceLayouts,
      ).groups,
    [scopedTerminals, activeMachineWorkspaceGroups, activeMachineWorkspaceLayouts],
  );
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const workspaceCommandsRef = useRef<WorkspaceCommandChannel>({});
  const [paletteState, setPaletteState] = useState<{
    open: boolean;
    filter: PaletteFilter;
  }>({ open: false, filter: "all" });
  const openPalette = useCallback(
    (filter: PaletteFilter = "all") => setPaletteState({ open: true, filter }),
    [],
  );

  const expandedTerminal = layout.zoomedTerminalId
    ? terminals.find((t) => t.id === layout.zoomedTerminalId) ?? null
    : null;
  const workspaceTerminal = useMemo(() => {
    if (expandedTerminal) return expandedTerminal;
    if (workspaceAnchorTerminal?.machine_id === activeMachine?.id)
      return workspaceAnchorTerminal;
    return scopedTerminals[0] ?? null;
  }, [
    expandedTerminal,
    workspaceAnchorTerminal,
    activeMachine,
    scopedTerminals,
  ]);

  useEffect(() => {
    if (!bootstrapReady || handoffLandingHandledRef.current) return;
    handoffLandingHandledRef.current = true;

    if (window.location.hash.startsWith("#/t/")) {
      // A shortcut may point to another machine. Restore that machine too;
      // otherwise reloading leaves the selected pane outside the active tab list.
      const linked = terminals.find(t => t.id === window.location.hash.slice(4));
      if (linked) setActiveMachineId(linked.machine_id);
      return;
    }
    const terminalId = browserState.lastFocusedTerminalId;
    if (!terminalId) return;
    const terminal = terminals.find((item) => item.id === terminalId);
    if (!terminal) return;

    if (activeMachineId !== terminal.machine_id) {
      setActiveMachineId(terminal.machine_id);
    }
    dispatchLayout({ type: "ZOOM_TERMINAL", terminalId });
    window.history.replaceState(null, "", `#/t/${terminalId}`);
    if (!wasRecentlyFocusedByThisSession(terminalId)) {
      setShowHandoffBanner(true);
    }
  }, [
    activeMachineId,
    bootstrapReady,
    browserState.lastFocusedTerminalId,
    terminals,
  ]);

  useEffect(() => {
    if (!bootstrapReady || !deviceId || !workspaceTerminal) return;
    if (lastSentFocusTerminalIdRef.current === workspaceTerminal.id) return;

    const terminalId = workspaceTerminal.id;
    const machineId = workspaceTerminal.machine_id;
    const timer = window.setTimeout(() => {
      recordLastFocusPut(terminalId);
      lastSentFocusTerminalIdRef.current = terminalId;
      void putFocus(terminalId, machineId).catch(() => {
        if (lastSentFocusTerminalIdRef.current === terminalId) {
          lastSentFocusTerminalIdRef.current = null;
        }
      });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [bootstrapReady, deviceId, workspaceTerminal]);

  useEffect(() => {
    if (expandedTerminal) {
      setWorkspaceAnchorTerminal(expandedTerminal);
    }
  }, [expandedTerminal]);

  const handleCreateTerminal = useCallback(
    async (
      machineId: string,
      cwd: string,
      startupCommand?: string,
      options: CreateTerminalOptions = {},
    ) => {
      if (!deviceId) return null;
      if (!isMachineController(machineId)) return null;
      // Estimate initial cols/rows from the current viewport so the tmux
      // session is born at roughly the size it will be displayed at.
      // Without this the server defaults to 80x24 and TUIs (notably Claude
      // Code / Ink) paint their welcome banner narrow; a later manual fit
      // cannot repaint that static content.
      const viewportHeightPx = viewportHeight ?? window.innerHeight;
      const { cols, rows } = isCompact
        ? estimateMobileInitialTerminalDimensions(
            window.innerWidth,
            viewportHeightPx,
          )
        : estimateInitialTerminalDimensions(window.innerWidth, viewportHeightPx);
      const newTerminal = await createTerminal(
        machineId,
        cwd,
        deviceId,
        startupCommand,
        cols,
        rows,
        options.workspaceGroupId ?? null,
      );
      setBrowserState((prev) => ({
        ...prev,
        terminals: upsertTerminalInfo(prev.terminals, newTerminal),
      }));
      // A terminal created without a tab comes back in one the hub just made.
      // Its row also arrives as workspace_group_created, but that event can
      // trail this response — until it lands the strip would render the
      // terminal in a derived cwd tab, which then jumps as the real tab
      // appears. Pulling the tabs closes that window.
      if (!options.workspaceGroupId && newTerminal.workspace_group_id) {
        try {
          const groups = await listWorkspaceGroups(machineId);
          setBrowserState((prev) => ({
            ...prev,
            workspaceGroups: replaceMachineWorkspaceGroups(
              prev.workspaceGroups,
              machineId,
              groups,
            ),
          }));
        } catch {
          /* the workspace_group_created event still fills the tab in */
        }
      }
      if (options.selectWorkpath === false) {
        dispatchLayout({
          type: "ZOOM_TERMINAL",
          terminalId: newTerminal.id,
        });
      } else {
        dispatchLayout({
          type: "TERMINAL_CREATED",
          terminalId: newTerminal.id,
          workpathId:
            bookmarks.find((b) => b.machine_id === machineId && b.path === cwd)
              ?.id ?? layout.selectedWorkpathId,
        });
      }
      window.history.pushState(null, "", `#/t/${newTerminal.id}`);
      return newTerminal;
    },
    [
      deviceId,
      isMachineController,
      bookmarks,
      isCompact,
      layout.selectedWorkpathId,
      viewportHeight,
    ],
  );

  const handleRequestControl = useCallback(
    async (machineId: string) => {
      if (!deviceId) return;
      const next = await requestControl(machineId, deviceId);
      setBrowserState((prev) => ({
        ...prev,
        controlLeases: next.controller_device_id
          ? {
              ...prev.controlLeases,
              [machineId]: next.controller_device_id,
            }
          : prev.controlLeases,
      }));
    },
    [deviceId],
  );

  const handleReleaseControl = useCallback(
    async (machineId: string) => {
      if (!deviceId) return;
      const next = await releaseControl(machineId, deviceId);
      setBrowserState((prev) => ({
        ...prev,
        controlLeases: next.controller_device_id
          ? {
              ...prev.controlLeases,
              [machineId]: next.controller_device_id,
            }
          : Object.fromEntries(
              Object.entries(prev.controlLeases).filter(
                ([key]) => key !== machineId,
              ),
            ),
      }));
    },
    [deviceId],
  );

  const handleEngageViewOnly = useCallback(
    (machineId: string) => {
      updateViewOnlyLock(true);
      if (isMachineController(machineId)) {
        void handleReleaseControl(machineId);
      }
    },
    [handleReleaseControl, isMachineController, updateViewOnlyLock],
  );

  const handleDisengageViewOnly = useCallback(() => {
    updateViewOnlyLock(false);
  }, [updateViewOnlyLock]);

  const handleDestroyTerminal = useCallback(
    async (
      terminal: TerminalInfo,
      options: DestroyTerminalOptions = {},
    ): Promise<DestroyTerminalRequestResult> => {
      if (!deviceId) return "pending";
      if (!isMachineController(terminal.machine_id)) return "pending";
      try {
        const result = await checkForegroundProcess(
          terminal.machine_id,
          terminal.id,
        );
        if (result.has_foreground_process) {
          setCloseConfirmation({
            terminal,
            processName: result.process_name ?? "unknown",
            options,
          });
          return "pending";
        }
      } catch {
        /* fall through */
      }
      if (options.keepWorkspaceOpen) {
        keepWorkspaceOpenDestroyedTerminalIdsRef.current.add(terminal.id);
        setWorkspaceAnchorTerminal(terminal);
      }
      try {
        await destroyTerminal(terminal.machine_id, terminal.id, deviceId);
      } catch (error) {
        keepWorkspaceOpenDestroyedTerminalIdsRef.current.delete(terminal.id);
        throw error;
      }
      return "accepted";
    },
    [deviceId, isMachineController],
  );

  const confirmClosePending = useCallback(async () => {
    if (!closeConfirmation || !deviceId) return;
    const { terminal, options } = closeConfirmation;
    setCloseConfirmation(null);
    if (options?.keepWorkspaceOpen) {
      keepWorkspaceOpenDestroyedTerminalIdsRef.current.add(terminal.id);
      setWorkspaceAnchorTerminal(terminal);
    }
    try {
      await destroyTerminal(terminal.machine_id, terminal.id, deviceId);
    } catch (error) {
      keepWorkspaceOpenDestroyedTerminalIdsRef.current.delete(terminal.id);
      throw error;
    }
    options?.afterAccepted?.();
  }, [closeConfirmation, deviceId]);

  const handleZoomTerminal = useCallback((id: string) => {
    dispatchLayout({ type: "ZOOM_TERMINAL", terminalId: id });
    window.history.pushState(null, "", `#/t/${id}`);
  }, []);

  // Create a tab named after the first free "tab N" slot and select it. The
  // group also arrives via workspace_group_created; selecting by the response
  // id is safe either way (selection is id-based).
  const createTab = useCallback(
    async (machineId: string) => {
      const taken = new Set(tabGroups.map((group) => group.label));
      let n = tabGroups.length + 1;
      while (taken.has(`tab ${n}`)) n += 1;
      const created = await createWorkspaceGroup(machineId, `tab ${n}`);
      workspaceCommandsRef.current.selectGroup?.(created.id);
      return created;
    },
    [tabGroups],
  );

  // Which tab a new terminal is created in; null hands the choice to the hub,
  // which opens a fresh tab named after the cwd. A tab renders every one of its
  // terminals as a split pane on desktop, so a full target overflows into a
  // fresh tab instead of growing past MAX_PANES_PER_TAB. Creating a terminal
  // therefore never fails on a full tab (mobile has no split view and no
  // other way out); splits refuse instead — see TerminalWorkspace.handleSplit.
  const resolveNewTerminalGroupId = useCallback(
    async (machineId: string, cwd: string, tabId: string | null) => {
      const placement = planNewTerminalPlacement(tabGroups, { tabId, cwd });
      if (!placement.needsNewTab) return placement.workspaceGroupId;
      const created = await createTab(machineId);
      return created.id;
    },
    [createTab, tabGroups],
  );

  const handleSplitWorkspacePane = useCallback(
    async (
      terminal: TerminalInfo,
      _direction: WorkspaceSplitIntent,
      workspaceGroupId: string | null,
    ) => {
      return handleCreateTerminal(terminal.machine_id, terminal.cwd, undefined, {
        selectWorkpath: false,
        workspaceGroupId,
      });
    },
    [handleCreateTerminal],
  );

  const handleCreateWorkspacePane = useCallback(
    async (input: {
      machineId: string;
      cwd: string;
      workspaceGroupId: string | null;
    }) => {
      return handleCreateTerminal(input.machineId, input.cwd, undefined, {
        selectWorkpath: false,
        workspaceGroupId: input.workspaceGroupId,
      });
    },
    [handleCreateTerminal],
  );

  // Mobile title-bar actions: ＋ / "New terminal here" create in the
  // group's cwd (machine home when there is no group); chip close goes
  // through the shared destroy flow (running-process confirm included).
  const handleMobileNewTerminal = useCallback(
    (group: WorkspaceGroup | null) => {
      if (!activeMachine) return;
      const machineId = activeMachine.id;
      const cwd = group?.cwd || activeMachine.home_dir || "~";
      void (async () => {
        // Mobile shows one terminal at a time, so it never splits — but its
        // terminals are panes of the same tab on desktop. A full tab overflows
        // into a new one, which keeps the desktop grid at four panes without
        // ever refusing a mobile "＋".
        const workspaceGroupId = await resolveNewTerminalGroupId(
          machineId,
          cwd,
          group?.id ?? null,
        );
        await handleCreateWorkspacePane({ machineId, cwd, workspaceGroupId });
      })().catch((error) => {
        console.error("Failed to create terminal", error);
      });
    },
    [activeMachine, handleCreateWorkspacePane, resolveNewTerminalGroupId],
  );

  const handleMobileCloseTerminal = useCallback(
    (target: TerminalInfo) => {
      // Closing the active terminal moves to its strip-order neighbor so the
      // shell doesn't land on an empty-group view. `wasActive` is captured
      // synchronously: the terminal_destroyed event may clear the zoom
      // before the destroy promise settles, which must not suppress the
      // fallback pick.
      const wasActive = zoomedTerminalIdRef.current === target.id;
      const ids = collectGroupPaneTerminalIds(tabGroups).filter((id) =>
        scopedTerminalsById.has(id),
      );
      const index = ids.indexOf(target.id);
      const nextId =
        index === -1 ? null : (ids[index + 1] ?? ids[index - 1] ?? null);
      const pickFallback = () => {
        if (!wasActive || !nextId) return;
        handleZoomTerminal(nextId);
      };
      void (async () => {
        try {
          const result = await handleDestroyTerminal(target, {
            afterAccepted: pickFallback,
          });
          if (result === "accepted") pickFallback();
        } catch (error) {
          console.error("Failed to close terminal", error);
        }
      })();
    },
    [
      handleDestroyTerminal,
      handleZoomTerminal,
      scopedTerminalsById,
      tabGroups,
    ],
  );

  const handleReorderWorkspaceGroups = useCallback(
    async (machineId: string, groupIds: string[]) => {
      const groups = await reorderWorkspaceGroups(machineId, groupIds);
      setBrowserState((prev) => ({
        ...prev,
        workspaceGroups: replaceMachineWorkspaceGroups(
          prev.workspaceGroups,
          machineId,
          groups,
        ),
      }));
      return groups;
    },
    [],
  );

  const handleRequestWorkspaceGroupReorder = useCallback(
    (
      sourceGroupId: string,
      targetGroupId: string,
      placement: "before" | "after",
    ) => {
      const workspaceHandler = workspaceCommandsRef.current.reorderGroups;
      if (workspaceHandler) {
        workspaceHandler(sourceGroupId, targetGroupId, placement);
        return;
      }
      // With no mounted TerminalWorkspace every visible group is an empty,
      // persistent row, so the manager can still reorder them directly.
      if (!activeMachineId) return;
      const groupIds = buildReorderPersistentGroupIds(
        tabGroups,
        sourceGroupId,
        targetGroupId,
        placement,
      );
      if (!groupIds) return;
      void handleReorderWorkspaceGroups(activeMachineId, groupIds);
    },
    [activeMachineId, handleReorderWorkspaceGroups, tabGroups],
  );

  const handleSaveWorkspaceLayout = useCallback(
    async (
      machineId: string,
      groupKey: string,
      root: WorkspaceLayoutNode | null,
    ) => {
      const baseUpdatedAt =
        workspaceLayoutsRef.current.find(
          (layout) =>
            layout.machine_id === machineId && layout.group_key === groupKey,
        )?.updated_at ?? null;
      const saved = await saveWorkspaceLayout(
        machineId,
        groupKey,
        root,
        baseUpdatedAt,
      );
      setBrowserState((prev) => ({
        ...prev,
        workspaceLayouts: (() => {
          const next = upsertWorkspaceLayoutInfo(prev.workspaceLayouts, saved);
          workspaceLayoutsRef.current = next;
          return next;
        })(),
      }));
      return saved;
    },
    [],
  );

  const handleAssignWorkspaceGroup = useCallback(
    async (terminal: TerminalInfo, workspaceGroupId: string | null) => {
      try {
        const updated = await assignTerminalWorkspaceGroup(
          terminal.machine_id,
          terminal.id,
          workspaceGroupId,
        );
        setBrowserState((prev) => ({
          ...prev,
          terminals: upsertTerminalInfo(prev.terminals, updated),
        }));
      } catch (error) {
        // The hub refuses a move into a tab already at the pane cap. The menu
        // greys those tabs out, so this is the stale-view case (another device
        // filled the tab first) — it must not fail silently.
        console.error("Failed to move pane to tab", error);
        const message = String(error);
        showWorkspaceToast(
          message.includes("409")
            ? `That tab is full (${MAX_PANES_PER_TAB} panes max).`
            : "Couldn't move the pane to that tab.",
        );
      }
    },
    [],
  );

  const handleMoveTerminalToWorkspace = useCallback(
    (terminal: TerminalInfo, targetGroup: WorkspaceGroup) => {
      if (!targetGroup.workspaceGroupId) return;
      void handleAssignWorkspaceGroup(terminal, targetGroup.workspaceGroupId);
    },
    [handleAssignWorkspaceGroup],
  );

  // Promote a cwd fallback tab to a persistent group: create the
  // workspace_groups row named after the fallback label, then move the tab's
  // terminals into it (same state-upsert pattern as
  // handleAssignWorkspaceGroup). The created group row itself arrives via
  // workspace_group_created.
  const handlePromoteWorkspaceGroup = useCallback(
    async (
      machineId: string,
      name: string,
      terminalIds: string[],
    ): Promise<WorkspaceGroupInfo | null> => {
      const created = await createWorkspaceGroup(machineId, name);
      for (const terminalId of terminalIds) {
        const updated = await assignTerminalWorkspaceGroup(
          machineId,
          terminalId,
          created.id,
        );
        setBrowserState((prev) => ({
          ...prev,
          terminals: upsertTerminalInfo(prev.terminals, updated),
        }));
      }
      return created;
    },
    [],
  );

  const handleNewTerminalFromHeader = useCallback(async () => {
    if (!activeMachine || !deviceId) return;
    if (!isMachineController(activeMachine.id)) return;
    const cwd =
      layout.selectedWorkpathId === "all" || !scopeBookmark
        ? activeMachine.home_dir || "~"
        : scopeBookmark.path;
    // No tab in mind: the hub gives the terminal a fresh tab named after its
    // cwd, appended to the end of the strip.
    const workspaceGroupId = await resolveNewTerminalGroupId(
      activeMachine.id,
      cwd,
      null,
    );
    await handleCreateTerminal(activeMachine.id, cwd, undefined, {
      workspaceGroupId,
    });
  }, [
    activeMachine,
    deviceId,
    isMachineController,
    handleCreateTerminal,
    layout.selectedWorkpathId,
    resolveNewTerminalGroupId,
    scopeBookmark,
  ]);

  const handleNewGroup = useCallback(async () => {
    if (!activeMachineId || !isActiveController) return;
    await createTab(activeMachineId);
  }, [activeMachineId, createTab, isActiveController]);

  const performDeleteGroup = useCallback(
    async (group: WorkspaceGroup) => {
      if (!activeMachineId || !group.workspaceGroupId) return;
      await deleteWorkspaceGroup(activeMachineId, group.workspaceGroupId);
      // Panes fall back to their cwd groups server-side; nothing to do here.
    },
    [activeMachineId],
  );

  // The other answer to "close this workspace": end its terminals. The
  // person chose this in a dialog that named the count, so no per-terminal
  // foreground-process prompt on top; then the empty group goes too.
  const performCloseGroupTerminals = useCallback(
    async (group: WorkspaceGroup) => {
      if (!activeMachineId || !deviceId) return;
      const ids = new Set(collectGroupPaneTerminalIds([group]));
      const doomed = terminals.filter(
        (terminal) => terminal.machine_id === activeMachineId && ids.has(terminal.id),
      );
      await Promise.allSettled(
        doomed.map((terminal) => destroyTerminal(terminal.machine_id, terminal.id, deviceId)),
      );
      if (group.workspaceGroupId) {
        await deleteWorkspaceGroup(activeMachineId, group.workspaceGroupId).catch(() => {
          /* an auto group deletes itself once empty */
        });
      }
    },
    [activeMachineId, deviceId, terminals],
  );

  const performRenameGroup = useCallback(
    async (group: WorkspaceGroup, name: string) => {
      if (!activeMachineId || !group.workspaceGroupId) return;
      await renameWorkspaceGroup(activeMachineId, group.workspaceGroupId, name);
      // The renamed group arrives via workspace_group_updated; nothing to do
      // here.
    },
    [activeMachineId],
  );

  const handleNewGroupClick = useCallback(() => {
    void handleNewGroup();
  }, [handleNewGroup]);

  const handleDeleteGroup = useCallback(
    (group: WorkspaceGroup) => {
      if (!isActiveController) return;
      if (group.paneCount > 0) {
        setGroupDeleteConfirmation(group);
        return;
      }
      void performDeleteGroup(group);
    },
    [isActiveController, performDeleteGroup],
  );

  const handleRenameGroup = useCallback(
    (group: WorkspaceGroup) => {
      if (!isActiveController || !group.persistent) return;
      setGroupRenameTarget(group);
    },
    [isActiveController],
  );

  // ---- prefix-key shortcut engine (⌃B) ----
  // The engine singleton lives in PrefixKeyProvider; this window listener is
  // the only place keydowns enter it. Workspace-owned actions (splits, pane
  // focus, group tabs, zoom/close pane, literal ⌃B) are registered by
  // TerminalWorkspace into the same dispatcher.
  const prefixKey = usePrefixKey();
  const prefixKeyRef = useRef(prefixKey);
  useEffect(() => {
    prefixKeyRef.current = prefixKey;
  }, [prefixKey]);
  const [cheatSheetOpen, setCheatSheetOpen] = useState(false);

  const canvasPrefixActionsRef = useRef<
    Partial<Record<PrefixActionId, () => void>>
  >({});
  canvasPrefixActionsRef.current = {
    newTerminal: isActiveController
      ? () => void handleNewTerminalFromHeader()
      : undefined,
    cheatSheet: () => setCheatSheetOpen((open) => !open),
    // ⌃B w opens the palette pre-filtered to tab rows, ⌃B s to host rows,
    // ⌃B k to the full palette.
    sessionSwitcher: () => openPalette("tabs"),
    switchHost: () => openPalette("hosts"),
    commandPalette: () => openPalette("all"),
    // TODO(phase 3+): copy mode. Registered as a no-op so armed + key is
    // swallowed, not typed.
    copyMode: () => {},
  };

  useEffect(() => {
    for (const action of CANVAS_PREFIX_ACTIONS) {
      prefixKeyRef.current.setActionHandler(action, () =>
        canvasPrefixActionsRef.current[action]?.(),
      );
    }
    return () => {
      for (const action of CANVAS_PREFIX_ACTIONS) {
        prefixKeyRef.current.clearActionHandler(action);
      }
    };
  }, []);

  useEffect(() => {
    if (isCompact) return;
    const onKeydown = (event: KeyboardEvent) => {
      const insideTerminal =
        event.target instanceof Element &&
        Boolean(event.target.closest(".xterm"));
      if (!insideTerminal && isEditableShortcutTarget(event.target)) return;
      const result = prefixKeyRef.current.handleKeydown(event);
      if (result.type === "pass") return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [isCompact]);

  // Esc unzooms the expanded view, unless focus is inside xterm (which needs
  // Esc for its own bindings — the expanded overlay handles that case).
  // Compact chrome has no overlay to dismiss.
  useEffect(() => {
    if (isCompact || !layout.zoomedTerminalId) return;
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey
      ) {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".xterm")) return;
        dispatchLayout({ type: "UNZOOM" });
        window.history.pushState(null, "", window.location.pathname);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isCompact, layout.zoomedTerminalId]);

  // ---- render ----

  const scopeLabel = useMemo(() => {
    if (layout.selectedWorkpathId === "all" || !activeMachine) return "All";
    return (
      bookmarks.find(
        (b) =>
          b.id === layout.selectedWorkpathId && b.machine_id === activeMachine.id,
      )?.label ?? "All"
    );
  }, [layout.selectedWorkpathId, activeMachine, bookmarks]);

  // Command palette rows, in the spec's fixed order. Workspace-owned actions
  // (splits, tab selection) go through the workspace command channel.
  const paletteRows = useMemo<PaletteRow[]>(() => {
    const bindings = loadPrefixBindings();
    const otherOnlineMachines = machines.filter(
      (machine) =>
        machine.id !== activeMachine?.id &&
        (Boolean(machineStats[machine.id]) ||
          terminals.some((t) => t.machine_id === machine.id && t.reachable)),
    );
    return [
      {
        id: "new-terminal",
        section: "actions",
        label: "New terminal",
        hint: formatPrefixBinding("newTerminal", bindings),
        disabled: !isActiveController,
        action: () => void handleNewTerminalFromHeader(),
      },
      {
        id: "new-tab",
        section: "actions",
        label: "New tab",
        keywords: "group workspace tab",
        disabled: !isActiveController,
        action: () => void handleNewGroup(),
      },
      {
        id: "split-right",
        section: "actions",
        label: "Split right",
        hint: formatPrefixBinding("splitRight", bindings),
        disabled: !isActiveController,
        action: () =>
          workspaceCommandsRef.current.runPrefixAction?.("splitRight"),
      },
      {
        id: "split-down",
        section: "actions",
        label: "Split down",
        hint: formatPrefixBinding("splitDown", bindings),
        disabled: !isActiveController,
        action: () =>
          workspaceCommandsRef.current.runPrefixAction?.("splitDown"),
      },
      {
        id: "rotate-layout",
        section: "actions",
        label: "Rotate layout",
        hint: formatPrefixBinding("rotateLayout", bindings),
        disabled: !isActiveController,
        action: () =>
          workspaceCommandsRef.current.runPrefixAction?.("rotateLayout"),
      },
      ...tabGroups.map((group, index): PaletteRow => {
        const tabAction = `selectTab${index + 1}` as PrefixActionId;
        return {
          id: `tab-${group.id}`,
          section: "tabs",
          label: group.label,
          keywords: group.cwd,
          hint:
            index < 9 ? formatPrefixBinding(tabAction, bindings) : undefined,
          action: () => workspaceCommandsRef.current.selectGroup?.(group.id),
        };
      }),
      ...otherOnlineMachines.map(
        (machine): PaletteRow => ({
          id: `host-${machine.id}`,
          section: "hosts",
          label: machine.name,
          keywords: machine.os,
          action: () => setActiveMachineId(machine.id),
        }),
      ),
      {
        id: "add-host",
        section: "actions",
        label: "Add a machine…",
        action: () => setAddMachineOpen(true),
      },
      {
        id: "reconnect",
        section: "actions",
        label: "Reconnect",
        action: () => window.location.reload(),
      },
      {
        id: "settings",
        section: "actions",
        label: "Settings",
        action: () => setShowSettings(true),
      },
      {
        id: "sign-out",
        section: "actions",
        label: "Sign out",
        action: () => void logout(),
      },
    ];
  }, [
    machines,
    activeMachine,
    machineStats,
    terminals,
    tabGroups,
    isActiveController,
    handleNewTerminalFromHeader,
    handleNewGroup,
    logout,
  ]);

  return (
    <div
      data-testid="terminal-canvas"
      style={{
        // iOS can pan the visual viewport while focusing ANY field. Anchor
        // the app chrome to its visible top, not the scrolled document. Keep
        // deliberate pinch zoom independent of keyboard layout changes.
        position: "fixed",
        top: viewport && Math.abs(viewport.scale - 1) < 0.01 ? viewport.offsetTop : 0,
        left: 0,
        display: "flex",
        flexDirection: "column",
        height: rootHeight,
        width: "100vw",
        overflow: "hidden",
        background: colors.bg0,
      }}
    >
      <AppTitleBar isMobile={isCompact} onOpenSettings={machines.length === 0 ? () => setShowSettings(true) : undefined} />

      <TerminalPreviewMuxProvider deviceId={deviceId}>
        <div
          style={{
            display: "flex",
            flex: 1,
            overflow: "hidden",
            position: "relative",
          }}
        >
          {showSettings ? (
            <Suspense fallback={<LazyLoadingFallback />}>
              <SettingsPage onClose={() => setShowSettings(false)} />
            </Suspense>
          ) : machines.length === 0 ? (
            <Suspense fallback={<LazyLoadingFallback />}>
              <OnboardingView />
            </Suspense>
          ) : isCompact ? (
            <MobileWorkbench
              machines={machines}
              activeMachineId={activeMachineId}
              controlLeases={controlLeases}
              deviceId={deviceId}
              machineStats={machineStats}
              rttMs={rttMs}
              terminals={terminals}
              groups={tabGroups}
              activeTerminalId={workspaceTerminal?.id ?? null}
              canCreateTerminal={isActiveController}
              onPickTerminal={handleZoomTerminal}
              onSelectGroup={(groupId) =>
                workspaceCommandsRef.current.selectGroup?.(groupId)
              }
              onNewTerminal={handleMobileNewTerminal}
              onCloseTerminal={handleMobileCloseTerminal}
              onNewGroup={handleNewGroupClick}
              onRenameGroup={handleRenameGroup}
              onDeleteGroup={handleDeleteGroup}
              onReorderGroups={handleRequestWorkspaceGroupReorder}
              onMoveTerminal={handleMoveTerminalToWorkspace}
              onSelectMachine={setActiveMachineId}
              onAddMachine={() => setAddMachineOpen(true)}
              onRemoveHost={handleRemoveHost}
              onRequestControl={handleRequestControl}
              viewOnlyLocked={viewOnlyLocked}
              onEngageViewOnly={handleEngageViewOnly}
              onDisengageViewOnly={handleDisengageViewOnly}
              onOpenSettings={() => setShowSettings(true)}
            >
              {scopedTerminals.length > 0 && workspaceTerminal?.machine_id === activeMachine?.id && workspaceTerminal ? (
                <TerminalWorkspace
                  key={workspaceTerminal.machine_id}
                  terminal={workspaceTerminal}
                  siblings={scopedTerminals}
                  workspaceGroups={activeMachineWorkspaceGroups}
                  workspaceLayouts={activeMachineWorkspaceLayouts}
                  isController={isMachineController(workspaceTerminal.machine_id)}
                  canType={canTypeOnMachine(workspaceTerminal.machine_id)}
                  eventsReconnecting={eventsReconnecting}
                  deviceId={deviceId ?? ""}
                  isCompact
                  isTouch={isTouch}
                  onPick={handleZoomTerminal}
                  onDestroy={handleDestroyTerminal}
                  onSplit={handleSplitWorkspacePane}
                  onCreatePane={handleCreateWorkspacePane}
                  onReorderGroups={handleReorderWorkspaceGroups}
                  onSaveWorkspaceLayout={handleSaveWorkspaceLayout}
                  onAssignGroup={handleAssignWorkspaceGroup}
                  onPromoteGroup={handlePromoteWorkspaceGroup}
                  onRequestControl={handleRequestControl}
                  onReleaseControl={handleReleaseControl}
                  commandsRef={workspaceCommandsRef}
                  onActiveGroupChange={setActiveGroupId}
                />
              ) : null}
            </MobileWorkbench>
          ) : (
            <KeyBarSlotProvider>
              <main
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  minWidth: 0,
                  background: colors.bg0,
                }}
              >
              <TabBar
                groups={tabGroups}
                activeGroupId={activeGroupId}
                activeTerminalId={workspaceTerminal?.id ?? null}
                terminalsById={scopedTerminalsById}
                terminals={terminals}
                machines={machines}
                activeMachineId={activeMachineId}
                controlLeases={controlLeases}
                deviceId={deviceId}
                machineStats={machineStats}
                stats={activeStats}
                rttMs={rttMs}
                isController={isActiveController}
                isTouch={isTouch}
                viewOnlyLocked={viewOnlyLocked}
                onSelectGroup={(groupId) =>
                  workspaceCommandsRef.current.selectGroup?.(groupId)
                }
                onSelectTerminal={handleZoomTerminal}
                onNewGroup={handleNewGroupClick}
                onNewTerminal={handleMobileNewTerminal}
                onCloseTerminal={handleMobileCloseTerminal}
                onMoveTerminal={handleMoveTerminalToWorkspace}
                onRenameGroup={handleRenameGroup}
                onDeleteGroup={handleDeleteGroup}
                onReorderGroups={handleRequestWorkspaceGroupReorder}
                onSelectMachine={setActiveMachineId}
                onAddMachine={() => setAddMachineOpen(true)}
                onOpenPhone={() => setPhoneOpen(true)}
                onOpenSettings={() => setShowSettings(true)}
                onRemoveHost={handleRemoveHost}
                onRequestControl={() => {
                  if (activeMachine) void handleRequestControl(activeMachine.id);
                }}
                onEngageViewOnly={() => {
                  if (activeMachine) handleEngageViewOnly(activeMachine.id);
                }}
                onDisengageViewOnly={handleDisengageViewOnly}
              />
              {!phoneHintDismissed && machines.length > 0 && (
                <div
                  data-testid="phone-hint"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "6px 12px",
                    borderBottom: `1px solid ${colors.border}`,
                    background: colors.surface,
                    color: colors.foregroundSecondary,
                    fontSize: 12,
                    flexShrink: 0,
                  }}
                >
                  <span style={{ flex: 1 }}>
                    Your phone can open these same terminals — scan a code, nothing
                    to type.
                  </span>
                  <button
                    type="button"
                    onClick={() => setPhoneOpen(true)}
                    style={{
                      background: colors.accent,
                      border: "none",
                      borderRadius: 6,
                      color: colors.onAccent,
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                      padding: "4px 10px",
                    }}
                  >
                    Show me
                  </button>
                  <button
                    type="button"
                    onClick={dismissPhoneHint}
                    aria-label="Dismiss"
                    style={{
                      background: "transparent",
                      border: "none",
                      color: colors.foregroundMuted,
                      cursor: "pointer",
                      fontSize: 14,
                      padding: "0 4px",
                    }}
                  >
                    ×
                  </button>
                </div>
              )}

              {scopedTerminals.length === 0 ? (
                <EmptyState
                  scopeLabel={scopeLabel}
                  canCreate={isActiveController}
                  onNewTerminal={handleNewTerminalFromHeader}
                />
              ) : (
                <TerminalWorkspace
                  terminal={workspaceTerminal!}
                  siblings={
                    scopedTerminals.length > 0
                      ? scopedTerminals
                      : workspaceTerminal
                        ? [workspaceTerminal]
                        : []
                  }
                  workspaceGroups={activeMachineWorkspaceGroups}
                  workspaceLayouts={activeMachineWorkspaceLayouts}
                  isController={isMachineController(workspaceTerminal!.machine_id)}
                  canType={canTypeOnMachine(workspaceTerminal!.machine_id)}
                  eventsReconnecting={eventsReconnecting}
                  deviceId={deviceId ?? ""}
                  isCompact={isCompact}
                  isTouch={isTouch}
                  onPick={handleZoomTerminal}
                  onDestroy={handleDestroyTerminal}
                  onSplit={handleSplitWorkspacePane}
                  onCreatePane={handleCreateWorkspacePane}
                  onReorderGroups={handleReorderWorkspaceGroups}
                  onSaveWorkspaceLayout={handleSaveWorkspaceLayout}
                  onAssignGroup={handleAssignWorkspaceGroup}
                  onPromoteGroup={handlePromoteWorkspaceGroup}
                  onRequestControl={handleRequestControl}
                  onReleaseControl={handleReleaseControl}
                  commandsRef={workspaceCommandsRef}
                  onActiveGroupChange={setActiveGroupId}
                />
              )}
              <WorkspaceKeyBarSlot />
              </main>
            </KeyBarSlotProvider>
          )}
          {showHandoffBanner && (
            <HandoffBanner
              isMobile={isCompact}
              onDone={hideHandoffBanner}
            />
          )}
        </div>

        {!isCompact && (
          // Tauri updater toast — floating bottom-right mount, replaces the
          // deleted StatusBar's slot. Renders nothing outside Tauri.
          <div style={{ position: "fixed", right: 12, bottom: isTouch ? 96 : 12, zIndex: 55 }}>
            <UpdateNotification />
          </div>
        )}

        {addMachineOpen && (
          <MachineOnboardingDialog onClose={() => setAddMachineOpen(false)} />
        )}

        {phoneOpen && <MobileAppDialog onClose={() => setPhoneOpen(false)} />}

        {!isCompact && paletteState.open && (
          <CommandPalette
            rows={paletteRows}
            filter={paletteState.filter}
            onClose={() =>
              setPaletteState((current) => ({ ...current, open: false }))
            }
          />
        )}

        {!isCompact && prefixKey.armed && (
          <div
            data-testid="prefix-armed-indicator"
            style={{
              position: "fixed",
              right: 16,
              bottom: isTouch ? 96 : 16,
              zIndex: 60,
              padding: "4px 10px",
              borderRadius: 6,
              background: colors.accent,
              color: colors.onAccent,
              fontSize: 12,
              fontWeight: 700,
              fontFamily: "var(--font-mono)",
              pointerEvents: "none",
            }}
          >
            ⌃B
          </div>
        )}

        {cheatSheetOpen && (
          <CheatSheetOverlay onClose={() => setCheatSheetOpen(false)} />
        )}

        {hostRemoveTarget && (
          <ConfirmDialog
            open
            title={`Remove ${hostRemoveTarget.name}?`}
            message={
              hostRemoveTarget.online
                ? `"${hostRemoveTarget.name}" is connected. Removing it disconnects the machine and it will not reconnect until registered again. Tabs and terminals for this machine leave offdesk.`
                : `"${hostRemoveTarget.name}" is offline. Removing it forgets the machine and its tabs and terminals. Re-register to add it back.`
            }
            confirmLabel="Remove machine"
            variant="danger"
            onConfirm={confirmRemoveHost}
            onCancel={() => setHostRemoveTarget(null)}
          />
        )}

        {groupDeleteConfirmation && (
          <ConfirmDialog
            open
            title={`Close tab "${groupDeleteConfirmation.label}"?`}
            message={`It has ${groupDeleteConfirmation.paneCount} terminal${groupDeleteConfirmation.paneCount === 1 ? "" : "s"}. Ungroup keeps them running and moves them to the tab for their directory. Close ends them.`}
            confirmLabel={`Close ${groupDeleteConfirmation.paneCount} terminal${groupDeleteConfirmation.paneCount === 1 ? "" : "s"}`}
            variant="danger"
            secondaryLabel="Ungroup"
            onSecondary={() => {
              const group = groupDeleteConfirmation;
              setGroupDeleteConfirmation(null);
              void performDeleteGroup(group);
            }}
            onConfirm={() => {
              const group = groupDeleteConfirmation;
              setGroupDeleteConfirmation(null);
              void performCloseGroupTerminals(group);
            }}
            onCancel={() => setGroupDeleteConfirmation(null)}
          />
        )}

        {groupRenameTarget && (
          <Suspense fallback={<LazyLoadingFallback />}>
            <RenameGroupDialog
              open
              initialName={groupRenameTarget.label}
              onSubmit={(name) => {
                const group = groupRenameTarget;
                setGroupRenameTarget(null);
                void performRenameGroup(group, name);
              }}
              onCancel={() => setGroupRenameTarget(null)}
            />
          </Suspense>
        )}

        {closeConfirmation && (
          <ConfirmDialog
            open
            title="Close terminal?"
            message={`"${closeConfirmation.processName}" is still running in this terminal. Closing the terminal will terminate it.`}
            confirmLabel="Close terminal"
            cancelLabel="Cancel"
            variant="danger"
            onConfirm={confirmClosePending}
            onCancel={() => setCloseConfirmation(null)}
          />
        )}
      </TerminalPreviewMuxProvider>
    </div>
  );
}

function EmptyState({
  scopeLabel,
  canCreate,
  onNewTerminal,
}: {
  scopeLabel: string;
  canCreate: boolean;
  onNewTerminal: () => void;
}) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: colors.fg3,
        fontSize: 14,
      }}
    >
      <div style={{ textAlign: "center" }}>
        <TerminalIcon size={40} style={{ opacity: 0.35 }} />
        <div style={{ marginTop: 12 }}>
          {scopeLabel === "All"
            ? "No terminals yet"
            : `No terminals in ${scopeLabel}`}
        </div>
        {canCreate && (
          <button
            data-testid="empty-new-terminal"
            onClick={onNewTerminal}
            style={{
              marginTop: 14,
              background: colors.accent,
              color: colors.onAccent,
              border: "none",
              borderRadius: 999,
              padding: "8px 14px",
              fontSize: 12,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Start terminal
          </button>
        )}
      </div>
    </div>
  );
}
