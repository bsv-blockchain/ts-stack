/** A bounded FIFO within each source, round-robin between sources. */
export class LookupHostQueue {
  private readonly queues = new Map<string, string[]>()
  private readonly seen = new Set<string>()
  private cursor = 0
  private active = 0
  private closed = false
  private sourceClosed = false
  private resolveDone: () => void = () => {}
  readonly done = new Promise<void>(resolve => { this.resolveDone = resolve })

  constructor(
    private readonly maxHosts: number,
    private readonly concurrency: number,
    private readonly run: (host: string) => Promise<void>,
    private readonly skipped: (count: number, limited: boolean) => void
  ) {}

  add(source: string, hosts: string[]): void {
    if (this.closed || this.sourceClosed) return
    const queue = this.queues.get(source) ?? []
    this.queues.set(source, queue)
    for (const host of hosts) {
      if (this.seen.has(host)) continue
      if (this.seen.size >= this.maxHosts) { this.skipped(1, true); continue }
      this.seen.add(host)
      queue.push(host)
    }
    this.pump()
  }

  finishSources(): void {
    this.sourceClosed = true
    this.pump()
  }

  cancel(): void {
    if (this.closed) return
    this.closed = true
    for (const queue of this.queues.values()) {
      this.skipped(queue.length, false)
      queue.length = 0
    }
    this.settle()
  }

  private next(): string | undefined {
    const sources = Array.from(this.queues.values())
    for (const [offset] of sources.entries()) {
      const index = (this.cursor + offset) % sources.length
      const host = sources[index].shift()
      if (host !== undefined) {
        this.cursor = index + 1
        return host
      }
    }
    this.cursor += sources.length
    return undefined
  }

  private settle(): void {
    if ((this.closed || this.sourceClosed) && this.active === 0 &&
      Array.from(this.queues.values()).every(queue => queue.length === 0)) this.resolveDone()
  }

  private pump(): void {
    while (!this.closed && this.active < this.concurrency) {
      const host = this.next()
      if (host === undefined) break
      this.active++
      void this.run(host).catch(() => {}).finally(() => {
        this.active--
        this.pump()
      })
    }
    this.settle()
  }
}
