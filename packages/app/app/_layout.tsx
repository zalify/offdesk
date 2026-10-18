import "../global.css";
import { UiUpdateLifecycle } from "../components/UiUpdateNotification";
import { getUiUpdateState, recoverUi } from "../lib/uiUpdates";
import "../lib/legacyStorageMigration";
// Before Expo Router mounts: its popstate listener must come second.
import "../lib/samePagePops";
import { Component, useLayoutEffect, type ErrorInfo, type ReactNode } from "react";
import { applyUiFontPreferences, subscribeFontPreferences } from "../lib/fontPreferences";
import { Slot } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Pressable, Text, View } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { isDesktopShell } from "../lib/desktopHub";
import { ThemeProvider } from "../lib/theme";
import { colors } from "../lib/colors";
import LoginScreen from "./login";
import { DesktopGate } from "../components/DesktopSetup.web";
import { BootScreen } from "../components/BootScreen.web";
import { AndroidUpdateNotification } from "../components/AndroidUpdateNotification";
import { IosUpdateNotification } from "../components/IosUpdateNotification";

// Decided once: the shell a page runs in does not change while it is open,
// and Tauri's bridge is there before any script runs. Reading it per render
// would let a bridge installed later (a test's stub) swap the whole tree.
const DESKTOP_SHELL = isDesktopShell();

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App render failed", error, info.componentStack);
  }

  private reload = () => {
    if (typeof location !== "undefined") {
      location.reload();
    }
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      <View className="flex-1 min-h-screen bg-background items-center justify-center px-6 py-10">
        <View className="w-full max-w-2xl gap-4">
          <Text className="font-display text-sm" style={{ color: colors.err }}>error: the app stopped</Text>
          <Text className="font-display text-3xl font-semibold text-foreground" style={{ letterSpacing: -1 }}>Something went wrong</Text>
          <View className="flex-row flex-wrap gap-2">
            <Pressable
              accessibilityRole="button"
              className="rounded bg-primary px-5 py-3"
              onPress={this.reload}
            >
              <Text className="font-display font-semibold text-on-primary" style={{ textTransform: "lowercase" }}>Reload</Text>
            </Pressable>
            {getUiUpdateState().status?.enabled && <Pressable accessibilityRole="button" className="rounded border border-border px-5 py-3" onPress={() => void recoverUi().catch(() => this.reload())}>
              <Text className="font-display text-foreground" style={{ textTransform: "lowercase" }}>Restore previous interface</Text>
            </Pressable>}
          </View>
          <View className="mt-4 w-full rounded-md border border-border-outline bg-surface p-4">
            <Text className="font-mono text-xs text-foreground-muted">
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
            </Text>
          </View>
        </View>
      </View>
    );
  }
}

function AuthGate() {
  const { isLoading, isAuthenticated } = useAuth();

  // The desktop app asks which machine this is before anything else, and
  // may have a hub to set up before there is anything to sign in to.
  if (DESKTOP_SHELL) {
    return (
      <DesktopGate>
        <Slot />
      </DesktopGate>
    );
  }

  if (isLoading) {
    return <BootScreen step="signin" />;
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  return <Slot />;
}

export default function RootLayout() {
  useLayoutEffect(() => {
    applyUiFontPreferences();
    return subscribeFontPreferences(applyUiFontPreferences);
  }, []);
  return (
    <AppErrorBoundary>
      <SafeAreaProvider>
        <ThemeProvider>
          <AuthProvider>
            <AuthGate />
            <AndroidUpdateNotification />
            <IosUpdateNotification />
            <UiUpdateLifecycle />
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
