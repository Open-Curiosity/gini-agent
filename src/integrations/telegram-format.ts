// Convert lightweight Markdown to Telegram MarkdownV2.
//
// Telegram's MarkdownV2 has two sharp edges:
//   1. Every special char outside a code span must be backslash-escaped,
//      even ones that look harmless (`.`, `-`, `!`). A single un-escaped
//      special anywhere in the body makes the API reject the message.
//   2. The set of recognized formatting markers differs from CommonMark:
//      bold is `*bold*` (single asterisk), not `**bold**`.
//
// We accept the common Markdown subset agents tend to produce — fenced
// code blocks, inline code, and `**bold**` — and convert just that.
// Italics are not auto-detected; a stray `*` or `_` is treated as a
// literal character and escaped. Anything more elaborate (headers,
// lists, links) gets escaped to literal text and rendered as plain
// prose.
//
// References:
//   https://core.telegram.org/bots/api#markdownv2-style

// MarkdownV2 specials per the spec.
const MDV2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

// Inside fenced and inline code spans only ` and \ need escaping.
const MDV2_CODE_SPECIALS = /[`\\]/g;

export function escapeMarkdownV2Literal(text: string): string {
  return text.replace(MDV2_SPECIALS, (c) => `\\${c}`);
}

function escapeMarkdownV2InsideCode(text: string): string {
  return text.replace(MDV2_CODE_SPECIALS, (c) => `\\${c}`);
}

// Tokenize the input into code blocks, inline-code spans, and prose. Code
// regions are preserved (with their internal specials escaped); prose is
// transformed and escaped.
export function formatTelegramMarkdownV2(input: string): string {
  if (input.length === 0) return input;

  const pattern = /```([\s\S]*?)```|`([^`\n]*)`/g;
  const segments: string[] = [];
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) segments.push(transformProse(input.slice(cursor, start)));
    if (match[1] !== undefined) {
      segments.push("```" + escapeMarkdownV2InsideCode(match[1]) + "```");
    } else if (match[2] !== undefined) {
      segments.push("`" + escapeMarkdownV2InsideCode(match[2]) + "`");
    }
    cursor = start + match[0].length;
  }
  if (cursor < input.length) segments.push(transformProse(input.slice(cursor)));
  return segments.join("");
}

// Prose transform: recognize `**bold**`, replace it with `*escape(inner)*`,
// and escape every other special as a literal. A two-pass placeholder
// dance keeps the bold markers from getting escaped along with the rest.
function transformProse(text: string): string {
  const boldRuns: string[] = [];
  // ASCII control codes for sentinels — chosen because they survive the
  // MDV2 special-char escape pass untouched and cannot appear in normal
  // user input.
  const SENTINEL_OPEN = "";
  const SENTINEL_CLOSE = "";

  const withPlaceholders = text.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, (_m, inner: string) => {
    boldRuns.push(inner);
    return `${SENTINEL_OPEN}${boldRuns.length - 1}${SENTINEL_CLOSE}`;
  });

  const escaped = escapeMarkdownV2Literal(withPlaceholders);

  return escaped.replace(
    new RegExp(`${SENTINEL_OPEN}(\\d+)${SENTINEL_CLOSE}`, "g"),
    (_m, indexStr: string) => `*${escapeMarkdownV2Literal(boldRuns[Number(indexStr)] ?? "")}*`
  );
}
