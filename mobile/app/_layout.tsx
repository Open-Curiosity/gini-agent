import {
  QueryClient,
  QueryClientProvider,
  useQueryClient
} from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { primeCredentials, useAuth } from "@/src/auth";

// Single shared client across the tree so navigating between screens
// keeps caches warm. Built once per app lifetime — Expo Router never
// remounts _layout outside of a full reload.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Polling on every screen is the primary freshness signal; aggressive
      // refetch-on-mount just doubles the request rate when the user taps
      // back from chat detail to the list.
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

export default function RootLayout() {
  // Prime the AsyncStorage credentials cache once before the first child
  // render. Without this, the auth gate in `app/index.tsx` would briefly
  // see `credentials: null` and bounce the user to /setup even if they
  // were already authed — bad UX on every cold start.
  const [primed, setPrimed] = useState(false);
  useEffect(() => {
    let active = true;
    primeCredentials().then(() => {
      if (active) setPrimed(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const screenOptions = useMemo(
    () => ({
      headerStyle: { backgroundColor: "transparent" } as const,
      contentStyle: { backgroundColor: "transparent" } as const
    }),
    []
  );

  if (!primed) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthCacheGuard />
          <StatusBar style="auto" />
          <Stack screenOptions={screenOptions}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="setup" options={{ title: "Connect to Gini" }} />
            <Stack.Screen name="agents" options={{ headerShown: false }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
            <Stack.Screen name="chat/[sessionId]" options={{ title: "Chat" }} />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

// Drop every cached query when the gateway identity changes. Sign-out
// and switching to a different gateway both broadcast through useAuth,
// so this single effect keeps stale data from leaking across
// credential boundaries without baking baseUrl/token into every query
// key.
function AuthCacheGuard() {
  const { credentials } = useAuth();
  const qc = useQueryClient();
  const prevKeyRef = useRef<string | null | undefined>(undefined);
  // Compose a stable identity from baseUrl + token so a token rotation
  // against the same gateway also evicts stale auth-tied data.
  const identity = credentials
    ? `${credentials.baseUrl}|${credentials.token}`
    : null;

  useEffect(() => {
    const prev = prevKeyRef.current;
    if (prev !== undefined && prev !== identity) {
      qc.clear();
    }
    prevKeyRef.current = identity;
  }, [identity, qc]);

  return null;
}
