/**
 * A token bucket holding up to `capacity` tokens, refilled continuously at
 * `capacity` per `windowMs`; it starts full.
 */
export class TokenBucket {
  private tokens: number
  private refilledAt: number

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
    now = Date.now()
  ) {
    this.tokens = capacity
    this.refilledAt = now
  }

  /** True when a token is available, without spending it. */
  ready(now = Date.now()): boolean {
    this.refill(now)
    return this.tokens >= 1
  }

  /** Spend one token; false (spending nothing) when none is available. */
  take(now = Date.now()): boolean {
    if (!this.ready(now)) return false
    this.tokens -= 1
    return true
  }

  /** True when the bucket is full again, so dropping it forgets nothing. */
  full(now = Date.now()): boolean {
    this.refill(now)
    return this.tokens >= this.capacity
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.refilledAt)
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs)
    this.refilledAt = now
  }
}
