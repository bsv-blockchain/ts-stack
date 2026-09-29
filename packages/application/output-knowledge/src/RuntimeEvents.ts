import { OutputProtocolError } from '@bsv/sdk'
import type { RuntimeEvent } from './ports.js'

type Pending = {
  resolve: (value: IteratorResult<RuntimeEvent>) => void
  reject: (error: Error) => void
}
/** A slow observer must resubscribe; it can never accumulate an unbounded queue. */
export class RuntimeEvents implements AsyncIterable<RuntimeEvent>, AsyncIterator<RuntimeEvent> {
  private readonly queue: { text: string; bytes: number }[] = []
  private bytes = 0
  private waiting: Pending | undefined
  private ended = false
  private failure: Error | undefined
  private readonly cancel = (): void =>
    this.close(new OutputProtocolError('cancelled', 'Runtime observer cancelled'))
  constructor(
    private readonly signal: AbortSignal,
    private readonly dispose: () => void
  ) {
    signal.addEventListener('abort', this.cancel, { once: true })
    if (signal.aborted) this.cancel()
  }
  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return this
  }
  push(text: string): void {
    if (this.ended) return
    const bytes = new TextEncoder().encode(text).length
    if (this.queue.length >= 8 || this.bytes + bytes > 8 * 1024 * 1024) {
      this.close(
        new OutputProtocolError(
          'reset-required',
          'Runtime observer fell behind; read current knowledge and resubscribe'
        )
      )
      return
    }
    this.queue.push({ text, bytes })
    this.bytes += bytes
    if (this.waiting) {
      const pending = this.waiting
      this.waiting = undefined
      void this.next().then(pending.resolve, pending.reject)
    }
  }
  close(error?: Error): void {
    if (this.ended) return
    this.ended = true
    this.failure = error
    this.queue.splice(0)
    this.bytes = 0
    this.signal.removeEventListener('abort', this.cancel)
    if (this.waiting) {
      if (error) this.waiting.reject(error)
      else this.waiting.resolve({ done: true, value: undefined })
      this.waiting = undefined
    }
    this.dispose()
  }
  async next(): Promise<IteratorResult<RuntimeEvent>> {
    if (this.failure) throw this.failure
    if (this.ended) return { done: true, value: undefined }
    if (this.waiting)
      throw new OutputProtocolError('conflict', 'Runtime observer already has a pending read')
    const item = this.queue.shift()
    if (item) {
      this.bytes -= item.bytes
      return { done: false, value: JSON.parse(item.text) as RuntimeEvent }
    }
    return new Promise<IteratorResult<RuntimeEvent>>((resolve, reject) => {
      this.waiting = { resolve, reject }
    })
  }
  async return(): Promise<IteratorResult<RuntimeEvent>> {
    this.close()
    return { done: true, value: undefined }
  }
}
