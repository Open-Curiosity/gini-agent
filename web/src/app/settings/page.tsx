"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, EmptyState } from "@/components/PageHeader";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";
import { useParity, useReadiness, useState_ } from "@/lib/queries";

export default function SettingsPage() {
  const state = useState_();
  const parity = useParity();
  const readiness = useReadiness();
  const catalog = useQuery({
    queryKey: ["providers"],
    queryFn: () => api<unknown[]>("/providers/catalog"),
    refetchInterval: 60_000
  });
  const profiles = useQuery({
    queryKey: ["profiles"],
    queryFn: () => api<{ profiles: unknown[]; activeProfileId?: string }>("/profiles")
  });
  const toolsets = useQuery({
    queryKey: ["toolsets"],
    queryFn: () => api<{ toolsets: Array<{ id: string; name: string; status: string; description: string }> }>("/toolsets")
  });
  const mcp = useQuery({
    queryKey: ["mcp"],
    queryFn: () => api<Array<{ id: string; name: string; status: string; command: string }>>("/mcp")
  });
  const messaging = useQuery({
    queryKey: ["messaging"],
    queryFn: () => api<Array<{ id: string; name: string; status: string; kind: string }>>("/messaging")
  });
  const devices = useQuery({
    queryKey: ["devices"],
    queryFn: () => api<Array<{ id: string; name: string; status: string }>>("/devices")
  });
  const promotions = useQuery({
    queryKey: ["promotions"],
    queryFn: () => api<Array<{ id: string; status: string; candidateRef: string; summary: string }>>("/promotions")
  });

  return (
    <>
      <PageHeader title="Settings" description="Lane, providers, profiles, integrations, devices, parity & readiness" />
      <div className="flex-1 space-y-4 overflow-auto p-6">
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="text-sm">Lane</CardTitle></CardHeader>
            <CardContent>
              <p className="font-mono text-sm">{state.data?.lane ?? "…"}</p>
              <p className="font-mono text-[11px] text-muted-foreground">active profile: {state.data?.activeProfileId ?? "—"}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-sm">Provider catalog</CardTitle></CardHeader>
            <CardContent>
              {catalog.data && Array.isArray(catalog.data) && catalog.data.length > 0 ? (
                <ul className="space-y-1 text-xs">
                  {(catalog.data as Array<{ id: string; displayName: string; auth: string; models: string[] }>).map((item) => (
                    <li key={item.id} className="flex items-center justify-between gap-2">
                      <span>{item.displayName}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{item.auth} · {item.models.length} models</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No catalog" />
              )}
            </CardContent>
          </Card>
        </div>

        <Section title="Profiles" data={(profiles.data?.profiles as Array<{ id: string; name: string; status: string }>) ?? []} render={(item) => (
          <div className="flex items-center justify-between gap-2">
            <span>{item.name}</span>
            <StatusPill value={item.status} />
          </div>
        )} />

        <Section title="Toolsets" data={(toolsets.data?.toolsets ?? []) as Array<{ id: string; name: string; status: string; description: string }>} render={(item) => (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm">{item.name}</p>
              <p className="font-mono text-[10px] text-muted-foreground">{item.description}</p>
            </div>
            <StatusPill value={item.status} />
          </div>
        )} />

        <Section title="MCP servers" data={mcp.data ?? []} render={(item) => (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm">{item.name}</p>
              <p className="font-mono text-[10px] text-muted-foreground">{item.command}</p>
            </div>
            <StatusPill value={item.status} />
          </div>
        )} />

        <Section title="Messaging bridges" data={messaging.data ?? []} render={(item) => (
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm">{item.name}</p>
              <p className="font-mono text-[10px] text-muted-foreground">{item.kind}</p>
            </div>
            <StatusPill value={item.status} />
          </div>
        )} />

        <Section title="Paired devices" data={devices.data ?? []} render={(item) => (
          <div className="flex items-center justify-between gap-2">
            <span>{item.name}</span>
            <StatusPill value={item.status} />
          </div>
        )} />

        <Section title="Promotions" data={promotions.data ?? []} render={(item) => (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-xs">{item.candidateRef}</span>
              <StatusPill value={item.status} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{item.summary}</p>
          </div>
        )} />

        <div className="grid gap-3 lg:grid-cols-2">
          <ChecksCard title="Hermes parity" result={parity.data} />
          <ChecksCard title="V1 readiness" result={readiness.data} />
        </div>
      </div>
    </>
  );
}

function Section<T extends { id: string }>({ title, data, render }: { title: string; data: T[]; render: (item: T) => React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{data.length} configured</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <EmptyState title="None configured" />
        ) : (
          <ul className="divide-y divide-border">
            {data.map((item) => (
              <li key={item.id} className="py-2">{render(item)}</li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function ChecksCard({ title, result }: { title: string; result?: { ok: boolean; checks: Array<{ id: string; label: string; status: string; evidence: string[] }> } }) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm">{title}</CardTitle>
          {result ? <StatusPill value={result.ok ? "pass" : "partial"} /> : null}
        </div>
      </CardHeader>
      <CardContent>
        {!result ? (
          <EmptyState title="Loading…" />
        ) : (
          <ul className="divide-y divide-border">
            {result.checks.map((check) => (
              <li key={check.id} className="flex items-center justify-between gap-2 py-1.5">
                <span className="text-xs">{check.label}</span>
                <StatusPill value={check.status} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
