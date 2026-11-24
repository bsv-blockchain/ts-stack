import { OutputProtocolError } from '@bsv/sdk'

/** One physical step per source instance, including late noncancellable storage. */
export class LookupSourceWork {
  private busy = false
  check(signal: AbortSignal): void {
    if (signal.aborted)
      throw new OutputProtocolError('cancelled', 'Live source operation cancelled')
  }
  async run<T>(
    signal: AbortSignal,
    timeoutMs: number,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    this.check(signal)
    if (this.busy)
      throw new OutputProtocolError('limited', 'Earlier live source work is still active', true)
    this.busy = true
    const controller = new AbortController()
    let expired = false
    const cancel = (): void => controller.abort()
    const interrupted = new Promise<PromiseRejectedResult>(resolve => {
      controller.signal.addEventListener(
        'abort',
        () =>
          resolve({
            status: 'rejected',
            reason: new OutputProtocolError(
              expired ? 'limited' : 'cancelled',
              'Live source operation interrupted',
              expired
            )
          }),
        { once: true }
      )
    })
    signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, timeoutMs)
    const pending = Promise.resolve()
      .then(async () => {
        this.check(controller.signal)
        const result = await operation(controller.signal)
        this.check(controller.signal)
        return result
      })
      // Observe the physical operation for its entire lifetime, independently
      // of which outcome wins the caller's race or when that caller finishes.
      .then<PromiseSettledResult<T>, PromiseSettledResult<T>>(
        value => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason })
      )
      .finally(() => {
        this.busy = false
      })
    try {
      const result = await Promise.race([pending, interrupted])
      if (result.status === 'rejected') throw result.reason
      return result.value
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
    }
  }
}
