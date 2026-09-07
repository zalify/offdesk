import { useState, useEffect, useRef, useCallback } from "react";
import { X } from "lucide-react";
import { Wordmark } from "./Warm.web";
import { createRegistrationToken } from "@/lib/api";
import { buildOnboardingScript, getJoinCommand } from "@/lib/nodeInstaller";
import {
  getTokenActionLabel,
  shouldGenerateRegistrationToken,
} from "@/lib/onboardingFlow";
import { isRegistrationTokenFresh } from "@/lib/tokenExpiry";
import { colors } from "@/lib/colors";
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
    <div style={{ marginBottom: 20 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: colors.foregroundSecondary,
          textTransform: "uppercase" as const,
          letterSpacing: 1,
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        style={{
          backgroundColor: colors.surface,
          border: `1px solid ${colors.border}`,
          borderRadius: 6,
          padding: "12px 14px",
          overflowX: "auto" as const,
        }}
      >
        <pre
          style={{
            margin: 0,
            fontFamily: "'SF Mono', 'Cascadia Code', 'Fira Code', 'Menlo', monospace",
            fontSize: 13,
            lineHeight: 1.6,
            color: colors.foreground,
            whiteSpace: "pre-wrap" as const,
            wordBreak: "break-all" as const,
          }}
        >
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
      <div style={{ maxWidth: embedded ? "100%" : 600, width: "100%" }}>
        {!embedded && (
          <div style={{ marginBottom: 36 }}><Wordmark size={26} /></div>
        )}
        {/* Header */}
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            color: colors.foreground,
            margin: "0 0 8px 0",
          }}
        >
          Connect a machine
        </h1>
        <p
          style={{
            fontSize: 14,
            color: colors.foregroundSecondary,
            margin: "0 0 28px 0",
            lineHeight: 1.5,
          }}
        >
          One line, pasted into a terminal on the machine you want to reach.
          It installs the agent, registers the machine with this hub and keeps
          the agent running. Works on this machine too.
        </p>

        {!requested && !loading && !error && !token ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 14,
              padding: 24,
              border: `1px solid ${colors.border}`,
              borderRadius: 10,
              background: colors.surface,
            }}
          >
            <p
              style={{
                margin: 0,
                color: colors.foregroundSecondary,
                lineHeight: 1.6,
                fontSize: 14,
              }}
            >
              Generate a token when you are ready to paste the line into a terminal on the machine. Each token works once.
            </p>
            <button
              onClick={handleGenerateClick}
              style={{
                width: "fit-content",
                backgroundColor: colors.accent,
                border: "none",
                borderRadius: 999,
                color: colors.onAccent,
                padding: "10px 18px",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {getTokenActionLabel({ loading, token })}
            </button>
          </div>
        ) : loading ? (
          <div
            style={{
              textAlign: "center" as const,
              padding: "32px 0",
              color: colors.foregroundSecondary,
              fontSize: 14,
            }}
          >
            Generating registration token…
          </div>
        ) : error ? (
          <div>
            <div
              style={{
                color: colors.danger,
                fontSize: 14,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
            <button
              onClick={handleGenerateClick}
              style={{
                backgroundColor: colors.surface,
                border: `1px solid ${colors.border}`,
                borderRadius: 6,
                color: colors.foreground,
                padding: "8px 16px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        ) : token ? (
          <div>
            <CodeBlock label="On the machine you want to reach" code={joinCmd} />

            {/* Action buttons */}
            <div
              style={{
                display: "flex",
                gap: 10,
                marginBottom: 24,
              }}
            >
              <button
                onClick={() => void handleCopy()}
                style={{
                  backgroundColor: colors.accent,
                  border: "none",
                  borderRadius: 6,
                  color: colors.onAccent,
                  padding: "8px 20px",
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                {copied ? "Copied!" : "Copy the line"}
              </button>
              <button
                onClick={handleRegenerate}
                style={{
                  backgroundColor: "transparent",
                  border: `1px solid ${colors.border}`,
                  borderRadius: 6,
                  color: colors.foregroundSecondary,
                  padding: "8px 16px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {getTokenActionLabel({ loading, token })}
              </button>
            </div>

            {/* Footer note */}
            <p
              style={{
                fontSize: 12,
                color: colors.foregroundMuted,
                margin: 0,
                lineHeight: 1.5,
              }}
            >
              The token on that line works once and expires after 24 hours. Once the
              machine connects, this page updates by itself.
            </p>
          </div>
        ) : null}

        {/* The other half of setting up: the phone. This page is where
            someone with a fresh hub actually is, so the app belongs here and
            not only behind Settings. Hidden in the dialog, which is about
            adding a machine to a hub that already works. */}
        {!embedded && (
          <div
            style={{
              marginTop: 32,
              paddingTop: 24,
              borderTop: `1px solid ${colors.border}`,
            }}
          >
            <h2
              style={{
                fontSize: 15,
                fontWeight: 600,
                color: colors.foreground,
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

export function MachineOnboardingDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  return (
    <div
      data-testid="add-machine-dialog"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(0, 0, 0, 0.56)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: "min(720px, 100%)",
          maxHeight: "min(820px, calc(100vh - 40px))",
          overflowY: "auto",
          background: colors.background,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          boxShadow: "0 28px 80px -24px rgba(0, 0, 0, 0.7)",
          padding: 24,
        }}
      >
        <button
          onClick={onClose}
          title="Close add machine"
          aria-label="Close add machine"
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            width: 32,
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 999,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color: colors.foregroundSecondary,
            cursor: "pointer",
          }}
        >
          <X size={16} />
        </button>
        <OnboardingView embedded />
      </div>
    </div>
  );
}

/// The phone, reachable from anywhere in the app — not only from the page a
/// fresh hub opens with, which a hub with a machine never shows again.
export function MobileAppDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      data-testid="phone-dialog"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(0, 0, 0, 0.56)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          position: "relative",
          width: "min(640px, 100%)",
          maxHeight: "min(820px, calc(100vh - 40px))",
          overflowY: "auto",
          background: colors.background,
          border: `1px solid ${colors.border}`,
          borderRadius: 16,
          boxShadow: "0 28px 80px -24px rgba(0, 0, 0, 0.7)",
          padding: 24,
        }}
      >
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          style={{
            position: "absolute",
            top: 14,
            right: 14,
            width: 32,
            height: 32,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 999,
            border: `1px solid ${colors.border}`,
            background: colors.surface,
            color: colors.foregroundSecondary,
            cursor: "pointer",
          }}
        >
          <X size={16} />
        </button>
        <h1
          style={{
            fontSize: 20,
            fontWeight: 700,
            color: colors.foreground,
            margin: "0 0 6px 0",
          }}
        >
          On your phone
        </h1>
        <p
          style={{
            fontSize: 14,
            color: colors.foregroundSecondary,
            margin: "0 0 20px 0",
            lineHeight: 1.5,
          }}
        >
          The same terminals, from wherever you are.
        </p>
        <MobileAppPanel />
      </div>
    </div>
  );
}
