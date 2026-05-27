import { randomBytes } from "node:crypto";

// 192 bits of entropy, base64url-encoded → 32 characters. Picked to fit
// cleanly on a 32-char URL segment while keeping brute-force well past
// physical limits at the 200 in-flight Cloudflare quick-tunnel ceiling.
// See PLAN.md Constants > "Per-instance secret entropy".
const SECRET_BYTES = 24;

export function generateTunnelSecret(): string {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

// Constant-time byte equality across two strings. We coerce both sides to
// Buffer with a deterministic length (the longer of the two) so the timing
// of the comparison does not leak length-difference information. Returns
// false when either input is empty.
export function constantTimeEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  const len = Math.max(aBuf.length, bBuf.length);
  const padded = (buf: Buffer) => {
    if (buf.length === len) return buf;
    const out = Buffer.alloc(len);
    buf.copy(out);
    return out;
  };
  // XOR each byte and OR into an accumulator; if the lengths differ even by
  // one, the padded suffix is all zeros for one side and any non-zero bytes
  // for the other, so the diff trips just like a byte mismatch would. The
  // length-equality check is folded into the accumulator at the end.
  const padA = padded(aBuf);
  const padB = padded(bBuf);
  let diff = aBuf.length ^ bBuf.length;
  for (let i = 0; i < len; i += 1) diff |= padA[i]! ^ padB[i]!;
  return diff === 0;
}
