interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-memory token bucket: `perMinute` tokens per key, refilled continuously. Keys are api key ids
 * (MCP) or `user:<id>` (chat). Idle buckets are evicted so memory stays bounded.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();
  private readonly perMinute: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.perMinute = perMinute;
    this.now = now;
    this.lastSweep = now();
  }

  /** Returns true when the call may proceed (and consumes one token). */
  take(key: string): boolean {
    const t = this.now();
    this.sweep(t);
    const capacity = this.perMinute;
    const refillPerMs = capacity / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: capacity, updatedAt: t };
      this.buckets.set(key, b);
    } else {
      b.tokens = Math.min(capacity, b.tokens + (t - b.updatedAt) * refillPerMs);
      b.updatedAt = t;
    }
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private sweep(t: number): void {
    if (t - this.lastSweep < 5 * 60_000) return;
    this.lastSweep = t;
    for (const [k, b] of this.buckets) if (t - b.updatedAt > 10 * 60_000) this.buckets.delete(k);
  }
}
