import { Search } from "lucide-react";
import { AgentAvatar } from "./AgentAvatar";
import { formatRelativeTime } from "./relative-time";

// Per-agent (or channel) chat header — design `zFqWM`. 52px colored-initial
// avatar, name, a green "Ready · last active …" status row, and a non-wired
// "Search in chat" affordance (parity with the design; search isn't a backend
// surface yet).
export function AgentChatHeader({
  name,
  seed,
  lastActiveAt,
  subtitle
}: {
  name: string;
  seed?: string;
  lastActiveAt?: string;
  subtitle?: string;
}) {
  const lastActive = lastActiveAt ? formatRelativeTime(lastActiveAt) : "";
  return (
    <header className="flex shrink-0 items-center justify-between gap-4 border-b border-[#1C1C1E] px-7 py-4">
      <div className="flex min-w-0 items-center gap-4">
        <AgentAvatar name={name} seed={seed} size={52} className="border border-[#1C1C1E]" />
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="truncate text-[19px] font-bold leading-none text-foreground">{name}</h1>
          <div className="flex items-center gap-1.5 text-[12px] leading-none">
            <span aria-hidden className="size-[7px] rounded-full bg-[#4ADE80]" />
            <span className="font-semibold text-[#C2C2C8]">Ready</span>
            {subtitle ? (
              <>
                <span className="text-[#5A5A60]">·</span>
                <span className="font-medium text-[#7A7A80]">{subtitle}</span>
              </>
            ) : lastActive ? (
              <>
                <span className="text-[#5A5A60]">·</span>
                <span className="font-medium text-[#7A7A80]">last active {lastActive}</span>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="hidden items-center gap-2 rounded-md border border-[#2A2A2E] bg-[#15161C] px-2.5 py-1.5 text-[12px] font-medium text-[#7A7A80] sm:flex">
        <Search className="size-3.5" />
        Search in chat
      </div>
    </header>
  );
}
