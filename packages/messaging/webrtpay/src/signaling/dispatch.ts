import type { PubKeyHex } from '../types.js'
import type { SignalEnvelope } from './types.js'

/** One `listen` registration; an object so the same function can be registered twice. */
export interface SignalSubscription {
  fn: (from: PubKeyHex, e: SignalEnvelope) => void
}

/**
 * Hand `e` to every subscription still registered, each with its own copy. A
 * handler that throws or returns a rejecting promise never reaches the carrier or
 * the other handlers.
 */
export function dispatchSignal(
  subs: ReadonlySet<SignalSubscription>,
  from: PubKeyHex,
  e: SignalEnvelope
): void {
  for (const sub of Array.from(subs)) {
    if (!subs.has(sub)) continue
    try {
      const result: unknown = sub.fn(from, { v: e.v, sid: e.sid, ciphertext: e.ciphertext })
      if (isThenable(result)) result.then(undefined, ignore)
    } catch {
      // a faulty handler must not stop signaling
    }
  }
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'
}

function ignore(): void {
  // A handler's own rejection is its business; it must not surface as unhandled here.
}
