type Mode = 'read' | 'exclusive'
type Priority = 'foreground' | 'background'
interface Waiter {
  mode: Mode
  priority: Priority
  queuedAt: number
  grant: (release: () => void) => void
}

/**
 * One ownership queue: exclusive operations never overlap; opted-in reads
 * share up to eight slots. Foreground work may pass a background page at most
 * eight times or for one second. FIFO order is retained within each priority.
 */
export class StorageAccessQueue {
  private readonly waiters: Waiter[] = []
  private readers = 0
  private exclusive = false
  private foregroundGrants = 0

  acquire(mode: Mode, priority: Priority = 'foreground'): Promise<() => void> {
    return new Promise(resolve => {
      this.waiters.push({ mode, priority, queuedAt: Date.now(), grant: resolve })
      this.pump()
    })
  }

  private nextIndex(): number {
    const background = this.waiters.findIndex(waiter => waiter.priority === 'background')
    if (background >= 0 && (this.foregroundGrants >= 8 || Date.now() - this.waiters[background].queuedAt >= 1000))
      return background
    const foreground = this.waiters.findIndex(waiter => waiter.priority === 'foreground')
    return Math.max(foreground, 0)
  }

  private pump(): void {
    while (!this.exclusive && this.waiters.length > 0) {
      const index = this.nextIndex()
      const waiter = this.waiters[index]
      if (waiter.mode === 'exclusive' ? this.readers > 0 : this.readers >= 8) return
      this.waiters.splice(index, 1)
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
