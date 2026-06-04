import type { ChatBlock, ThreadSummary } from "@/src/types";

// Pure helpers for splitting the single session block stream into a main
// chat and its threads. The gateway streams every block for a session
// over one /stream connection, each tagged with an optional `threadId`;
// the client routes by membership so the main transcript and each Thread
// View show only the blocks that belong to them.

// Does this block belong to the view identified by `viewThreadId`?
//   - viewThreadId == null  → the main chat: only untagged blocks.
//   - viewThreadId set      → that thread: only blocks with the same tag.
export function blockBelongsToView(
  block: { threadId?: string },
  viewThreadId: string | null
): boolean {
  return (block.threadId ?? null) === (viewThreadId ?? null);
}

// Keep only the blocks that belong to the view. Used to filter the seed
// /blocks response for the main chat (the seed endpoint returns every
// block, including threaded ones).
export function filterBlocksForView(
  blocks: ChatBlock[],
  viewThreadId: string | null
): ChatBlock[] {
  return blocks.filter((b) => blockBelongsToView(b, viewThreadId));
}

// Index thread summaries by the main-chat block they branched from, so a
// rendered assistant_text block can find the thread it roots to attach an
// inline "N replies" chip. When two summaries share a parent (shouldn't
// happen, but be defensive), the later one wins.
export function indexThreadsByParentBlock(
  threads: ThreadSummary[]
): Map<string, ThreadSummary> {
  const map = new Map<string, ThreadSummary>();
  for (const t of threads) {
    if (t.parentBlockId) map.set(t.parentBlockId, t);
  }
  return map;
}
