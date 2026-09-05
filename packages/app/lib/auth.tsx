import { refreshConnectionRoutes, restoreSecureConnection, isSecureConnection, forgetSecureConnection } from "./secureTransport";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Platform } from "react-native";
// The imperative singleton, not the hook: useRouter() hands back a fresh
// object per render, and an effect that depends on it re-runs forever.
import { router } from "expo-router";

import { ApiError, configure, devLogin, getMe, redeemLoginCode } from "./api";
import type { User } from "@offdesk/shared";
import { storage } from "./storage";
import { getServerUrl, setServerUrl } from "./serverUrl";
import { isTauri, isTauriMobile } from "./platform";

export type { User };

const TOKEN_KEY = "token";
const GET_ME_TIMEOUT_MS = 10_000;
const DESKTOP_CALLBACK_KEY = "offdesk:desktop_callback";

export interface AuthContextType {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (provider?: "github" | "google") => Promise<void>;
  /**
   * Sign in with a token already in hand — the one on the hub's own link,
   * which the desktop app has when it just made this machine the hub, or
   * when someone pasted the link. `serverUrl` first, then the token, so the
   * session is validated against the hub it belongs to.
   */
  loginWithToken: (serverUrl: string, token: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return ctx;
}

// ── URL & desktop callback helpers ──

// Read once, at module load, and kept in memory for the one render that
// needs it. It cannot be *removed* from the address bar here: expo-router's
// entry recorded the initial URL before any of this ran, and writes it back
// when it mounts — a plain history.replaceState loses that race, which is
// how a session ended up sitting in the address bar, in browser history, in
// the next screenshot. The router has to do the removing; see AuthProvider.
let pendingUrlToken: string | null = (() => {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token");
})();

// Hand the token over exactly once. AuthProvider's restore can run more
/// than once — the router re-renders the tree when the URL changes — and a
/// token that stays "pending" would send it round again: replace, re-render,
/// restore, replace.
function takeUrlToken(): string | null {
  const token = pendingUrlToken;
  pendingUrlToken = null;
  return token;
}

// The QR code carries `?code=` — short, single-use — instead of a token.
// Same one-shot handling: it is redeemed once, and it comes off the URL.
let pendingUrlCode: string | null = (() => {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("code");
})();
function takeUrlCode(): string | null {
  const code = pendingUrlCode;
  pendingUrlCode = null;
  return code;
}

function getUrlParam(name: string): string | null {
  if (Platform.OS !== "web" || typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

function removeUrlParams(...names: string[]): void {
  if (Platform.OS !== "web" || typeof window === "undefined") return;
  const url = new URL(window.location.href);
  for (const n of names) url.searchParams.delete(n);
  window.history.replaceState({}, "", url.pathname + url.search + url.hash);
}

/**
 * Get the desktop callback URL — from URL param or sessionStorage
 * (persisted across the OAuth redirect round-trip).
 */
function getDesktopCallback(): string | null {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return null;
  try {
    const fromUrl = getUrlParam("desktop_callback");
    if (fromUrl) {
      sessionStorage.setItem(DESKTOP_CALLBACK_KEY, fromUrl);
      removeUrlParams("desktop_callback");
      return fromUrl;
    }
    return sessionStorage.getItem(DESKTOP_CALLBACK_KEY);
  } catch {
    return null;
  }
}

function clearDesktopCallback(): void {
  if (Platform.OS !== "web" || typeof sessionStorage === "undefined") return;
  try { sessionStorage.removeItem(DESKTOP_CALLBACK_KEY); } catch { /* */ }
}

function isLoopbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

/**
 * Redirect the token to the desktop app's loopback server.
 * Returns true if redirect was performed.
 */
function redirectTokenToDesktop(jwt: string): boolean {
  if (Platform.OS !== "web" || typeof window === "undefined") return false;
  const callback = getDesktopCallback();
  if (!callback || !isLoopbackUrl(callback)) {
    clearDesktopCallback();
    return false;
  }
  clearDesktopCallback();
  const url = new URL(callback);
  url.searchParams.set("token", jwt);
  window.location.href = url.toString();
  return true;
}

// ── Tauri desktop login ──

async function tauriDesktopLogin(
  onToken: (token: string) => void,
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { open } = await import("@tauri-apps/plugin-shell");
  const { listen } = await import("@tauri-apps/api/event");

  const port: number = await invoke("start_oauth_listener");
  const callback = `http://127.0.0.1:${port}/callback`;
  const serverUrl = getServerUrl();
  const connectUrl = `${serverUrl}?desktop_callback=${encodeURIComponent(callback)}`;

  const unlisten = await listen("oauth-token", (event: { payload: string }) => {
    unlisten();
    onToken(event.payload);
  });

  await open(connectUrl);
}

// ── Provider ──

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const isAuthenticated = !!user && !!token;
  const currentServerUrl = useCallback(() => getServerUrl(Platform.OS), []);

  // On mount: persist desktop_callback from URL to sessionStorage so it
  // survives the OAuth redirect round-trip.
  useEffect(() => {
    if (Platform.OS === "web" && !isTauri()) {
      getDesktopCallback();
    }
  }, []);

  // Restore session on mount
  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      try {
        // Encrypted sessions always restore through native Rust on bundled
        // assets, before any legacy token or development login is considered.
        try {
          const secure = await restoreSecureConnection();
          if (secure) {
            setServerUrl(secure.endpoint.hub_url);
            configure(secure.endpoint.hub_url, "secure-session");
            const me = await getMe();
            void refreshConnectionRoutes().catch(() => {});
            if (!cancelled) { setUser(me); setToken("secure-session"); setIsLoading(false); }
            return;
          }
        } catch {
          if (isSecureConnection()) { if (!cancelled) setIsLoading(false); return; }
        }
        // 1. A token that arrived on the URL — an OAuth callback, or the
        //    hub's own sign-in link. Already off the address bar; see above.
        //    A scanned code is one step further back: redeem it for the
        //    token first. A stale or used code just falls through to the
        //    sign-in page, which says what to do.
        let urlToken = takeUrlToken();
        const urlCode = urlToken ? null : takeUrlCode();
        if (urlCode) {
          if (
            Platform.OS === "web" &&
            typeof window !== "undefined" &&
            new URLSearchParams(window.location.search).has("code")
          ) {
            router.replace(window.location.pathname);
          }
          try {
            urlToken = await redeemLoginCode(currentServerUrl(), urlCode);
          } catch {
            urlToken = null;
          }
        }
        if (urlToken) {
          // Through the router, so its own idea of the URL loses the token
          // too — a plain history.replaceState is overwritten the next time
          // the router syncs its state to the address bar.
          if (
            Platform.OS === "web" &&
            typeof window !== "undefined" &&
            new URLSearchParams(window.location.search).has("token")
          ) {
            router.replace(window.location.pathname);
          }
          await storage.set(TOKEN_KEY, urlToken);
          if (!cancelled) {
            configure(currentServerUrl(), urlToken);
            setToken(urlToken);
          }
          return;
        }

        // 2. Check storage for existing token
        const storedToken = await storage.get(TOKEN_KEY);
        if (storedToken) {
          if (!cancelled) {
            configure(currentServerUrl(), storedToken);
            setToken(storedToken);
          }
          return;
        }

        // 3. Development login belongs to a browser-served Hub. The
        // bundled App has no Hub to contact before the user chooses one.
        if (Platform.OS === "web" && !isTauri()) {
          try {
            const result = await devLogin();
            if (result?.token) {
              await storage.set(TOKEN_KEY, result.token);
              if (!cancelled) {
                configure(currentServerUrl(), result.token);
                setToken(result.token);
              }
              return;
            }
          } catch {
            // Dev login not available (production mode)
          }
        }
      } catch {
        await storage.remove(TOKEN_KEY);
      }

      if (!cancelled) {
        setIsLoading(false);
      }
    };

    void restore();
    return () => { cancelled = true; };
  }, [currentServerUrl]);

  // When token changes, validate via getMe(), then handle desktop callback
  useEffect(() => {
    if (token === null) return;

    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const loadUser = async () => {
      controller = new AbortController();
      const timeoutId = setTimeout(() => controller?.abort(), GET_ME_TIMEOUT_MS);
      try {
        const me = await getMe(controller.signal);
        if (cancelled) return;
        setUser(me);
        setIsLoading(false);
        if (Platform.OS === "web" && !isTauri()) redirectTokenToDesktop(token);
      } catch (error) {
        if (cancelled) return;
        // Native failures (changed key, revoked device, locked credentials or
        // an interrupted first getMe) are not HTTP 401s. Preserve the pinned
        // connection and leave loading so LoginScreen can offer recovery,
        // just as the startup restore path does. Never retry indefinitely or
        // fall back to ordinary authentication after encrypted pairing.
        if (isSecureConnection()) {
          setToken(null);
          setUser(null);
          setIsLoading(false);
          return;
        }
        // A restart, timeout or gateway failure is not a revoked session.
        if (error instanceof ApiError && error.status === 401) {
          await storage.remove(TOKEN_KEY);
          if (cancelled) return;
          configure(currentServerUrl(), null);
          setToken(null);
          setUser(null);
          setIsLoading(false);
        } else {
          retry = setTimeout(() => void loadUser(), 2000);
        }
      } finally {
        clearTimeout(timeoutId);
      }
    };

    void loadUser();
    return () => {
      cancelled = true;
      clearTimeout(retry);
      controller?.abort();
    };
  }, [currentServerUrl, token]);

  const login = useCallback(async (provider?: "github" | "google") => {
    if (
      Platform.OS === "web" &&
      typeof window !== "undefined" &&
      isTauri() &&
      !isTauriMobile()
    ) {
      // Tauri desktop: open external browser, receive token via loopback.
      await tauriDesktopLogin(async (newToken) => {
        await storage.set(TOKEN_KEY, newToken);
        configure(currentServerUrl(), newToken);
        setToken(newToken);
      });
      return;
    }

    // Plain mobile-web AND Tauri-on-mobile both follow the same provider
    // redirect: the WebView navigates to /api/auth/<provider>, OAuth
    // completes server-side, and the SPA picks up `?token=` on the
    // redirect back. Works for Tauri Android because we load the hub URL
    // directly, so it's a same-origin round trip.
    if (!provider) return;
    const base = currentServerUrl();
    if (typeof window !== "undefined") {
      window.location.href = `${base}/api/auth/${provider}`;
    }
  }, [currentServerUrl]);

  const loginWithToken = useCallback(async (serverUrl: string, newToken: string) => {
    setServerUrl(serverUrl);
    await storage.set(TOKEN_KEY, newToken);
    configure(currentServerUrl(), newToken);
    setIsLoading(true);
    setToken(newToken);
  }, [currentServerUrl]);

  const logout = useCallback(async () => {
    if (isSecureConnection()) await forgetSecureConnection();
    await storage.remove(TOKEN_KEY);
    configure(currentServerUrl(), null);
    setToken(null);
    setUser(null);
  }, [currentServerUrl]);

  const value = useMemo<AuthContextType>(
    () => ({ user, token, isLoading, isAuthenticated, login, loginWithToken, logout }),
    [user, token, isLoading, isAuthenticated, login, loginWithToken, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
