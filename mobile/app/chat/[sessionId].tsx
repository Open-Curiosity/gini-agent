import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ApiError } from "@/src/api";
import { BlockRenderer } from "@/src/components/chat/BlockRenderer";
import {
  isTaskInFlight,
  useChatBlocks,
  useSendMessage
} from "@/src/queries";
import { theme } from "@/src/theme";
import type { ChatBlock } from "@/src/types";

// Pure renderer of the runtime's typed ChatBlock stream. The previous
// implementation derived a phase indicator from Task.currentStep,
// synthesized an in-flight placeholder, and POSTed /sync after each
// terminal task. All that derivation lives server-side now — this
// screen polls /chat/:id/blocks, walks the list, and dispatches each
// block through BlockRenderer.
export default function ChatDetailScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const blocks = useChatBlocks(sessionId ?? null);
  const send = useSendMessage(sessionId ?? null);

  const [text, setText] = useState("");
  const scrollRef = useRef<ScrollView | null>(null);

  // 401 → setup. Effect-driven so all later hooks still run on the
  // unauthorized render (Rules of Hooks).
  const unauthorized =
    blocks.error instanceof ApiError && blocks.error.status === 401;
  useEffect(() => {
    if (unauthorized) router.replace("/setup");
  }, [unauthorized]);

  const list = useMemo<ChatBlock[]>(() => blocks.data ?? [], [blocks.data]);

  // Title derivation: first user_text block's excerpt, falling back to
  // "Chat" while the list is empty. Avoids a second polling call to
  // /chat/:id for the session record — the block stream carries enough
  // for the detail header.
  const headerTitle = useMemo(() => {
    const firstUserText = list.find((b) => b.kind === "user_text");
    if (firstUserText && firstUserText.kind === "user_text") {
      const trimmed = firstUserText.text.trim();
      if (trimmed) return trimmed.length > 40 ? `${trimmed.slice(0, 40)}…` : trimmed;
    }
    return "Chat";
  }, [list]);

  const inFlight = useMemo(() => isTaskInFlight(list), [list]);

  // The most recent assistant_text block's updatedAt advances on every
  // streaming delta. Including it in the scroll dep array means the
  // ScrollView pins to the bottom as text accretes mid-stream, not just
  // on block count change.
  const lastAssistantUpdatedAt = useMemo(() => {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const b = list[i]!;
      if (b.kind === "assistant_text") return b.updatedAt;
    }
    return "";
  }, [list]);

  // Auto-scroll to bottom on new block arrival and on streaming text
  // accretion. The 50ms defer lets layout settle so the new content is
  // measured before the scroll request lands.
  useEffect(() => {
    const id = setTimeout(
      () => scrollRef.current?.scrollToEnd({ animated: true }),
      50
    );
    return () => clearTimeout(id);
  }, [list.length, sessionId, lastAssistantUpdatedAt]);

  const showSendBusy = send.isPending || inFlight;

  const submit = () => {
    const trimmed = text.trim();
    // Hardware-keyboard onSubmitEditing can fire mid-task; `showSendBusy`
    // also covers in-flight assistant work, not just the mutation's own
    // pending state.
    if (!trimmed || showSendBusy || !sessionId) return;
    send.mutate(trimmed, {
      onSuccess: () => setText("")
    });
  };

  if (unauthorized) return null;

  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <Stack.Screen
        options={{
          title: headerTitle,
          headerStyle: { backgroundColor: theme.bg },
          headerTitleStyle: { color: theme.text },
          headerTintColor: theme.accent
        }}
      />

      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={Platform.OS === "ios" ? 80 : 0}
        style={styles.flex}
      >
        {blocks.isPending && !blocks.data ? (
          <View style={styles.center}>
            <ActivityIndicator color={theme.subtle} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.messages}
            keyboardShouldPersistTaps="handled"
          >
            {list.length > 0 ? (
              list.map((block) => <BlockRenderer key={block.id} block={block} />)
            ) : (
              <View style={styles.emptyChat}>
                <Text style={styles.emptyChatText}>What can I help with?</Text>
              </View>
            )}
          </ScrollView>
        )}

        <View style={styles.composerWrap}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Message"
            placeholderTextColor={theme.subtle}
            multiline
            editable={!!sessionId}
            onSubmitEditing={submit}
            blurOnSubmit={false}
            style={styles.composerInput}
          />
          <Pressable
            onPress={submit}
            disabled={!text.trim() || showSendBusy}
            style={[
              styles.sendButton,
              {
                backgroundColor:
                  !text.trim() || showSendBusy
                    ? theme.buttonDisabled
                    : theme.button
              }
            ]}
          >
            {send.isPending ? (
              <ActivityIndicator color={theme.buttonText} />
            ) : (
              <Text style={styles.sendText}>Send</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.bg },
  flex: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  messages: { padding: 16, gap: 10, paddingBottom: 24 },
  emptyChat: {
    flex: 1,
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center"
  },
  emptyChatText: { fontSize: 18, fontWeight: "500", color: theme.subtle },
  composerWrap: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.border,
    backgroundColor: theme.bg
  },
  composerInput: {
    flex: 1,
    minHeight: 40,
    maxHeight: 140,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    borderWidth: 1,
    fontSize: 16,
    color: theme.text,
    backgroundColor: theme.inputBg,
    borderColor: theme.border
  },
  sendButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 18,
    minWidth: 64,
    alignItems: "center",
    justifyContent: "center"
  },
  sendText: { fontSize: 15, fontWeight: "600", color: theme.buttonText }
});
