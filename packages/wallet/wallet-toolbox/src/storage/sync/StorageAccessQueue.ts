import { StorageAccessQueueLimitError } from './StorageAccessQueueLimitError'
import { StorageAccessCancelledError } from './StorageAccessCancelledError'

type Mode = 'read' | 'exclusive'
type Priority = 'foreground' | 'background'
interface Waiter {
  mode: Mode
  priority: Priority
  queuedAt: number
  grant: (release: () => void) => void
  detach: () => void
}

/**
 * One ownership queue: exclusive operations never overlap; opted-in reads
 * share up to eight slots. Foreground work may pass a background page at most
 * eight times or for one second. FIFO order is retained within each priority.
 * Pending admission is finite; this bounds waiter count, not caller payload
 * bytes. Cancellation removes only the actual queued request, never an owner.
 */
export class StorageAccessQueue {
  private readonly waiters: Waiter[] = []
  private readers = 0
  private exclusive = false
  private foregroundGrants = 0
  private requests = 0

  constructor(private readonly maximumPending = 1024) {
    if (!Number.isSafeInteger(maximumPending) || maximumPending < 1 || maximumPending > 65536)
      throw new StorageAccessQueueLimitError('Storage queue pending admission limit must be an integer from 1 to 65536')
  }

  /** Bound manager requests even while initial availability I/O precedes
   * ownership selection. Retain one original admission across mode re-selection.
   * Eight extra slots account for the maximum number of actual read owners. */
  admit(): () => void {
    if (this.requests >= this.maximumPending + 8)
      throw new StorageAccessQueueLimitError('Storage request admission limit reached before initialization')
    this.requests++
    let released = false
    return () => {
      if (!released) {
        released = true
        this.requests--
      }
    }
  }

  acquire(mode: Mode, priority: Priority = 'foreground', signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) return Promise.reject(new StorageAccessCancelledError(signal))
    if (this.waiters.length >= this.maximumPending)
      return Promise.reject(new StorageAccessQueueLimitError('Storage queue pending admission limit reached'))
    return new Promise((resolve, reject) => {
      const detach = (): void => signal?.removeEventListener('abort', cancel)
      const waiter: Waiter = { mode, priority, queuedAt: Date.now(), grant: resolve, detach }
      const cancel = (): void => {
        const index = this.waiters.indexOf(waiter)
        if (index < 0) return
        this.waiters.splice(index, 1)
        detach()
        reject(new StorageAccessCancelledError(signal!))
        this.pump()
      }
      this.waiters.push(waiter)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted === true) cancel()
      this.pump()
    })
  }

  private first(priority: Priority): number {
    for (let index = 0; index < this.waiters.length; index++) {
      if (this.waiters[index].priority === priority) return index
    }
    return -1
  }

  private nextIndex(): number {
    const background = this.first('background')
    if (background >= 0 && (this.foregroundGrants >= 8 || Date.now() - this.waiters[background].queuedAt >= 1000))
      return background
    const foreground = this.first('foreground')
    return Math.max(foreground, 0)
  }

  private pump(): void {
    while (!this.exclusive && this.waiters.length > 0) {
      // Uncontended access needs no priority search or predicate allocation.
      const index = this.waiters.length === 1 ? 0 : this.nextIndex()
      const waiter = this.waiters[index]
      if (waiter.mode === 'exclusive' ? this.readers > 0 : this.readers >= 8) return
      this.waiters.splice(index, 1)
      waiter.detach()
      if (waiter.mode === 'exclusive') this.exclusive = true
      else this.readers++
      this.foregroundGrants = waiter.priority === 'background' ? 0 : Math.min(8, this.foregroundGrants + 1)
      let released = false
      waiter.grant(() => {
        if (released) return
        released = true
        if (waiter.mode === 'exclusive') this.exclusive = false
        else this.readers--
        this.pump()
      })
    }
  }
}
