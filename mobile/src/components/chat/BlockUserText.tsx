import { StyleSheet, Text, View } from "react-native";
import { theme } from "@/src/theme";
import type { UserTextBlock } from "@/src/types";

// User turns sit on the right with the accent-tinted bubble that matches
// the rest of the chat surface. No avatar — the brief explicitly avoids
// icon decoration, and alignment is enough of a signal on its own.
export function BlockUserText({ block }: { block: UserTextBlock }) {
  return (
    <View style={styles.row}>
      <View style={styles.bubble}>
        <Text style={styles.text} selectable>
          {block.text}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-end",
    maxWidth: "85%"
  },
  bubble: {
    backgroundColor: theme.userBubble,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
    borderTopRightRadius: 4
  },
  text: {
    fontSize: 16,
    lineHeight: 22,
    color: theme.userBubbleText
  }
});
