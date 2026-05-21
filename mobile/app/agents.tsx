import { Link, router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  useColorScheme,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/src/api";
import { useAgents, useUseAgent } from "@/src/queries";
import type { AgentRecord } from "@/src/types";

export default function AgentsScreen() {
  const scheme = useColorScheme();
  const theme = scheme === "dark" ? darkTheme : lightTheme;
  const agents = useAgents();
  const useAgent = useUseAgent();
  const [pendingId, setPendingId] = useState<string | null>(null);

  // Auth-gate fallback. If the cached token has been rotated out from
  // under us, the agents query 401s — kick the user back to setup
  // rather than spinning forever. Redirect from an effect so all later
  // hooks still run on the 401 render (Rules of Hooks).
  const unauthorized =
    agents.error instanceof ApiError && agents.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const data = agents.data;
  const list = useMemo<AgentRecord[]>(() => data?.agents ?? [], [data]);
  const activeAgentId = data?.activeAgentId;

  const openChats = useCallback(
    (agent: AgentRecord) => {
      // Already-active agent skips the /use POST; the server-side filter
      // already matches the agentId we're about to navigate to.
      if (agent.id === activeAgentId) {
        router.push(`/chats/${agent.id}`);
        return;
      }
      setPendingId(agent.id);
      useAgent.mutate(agent.id, {
        onSuccess: () => {
          setPendingId(null);
          router.push(`/chats/${agent.id}`);
        },
        onError: () => {
          // Even on failure, the gateway's GET /api/chat filter is
          // client-driven by ?agentId, so we still navigate — but the
          // user's "active agent" elsewhere (web client, CLI) didn't
          // change. Surface the error briefly.
          setPendingId(null);
        }
      });
    },
    [activeAgentId, useAgent]
  );

  if (unauthorized) return null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: "Agents",
          headerRight: () => (
            <Link href="/settings" asChild>
              <TouchableOpacity hitSlop={12}>
                <Text style={{ color: theme.accent, fontSize: 16 }}>Settings</Text>
              </TouchableOpacity>
            </Link>
          )
        }}
      />

      {agents.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : agents.isError ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: theme.danger }]}>
            {agents.error instanceof Error ? agents.error.message : "Failed to load agents"}
          </Text>
          <TouchableOpacity onPress={() => agents.refetch()} style={styles.retry}>
            <Text style={{ color: theme.accent }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : list.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: theme.subtle }]}>No agents yet</Text>
          <Text style={[styles.emptySub, { color: theme.subtle }]}>
            Create one from the web client or `gini agent new`.
          </Text>
        </View>
      ) : (
        <FlatList
          data={list}
          keyExtractor={(a) => a.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={agents.isFetching && !agents.isLoading}
              onRefresh={() => agents.refetch()}
              tintColor={theme.subtle}
            />
          }
          renderItem={({ item }) => {
            const isActive = item.id === activeAgentId;
            const isPending = pendingId === item.id;
            return (
              <TouchableOpacity
                onPress={() => openChats(item)}
                disabled={isPending}
                style={[
                  styles.row,
                  { backgroundColor: theme.rowBg, borderColor: theme.border }
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                    {item.name}
                  </Text>
                  <Text style={[styles.rowMeta, { color: theme.subtle }]} numberOfLines={1}>
                    {item.providerName ? `${item.providerName}` : ""}
                    {item.providerName && item.model ? " · " : ""}
                    {item.model ?? ""}
                    {!item.providerName && !item.model ? item.status : ""}
                  </Text>
                </View>
                {isPending ? (
                  <ActivityIndicator color={theme.subtle} />
                ) : isActive ? (
                  <Text style={[styles.checkmark, { color: theme.accent }]}>✓</Text>
                ) : null}
              </TouchableOpacity>
            );
          }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  error: { fontSize: 14, textAlign: "center" },
  empty: { fontSize: 18, fontWeight: "600", marginBottom: 6 },
  emptySub: { fontSize: 14, textAlign: "center" },
  retry: { marginTop: 12, padding: 8 },
  listContent: { padding: 16, gap: 8 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowMeta: { fontSize: 13 },
  checkmark: { fontSize: 18, fontWeight: "700" }
});

const lightTheme = {
  bg: "#ffffff",
  text: "#0a0a0a",
  subtle: "#6b7280",
  border: "#e4e4e7",
  rowBg: "#fafafa",
  accent: "#2563eb",
  danger: "#dc2626"
};

const darkTheme = {
  bg: "#0a0a0a",
  text: "#fafafa",
  subtle: "#9ca3af",
  border: "#27272a",
  rowBg: "#18181b",
  accent: "#60a5fa",
  danger: "#f87171"
};
