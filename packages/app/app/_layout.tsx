import "../global.css";
import "../lib/legacyStorageMigration";
import { Component, useLayoutEffect, type ErrorInfo, type ReactNode } from "react";
import { applyUiFontPreferences, subscribeFontPreferences } from "../lib/fontPreferences";
import { Slot } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { AuthProvider, useAuth } from "../lib/auth";
import { isDesktopShell } from "../lib/desktopHub";
import { ThemeProvider } from "../lib/theme";
import LoginScreen from "./login";
import { DesktopGate } from "../components/DesktopSetup.web";
import { AndroidUpdateNotification } from "../components/AndroidUpdateNotification";

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
        <View className="w-full max-w-2xl items-center gap-4">
          <Text className="text-2xl font-semibold text-foreground">Something went wrong</Text>
          <Pressable
            accessibilityRole="button"
            className="rounded-md bg-accent px-5 py-3"
            onPress={this.reload}
          >
            <Text className="font-semibold text-on-accent">Reload</Text>
          </Pressable>
          <View className="mt-4 w-full rounded-md bg-surface p-4">
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
    return (
      <View className="flex-1 bg-background items-center justify-center">
        <ActivityIndicator size="large" color="#ff6b57" />
      </View>
    );
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
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </AppErrorBoundary>
  );
}
