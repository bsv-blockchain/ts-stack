import { describe, expect, it } from 'vitest'
import {
  DeliveryFailed,
  GroupMessagingError,
  isPermanent,
  PermanentProcessingError
} from '../errors.js'

describe('PermanentProcessingError', () => {
  it('is permanent', () => {
    expect(isPermanent(new PermanentProcessingError('will never work'))).toBe(true)
  })

  it('preserves its message and cause', () => {
    const cause = new Error('underlying')
    const error = new PermanentProcessingError('wrapped', { cause })

    expect(error.message).toBe('wrapped')
    expect(error.cause).toBe(cause)
    expect(error.name).toBe('PermanentProcessingError')
    expect(error).toBeInstanceOf(GroupMessagingError)
  })
})

describe('isPermanent', () => {
  it('is false for a plain Error', () => {
    expect(isPermanent(new Error('ordinary'))).toBe(false)
  })

  it('is false for non-Error values', () => {
    expect(isPermanent('nope')).toBe(false)
    expect(isPermanent(null)).toBe(false)
    expect(isPermanent(undefined)).toBe(false)
    expect(isPermanent({ permanent: true })).toBe(false)
  })

  it('is true for a DeliveryFailed whose failures are all permanent', () => {
    const aggregate = new DeliveryFailed('02aa', [
      new PermanentProcessingError('one'),
      new PermanentProcessingError('two')
    ])
    expect(isPermanent(aggregate)).toBe(true)
  })

  it('is false for a DeliveryFailed with a mix of permanent and transient failures', () => {
    // One transient failure among them means a retry might still get that
    // handler through, so the aggregate as a whole is not permanent.
    const aggregate = new DeliveryFailed('02aa', [
      new PermanentProcessingError('one'),
      new Error('storage is down')
    ])
    expect(isPermanent(aggregate)).toBe(false)
  })

  it('is false for a DeliveryFailed whose failures are all transient', () => {
    const aggregate = new DeliveryFailed('02aa', [new Error('one'), new Error('two')])
    expect(isPermanent(aggregate)).toBe(false)
  })

  it('is false for a DeliveryFailed with no failures', () => {
    // Nothing to point to means nothing was actually permanent.
    const aggregate = new DeliveryFailed('02aa', [])
    expect(isPermanent(aggregate)).toBe(false)
  })

  /**
   * The regression guard for a predicate that must never throw: `isPermanent`
   * is exported, so a host can pass any error class, including one whose
   * `permanent` accessor is a getter that throws instead of a plain field.
   * `MessageBoxTransport#failed` calls this unguarded inside a per-message
   * catch — a throw here would abort the whole delivery batch, which is
   * exactly what invariant 5 (isolated inbound handlers) exists to prevent.
   */
  it('is false, not thrown, for an error whose permanent getter throws', () => {
    class Hostile extends Error {
      get permanent(): boolean {
        throw new Error('getter blew up')
      }
    }

    expect(() => isPermanent(new Hostile('hostile'))).not.toThrow()
    expect(isPermanent(new Hostile('hostile'))).toBe(false)
  })

  it('is false for a DeliveryFailed whose failures getter throws', () => {
    class HostileAggregate extends Error {
      get failures(): Error[] {
        throw new Error('getter blew up')
      }
    }

    expect(() => isPermanent(new HostileAggregate('hostile'))).not.toThrow()
    expect(isPermanent(new HostileAggregate('hostile'))).toBe(false)
  })
})
