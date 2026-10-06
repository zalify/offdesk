// The live-view and control logic of one agent browser, shared by the desktop
// workspace pane and the mobile full-screen view: the viewer WebSocket
// (frame decoding, per-frame acks, reconnect), the stream size params, and
// taking / handing back control. Rendering and input mapping stay with the
// caller.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from "react";
import type { AgentBrowserInfo, AgentBrowserInputEvent } from "@offdesk/shared";
import {
  agentBrowserWsUrl,
  closeAgentBrowser,
  controlAgentBrowser,
} from "@/lib/api";
import {
  parseFrameMeta,
  type AgentBrowserFrameMeta,
} from "@/lib/agentBrowserInput";
import { getPersistentDeviceId } from "@/lib/deviceId";
import { openSocket } from "@/lib/secureTransport";
import { createTerminalReconnectController } from "@/lib/terminalReconnect";

// The agent browser's viewport is fixed at 1280x800 on the node; the stream
// is only ever downscaled to the view.
export const MAX_STREAM_WIDTH = 1280;
export const MAX_STREAM_HEIGHT = 800;
const MIN_STREAM_SIZE = 200;
export const DESKTOP_STREAM_QUALITY = 60;
export const COMPACT_STREAM_QUALITY = 50;
const PARAMS_DEBOUNCE_MS = 250;
const RECONNECT_DELAY_MS = 1000;

export type AgentBrowserStreamState =
  | "connecting"
  | "live"
  | "reconnecting"
  | "paused"
  | "closed";

export const STREAM_STATE_LABEL: Record<AgentBrowserStreamState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  paused: "Paused",
  closed: "Closed",
};

function clampSize(value: number, max: number): number {
  return Math.max(MIN_STREAM_SIZE, Math.min(max, Math.round(value)));
}

export interface AgentBrowserStream {
  deviceId: string | null;
  /** True while this device controls the browser. */
  mine: boolean;
  /** A person on another device controls it. */
  otherDevice: boolean;
  state: AgentBrowserStreamState;
  hasFrame: boolean;
  /** Meta of the frame currently drawn (viewport size, page scale). */
  metaRef: MutableRefObject<AgentBrowserFrameMeta | null>;
  sendInput: (event: AgentBrowserInputEvent) => void;
  changeControl: (action: "take" | "release") => Promise<void>;
  controlBusy: boolean;
  error: string | null;
  closing: boolean;
  /** Hands control back first when this device holds it, then closes the browser. */
  closeBrowser: () => Promise<void>;
}

/**
 * Streams only while `visible` (and the document is shown): a hidden view
 * holds no WebSocket, and the hub stops the screencast once the last viewer
 * disconnects (and hands control back to the agent if the controlling device
 * stays away for 2 minutes).
 */
export function useAgentBrowserStream({
  browser,
  visible,
  quality,
  bodyRef,
  canvasRef,
}: {
  browser: AgentBrowserInfo;
  visible: boolean;
  quality: number;
  /** Element whose size the stream is fitted to. */
  bodyRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}): AgentBrowserStream {
  const machineId = browser.machine_id ?? "";
  const browserId = browser.id;

  const wsRef = useRef<WebSocket | null>(null);
  const metaRef = useRef<AgentBrowserFrameMeta | null>(null);
  const framesRef = useRef(0);
  const paramsRef = useRef({
    max_width: MAX_STREAM_WIDTH,
    max_height: MAX_STREAM_HEIGHT,
    quality,
  });
  const sentParamsRef = useRef("");

  const [documentHidden, setDocumentHidden] = useState(
    typeof document !== "undefined" && document.hidden,
  );
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<AgentBrowserStreamState>("connecting");
  const [hasFrame, setHasFrame] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);

  const controller = browser.controller ?? "agent";
  const mine =
    controller === "human" &&
    deviceId !== null &&
    browser.controller_device_id === deviceId;
  const otherDevice = controller === "human" && !mine;

  const streaming =
    visible && !documentHidden && machineId !== "" && deviceId !== null;

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
    const onVisibility = () => setDocumentHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const sendParams = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const message = JSON.stringify({ type: "params", ...paramsRef.current });
    if (message === sentParamsRef.current) return;
    sentParamsRef.current = message;
    ws.send(message);
  }, []);

  // Size the stream to the view body: no point decoding more pixels than it
  // can show.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let timer = 0;
    const measure = (width: number, height: number) => {
      const dpr = window.devicePixelRatio || 1;
      paramsRef.current = {
        max_width: clampSize(width * dpr, MAX_STREAM_WIDTH),
        max_height: clampSize(height * dpr, MAX_STREAM_HEIGHT),
        quality,
      };
      sendParams();
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[entries.length - 1]?.contentRect;
      if (!rect) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(
        () => measure(rect.width, rect.height),
        PARAMS_DEBOUNCE_MS,
      );
    });
    observer.observe(body);
    const rect = body.getBoundingClientRect();
    measure(rect.width, rect.height);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [bodyRef, quality, sendParams]);

  useEffect(() => {
    if (!streaming) {
      setState((current) => (current === "closed" ? current : "paused"));
      return;
    }
    let disposed = false;
    let destroyed = false;
    let decoding = false;
    let pending: Uint8Array | null = null;

    const ws = openSocket(agentBrowserWsUrl(machineId, browserId, deviceId ?? undefined));
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    sentParamsRef.current = "";
    setState(generation === 0 ? "connecting" : "reconnecting");

    const reconnect = createTerminalReconnectController<number>({
      delayMs: RECONNECT_DELAY_MS,
      openReadyState: WebSocket.OPEN,
      onReconnect: () => {
        if (!disposed) setGeneration((value) => value + 1);
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timerId) => window.clearTimeout(timerId),
    });

    const drawLoop = async () => {
      if (decoding) return;
      decoding = true;
      try {
        while (pending && !disposed) {
          // Latest frame wins; anything older was superseded while decoding.
          const jpeg = pending;
          pending = null;
          let bitmap: ImageBitmap | null = null;
          try {
            bitmap = await createImageBitmap(
              new Blob([jpeg as BlobPart], { type: "image/jpeg" }),
            );
            const canvas = canvasRef.current;
            if (disposed || !canvas) continue;
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
            framesRef.current += 1;
            canvas.dataset.frames = String(framesRef.current);
            setHasFrame(true);
          } catch {
            // A corrupt frame is skipped; the ack below still unblocks the hub.
          } finally {
            bitmap?.close();
          }
          if (!disposed && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "ack" }));
          }
        }
      } finally {
        decoding = false;
      }
    };

    ws.onopen = () => {
      reconnect.handleSocketOpen();
      setState("live");
      sendParams();
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        try {
          const message = JSON.parse(event.data) as { type?: string };
          if (message.type === "destroyed") {
            destroyed = true;
            setState("closed");
          }
        } catch {
          // ignore malformed control messages
        }
        return;
      }
      // [u16 BE meta_len][meta JSON][jpeg]
      const data = new Uint8Array(event.data as ArrayBuffer);
      if (data.length < 2) return;
      const metaLen = (data[0] << 8) | data[1];
      if (data.length < 2 + metaLen) return;
      metaRef.current = parseFrameMeta(data.subarray(2, 2 + metaLen));
      pending = data.subarray(2 + metaLen);
      void drawLoop();
    };
    ws.onclose = () => {
      if (disposed || destroyed) return;
      setState("reconnecting");
      reconnect.scheduleReconnect();
    };
    ws.onerror = () => {
      // onclose follows and schedules the reconnect.
    };

    return () => {
      disposed = true;
      reconnect.cancelReconnect();
      if (wsRef.current === ws) wsRef.current = null;
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      ws.close();
    };
  }, [streaming, machineId, browserId, deviceId, generation, sendParams, canvasRef]);

  const changeControl = useCallback(
    async (action: "take" | "release") => {
      if (!deviceId) return;
      setControlBusy(true);
      setError(null);
      try {
        await controlAgentBrowser(machineId, browserId, {
          action,
          device_id: deviceId,
        });
      } catch (e) {
        setError(
          `Could not ${action === "take" ? "take over" : "hand back"}: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setControlBusy(false);
      }
    },
    [deviceId, machineId, browserId],
  );

  const sendInput = useCallback((event: AgentBrowserInputEvent) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "input", event }));
  }, []);

  const closeBrowser = useCallback(async () => {
    setClosing(true);
    setError(null);
    try {
      // The hub refuses to close a browser a person controls; hand it back first.
      if (mine && deviceId) {
        await controlAgentBrowser(machineId, browserId, {
          action: "release",
          device_id: deviceId,
        });
      }
      await closeAgentBrowser(machineId, browserId);
    } catch (e) {
      setError(
        `Could not close the browser: ${e instanceof Error ? e.message : String(e)}`,
      );
      setClosing(false);
    }
  }, [machineId, browserId, mine, deviceId]);

  return {
    deviceId,
    mine,
    otherDevice,
    state,
    hasFrame,
    metaRef,
    sendInput,
    changeControl,
    controlBusy,
    error,
    closing,
    closeBrowser,
  };
}

/** Closes a browser from outside its view (e.g. the mobile session list). */
export async function releaseAndCloseAgentBrowser(
  browser: AgentBrowserInfo,
  deviceId: string | null,
): Promise<void> {
  const machineId = browser.machine_id ?? "";
  if (
    deviceId &&
    browser.controller === "human" &&
    browser.controller_device_id === deviceId
  ) {
    await controlAgentBrowser(machineId, browser.id, {
      action: "release",
      device_id: deviceId,
    });
  }
  await closeAgentBrowser(machineId, browser.id);
}
