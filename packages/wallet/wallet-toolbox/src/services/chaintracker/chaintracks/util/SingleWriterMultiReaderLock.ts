import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk'

/**
 * A reader-writer lock to manage concurrent access.
 * Allows multiple readers or one writer at a time.
 */
export class SingleWriterMultiReaderLock {
  private readers: number = 0
  private writerActive: boolean = false
  private readonly readerQueue: Array<() => void> = []
  private readonly writerQueue: Array<() => void> = []

  constructor(private readonly maxQueued = 4096) {
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 100_000) {
      throw new WERR_INVALID_PARAMETER('maxQueued', 'an integer from 1 through 100000')
    }
  }

  private assertQueueCapacity(): void {
    if (this.readerQueue.length + this.writerQueue.length >= this.maxQueued) {
      throw new WERR_INVALID_OPERATION(`Chaintracks lock queue reached its ${this.maxQueued}-operation limit`)
    }
  }

  private checkQueues(): void {
    if (this.writerActive || this.readers > 0) return
    if (this.writerQueue.length > 0) {
      // If there are waiting writers and no active readers or writers, start the next writer
      const resolve = this.writerQueue.shift()!
      resolve()
    } else if (this.readerQueue.length > 0) {
      // If there are waiting readers and no waiting writers, start all readers
      const readers = this.readerQueue.splice(0)
      for (const resolve of readers) {
        resolve()
      }
    }
  }

  async withReadLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.writerActive && this.writerQueue.length === 0) {
      // Fast path: no active writer or waiting writers, proceed immediately
      this.readers++
      try {
        return await fn()
      } finally {
        this.readers--
        this.checkQueues()
      }
    } else {
      // Queue the reader until writers are done
      this.assertQueueCapacity()
      const promise = new Promise<void>(resolve => {
        this.readerQueue.push(resolve)
      })
      await promise
      this.readers++
      try {
        return await fn()
      } finally {
        this.readers--
        this.checkQueues()
      }
    }
  }

  async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.writerActive && this.readers === 0) {
      // Fast path: no active writer or readers, proceed immediately
      this.writerActive = true
      try {
        return await fn()
      } finally {
        this.writerActive = false
        this.checkQueues()
      }
    } else {
      this.assertQueueCapacity()
      const promise = new Promise<void>(resolve => {
        this.writerQueue.push(resolve)
      })
      await promise
      this.writerActive = true
      try {
        return await fn()
      } finally {
        this.writerActive = false
        this.checkQueues()
      }
    }
  }
}
