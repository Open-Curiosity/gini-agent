"use client";

import { usePathname } from "next/navigation";
import { MobileTopBar, Sidebar } from "@/components/Sidebar";
import { TunnelMenu } from "@/components/tunnel/TunnelMenu";

// The /pair page is a pre-auth, standalone surface shown to a device that has
// no session yet. Wrapping it in the authenticated app chrome (Sidebar +
// TunnelMenu) fires /api/runtime/* queries that 401 for the unpaired device
// (console noise) and leaks app navigation onto the pairing screen. So /pair
// renders bare; every other route gets the full shell. See ADR
// device-pairing-auth.md.
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith("/pair")) {
    return <>{children}</>;
  }
  return (
    <div className="flex h-screen">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <MobileTopBar />
        <main className="relative flex flex-1 flex-col overflow-hidden">
          <div className="pointer-events-none absolute right-4 top-4 z-30">
            <div className="pointer-events-auto">
              <TunnelMenu />
            </div>
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
