import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AgentBrowserInfo } from "@offdesk/shared";
import { openAgentBrowser } from "@/lib/api";
import {
  browserControlledBy,
  normalizeBrowserUrl,
  pickSelectedBrowserId,
} from "@/lib/agentBrowserOverlay";
import { releaseAndCloseAgentBrowser } from "@/lib/useAgentBrowserStream";

const AWAIT_CREATED_MS = 5000;

/**
 * State behind the browser tab strip, shared by the desktop overlay and the
 * phone surface: which tab is selected, the "+" address field (open a page,
 * select the new tab once its created event arrives) and closing a tab.
 */
export function useAgentBrowserTabs({
  machineId,
  browsers,
  rememberedId,
  deviceId,
  onSelect,
}: {
  machineId: string;
  browsers: AgentBrowserInfo[];
  /** The tab the person last picked on this machine; may be gone by now. */
  rememberedId: string | null;
  deviceId: string | null;
  onSelect: (browserId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState("");
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closingIds, setClosingIds] = useState<ReadonlySet<string>>(new Set());
  // A tab just opened whose created event has not arrived yet.
  const [awaitingId, setAwaitingId] = useState<string | null>(null);

  const selectedBrowserId = pickSelectedBrowserId(
    browsers,
    rememberedId,
    awaitingId,
  );
  const selected =
    browsers.find((browser) => browser.id === selectedBrowserId) ?? null;
  const controlling = selected ? browserControlledBy(selected, deviceId) : false;
  const showForm = adding || browsers.length === 0;

  useEffect(() => {
    if (awaitingId === null) return;
    if (browsers.some((browser) => browser.id === awaitingId)) {
      setAwaitingId(null);
      return;
    }
    const timer = window.setTimeout(() => setAwaitingId(null), AWAIT_CREATED_MS);
    return () => window.clearTimeout(timer);
  }, [awaitingId, browsers]);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (opening) return;
      const url = normalizeBrowserUrl(address);
      if (!url) {
        setError("Enter a web address, for example example.com");
        return;
      }
      setOpening(true);
      setError(null);
      try {
        const created = await openAgentBrowser(machineId, url);
        setAddress("");
        setAdding(false);
        setAwaitingId(created.id);
        onSelect(created.id);
      } catch (e) {
        setError(
          `Could not open the page: ${e instanceof Error ? e.message : String(e)}`,
        );
      } finally {
        setOpening(false);
      }
    },
    [address, machineId, onSelect, opening],
  );

  const closeTab = useCallback(
    async (browser: AgentBrowserInfo) => {
      setClosingIds((ids) => new Set(ids).add(browser.id));
      setError(null);
      try {
        await releaseAndCloseAgentBrowser(browser, deviceId);
      } catch (e) {
        setError(
          `Could not close the tab: ${e instanceof Error ? e.message : String(e)}`,
        );
        setClosingIds((ids) => {
          const next = new Set(ids);
          next.delete(browser.id);
          return next;
        });
      }
    },
    [deviceId],
  );

  return {
    selectedBrowserId,
    selected,
    controlling,
    showForm,
    adding,
    setAdding,
    address,
    setAddress,
    opening,
    error,
    setError,
    closingIds,
    awaitingId,
    submit,
    closeTab,
  };
}
