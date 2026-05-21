import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo } from "react";
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
import { relativeTime } from "@/src/format";
import { useAgents, useChats, useCreateChat } from "@/src/queries";
import type { ChatSession } from "@/src/types";

export default function ChatsScreen() {
  const scheme = useColorScheme();
  const theme = scheme === "dark" ? darkTheme : lightTheme;
  const { agentId } = useLocalSearchParams<{ agentId: string }>();
  const agents = useAgents();
  const chats = useChats(agentId ?? null);
  const createChat = useCreateChat(agentId ?? null);

  // 401 → setup. Effect-driven so the redirect doesn't short-circuit
  // hooks below (Rules of Hooks).
  const unauthorized =
    chats.error instanceof ApiError && chats.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const agent = useMemo(
    () => (agents.data?.agents ?? []).find((a) => a.id === agentId),
    [agents.data, agentId]
  );

  const ordered = useMemo<ChatSession[]>(() => {
    const all = chats.data ?? [];
    return [...all].sort((a, b) =>
      (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt)
    );
  }, [chats.data]);

  const onNewChat = () => {
    createChat.mutate(undefined, {
      onSuccess: (session) => {
        router.push(`/chat/${session.id}`);
      }
    });
  };

  if (unauthorized) return null;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: agent?.name ?? "Chats",
          headerRight: () => (
            <TouchableOpacity
              onPress={onNewChat}
              hitSlop={12}
              disabled={createChat.isPending}
            >
              {createChat.isPending ? (
                <ActivityIndicator color={theme.subtle} />
              ) : (
                <Text style={{ color: theme.accent, fontSize: 24, fontWeight: "600" }}>+</Text>
              )}
            </TouchableOpacity>
          )
        }}
      />

      {chats.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : chats.isError ? (
        <View style={styles.center}>
          <Text style={[styles.error, { color: theme.danger }]}>
            {chats.error instanceof Error ? chats.error.message : "Failed to load chats"}
          </Text>
          <TouchableOpacity onPress={() => chats.refetch()} style={styles.retry}>
            <Text style={{ color: theme.accent }}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : ordered.length === 0 ? (
        <View style={styles.center}>
          <Text style={[styles.empty, { color: theme.subtle }]}>No chats yet</Text>
          <TouchableOpacity
            onPress={onNewChat}
            disabled={createChat.isPending}
            style={[styles.newButton, { backgroundColor: theme.button }]}
          >
            <Text style={[styles.newButtonText, { color: theme.buttonText }]}>
              Start a chat
            </Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={ordered}
          keyExtractor={(s) => s.id}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={chats.isFetching && !chats.isLoading}
              onRefresh={() => chats.refetch()}
              tintColor={theme.subtle}
            />
          }
          renderItem={({ item }) => (
            <TouchableOpacity
              onPress={() => router.push(`/chat/${item.id}`)}
              style={[styles.row, { backgroundColor: theme.rowBg, borderColor: theme.border }]}
            >
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                  {item.title?.trim() || "New chat"}
                </Text>
                <Text style={[styles.rowMeta, { color: theme.subtle }]} numberOfLines={1}>
                  {relativeTime(item.updatedAt ?? item.createdAt)}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 },
  error: { fontSize: 14, textAlign: "center" },
  empty: { fontSize: 18, fontWeight: "600" },
  retry: { padding: 8 },
  newButton: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 10
  },
  newButtonText: { fontSize: 15, fontWeight: "600" },
  listContent: { padding: 16, gap: 8 },
  row: {
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1
  },
  rowText: { gap: 2 },
  rowTitle: { fontSize: 16, fontWeight: "600" },
  rowMeta: { fontSize: 13 }
});

const lightTheme = {
  bg: "#ffffff",
  text: "#0a0a0a",
  subtle: "#6b7280",
  border: "#e4e4e7",
  rowBg: "#fafafa",
  accent: "#2563eb",
  danger: "#dc2626",
  button: "#0a0a0a",
  buttonText: "#ffffff"
};

const darkTheme = {
  bg: "#0a0a0a",
  text: "#fafafa",
  subtle: "#9ca3af",
  border: "#27272a",
  rowBg: "#18181b",
  accent: "#60a5fa",
  danger: "#f87171",
  button: "#fafafa",
  buttonText: "#0a0a0a"
};
