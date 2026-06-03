// A small in-process token-bucket rate limiter. Used to throttle the public
// pairing-request endpoint so a relay caller can't flood the operator's
// approval panel (approval-fatigue / DoS). Per-process and per-instance is the
// deployment model, so an in-memory Map is sufficient.
//
// The clock is injectable (nowMs) so tests drive refill deterministically
// without sleeping, per the repo's fast-test rules.

export interface RateLimitOptions {
  // Maximum tokens (the burst size).
  capacity: number;
  // Tokens regenerated per second.
  refillPerSec: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly options: RateLimitOptions) {}

  // Attempt to consume one token for `key`. Returns true when allowed (a token
  // was consumed), false when the bucket is empty (rate limited). Refills lazily
  // based on elapsed time since the bucket was last touched.
  tryConsume(key: string, nowMs: number = Date.now()): boolean {
    const existing = this.buckets.get(key);
    const bucket: Bucket = existing ?? { tokens: this.options.capacity, updatedAt: nowMs };
    const elapsedSec = Math.max(0, nowMs - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + elapsedSec * this.options.refillPerSec);
    bucket.updatedAt = nowMs;
    let allowed: boolean;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      allowed = true;
    } else {
      allowed = false;
    }
    this.buckets.set(key, bucket);
    return allowed;
  }

  // Test/maintenance hook: drop all buckets.
  reset(): void {
    this.buckets.clear();
  }
}
