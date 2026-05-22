import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, Text, View } from "react-native";
import { theme } from "@/src/theme";
import type { ToolCallBlock, ToolCallStatus } from "@/src/types";

// Single inline row for a tool dispatch. The runtime emits a `running`
// row at dispatch time and upserts it with `ok` / `error` / `denied`
// once the call resolves — same id, status flip. Mobile sees both
// upserts on the next poll tick.
//
// We avoid icons (the brief is explicit about that) and rely on a small
// colored status indicator: pulsing accent for running, subtle green
// for ok, danger red for error/denied.
const STATUS_TONES: Record<ToolCallStatus, string> = {
  running: theme.accent,
  ok: "#7BC862",
  error: theme.danger,
  denied: theme.danger
};

const STATUS_LABELS: Record<ToolCallStatus, string> = {
  running: "running",
  ok: "ok",
  error: "error",
  denied: "denied"
};

export function BlockToolCall({ block }: { block: ToolCallBlock }) {
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.label} numberOfLines={1}>
          {block.displayLabel}
        </Text>
        <StatusDot status={block.status} />
        <Text style={[styles.status, { color: STATUS_TONES[block.status] }]}>
          {STATUS_LABELS[block.status]}
        </Text>
      </View>
      {block.argsPreview ? (
        <Text style={styles.preview} numberOfLines={2}>
          {block.argsPreview}
        </Text>
      ) : null}
      {block.errorMessage ? (
        <Text style={styles.errorMessage} numberOfLines={3}>
          {block.errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

function StatusDot({ status }: { status: ToolCallStatus }) {
  // Running dots pulse so a long-lived tool call has a visible heartbeat;
  // terminal states render the dot as a flat color so the user can tell
  // at a glance whether the call is still going.
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (status !== "running") {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true
        })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [status, opacity]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: STATUS_TONES[status], opacity }
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.inputBg
  },
  header: { flexDirection: "row", alignItems: "center", gap: 6 },
  label: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    marginLeft: 2
  },
  status: {
    fontSize: 11,
    fontFamily: "Menlo",
    textTransform: "lowercase"
  },
  preview: {
    color: theme.subtle,
    fontSize: 12,
    fontFamily: "Menlo",
    marginTop: 2
  },
  errorMessage: {
    color: theme.danger,
    fontSize: 12,
    marginTop: 4
  }
});
