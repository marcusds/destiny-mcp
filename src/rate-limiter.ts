/**
 * Sliding-window client-side rate limiter.
 *
 * Bungie's platform allows a burst of requests per rolling window; we throttle
 * locally to stay under it. Acquisitions are serialized through a promise chain
 * so the "is there room in the window?" check and the recording of a new request
 * are atomic — without that, concurrent callers could all observe room and blow
 * past the limit together.
 */
export class RateLimiter {
  private timestamps: number[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly maxRequests = 25,
    private readonly windowMs = 10_000
  ) {}

  /** Resolves once it is safe to make a request, having reserved a slot. */
  acquire(): Promise<void> {
    const next = this.tail.then(() => this.reserve());
    // Keep the chain alive even if a reservation rejects (it never should).
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async reserve(): Promise<void> {
    this.prune();
    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.windowMs - (Date.now() - this.timestamps[0]);
      if (waitMs > 0) await delay(waitMs);
      this.prune();
    }
    this.timestamps.push(Date.now());
  }

  /** Drop timestamps that have aged out of the window. */
  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i > 0) this.timestamps.splice(0, i);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
