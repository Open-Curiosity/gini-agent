"use client";

import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Toaster } from "sonner";
import { RuntimeStreamBridge } from "./RuntimeStreamBridge";

export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      // SSE-driven invalidation (via RuntimeStreamBridge) handles freshness.
      // Window-focus refetch is a safety net for when the browser closes idle
      // EventSource connections on tab background.
      queries: { refetchOnWindowFocus: true, staleTime: 5_000, retry: 1 }
    }
  }));
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} disableTransitionOnChange>
      <QueryClientProvider client={client}>
        <RuntimeStreamBridge />
        {children}
        <Toaster richColors position="bottom-right" />
      </QueryClientProvider>
    </ThemeProvider>
  );
}
