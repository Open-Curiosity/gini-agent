# Gini Roadmap

Gini's runtime is the gateway. The roadmap is organized around that fact: shipped surfaces deepen the gateway contract, and planned surfaces are new clients and lifecycle layers built on top of it. The architecture invariant (one stateful local runtime, replaceable clients, no browser tokens, no privileged side channels) does not change.

This is the long-form version of the short list in the [README](README.md#roadmap). Items marked ✅ are shipped today. Items marked ⚪ are planned and may shift order.

## Shipped

- ✅ **Local-first Bun gateway.** One process per instance owns durable state and performs all real work, exposing an authenticated HTTP + SSE `/api/*` contract.
- ✅ **Next.js webapp with BFF.** The browser never receives a gateway bearer token; the Next.js server attaches it on every proxied request.
- ✅ **CLI and parallel instances.** Each worktree can run an isolated instance with its own ports, state, logs, and workspace. Smoke tests run in ephemeral instances.
- ✅ **Persistent conversational surface.** Chat sessions, runs, plan steps, tasks, approvals, audit events, traces, and evidence bundles are all durable.
- ✅ **Approval-gated tools.** File, terminal, and code tools always raise high-risk approvals before side-effecting; trace and audit handoff is preserved.
- ✅ **Four-network memory.** Retain, recall, embeddings, and reranking ship locally by default; Transformers.js model cache is shared across instances.
- ✅ **Trace-backed improvement proposals.** Memory, skill, and job changes are proposed from traces rather than written blindly.
- ✅ **Provider support.** Codex OAuth (existing `codex --login`), OpenAI API key, and OpenRouter-compatible records. Provider tokens are never written to Gini config.
- ✅ **Paired-device auth.** Mobile bootstrap contract and device records are in place so a future mobile client can pair once and hold its own token.
- ✅ **Instance-local snapshots.** Snapshots and promotion proposal records preserve the "before trying a candidate" state.
- ✅ **Hermes / OpenClaw parity primitives.** Memory, skills, jobs, search, providers, toolsets, subagents, MCP records, messaging records, and import inspection.

## Planned

The three items the roadmap is built around — what "done" looks like — are **task self-learning and iteration loop**, **native macOS client**, and **iOS mobile app for remote control**. Everything else is supporting infrastructure that makes those three load-bearing pieces work well.

### Task self-learning and iteration loop

Trace-backed improvement proposals (shipped) let memory, skills, and jobs evolve from observed runs. The next step is closing the loop at the task level: a task observes its own attempts, refines its plan, and retries — without a human relaying the lesson each time.

- ⚪ **Per-task trace introspection.** A task can read its own prior runs, plan steps, tool calls, and outcomes as structured signal, not just a chat log.
- ⚪ **Plan revision from outcomes.** When a step fails or produces a low-quality result, the next attempt revises the plan rather than retrying verbatim.
- ⚪ **Auto-proposed memory and skill writes.** Lessons from a task's own runs surface as improvement proposals against the relevant memory bank or skill, gated by the existing approval surface.
- ⚪ **Multi-attempt budgets.** Tasks declare a budget (time, tokens, attempts) and the loop terminates cleanly when exhausted, with an explanation rather than a hang.
- ⚪ **Replay determinism.** A failed task can be re-run from any checkpoint with the same provider, tools, and memory state — so the iteration loop is debuggable, not magic.

### Always-on runtime

The webapp dead-ends if you haven't run `gini start`. A native client without a supervised runtime hits the same wall. The fix is to make the gateway a real macOS background service so "is it running" is almost always yes.

- ⚪ **`gini autostart enable|disable`.** Writes a per-instance `~/Library/LaunchAgents/ai.lilac.gini.<instance>.plist` and registers with `launchctl bootstrap gui/$(id -u)`. `disable` boots it out and removes the file.
- ⚪ **Crash recovery.** `KeepAlive` configured as a dict (not bool), so `gini stop` is honored but unexpected exits respawn within `ThrottleInterval`.
- ⚪ **Network-aware startup.** `KeepAlive.NetworkState = true` so the first boot of the day waits for networking before launching provider auth flows.
- ⚪ **Health watchdog.** A secondary `StartInterval` plist or in-process job hits `/api/healthz` and kills wedged Bun processes that launchd can't detect.
- ⚪ **Linux equivalent.** `systemd --user` unit shipped alongside the macOS plist for parity.

### Official native macOS client

Gini ships an opinionated, best-in-class native client. The webapp does not go away — it gets demoted to one client among many. The Mac app is the recommended interface because approvals are interrupts, not pages, and the right shape for interrupts is the menubar and native notifications, not a browser tab.

- ⚪ **Tauri-style shell hosting the existing Next.js UI.** Reuse the frontend; add the OS-integration layer the browser can't reach.
- ⚪ **Menubar presence.** Status dot, pending-approval badge, run-activity indicator, click-to-summon. Survives sleep, network changes, and instance restarts.
- ⚪ **Global hotkey.** Summon a Gini chat from anywhere without switching apps. Quick-action surface for the current cursor selection.
- ⚪ **Native notifications.** macOS notifications for pending approvals, run completion, job results, and watchdog events — fire whether the app is foregrounded or not.
- ⚪ **Persistent SSE stream.** No "tab unloaded, missed the run completion." The native window keeps the event stream alive across screensaver, sleep/wake, and reconnects automatically.
- ⚪ **Lifecycle ownership.** Quit-means-quit, with a clean shutdown handoff to the supervised gateway. No orphaned Bun processes or stuck ports.
- ⚪ **Keychain-backed approval gating.** Touch ID confirmation for high-risk approvals where applicable.
- ⚪ **Universal binary.** Apple Silicon + Intel in one artifact, distributed via GitHub Releases (not the Mac App Store — sandbox constraints conflict with the supervisor role).

### Trust layer

The native client is an *expression* of the local-first philosophy, not a compromise of it. Users should not have to trust Gini-the-distributor any more than they have to trust Gini-the-source-code. The trust posture should be stronger than the commercial alternatives in this space — closer to Signal and Bitwarden than to any commercial AI desktop app.

The structural property the architecture already gives us: **the native client has no privileged side channels.** Its only inputs come from `/api/*`. Its only outputs go to `/api/*`. Anything it does is auditable in the gateway logs the user already has. The trust layer makes that property visible and verifiable.

- ⚪ **Client source in this repo.** `clients/macos/` lives next to the runtime. No closed-source binary anywhere in the install path.
- ⚪ **Reproducible builds.** Pinned toolchain, vendored or hash-locked dependencies, `SOURCE_DATE_EPOCH=0`, stripped timestamps, documented in `BUILDING.md`. Anyone can rebuild the released binary on their own Mac and verify the hash matches the artifact on GitHub Releases.
- ⚪ **`gini verify-app`.** First-class CLI subcommand that rebuilds the installed app from the corresponding tag in a fresh sandbox and diffs hashes. Reports `verified` or `mismatch`. The existence of the command is the trust signal, not the fact that most users will run it.
- ⚪ **SLSA / sigstore build provenance.** CI publishes a signed attestation for every release saying "this binary was built from commit X by this exact workflow run." Verifiable via the public transparency log without the user rebuilding.
- ⚪ **Apple notarization.** For Gatekeeper UX. Treated as a UX signal, not a trust signal — notarization proves Apple's malware scanner cleared the binary, not that the maintainer is honest.
- ⚪ **Zero phone-home by default.** No analytics, no crash reports, no "anonymized telemetry" sent automatically. If telemetry is ever added, it is opt-in with payload preview before the first send. Discoverable in code, not just policy.
- ⚪ **Network policy.** The app talks only to `127.0.0.1:<runtime-port>/api/*` and a fixed GitHub Releases URL for update checks. CI-enforced lint fails any PR that introduces a new outbound endpoint.
- ⚪ **Auto-update is the user's choice.** Sparkle (or Tauri's updater) defaults on, pulling signed updates from GitHub Releases, with a one-click setting to disable the channel entirely.
- ⚪ **Live debug pane.** `cmd+opt+I`-style view showing real-time API calls between the app and the gateway. Nothing the app does is hidden from a user who wants to look.
- ⚪ **`TRUST.md`.** Public document listing every entitlement requested, every network endpoint contacted, and the exact verification commands users can run to confirm each claim.

### iOS mobile app (remote control)

The phone is not a place to run the gateway — the gateway lives on the Mac. The phone is a **remote control** for that running agent: see what's pending, approve from anywhere, trigger tasks, receive notifications. This is what the paired-device auth and mobile bootstrap contracts (shipped) were designed for.

- ⚪ **Native iOS client.** SwiftUI app pairing once with a Mac instance and storing its token in the Secure Enclave.
- ⚪ **Approvals on the phone.** Pending approvals delivered as push notifications, actioned with Face ID confirmation, audit-logged on the gateway like any other approval.
- ⚪ **Run and task visibility.** Live view of in-flight runs, queued tasks, and recent traces — the same SSE stream the Mac client consumes.
- ⚪ **Voice and quick triggers.** Shortcuts.app and Siri integration so a task can be kicked off without unlocking the phone.
- ⚪ **Off-LAN reachability.** Requires the production relay (see Reach) before remote control works outside the home network. Local-network usage works without it.
- ⚪ **Android later.** Same paired-device contract, lower priority.

### Gini as MCP server

The gateway already records MCP. The reverse direction — Gini *as* an MCP server consumed by Claude Desktop, Cursor, Zed, Warp, and other AI-native hosts — turns trusted host apps into inherited trust surfaces. Users reuse permissions they already granted to those tools instead of being asked to grant Gini new ones.

- ⚪ **Gini MCP server.** Stable MCP surface exposing chat, runs, memory, skills, approvals, and tools to host AI editors.
- ⚪ **Discovery and wiring.** `gini setup` detects installed MCP hosts (Claude Desktop, Cursor, Zed) and offers to register Gini with them.
- ⚪ **Capability scoping.** Per-host capability tokens so a host editor only sees the surface a user opts into.

### Reference integrations

The "official native client" is opinionated, but the architecture is plural. Reference integrations show users (and other developers) that the gateway contract is a public protocol, and that ad-hoc clients can be first-class without forking the project.

- ⚪ **Raycast extension.** Menubar, hotkey, notifications, quick-summon — using Raycast's existing trust surface.
- ⚪ **Shortcuts.app workflows.** Voice + automation triggers wired to `/api/*`.
- ⚪ **Hammerspoon Spoon.** Power-user scripting surface.
- ⚪ **Alfred workflow.** For Alfred holdouts.
- ⚪ **`clients/` directory.** All reference clients live alongside the runtime in the same repo, so they move with the API contract.

### Reach

These items extend Gini beyond a single Mac. The native macOS client and the iOS remote control are the consumers; these items are the plumbing that makes them work outside the home network.

- ⚪ **Production relay.** Off-LAN access without exposing localhost. Tailscale-style mesh or a thin Cloudflare Worker relay, with end-to-end auth that never trusts the relay operator.
- ⚪ **Native push notifications.** APNs for iOS, FCM for Android, surfaced into the existing approval and run-completion events.
- ⚪ **Cross-instance federation.** Optional shared memory and skill sync between a user's own instances (laptop ↔ desktop) under user-controlled keys.

## What's deliberately not on the roadmap

- **A SaaS-hosted Gini.** The runtime is local-first by design. A managed version is a different product, not a stage of this one.
- **A drag-and-drop workflow builder.** Skills, jobs, and runs are the unit of composition. Gini is not a low-code platform.
- **Mac App Store distribution.** Sandbox entitlements conflict with the always-on supervisor role.
- **Bundled providers.** Gini does not ship an in-house model. Users bring their Codex or OpenAI credentials (or any future provider). Provider tokens never enter Gini config.

## How items move from ⚪ to ✅

A planned item moves to shipped when:

1. The capability is reachable through the current `/api/*` contract (no breaking client changes after the fact).
2. ADRs that govern the relevant boundary are updated or added (see [docs/adr/](docs/adr/)).
3. The change has a verification path documented in [docs/runtime-capabilities.md](docs/runtime-capabilities.md).
4. Trust-layer items additionally require updates to `TRUST.md` and any CI guardrails (network-policy lint, build reproducibility checks) before they are considered shipped.

If a planned item turns out to be wrong-shape or superseded, the corresponding entry here is removed and an ADR records why.
