/// <reference lib="dom" />

// AppShell picks the layout from the route: /pair (and /pair/*) renders children
// bare (no app chrome); every other route wraps children in the full shell
// (Sidebar + MobileTopBar + TunnelMenu). Only usePathname drives that branch.
//
// LEAK SAFETY + COVERAGE SCOPE: mock.module is process-wide in `bun test`, so we
// only mock specifiers that no OTHER test renders as its subject:
//   - next/navigation (node_module; spread + usePathname override; reverted so it
//     can't leak — node_modules aren't counted for coverage)
//   - @/components/Sidebar (no other test imports it, so the stub needs no revert)
// We deliberately do NOT import the real @/components/Sidebar: pulling that src
// file in would register it (and its heavy AgentSwitcher/CreateAgentDialog deps)
// for the 100% coverage gate without covering it. The stub fully replaces it.
// We also do NOT mock @/components/tunnel/TunnelMenu or its useTunnel hook —
// those ARE subjects of the tunnel tests, and stubbing them leaks. Instead the
// REAL TunnelMenu renders, so the shell branch is observable via the Sidebar stub
// + the real tunnel trigger.
//
// DETERMINISM: TunnelMenu's useTunnel() fires a GET on mount. happy-dom restores
// the native fetch, so that real async call would resolve AFTER the synchronous
// assertions and commit React state outside act() (the "not wrapped in act(...)"
// warning, and a risk of a post-teardown setState). We stub globalThis.fetch with
// a resolved tunnel-state Response (leak-safe: snapshot the real fetch in a
// closure and restore it in afterEach), and the shell-rendering tests await the
// in-flight read inside act via waitFor before they finish. The /pair tests render
// children bare (no TunnelMenu mounts), so there is nothing to drain there.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const realNav = await import("next/navigation");
const realFetch = globalThis.fetch;

let pathname: string | null = "/";
let AppShell: typeof import("./AppShell").AppShell;

beforeAll(async () => {
  mock.module("next/navigation", () => ({ ...realNav, usePathname: () => pathname }));
  mock.module("@/components/Sidebar", () => ({
    Sidebar: () => <div data-testid="sidebar-stub" />,
    MobileTopBar: () => <div data-testid="mobile-topbar-stub" />
  }));
  // The query suffix is a runtime cache-bust; keep it in a variable so tsc treats
  // the dynamic import as `any` instead of trying to resolve the suffixed path.
  const appShellPath = "./AppShell?appshell-test";
  ({ AppShell } = (await import(appShellPath)) as typeof import("./AppShell"));
});

afterAll(() => {
  mock.module("next/navigation", () => realNav);
});

const CHILD = <div data-testid="child">child content</div>;

function renderShell() {
  // TunnelMenu (rendered for real on the shell branch) reads QueryClient context
  // indirectly via useTunnel's fetch path; a provider keeps it from throwing.
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <AppShell>{CHILD}</AppShell>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  pathname = "/";
  // Resolve useTunnel's on-mount GET deterministically so its state commit lands
  // inside act (drained via waitFor below) rather than after teardown.
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({ providers: [], selectedProvider: null, status: "idle" }),
        { headers: { "content-type": "application/json" } }
      )
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("AppShell", () => {
  test("normal route: wraps children in the full shell (Sidebar + MobileTopBar + tunnel chrome)", async () => {
    pathname = "/chat";
    const { container } = renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(screen.queryByTestId("mobile-topbar-stub")).not.toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
    // The shell's distinctive flex container is present on non-/pair routes.
    expect(container.querySelector(".flex.h-screen")).not.toBeNull();
    // The real tunnel trigger renders inside the shell. Awaiting it also drains
    // useTunnel's on-mount GET inside act, so the state commit doesn't fire after
    // teardown.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /tunnel/i })).not.toBeNull()
    );
  });

  test("/pair: renders only children, no app chrome", () => {
    pathname = "/pair";
    const { container } = renderShell();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(screen.queryByTestId("mobile-topbar-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
    expect(screen.queryByRole("button", { name: /tunnel/i })).toBeNull();
  });

  test("/pair/* subpaths also render bare", () => {
    pathname = "/pair/done";
    const { container } = renderShell();
    expect(screen.queryByTestId("child")).not.toBeNull();
    expect(screen.queryByTestId("sidebar-stub")).toBeNull();
    expect(container.querySelector(".flex.h-screen")).toBeNull();
  });

  test("a null pathname falls through to the full shell", async () => {
    pathname = null;
    renderShell();
    expect(screen.queryByTestId("sidebar-stub")).not.toBeNull();
    expect(screen.queryByTestId("child")).not.toBeNull();
    // This route also mounts the real TunnelMenu; drain its on-mount GET inside
    // act so the state commit lands before teardown.
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /tunnel/i })).not.toBeNull()
    );
  });
});
