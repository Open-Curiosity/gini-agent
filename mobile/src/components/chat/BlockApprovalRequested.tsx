import { StyleSheet, Text, View } from "react-native";
import { theme } from "@/src/theme";
import type { ApprovalRequestedBlock } from "@/src/types";

// Approval bubble. Mobile in this round doesn't have the approve/deny
// mutations wired (web carries the AddConnectorDialog + the
// /approvals/:id/{approve,deny,connect} POSTs), so we render a warning
// card with the summary and a hint to open the chat on the web. Future
// rounds can layer the actions onto this same component.
//
// The bubble stays in the chat log forever — the runtime never deletes
// approval rows, and the visual treatment lets the user see the
// historical gate decision without losing the chat narrative.
export function BlockApprovalRequested({ block }: { block: ApprovalRequestedBlock }) {
  return (
    <View style={styles.row}>
      <View style={styles.header}>
        <Text style={styles.action}>{block.action}</Text>
        <Text style={[styles.risk, riskStyle(block.risk)]}>{block.risk}</Text>
      </View>
      <Text style={styles.summary}>{block.summary}</Text>
      <Text style={styles.hint}>
        Approve or deny this on the web client.
      </Text>
    </View>
  );
}

// Color the risk pill so the user gets a quick glanceable severity cue.
// We keep the warning amber for the card border and reserve red only for
// high risk.
function riskStyle(risk: string) {
  if (risk === "high") return { backgroundColor: "rgba(229, 83, 83, 0.18)", color: theme.danger };
  if (risk === "medium") return { backgroundColor: "rgba(250, 167, 48, 0.18)", color: "#FAA730" };
  return { backgroundColor: "rgba(123, 200, 98, 0.18)", color: "#7BC862" };
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "stretch",
    maxWidth: "92%",
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(250, 167, 48, 0.4)",
    backgroundColor: "rgba(250, 167, 48, 0.08)"
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4
  },
  action: {
    color: theme.text,
    fontSize: 12,
    fontFamily: "Menlo",
    flexShrink: 1
  },
  risk: {
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: "hidden"
  },
  summary: {
    color: theme.text,
    fontSize: 13,
    lineHeight: 18,
    marginBottom: 6
  },
  hint: {
    color: theme.subtle,
    fontSize: 11,
    fontStyle: "italic"
  }
});
