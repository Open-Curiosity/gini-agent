import { Feather } from "@expo/vector-icons";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { relativeTime } from "@/src/format";
import { family } from "@/src/theme";

// Inline "N replies · last reply …" chip (design GmqLz, light palette)
// rendered under a main-chat assistant bubble when that message hosts a
// thread. Tapping opens the Slack-style Thread View. Threads are created
// by the agent (the runtime branches a turn into a thread); the user
// continues an existing one from here, so there's no user-initiated
// "start a thread" affordance — only this open-the-thread chip.

export function ThreadRepliesChip({
  replyCount,
  lastReplyAt,
  onPress
}: {
  replyCount: number;
  lastReplyAt?: string;
  onPress: () => void;
}) {
  const last = lastReplyAt ? relativeTime(lastReplyAt) : null;
  return (
    <TouchableOpacity
      onPress={onPress}
      activeOpacity={0.7}
      style={styles.chip}
      accessibilityRole="button"
      accessibilityLabel={`${replyCount} ${replyCount === 1 ? "reply" : "replies"} in thread`}
    >
      <View style={styles.chipText}>
        <Text style={styles.chipReplies}>
          {replyCount} {replyCount === 1 ? "reply" : "replies"}
        </Text>
        {last ? (
          <>
            <Text style={styles.chipSep}>·</Text>
            <Text style={styles.chipLast}>last reply {last}</Text>
          </>
        ) : null}
      </View>
      <Feather name="chevron-right" size={18} color="#8A93B8" />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    alignSelf: "flex-start",
    backgroundColor: "#EEF2FF",
    borderWidth: 1,
    borderColor: "#DCE3FB",
    borderRadius: 13,
    paddingVertical: 7,
    paddingLeft: 9,
    paddingRight: 11
  },
  chipText: { flexDirection: "row", alignItems: "center", gap: 6 },
  chipReplies: {
    color: "#2F6BFF",
    fontFamily: family("HankenGrotesk", 700),
    fontSize: 13
  },
  chipSep: {
    color: "#AEBBE8",
    fontFamily: family("HankenGrotesk", 600),
    fontSize: 12
  },
  chipLast: {
    color: "#7A86A8",
    fontFamily: family("HankenGrotesk", 500),
    fontSize: 12
  }
});
