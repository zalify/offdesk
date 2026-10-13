import { useState, useEffect, useRef, useCallback } from "react";
import { Body, Button, Display, Eyebrow, StepMark, Wordmark, fontDisplay } from "./Primitives.web";
import { createRegistrationToken } from "@/lib/api";
import { buildOnboardingScript, getJoinCommand } from "@/lib/nodeInstaller";
import {
  getTokenActionLabel,
  shouldGenerateRegistrationToken,
} from "@/lib/onboardingFlow";
import { isRegistrationTokenFresh } from "@/lib/tokenExpiry";
import { colors, colorAlpha } from "@/lib/colors";
import { getServerUrl } from "@/lib/serverUrl";
import { MobileAppPanel } from "./MobileAppPanel.web";

// The hub a new machine should dial: in a browser tab the page came from
// the hub, so its own origin; in the desktop app the page is bundled and
// the hub is whatever the app is connected to.
function getHubUrl(): string {
  const stored = getServerUrl();
  const { protocol, host } = stored ? new URL(stored) : window.location;
  const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${host}/ws/machine`;
}

function buildFullScript(token: string): string {
  const hubUrl = getHubUrl();
  return buildOnboardingScript(hubUrl, token);
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function CodeBlock({
  label,
  code,
}: {
  label: string;
  code: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontFamily: fontDisplay, fontSize: 12, fontWeight: 500, color: colors.fg0 }}>
        {label}
      </div>
      <div
        style={{
          backgroundColor: colors.termBg,
          border: `1px solid ${colors.lineSoft}`,
          borderRadius: 4,
          padding: "16px 18px",
          overflowX: "auto" as const,
        }}
      >
        <pre
          style={{
            margin: 0,
            fontFamily: fontDisplay,
            fontSize: 13,
            lineHeight: 1.6,
            color: "#ecebe6",
            whiteSpace: "pre-wrap" as const,
            wordBreak: "break-all" as const,
          }}
        >
          <span style={{ color: "#d4ff3a" }} aria-hidden="true">$ </span>
          {code}
        </pre>
      </div>
    </div>
  );
}

interface OnboardingViewProps {
  embedded?: boolean;
}

export function OnboardingView({
  embedded = false,
}: OnboardingViewProps = {}) {
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [requested, setRequested] = useState(false);
  const cachedRef = useRef<CachedToken | null>(null);

  const generateToken = useCallback(async () => {
    // Reuse cached token if still valid (with 60s buffer)
    const cached = cachedRef.current;
    if (cached && isRegistrationTokenFresh(cached.expiresAt)) {
      setToken(cached.token);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await createRegistrationToken("node");
      cachedRef.current = { token: data.token, expiresAt: data.expires_at };
      setToken(data.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loading || error) {
      return;
    }
    const cached = cachedRef.current;
    if (
      !shouldGenerateRegistrationToken({
        requested,
        token,
        expiresAt: cached?.expiresAt ?? null,
      })
    ) {
      return;
    }
    void generateToken();
  }, [error, generateToken, loading, requested, token]);

  const handleCopy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(buildFullScript(token));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  };

  const handleRegenerate = () => {
    setRequested(true);
    cachedRef.current = null;
    setToken(null);
    setCopied(false);
  };

  const handleGenerateClick = () => {
    setRequested(true);
    setError(null);
    setCopied(false);
  };

  const hubUrl = getHubUrl();
  const joinCmd = token ? getJoinCommand(hubUrl, token) : "";
  const tokenAction = getTokenActionLabel({ loading, token });

  return (
    <div
      style={{
        display: "flex",
        flex: 1,
        width: "100%",
        boxSizing: "border-box",
        alignItems: embedded ? "stretch" : "flex-start",
        justifyContent: "center",
        height: embedded ? "auto" : "100%",
        minHeight: embedded ? "auto" : "100%",
        overflowY: embedded ? "visible" : "auto",
        padding: embedded ? 0 : "56px 32px 48px",
        background: embedded ? "transparent" : colors.background,
      }}
    >
      <div style={{ maxWidth: embedded ? "100%" : 640, width: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
        {!embedded && (
          <div style={{ marginBottom: 20 }}><Wordmark size={18} /></div>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Eyebrow prompt>add a machine</Eyebrow>
          <Display size={30}>Connect a machine</Display>
        </div>
        <Body size={15}>
          One line, pasted into a terminal on the machine you want to reach.
          It installs the agent, registers the machine with this hub and keeps
          the agent running. Works on this machine too.
        </Body>

        {!requested && !loading && !error && !token ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              padding: 20,
              border: `1px solid ${colors.lineSoft}`,
              borderRadius: 4,
            }}
          >
            <Body size={14}>
              Generate a token when you are ready to paste the line into a terminal on the machine. Each token works once.
            </Body>
            <div>
              <Button size="sm" onClick={handleGenerateClick} ariaLabel={tokenAction}>
                {tokenAction.toLowerCase()}
              </Button>
            </div>
          </div>
        ) : loading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1px solid ${colors.lineSoft}`, borderRadius: 4, fontSize: 13, color: colors.fg2 }}>
            <StepMark state="active" />
            generating a registration token…
          </div>
        ) : error ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-start" }}>
            <div role="alert" style={{ padding: "10px 12px", border: `1px solid ${colors.err}`, borderRadius: 4, color: colors.err, fontSize: 12 }}>
              {error}
            </div>
            <Button kind="secondary" size="sm" onClick={handleGenerateClick} ariaLabel="Try again">
              try again
            </Button>
          </div>
        ) : token ? (
          <>
            <CodeBlock label="on the machine you want to reach" code={joinCmd} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <Button size="sm" onClick={() => void handleCopy()} ariaLabel={copied ? "Copied!" : "Copy the line"}>
                {copied ? "copied" : "copy the line"}
              </Button>
              <Button kind="secondary" size="sm" onClick={handleRegenerate} ariaLabel={tokenAction}>
                {tokenAction.toLowerCase()}
              </Button>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: "var(--font-sans)", fontSize: 12, color: colors.fg3 }}>
                Works once, expires after 24 hours
              </span>
            </div>
            <div
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 14px", border: `1px solid ${colors.lineSoft}`, borderRadius: 4, fontSize: 13, color: colors.fg2 }}
            >
              <StepMark state="active" />
              waiting for the machine to come online… this page updates by itself
            </div>
          </>
        ) : null}

        {/* The other half of setting up: the phone. This page is where
            someone with a fresh hub actually is, so the app belongs here and
            not only behind Settings. Hidden in the dialog, which is about
            adding a machine to a hub that already works. */}
        {!embedded && (
          <div
            style={{
              marginTop: 16,
              paddingTop: 24,
              borderTop: `1px solid ${colors.lineSoft}`,
            }}
          >
            <h2
              style={{
                fontSize: 17,
                fontWeight: 600,
                letterSpacing: "-0.02em",
                color: colors.fg0,
                margin: "0 0 4px",
              }}
            >
              And on your phone
            </h2>
            <MobileAppPanel />
          </div>
        )}
      </div>
    </div>
  );
}

function DialogFrame({
  testId,
  width,
  closeLabel,
  onClose,
  children,
}: {
  testId: string;
  width: number;
  closeLabel: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: colorAlpha.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        role="dialog"
        onClick={(event) => event.stopPropagation()}
        className="odk-float"
        style={{
          position: "relative",
          width: `min(${width}px, 100%)`,
          maxHeight: "min(820px, calc(100vh - 40px))",
          overflowY: "auto",
          padding: 32,
          boxSizing: "border-box",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          title={closeLabel}
          aria-label={closeLabel}
          className="odk-text-btn"
          style={{ position: "absolute", top: 24, right: 24 }}
        >
          [esc]
        </button>
        {children}
      </div>
    </div>
  );
}

export function MachineOnboardingDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <DialogFrame testId="add-machine-dialog" width={720} closeLabel="Close add machine" onClose={onClose}>
      <OnboardingView embedded />
    </DialogFrame>
  );
}

/// The phone, reachable from anywhere in the app — not only from the page a
/// fresh hub opens with, which a hub with a machine never shows again.
export function MobileAppDialog({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  return (
    <DialogFrame testId="phone-dialog" width={640} closeLabel="Close" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        <Eyebrow prompt>phone</Eyebrow>
        <Display size={26}>On your phone</Display>
        <Body size={15}>The same terminals, from wherever you are.</Body>
      </div>
      <MobileAppPanel />
    </DialogFrame>
  );
}

function useEscape(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}
