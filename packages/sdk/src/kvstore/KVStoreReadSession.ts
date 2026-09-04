import { KVStoreReadState, type KVStoreReadResult } from './ReliableKVStore.js'

export interface KVStoreReadSnapshot {
  refreshing: boolean
  result?: KVStoreReadResult
}
/** Shared lifecycle for UI refresh/retry. Create a new session on identity/query change. */
export class KVStoreReadSession {
  private readonly state = new KVStoreReadState()
  private snapshot: KVStoreReadSnapshot = { refreshing: false }
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending: Promise<void> | undefined
  private stopped = false
  private controller: AbortController | undefined
  constructor(
    private readonly read: (signal: AbortSignal) => Promise<KVStoreReadResult>,
    private readonly onChange: (snapshot: KVStoreReadSnapshot) => void,
    private readonly retryDelayMs = 2000
  ) {
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 100)
      throw new RangeError('Retry delay must be at least 100 ms')
  }
  private emit(): void {
    try {
      this.onChange({ ...this.snapshot })
    } catch {
      /* UI observers cannot interrupt recovery. */
    }
  }
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.pending !== undefined) return await this.pending
    clearTimeout(this.timer)
    this.snapshot = { ...this.snapshot, refreshing: true }
    this.emit()
    this.controller = new AbortController()
    const controller = this.controller
    this.pending = Promise.resolve()
      .then(async () => {
        let result: KVStoreReadResult
        try {
          result = await this.read(controller.signal)
        } catch {
          result = {
            kind: 'unavailable',
            retryable: true,
            evidence: { completedHosts: 0, failedHosts: 0, discoveryComplete: false, durationMs: 0 }
          }
        }
        if (this.stopped) return
        result = this.state.apply(result)
        this.snapshot = { refreshing: false, result }
        this.emit()
        if (
          result.kind !== 'absent' &&
          !(result.kind === 'data' && result.completeness === 'complete')
        ) {
          this.timer = setTimeout(() => {
            void this.refresh()
          }, this.retryDelayMs)
        }
      })
      .finally(() => {
        this.pending = undefined
      })
    return await this.pending
  }
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.controller?.abort()
    this.state.clear()
  }
}
