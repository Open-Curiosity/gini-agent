import { useState } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { theme } from "@/src/theme";
import type { ToolCallBlock, ToolResultBlock } from "@/src/types";

// Single inline row for a tool dispatch. Tapping the row toggles an
// inline preview of the matching tool_result (passed via prop from the
// BlockRenderer dispatcher). Mirrors the web BlockToolCall behavior:
// no status badge on the happy path, error message inline for failures.
export function BlockToolCall({
  block,
  result
}: {
  block: ToolCallBlock;
  result?: ToolResultBlock;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = block.status === "error" || block.status === "denied";
  const canExpand = Boolean(result);
  return (
    <View style={styles.row}>
      <TouchableOpacity
        activeOpacity={canExpand ? 0.7 : 1}
        disabled={!canExpand}
        onPress={() => canExpand && setExpanded((v) => !v)}
        style={styles.header}
      >
        <Text style={styles.chevron}>{canExpand ? (expanded ? "▾" : "▸") : "•"}</Text>
        <Text style={styles.label} numberOfLines={1}>
          {block.displayLabel}
        </Text>
        {block.argsPreview ? (
          <Text style={styles.preview} numberOfLines={1}>
            {block.argsPreview}
          </Text>
        ) : null}
      </TouchableOpacity>
      {failed && block.errorMessage ? (
        <Text style={styles.errorMessage} numberOfLines={3}>
          {block.errorMessage}
        </Text>
      ) : null}
      {expanded && result ? (
        <View style={styles.resultBox}>
          <Text style={styles.resultText} numberOfLines={20}>
            {result.preview}
            {result.truncated ? "\n\n[truncated]" : ""}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    gap: 6
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap"
  },
  chevron: {
    color: theme.subtle,
    fontSize: 11,
    width: 10
  },
  label: {
    color: theme.text,
    fontSize: 13,
    fontWeight: "600"
  },
  preview: {
    color: theme.subtle,
    fontSize: 11,
    fontFamily: "Menlo",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: theme.inputBg,
    overflow: "hidden",
    flexShrink: 1
  },
  errorMessage: {
    color: theme.danger,
    fontSize: 12,
    paddingLeft: 16
  },
  resultBox: {
    marginLeft: 16,
    padding: 8,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
    maxHeight: 200
  },
  resultText: {
    color: theme.subtle,
    fontSize: 11,
    fontFamily: "Menlo"
  }
});
