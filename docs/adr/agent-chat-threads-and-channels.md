# ADR: One Chat Per Agent, Threads, And Job Channels

- **Status:** Accepted
- **Date:** 2026-06-03
- **See also:** [ChatBlock Protocol](./chat-block-protocol.md), [Agents Replace Profiles And Drive Runtime Behavior](./agents-replace-profiles.md), [Agent Loop With Native Tool Calling](./agent-loop-tool-calling.md), [Bounded Chat Context Window](./chat-context-window.md), [Mobile Push Notifications](./mobile-push-notifications.md)

## Decision

The Chats information architecture is reorganized around the agent, not
the session list:

- **One chat per agent.** Each agent has a single canonical chat. The
  session list is gone from the UI; selecting an agent opens its one
  chat directly.
- **Threads are tagged spans of that one session.** A thread is a span
  of `chat_blocks` inside the agent's single session, tagged with a
  `thread_id` and rooted at the main-chat `assistant_text` block it
  branched from (`parent_block_id`). There is **no new session per
  thread** — threads ride the same ordinal stream, SSE, and APNs the
  ChatBlock protocol already provides (see ADR chat-block-protocol.md).
- **Threads are user-initiated; routing is fixed at task spawn.** A user
  starts a thread from a message's "Reply in thread" composer; the first
  reply creates the thread, rooted at the main-chat block it branched
  from, and later replies append. A task spawned for a thread reply
  pre-seeds `threadId` / `parentBlockId` and its whole response threads —
  user context wins. A task spawned from the main composer carries no
  thread fields and is always answered in the main timeline; the runtime
  never re-routes a turn mid-flight. (The earlier agent-decided routing —
  a `start_thread` control tool with a `<route>thread</route>` directive
  fallback — silently diverted main-chat replies into threads and was
  removed; see Thread Routing and Resolved Decisions, B.)
- **Channels are job sessions surfaced as chats.** A recurring job's
  dedicated session is surfaced in the rail as a chattable channel
  (`kind:"channel"`, `origin:"job"`). It is a view over the existing
  job session, not a new record type.

This is additive to the persistence layer: `memory.db` schema bumps
8 → 9 with two nullable columns on `chat_blocks` (`thread_id`,
`parent_block_id`) plus one index, and `ChatMessageRecord` carries
optional `threadId` / `parentBlockId` for provider replay. The ChatBlock
protocol — block shapes, the SSE stream, `Last-Event-ID` resume, the
`UNIQUE (session_id, ordinal)` invariant — is unchanged.

## Context

The prior IA gave each agent an unbounded list of chat sessions. A user
who returned to an agent had to remember which session held which line
of work, and a long-running back-and-forth (a research task, a
debugging investigation) buried the rest of the conversation in a flat
transcript. The product direction is the inverse: one durable chat per
agent that stays scannable, with side conversations branched out as
threads — the Slack model — and recurring jobs surfaced as channels you
can also chat into.

The naive implementation — one session per thread — would have forced
every thread to re-derive the ChatBlock machinery: its own ordinal
stream, its own SSE subscription, its own APNs routing, its own
block-grouping. It would also have split a single agent conversation
across many `ChatSessionRecord`s, which is exactly the fragmentation the
"one chat per agent" goal is trying to remove. Treating a thread as a
*tag on existing blocks within the one session* keeps the entire chat in
one ordinal stream and lets every existing client behavior carry over
untouched.

## Data Model

### Session kind

`ChatSessionRecord` gains `kind?: "agent" | "channel"` (in
`src/types.ts`), distinct from `source?.kind` (the messaging-bridge
kind):

- `"agent"` — the single canonical chat for an agent.
- `"channel"` — a recurring-job-derived session (always also carries
  `origin: "job"`).
- `undefined` — a legacy/non-canonical session. The new UI treats
  undefined as **hidden** (not deleted) — legacy multi-session history
  is preserved on disk but not surfaced.

`getOrCreateAgentChat(instance, agentId)` (`src/execution/chat.ts`) is
the one resolver for an agent's canonical chat. It runs inside a single
`mutateState` and:

1. validates the agent exists (`throw "Agent not found"` → 404 — an
   arbitrary `agentId` must not mint a session);
2. among sessions already tagged `kind:"agent"`, returns the
   most-recently-updated one that has history (non-empty
   `messageIds`/`taskIds`) and **demotes any other `kind:"agent"`
   duplicates** back to `undefined`, enforcing exactly one canonical
   chat per agent so a stray empty duplicate cannot hijack the real
   chat. It falls back to the most-recent `kind:"agent"` session (and
   demotes nothing) only when none has history — a legitimately empty,
   brand-new chat;
3. otherwise lazily promotes the most-recent non-job, non-bridge legacy
   session to `kind:"agent"` (this is the "fold one legacy session into
   the canonical chat, hide the rest" path — reversible, nothing
   deleted);
4. otherwise creates a fresh `kind:"agent"` session.

### Thread tagging

`ChatBlockBase` gains `threadId?` and `parentBlockId?` (additive, all
block kinds). A main-chat block leaves both unset; a thread block
carries `threadId` and the thread's root carries `parentBlockId`
pointing at the main-chat `assistant_text` it branched from.

Schema `MEMORY_SCHEMA_VERSION` 8 → 9 (`src/state/memory-db.ts`):

- `ADD COLUMN thread_id TEXT` and `parent_block_id TEXT` (nullable, so
  every pre-9 row is a main-chat block with `NULL thread_id`);
- `CREATE INDEX idx_chat_blocks_thread ON chat_blocks(session_id, thread_id, ordinal)`.

The `UNIQUE (session_id, ordinal)` constraint is untouched — thread
blocks still draw from the one per-session ordinal sequence, so the
single durable stream and its `Last-Event-ID` resume work for threaded
blocks with no special-casing. The CHECK-table-recreate migration path
copies `thread_id` / `parent_block_id` forward, so an upgrade from any
prior schema lands the new columns whether it took the `ADD COLUMN` or
the recreate branch.

`insertChatBlock` accepts `threadId?` / `parentBlockId?` on every kind;
`upsertAssistantTextBlock` / `updateToolCallBlock` carry the columns
forward (`SELECT *`), so streaming deltas and tool-status flips preserve
thread membership with no extra arguments.

`ChatMessageRecord` also carries optional `threadId?` / `parentBlockId?`
on user, assistant, approval-reason, and tool-transcript rows created
after this change. These fields do not drive UI rendering; they let the
chat-task prompt packer prefer the active thread plus main chat before
unrelated thread side conversations (see ADR chat-context-window.md).
Legacy rows omit them and are treated as main-chat context.

### Thread read helpers

In `src/state/chat-blocks.ts`, surfaced through the `src/state` barrel:

- `listThreadBlocks(instance, sessionId, threadId)` — ordinal-ascending
  blocks of one thread.
- `listMainChatBlocks(instance, sessionId)` — blocks with no
  `thread_id`.
- `summarizeThreads(instance, sessionId)` — one `ThreadSummary` per
  distinct thread in a session, newest reply first.
- `summarizeThreadsForInstance(instance, agentSessionIds)` — the
  cross-agent inbox. It takes an **explicit list of agent session ids**
  because sessions live in the JSON `RuntimeState`, not SQLite — only
  `chat_blocks` is SQLite, so the helper can't discover which sessions
  are `kind:"agent"` on its own.

`ThreadSummary` (`src/types.ts`) carries `threadId`, `sessionId`,
optional `agentId` / `parentBlockId` / `rootPreview`, `replyCount`,
`lastReplyAt`, and optional `lastReplyPreview` / `lastReplyAuthor`.
`lastReplyAt` is the newest **message** block's `createdAt`
(`user_text` / `assistant_text`), not the newest block of any kind: a run
appends auxiliary blocks (trailing `phase` "Completed", `tool_call` /
`tool_result`, `system_note`) after the reply text, and the client unread
compare keys on `lastReplyAt`, so counting those would re-flag a thread the
user already opened. This matches `replyCount` / `lastReplyPreview` /
`lastReplyAuthor`, which are also message-derived.

### Channels

A recurring job that creates a dedicated delivery session tags it
`kind:"channel"` + `origin:"job"` at the create site
(`createChatSession(..., "job", "channel")` in `src/jobs/index.ts`),
and `normalizeState` backfills the kind on existing job sessions. A
channel is therefore a **view over the job's existing session** — there
is no `ChannelRecord`. The user can chat into a channel exactly as into
an agent chat; the difference is purely the `kind`/`origin` tags that
drive the rail grouping and the unread-until-opened behavior job
sessions already had.

## Thread Routing

A turn's thread membership is decided once, when its task is spawned:

1. **User reply in a thread.** `submitThreadReply` spawns the task with
   the thread's `threadId` / `parentBlockId`; `resolveEmitContext`
   (`src/execution/chat-task-emit.ts`) seeds the emit context from those
   fields and every block the turn emits — assistant text, tool calls,
   tool results, phases — carries them. User context wins: nothing the
   model outputs can move the response out of the thread.

2. **Main-composer message.** `submitChatMessage` spawns the task with
   no thread fields, and the runtime never sets them mid-turn, so the
   whole response lands in the main timeline.

Earlier revisions let the agent re-route a fresh main-chat turn into a
newly minted thread: a `start_thread` control tool (primary) with a
leading `<route>thread</route>` text directive as fallback, both feeding
a mid-turn emit-context switch. That mechanism was removed (#280).
Models over-triggered it on any multi-turn-looking prompt, which left
the main chat showing the user's message with no reply — and because the
minted thread rooted at the same parent `assistant_text` block as an
existing user-created thread, the two were indistinguishable in every
surface (same root preview, one chip per parent block), so the reply
appeared to land inside a thread the user never sent it to. A message
sent in the main chat must never silently divert into a thread, so the
runtime no longer carries the tool, the directive grammar, or the
mid-turn switch. Instances that seeded the old INSTRUCTIONS.md threading
guidance get those lines stripped by a one-time boot migration
(`migrateInstructionsThreadRouting` in `src/runtime/identity-files.ts`),
mirroring the identity-line migration.

## Client Contract

New routes (`src/http.ts`):

- `GET /api/agents/:agentId/chat` — resolve (or lazily create) the
  agent's one canonical chat via `getOrCreateAgentChat`.
- `GET /api/chat/:id/threads` — `ThreadSummary[]` for the session
  (`summarizeThreads`), newest reply first.
- `GET /api/chat/:id/threads/:threadId/blocks` — the thread's blocks
  in ordinal order (`listThreadBlocks`).
- `POST /api/chat/:id/threads/:threadId/messages` — post a user reply
  into a thread (`submitThreadReply`), **create-or-append**: if the
  thread has no blocks yet it is *created* on this first reply, rooted at
  the `parentBlockId` supplied in the body (the main-chat message the
  user branched from, validated to be an un-threaded block in this
  session); if the thread already exists, the parent is inherited from
  its first block (a missing one is an error, not a silent drop). This
  is how a thread comes to exist at all: a user starts one off any agent
  message (Slack-style "Reply in thread").
  Body also accepts `alsoToMain?` to best-effort mirror the message into
  the main chat (consistent with the existing dual-publish pattern). The
  handler validates the **session** exists first (so a bad `sessionId`
  fails as "Chat session not found" rather than a misleading
  "Thread not found").
- `GET /api/threads` — the cross-agent inbox: every thread across all
  `kind:"agent"` sessions, enriched with the owning agent's display
  name, newest reply first. The `?filter=all|unread` query is accepted
  but **not** applied server-side.

All thread endpoints 404 on an unknown session id, so a stale link
fails cleanly rather than returning an empty list.

**Thread unread is computed client-side.** The server has no per-thread
read cursor. The existing `POST` / `DELETE /api/chat/:id/read`
endpoints track a per-device, **session-level** read cursor (and feed
`GET /api/badge`); they are unchanged and remain whole-chat granularity.
The web client tracks thread read-state in `localStorage` and hides read
threads for `filter=unread`; the inbox always receives the full list.

## Resolved Decisions

- **A. Legacy sessions on collapse.** Fold the most-recent non-job,
  non-bridge legacy session into the canonical agent chat (lazy promote
  to `kind:"agent"`); leave the rest with `kind` undefined so they are
  hidden, not deleted. Reversible.
- **B. Thread decision mechanism.** Superseded — threads are
  user-initiated only (decision E) and a turn's membership is fixed at
  task spawn (see Thread Routing). The original agent-decided routing
  (`start_thread` control tool primary, `<route>thread</route>` leading
  directive fallback) silently moved main-composer replies into threads
  indistinguishable from existing ones (#280) and was removed.
- **C. Channels.** A view over the job's existing session
  (`kind:"channel"` + `origin:"job"`), no `ChannelRecord`.
- **D. Delete-agent cascade.** Deleting an agent deletes its chat and
  threads and detaches its job channels (the jobs themselves survive,
  paused), while `JobRunRecord` audit history is retained.
- **E. User reply in a thread.** User context wins — the response stays
  in the thread. A user starts a thread off any agent message: the first
  reply (carrying its `parentBlockId`) creates the thread,
  create-or-append (see Client Contract). This is the only way a thread
  is created.
- **F. Thread read-state.** Per-thread unread is computed **client-side**
  (web `localStorage`); the server's per-device read cursor stays
  session-level, and opening the main chat does not clear thread badges.

## Consequences

Pro:

- Threads inherit the entire ChatBlock protocol for free: one ordinal
  stream per session, one SSE subscription, `Last-Event-ID` resume,
  block grouping, and APNs routing all work unchanged because a thread
  is just a tag on blocks in the session that already had them.
- The "which session held that conversation?" problem is gone — one
  chat per agent, side work branched into named threads, recurring jobs
  surfaced as channels in the same rail.
- The persistence change is purely additive (two nullable columns + one
  index). Every pre-9 row reads back as a main-chat block, so the
  migration needs no data backfill for thread membership.
- Routing is deterministic and fixed at task spawn: a thread reply
  threads, a main-composer message answers in the main timeline. No
  model judgment call decides where a reply lands, so the main composer
  can never silently inherit or mint a thread.

Con:

- Per-thread read-state is client-side only today, so thread unread
  badges do not sync across devices the way the session-level badge
  does. Server-side per-thread read cursors are the deferred follow-up
  (see below).
- `summarizeThreadsForInstance` must be handed the agent session-id list
  by the caller because sessions live in JSON `RuntimeState` while
  blocks live in SQLite — the two stores can't be joined in one query.
- The agent cannot move long multi-turn work into a thread on its own;
  keeping the main chat scannable relies on the user branching threads
  where they want them.

## Deferred Follow-Up

- **Server-side per-thread read-state.** Today thread unread is computed
  client-side from `localStorage`; the server cursor is session-level
  and per-device. A per-thread, per-device read cursor (mirroring the
  existing session-level `markRead`/`markUnread`) would let thread
  badges sync across devices and feed the APNs badge total. Decision F
  is satisfied behaviorally on web today; the cross-device version is
  out of scope for this change.

## Acceptance Checks

- `bun test src/execution/agent-chat-resolver.test.ts` covers
  `getOrCreateAgentChat`: the agent-exists guard, returning an existing
  `kind:"agent"` session, preferring the non-empty chat over an empty
  `kind:"agent"` duplicate (and demoting the duplicate), lazy promotion
  of a legacy session, and fresh creation.
- `bun test src/execution/chat-task-route.test.ts` covers per-turn
  thread membership: a main-composer turn answers in the main chat, a
  stale leading `<route>thread</route>` text passes through without
  threading, a `start_thread` tool call cannot move the turn out of the
  main chat, and a pre-seeded thread reply threads its whole response.
- `bun test src/state/chat-blocks.test.ts` covers thread tagging on
  insert, `listThreadBlocks` / `listMainChatBlocks`, and the
  `summarizeThreads` / `summarizeThreadsForInstance` aggregates.
- `bun test src/http.test.ts` smoke-tests the new routes — the
  agent-chat resolver, the three per-session thread routes (including
  create-or-append from a new thread id + `parentBlockId`, the
  session-first 404, and the `parentBlockId` requirement), and the
  `/api/threads` inbox.
- The live-gateway end-to-end verification confirms a main-composer
  message — including a multi-turn-shaped brainstorm prompt — is
  answered in the main timeline, a "Reply in thread" reply stays in its
  thread, the web Thread panel and `/threads` inbox render the thread,
  and the `UNIQUE (session_id, ordinal)` invariant holds with threaded
  blocks interleaved in the stream.
