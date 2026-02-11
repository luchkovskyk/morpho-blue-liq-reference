/**
 * Token-bucket rate limiter. Callers await acquire() which resolves
 * when a token is available. Tokens refill at a fixed rate.
 *
 * Example: new RateLimiter(8, 1000) => 8 requests per second
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private queue: { resolve: () => void; reject: (err: Error) => void; deadline: number }[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private maxTokens: number,
    private refillIntervalMs: number,
    private maxWaitMs = 30_000,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, deadline: Date.now() + this.maxWaitMs });
      this.scheduleDrain();
    });
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = Math.floor((elapsed / this.refillIntervalMs) * this.maxTokens);
    if (newTokens > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      // Advance lastRefill only by the time actually consumed (avoids drift)
      this.lastRefill += (newTokens / this.maxTokens) * this.refillIntervalMs;
    }
  }

  private scheduleDrain() {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drainQueue();
    }, this.refillIntervalMs);
  }

  private drainQueue() {
    this.refill();
    const now = Date.now();

    // Reject expired waiters
    for (let head = this.queue[0]; head && head.deadline <= now; head = this.queue[0]) {
      this.queue.shift();
      head.reject(new Error("RateLimiter: max wait time exceeded"));
    }

    // Resolve waiters that can proceed
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      const entry = this.queue.shift();
      if (entry) entry.resolve();
    }

    if (this.queue.length > 0) {
      this.scheduleDrain();
    }
  }
}
