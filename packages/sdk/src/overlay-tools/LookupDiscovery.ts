import { LookupLimits, LookupResourceLimitError, normalizeLookupHost } from './LookupResources.js'

export interface LookupDiscoveryUpdate {
  sources: Map<string, string[]>
  trackersTotal: number
  trackersCompleted: number
  trackersFailed: number
  skippedHosts: number
  receivedBytes: number
  limitsHit: Set<string>
  done: boolean
}

/** One bounded refresh shared only by subscribers of the same resolver/configuration. */
export class LookupDiscovery {
  readonly controller = new AbortController()
  readonly state: LookupDiscoveryUpdate
  private readonly listeners = new Set<(state: LookupDiscoveryUpdate) => void>()
  private started = false
  private abandoned = false

  constructor(
    private readonly trackers: string[],
    private readonly limits: LookupLimits,
    private readonly lookup: (tracker: string, signal: AbortSignal, consume: (bytes: number) => void) => Promise<string[]>,
    private readonly finish: (state: LookupDiscoveryUpdate, abandoned: boolean) => void
  ) {
    this.state = {
      sources: new Map(), trackersTotal: trackers.length, trackersCompleted: 0,
      trackersFailed: 0, skippedHosts: 0, receivedBytes: 0, limitsHit: new Set(), done: false
    }
  }

  subscribe(listener: (state: LookupDiscoveryUpdate) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    if (!this.started) { this.started = true; void this.run() }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0 && !this.state.done) {
        this.abandoned = true
        this.controller.abort()
        this.finish(this.state, true)
      }
    }
  }

  private emit(): void {
    if (this.abandoned) return
    for (const listener of this.listeners) listener(this.state)
  }

  private consume = (bytes: number): void => {
    if (this.abandoned) throw new LookupResourceLimitError('abandoned')
    if (bytes > this.limits.maxTotalBytes - this.state.receivedBytes) {
      this.state.limitsHit.add('maxTotalBytes')
      throw new LookupResourceLimitError('maxTotalBytes')
    }
    this.state.receivedBytes += bytes
    this.emit()
  }

  private async run(): Promise<void> {
    let cursor = 0
    // Each tracker keeps a reserved share, so an early advertisement flood
    // cannot consume the complete candidate budget before later sources reply.
    const share = Math.min(this.limits.maxHostsPerTracker,
      Math.max(1, Math.floor(this.limits.maxHosts / Math.max(1, this.trackers.length))))
    const worker = async (): Promise<void> => {
      while (!this.controller.signal.aborted && cursor < this.trackers.length) {
        const tracker = this.trackers[cursor++]
        try {
          const candidates = await this.lookup(tracker, this.controller.signal, this.consume)
          if (this.abandoned) return
          const hosts = new Set<string>()
          for (const candidate of candidates) {
            const host = normalizeLookupHost(candidate)
            if (host === null) { this.state.skippedHosts++; continue }
            if (hosts.has(host)) continue
            if (hosts.size >= share) {
              this.state.skippedHosts++
              this.state.limitsHit.add('maxHostsPerTracker')
            } else hosts.add(host)
          }
          this.state.sources.set(tracker, Array.from(hosts))
        } catch (error) {
          if (error instanceof LookupResourceLimitError) this.state.limitsHit.add(error.limit)
          else if (!this.controller.signal.aborted) this.state.trackersFailed++
        } finally {
          this.state.trackersCompleted++
          this.emit()
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.limits.trackerConcurrency, this.trackers.length) }, worker))
    this.state.done = true
    this.finish(this.state, this.abandoned)
    this.emit()
    this.listeners.clear()
  }
}
