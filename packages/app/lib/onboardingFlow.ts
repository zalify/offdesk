import { isRegistrationTokenFresh } from "./tokenExpiry.ts";

interface TokenGenerationState {
  requested: boolean;
  token: string | null;
  expiresAt: number | null;
  now?: number;
}

interface TokenActionState {
  loading: boolean;
  token: string | null;
}

export function shouldGenerateRegistrationToken({
  requested,
  token,
  expiresAt,
  now = Date.now(),
}: TokenGenerationState): boolean {
  if (!requested) {
    return false;
  }

  if (!token || !expiresAt) {
    return true;
  }

  return !isRegistrationTokenFresh(expiresAt, now);
}

export function getTokenActionLabel({
  loading,
  token,
}: TokenActionState): string {
  if (loading) {
    return "Generating…";
  }

  return token ? "New token" : "Generate a token";
}

/** Only the desktop connected to its own loopback Hub may repair local setup. */
export function isLocalHubAddress(address: string): boolean {
  try {
    const url = new URL(address);
    return ["http:", "https:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch { return false; }
}
