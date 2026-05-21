import { Redirect } from "expo-router";
import { useAuth } from "@/src/auth";

// Auth gate. The root layout has already primed the AsyncStorage cache
// by the time this component renders, so the redirect is synchronous
// from the user's perspective.
export default function Index() {
  const { status, credentials } = useAuth();
  if (status === "loading") return null;
  if (!credentials) return <Redirect href="/setup" />;
  return <Redirect href="/agents" />;
}
