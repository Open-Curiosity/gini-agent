import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { primeCredentials } from "@/src/auth";

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
          <StatusBar style="auto" />
          <Stack screenOptions={screenOptions}>
            <Stack.Screen name="index" options={{ headerShown: false }} />
            <Stack.Screen name="setup" options={{ title: "Connect to Gini" }} />
            <Stack.Screen name="agents" options={{ title: "Agents" }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
            <Stack.Screen name="chats/[agentId]" options={{ title: "Chats" }} />
            <Stack.Screen name="chat/[sessionId]" options={{ title: "Chat" }} />
          </Stack>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
