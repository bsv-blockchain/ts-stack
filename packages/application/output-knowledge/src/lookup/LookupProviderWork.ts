import { OutputProtocolError, outputIdentity } from '@bsv/sdk'

export function checkLookupWork(signal: AbortSignal): void {
  if (signal.aborted) {
    if (signal.reason instanceof OutputProtocolError) throw signal.reason
    throw new OutputProtocolError('cancelled', 'Lookup request cancelled')
  }
}

/** No queue: cancelled callers retain capacity until their physical work settles. */
export class LookupProviderWork {
  private active = 0
  private readonly principals = new Map<string | null, number>()
  constructor(
    readonly maximum = 64,
    readonly perPrincipal = 4,
    readonly timeoutMs = 30000
  ) {
    for (const [value, ceiling] of [
      [maximum, 4096],
      [perPrincipal, maximum],
      [timeoutMs, 30000]
    ])
      if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
        throw new OutputProtocolError('invalid', 'Invalid lookup work capacity or deadline')
  }

  async run<T>(
    principal: string | null,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (principal !== null) outputIdentity(principal)
    if (signal) checkLookupWork(signal)
    const count = this.principals.get(principal) ?? 0
    if (this.active >= this.maximum || count >= this.perPrincipal)
      throw new OutputProtocolError('limited', 'Lookup physical work capacity is full', true)
    this.active++
    this.principals.set(principal, count + 1)
    const controller = new AbortController()
    const stop = () =>
      controller.abort(new OutputProtocolError('cancelled', 'Lookup request cancelled'))
    signal?.addEventListener('abort', stop, { once: true })
    if (signal?.aborted) stop()
    const timer = setTimeout(
      () =>
        controller.abort(
          new OutputProtocolError('unavailable', 'Lookup request deadline reached', true)
        ),
      this.timeoutMs
    )
    let listener: () => void = () => {}
    const interrupted = new Promise<PromiseRejectedResult>(resolve => {
      listener = () => resolve({ status: 'rejected', reason: controller.signal.reason })
      controller.signal.addEventListener('abort', listener, { once: true })
      if (controller.signal.aborted) listener()
    })
    const pending = Promise.resolve()
      .then(async () => {
        checkLookupWork(controller.signal)
        const result = await operation(controller.signal)
        checkLookupWork(controller.signal)
        return result
      })
      .then<PromiseSettledResult<T>, PromiseSettledResult<T>>(
        value => ({ status: 'fulfilled', value }),
        (reason: unknown) => ({ status: 'rejected', reason })
      )
      .finally(() => {
        this.active--
        const remaining = (this.principals.get(principal) ?? 1) - 1
        if (remaining === 0) this.principals.delete(principal)
        else this.principals.set(principal, remaining)
      })
    try {
      const result = await Promise.race([pending, interrupted])
      if (result.status === 'rejected') throw result.reason
      return result.value
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      controller.signal.removeEventListener('abort', listener)
    }
  }
}
