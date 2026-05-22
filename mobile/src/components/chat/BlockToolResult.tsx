import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "@/src/theme";
import type { ToolResultBlock } from "@/src/types";

// Single-line muted monospace preview of the tool's result. Tappable to
// expand into the full (already server-truncated) preview. The runtime
// keeps the full transcript on the legacy ChatMessageRecord during the
// migration window — clients only render the block's preview.
export function BlockToolResult({ block }: { block: ToolResultBlock }) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = firstLine(block.preview) || "(empty result)";
  return (
    <Pressable onPress={() => setExpanded((v) => !v)} style={styles.row}>
      <Text
        style={styles.text}
        numberOfLines={expanded ? undefined : 1}
        selectable
      >
        {expanded ? block.preview : collapsed}
      </Text>
      {block.truncated && !expanded ? (
        <Text style={styles.truncated}> (truncated)</Text>
      ) : null}
    </Pressable>
  );
}

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx >= 0 ? text.slice(0, idx) : text;
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    paddingHorizontal: 10,
    paddingVertical: 4
  },
  text: {
    color: theme.subtle,
    fontSize: 12,
    fontFamily: "Menlo",
    lineHeight: 16
  },
  truncated: {
    color: theme.subtle,
    fontSize: 11,
    fontStyle: "italic"
  }
});
