import { StyleSheet, Text } from "react-native";
import { theme } from "@/src/theme";
import type { SystemNoteBlock } from "@/src/types";

// Muted italic single-paragraph note. Used for terminal flags
// (Cancelled, Failed: …) and other operator-attributed lines. Kept
// low-key so it doesn't pull focus away from the assistant's reply.
export function BlockSystemNote({ block }: { block: SystemNoteBlock }) {
  return <Text style={styles.text}>{block.text}</Text>;
}

const styles = StyleSheet.create({
  text: {
    color: theme.subtle,
    fontSize: 12,
    fontStyle: "italic",
    paddingHorizontal: 4,
    paddingVertical: 2
  }
});
