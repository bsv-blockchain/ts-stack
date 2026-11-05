import type { ExpressTransport } from '../index.js'

/**
 * Observe the promise behind Express's intentionally synchronous send surface.
 * A rejection is immediately handled and then rethrown by the explicit test
 * await, so a broken internal failure path fails Jest instead of crashing Node.
 */
export function observeAuthenticatedResponseCompletion(
  transport: ExpressTransport
): () => Promise<void> {
  const pending: Promise<void>[] = []
  const hijack = Reflect.get(transport, 'hijackResponse') as (...args: unknown[]) => void
  Reflect.set(transport, 'hijackResponse', (...args: unknown[]) => {
    const build = args[3] as () => Promise<void>
    args[3] = () => {
      const result = build()
      pending.push(result)
      void result.catch(() => undefined)
      return result
    }
    hijack.apply(transport, args)
  })
  return async () => {
    if (pending.length === 0) throw new Error('No authenticated response builder was observed.')
    await Promise.all(pending)
  }
}
