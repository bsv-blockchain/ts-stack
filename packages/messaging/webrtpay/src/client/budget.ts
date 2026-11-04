/**
 * Rate budgets for signal intake and refusals. Internal: not exported from the package.
 */

/** A clock in milliseconds; only differences between its readings matter. */
export type Clock = () => number

/**
 * Milliseconds from a clock that never steps backwards: `performance.now()` (browsers, Node,
 * React Native), else `Date.now()`. Budgets run on it so that a wall clock set back an hour
 * does not freeze them for that hour (M24).
 */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/** A token bucket: holds up to `capacity` tokens and regains one every `refillMs`. */
export class TokenBucket {
  private tokens: number
  private updatedAt: number

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly clock: Clock = monotonicNow
  ) {
    this.tokens = capacity
    this.updatedAt = clock()
  }

  /** Whether a token is available at `now` (on the bucket's clock). */
  has(now: number = this.clock()): boolean {
    this.refill(now)
    return this.tokens >= 1
  }

  /** Take a token at `now`; false, taking nothing, when none is available. */
  take(now: number = this.clock()): boolean {
    if (!this.has(now)) return false
    this.tokens -= 1
    return true
  }

  /** True once the bucket has refilled completely, so forgetting it changes nothing. */
  full(now: number = this.clock()): boolean {
    this.refill(now)
    return this.tokens >= this.capacity
  }

  private refill(now: number): void {
    if (now <= this.updatedAt) return
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) / this.refillMs)
    this.updatedAt = now
  }
}

/** One {@link TokenBucket} per key; buckets that have refilled are forgotten now and then. */
export class KeyedBuckets {
  private readonly buckets = new Map<string, TokenBucket>()
  /** Number of buckets at which full ones are next swept out. */
  private sweepAt = 1024

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly clock: Clock = monotonicNow
  ) {}

  /** Take a token from `key`'s bucket at `now` (on the clock); false when it has none. */
  take(key: string, now: number = this.clock()): boolean {
    let bucket = this.buckets.get(key)
    if (bucket === undefined) {
      if (this.buckets.size >= this.sweepAt) {
        for (const [k, b] of this.buckets) if (b.full(now)) this.buckets.delete(k)
        this.sweepAt = Math.max(1024, this.buckets.size * 2)
      }
      bucket = new TokenBucket(this.capacity, this.refillMs, this.clock)
      this.buckets.set(key, bucket)
    }
    return bucket.take(now)
  }
}
