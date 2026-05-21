import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { api, ApiError } from "@/src/api";
import { normalizeBaseUrl, saveCredentials } from "@/src/auth";
import type { RuntimeStatus } from "@/src/types";

const DEFAULT_BASE_URL = "http://localhost:7421";

export default function SetupScreen() {
  const scheme = useColorScheme();
  const theme = scheme === "dark" ? darkTheme : lightTheme;
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    const trimmedToken = token.trim();
    let normalizedUrl: string;
    try {
      normalizedUrl = normalizeBaseUrl(baseUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Invalid base URL.");
      return;
    }
    if (!trimmedToken) {
      setError("Bearer token is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // Validate before persisting — saving an unreachable URL would
      // strand the user on a "broken" agents screen with no easy way
      // back without nuking storage.
      await api<RuntimeStatus>("/status", {
        auth: { baseUrl: normalizedUrl, token: trimmedToken }
      });
      await saveCredentials({ baseUrl: normalizedUrl, token: trimmedToken });
      router.replace("/agents");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setError("Token rejected by gateway (401). Double-check the token.");
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError("Unknown error reaching gateway.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: theme.bg }]} edges={["bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={[styles.heading, { color: theme.text }]}>Connect to Gini</Text>
          <Text style={[styles.subhead, { color: theme.subtle }]}>
            Paste the runtime's base URL and bearer token. You can find the
            token in {`~/.gini/instances/<instance>/config.json`} or by running
            {" "}<Text style={styles.mono}>gini status</Text>.
          </Text>

          <Text style={[styles.label, { color: theme.text }]}>Base URL</Text>
          <TextInput
            value={baseUrl}
            onChangeText={setBaseUrl}
            autoCapitalize="none"
            autoCorrect={false}
            inputMode="url"
            keyboardType="url"
            placeholder={DEFAULT_BASE_URL}
            placeholderTextColor={theme.subtle}
            editable={!busy}
            style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
          />

          <Text style={[styles.label, { color: theme.text }]}>Bearer token</Text>
          <TextInput
            value={token}
            onChangeText={setToken}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder="paste token"
            placeholderTextColor={theme.subtle}
            editable={!busy}
            style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.inputBg }]}
          />

          {error ? (
            <Text style={[styles.error, { color: theme.danger }]}>{error}</Text>
          ) : null}

          <TouchableOpacity
            disabled={busy}
            onPress={onSubmit}
            style={[styles.button, { backgroundColor: busy ? theme.buttonDisabled : theme.button }]}
          >
            {busy ? (
              <ActivityIndicator color={theme.buttonText} />
            ) : (
              <Text style={[styles.buttonText, { color: theme.buttonText }]}>Save & continue</Text>
            )}
          </TouchableOpacity>

          <Text style={[styles.footnote, { color: theme.subtle }]}>
            On a real device, replace localhost with the runtime host's LAN
            IP (e.g. http://192.168.1.42:7421). The simulator/emulator can
            keep localhost.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  flex: { flex: 1 },
  scroll: { padding: 20, paddingTop: 32, gap: 12 },
  heading: { fontSize: 24, fontWeight: "700" },
  subhead: { fontSize: 14, lineHeight: 20, marginBottom: 8 },
  mono: { fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }) },
  label: { fontSize: 13, fontWeight: "600", marginTop: 12 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16
  },
  error: { fontSize: 14, marginTop: 4 },
  button: {
    marginTop: 20,
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center"
  },
  buttonText: { fontSize: 16, fontWeight: "600" },
  footnote: { fontSize: 12, marginTop: 16, lineHeight: 18 }
});

const lightTheme = {
  bg: "#ffffff",
  text: "#0a0a0a",
  subtle: "#6b7280",
  border: "#d4d4d8",
  inputBg: "#fafafa",
  button: "#0a0a0a",
  buttonDisabled: "#a1a1aa",
  buttonText: "#ffffff",
  danger: "#dc2626"
};

const darkTheme = {
  bg: "#0a0a0a",
  text: "#fafafa",
  subtle: "#9ca3af",
  border: "#27272a",
  inputBg: "#18181b",
  button: "#fafafa",
  buttonDisabled: "#52525b",
  buttonText: "#0a0a0a",
  danger: "#f87171"
};
