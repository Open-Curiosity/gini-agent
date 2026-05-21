import { router } from "expo-router";
import {
  Alert,
  StyleSheet,
  Text,
  TouchableOpacity,
  useColorScheme,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth";

export default function SettingsScreen() {
  const scheme = useColorScheme();
  const theme = scheme === "dark" ? darkTheme : lightTheme;
  const { credentials, clear } = useAuth();

  const onClear = () => {
    Alert.alert(
      "Sign out?",
      "Stored URL and token will be removed from this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Sign out",
          style: "destructive",
          onPress: async () => {
            await clear();
            router.replace("/setup");
          }
        }
      ]
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={["bottom"]}>
      <View style={styles.section}>
        <Text style={[styles.label, { color: theme.subtle }]}>Base URL</Text>
        <Text style={[styles.value, { color: theme.text }]}>
          {credentials?.baseUrl ?? "—"}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.label, { color: theme.subtle }]}>Token</Text>
        <Text style={[styles.value, { color: theme.text }]} numberOfLines={1}>
          {credentials?.token ? maskToken(credentials.token) : "—"}
        </Text>
      </View>

      <TouchableOpacity
        onPress={onClear}
        style={[styles.button, { backgroundColor: theme.danger }]}
      >
        <Text style={[styles.buttonText, { color: theme.dangerText }]}>Sign out</Text>
      </TouchableOpacity>
    </SafeAreaView>
  );
}

// First/last 4 chars only so the value is recognizable to a user that
// pasted it but doesn't fully expose the secret on a casual glance.
function maskToken(t: string): string {
  if (t.length <= 12) return "•".repeat(t.length);
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, padding: 20 },
  section: { marginBottom: 20 },
  label: { fontSize: 12, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4 },
  value: { fontSize: 16 },
  button: {
    marginTop: 12,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  buttonText: { fontSize: 16, fontWeight: "600" }
});

const lightTheme = {
  bg: "#ffffff",
  text: "#0a0a0a",
  subtle: "#6b7280",
  danger: "#fee2e2",
  dangerText: "#b91c1c"
};

const darkTheme = {
  bg: "#0a0a0a",
  text: "#fafafa",
  subtle: "#9ca3af",
  danger: "#3f1d1d",
  dangerText: "#fca5a5"
};
