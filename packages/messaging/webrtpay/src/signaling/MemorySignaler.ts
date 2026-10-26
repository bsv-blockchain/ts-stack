import type { PubKeyHex } from '../types.js'
import { WebRTPayError } from '../util/errors.js'
import { dispatchSignal } from './dispatch.js'
import type { SignalSubscription } from './dispatch.js'
import type { Signaler } from './types.js'

/** In-process signaling between identities, for tests and demos. */
export interface MemoryHub {
  /** A signaler that sends and listens as `identityKey`. */
  signaler(identityKey: PubKeyHex): Signaler
  /** Drop every listener of `identityKey`, so sends to it fail until it listens again. */
  offline(identityKey: PubKeyHex): void
}

/**
 * Create an in-process hub. Delivery is asynchronous and the hub asserts the
 * sender, like a real carrier; `send` to an identity with no listener rejects
 * `WebRTPayError('peer_unreachable')`.
 */
export function createMemoryHub(): MemoryHub {
  const listeners = new Map<PubKeyHex, Set<SignalSubscription>>()

  return {
    signaler(identityKey: PubKeyHex): Signaler {
      return {
        send(to, e) {
          // Any failure, a malformed envelope included, rejects rather than throws.
          try {
            const subs = listeners.get(to)
            if (subs === undefined || subs.size === 0) {
              throw new WebRTPayError('peer_unreachable', 'Peer is not listening')
            }
            const copy = { v: e.v, sid: e.sid, ciphertext: e.ciphertext }
            // A resolved promise rather than a timer, so fake timers cannot hold delivery.
            void Promise.resolve().then(() => dispatchSignal(subs, identityKey, copy))
            return Promise.resolve()
          } catch (error) {
            return Promise.reject(error)
          }
        },

        listen(fn) {
          let subs = listeners.get(identityKey)
          if (subs === undefined) {
            subs = new Set()
            listeners.set(identityKey, subs)
          }
          const own = subs
          const sub: SignalSubscription = { fn }
          own.add(sub)
          return Promise.resolve(() => {
            own.delete(sub)
            if (own.size === 0 && listeners.get(identityKey) === own) listeners.delete(identityKey)
            return Promise.resolve()
          })
        }
      }
    },

    offline(identityKey: PubKeyHex): void {
      listeners.get(identityKey)?.clear()
      listeners.delete(identityKey)
    }
  }
}
