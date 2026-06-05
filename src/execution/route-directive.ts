// Leading control-directive parser for the per-turn chat-vs-thread routing.
//
// The agent decides whether a reply belongs in the main chat (default) or in
// a thread branched off its last message by emitting a control directive as
// the very FIRST text of its response: `<route>thread</route>` or
// `<route>chat</route>`. The runtime parses and strips it before any text
// reaches the user or the task summary — the directive is an internal routing
// signal, never user-visible.
//
// Detection runs against the accreted leading text of a turn as deltas stream
// in, so the parser distinguishes three states: a complete recognized
// directive, a strict prefix that could still BECOME one (buffer and wait for
// more tokens), and everything else (no directive — surface the text as-is).

export type ChatRoute = "thread" | "chat";

export interface RouteDirectiveResult {
  status: "none" | "incomplete" | "directive";
  // Set when status === "directive".
  route?: ChatRoute;
  // The text after the directive tag, with its leading whitespace trimmed.
  // Set when status === "directive".
  rest?: string;
}

// The set of complete directives we recognize, lowercased for case-insensitive
// matching against the left-trimmed leading text.
const DIRECTIVES: Array<{ tag: string; route: ChatRoute }> = [
  { tag: "<route>thread</route>", route: "thread" },
  { tag: "<route>chat</route>", route: "chat" }
];

// Inspect the accreted leading text of a turn. Only the very start matters —
// once the first non-whitespace content is something other than the start of
// a recognized directive, the answer is `none` for the rest of the turn.
export function parseLeadingRouteDirective(text: string): RouteDirectiveResult {
  // Tolerate leading whitespace/newlines before the tag.
  const trimmed = text.replace(/^\s+/, "");
  const lower = trimmed.toLowerCase();

  // Complete directive: the left-trimmed text begins with a full tag.
  for (const { tag, route } of DIRECTIVES) {
    if (lower.startsWith(tag)) {
      const rest = trimmed.slice(tag.length).replace(/^\s+/, "");
      return { status: "directive", route, rest };
    }
  }

  // Empty (or whitespace-only) so far — it could still become a directive.
  if (lower.length === 0) return { status: "incomplete" };

  // Strict prefix of a possible directive: the accreted text is the start of
  // a tag but not yet complete. Keep buffering until more tokens arrive.
  for (const { tag } of DIRECTIVES) {
    if (tag.startsWith(lower)) return { status: "incomplete" };
  }

  // First non-whitespace content is not the start of a recognized directive
  // (or the directive value is unrecognized, e.g. `<route>foo</route>`).
  return { status: "none" };
}
