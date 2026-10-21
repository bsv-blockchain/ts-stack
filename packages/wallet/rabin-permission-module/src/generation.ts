/**
 * Bounds on key generation and signing (BRC-206 "Scheduling, caching and resource use"): one job at a
 * time, a bounded FIFO queue with a waiting limit, and token buckets that rate-limit generations
 * per originator and overall.
 */

/** Token bucket: holds up to `capacity` tokens and regains one every `interval` ms. */
export class TokenBucket {
  readonly #capacity: number
  readonly #interval: number
  #tokens: number
  #updatedAt: number

  constructor(capacity: number, interval: number, now: number) {
    this.#capacity = capacity
    this.#interval = interval
    this.#tokens = capacity
    this.#updatedAt = now
  }

  #refill(now: number): void {
    if (now > this.#updatedAt) {
      this.#tokens = Math.min(
        this.#capacity,
        this.#tokens + (now - this.#updatedAt) / this.#interval
      )
    }
    this.#updatedAt = Math.max(this.#updatedAt, now)
  }

  /** True when a token is available at `now`. */
  available(now: number): boolean {
    this.#refill(now)
    return this.#tokens >= 1
  }

  /** True when the bucket has refilled completely, so it is equivalent to a new one. */
  full(now: number): boolean {
    this.#refill(now)
    return this.#tokens >= this.#capacity
  }

  take(): void {
    this.#tokens -= 1
  }
}

export interface RateLimits {
  originatorBurst: number
  originatorInterval: number
  globalBurst: number
  globalInterval: number
}

/** Buckets kept for distinct originators before full (idle) ones are dropped. */
const MAX_TRACKED_ORIGINATORS = 1024

/** Per-originator and global token buckets; a generation needs a token from both. */
export class GenerationRateLimiter {
  readonly #limits: RateLimits
  readonly #global: TokenBucket
  readonly #perOriginator = new Map<string, TokenBucket>()

  constructor(limits: RateLimits, now: number) {
    this.#limits = limits
    this.#global = new TokenBucket(limits.globalBurst, limits.globalInterval, now)
  }

  /** Takes one token from the originator's bucket and from the global bucket, or neither. */
  tryAcquire(originator: string, now: number): boolean {
    let bucket = this.#perOriginator.get(originator)
    if (bucket === undefined) {
      this.#prune(now)
      bucket = new TokenBucket(this.#limits.originatorBurst, this.#limits.originatorInterval, now)
      this.#perOriginator.set(originator, bucket)
    }
    if (!bucket.available(now) || !this.#global.available(now)) return false
    bucket.take()
    this.#global.take()
    return true
  }

  #prune(now: number): void {
    if (this.#perOriginator.size < MAX_TRACKED_ORIGINATORS) return
    for (const [originator, bucket] of this.#perOriginator) {
      if (bucket.full(now)) this.#perOriginator.delete(originator)
    }
    // Every tracked originator is still throttled: forget the oldest. The global bucket still
    // bounds the total, so a flood of fresh originators gains nothing.
    while (this.#perOriginator.size >= MAX_TRACKED_ORIGINATORS) {
      this.#perOriginator.delete(this.#perOriginator.keys().next().value!)
    }
  }
}

interface Job<T> {
  id: string | undefined
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
  timer?: ReturnType<typeof setTimeout>
  promise?: Promise<T>
}

/**
 * Runs one job at a time in FIFO order. At most `maxPending` jobs are admitted (running plus
 * waiting); a job that waits longer than `queueTimeout` ms is rejected. Jobs with an id can be
 * joined by later requests for the same id while they are running or waiting.
 */
export class GenerationScheduler<T> {
  readonly #maxPending: number
  readonly #queueTimeout: number
  readonly #busyError: () => Error
  readonly #queue: Array<Job<T>> = []
  readonly #byId = new Map<string, Promise<T>>()
  #running: Job<T> | undefined

  constructor(maxPending: number, queueTimeout: number, busyError: () => Error) {
    this.#maxPending = maxPending
    this.#queueTimeout = queueTimeout
    this.#busyError = busyError
  }

  /** The admitted job for this id, if one is running or waiting. */
  joinable(id: string): Promise<T> | undefined {
    return this.#byId.get(id)
  }

  /** True when another job can be admitted. */
  hasCapacity(): boolean {
    return (this.#running === undefined ? 0 : 1) + this.#queue.length < this.#maxPending
  }

  /** Admits a job; the caller has checked `hasCapacity`. */
  submit(id: string | undefined, run: () => Promise<T>): Promise<T> {
    let job!: Job<T>
    const promise = new Promise<T>((resolve, reject) => {
      job = { id, run, resolve, reject }
    })
    job.promise = promise
    if (id !== undefined) this.#byId.set(id, promise)
    if (this.#running === undefined) {
      this.#start(job)
    } else {
      job.timer = setTimeout(() => this.#expire(job), this.#queueTimeout)
      this.#queue.push(job)
    }
    return promise
  }

  /** Rejects every waiting job and forgets every id; a running job finishes on its own. */
  clear(error: () => Error): void {
    for (const job of this.#queue.splice(0)) {
      clearTimeout(job.timer)
      job.reject(error())
    }
    this.#byId.clear()
  }

  #start(job: Job<T>): void {
    this.#running = job
    job
      .run()
      .then(job.resolve, job.reject)
      .finally(() => {
        this.#forget(job)
        this.#running = undefined
        const next = this.#queue.shift()
        if (next !== undefined) {
          clearTimeout(next.timer)
          this.#start(next)
        }
      })
  }

  #expire(job: Job<T>): void {
    const index = this.#queue.indexOf(job)
    if (index < 0) return
    this.#queue.splice(index, 1)
    this.#forget(job)
    job.reject(this.#busyError())
  }

  #forget(job: Job<T>): void {
    // Only the job's own entry: after clear() a newer job may hold the same id.
    if (job.id !== undefined && this.#byId.get(job.id) === job.promise) this.#byId.delete(job.id)
  }
}
