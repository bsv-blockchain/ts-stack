import { jest } from '@jest/globals'
import { AuthFetch, type AuthFetchOptions } from '../AuthFetch.js'

const origin = 'https://service.example'

function waitingClient(options: AuthFetchOptions = {}) {
  const auth = new AuthFetch({} as never, undefined, undefined, undefined, options)
  const peer = {
    listenForGeneralMessages: jest.fn(() => 1),
    stopListeningForGeneralMessages: jest.fn(),
    toPeer: jest.fn(async () => {})
  }
  Reflect.set(auth, 'peers', {
    [origin]: {
      peer,
      identityKey: 'server',
      supportsMutualAuth: true,
      pendingCertificateRequests: []
    }
  })
  return { auth, peer }
}

describe('AuthFetch response timeout configuration', () => {
  afterEach(() => jest.useRealTimers())

  test.each([
    [{}, 30_000],
    [{ requestTimeoutMs: 60_000 }, 30_000],
    [{ responseTimeoutMs: 60_000, requestTimeoutMs: 60_000 }, 60_000],
    [{ responseTimeoutMs: 5 }, 5]
  ])('bounds the response waiter with options %j', async (options, expectedMs) => {
    jest.useFakeTimers()
    const { auth, peer } = waitingClient(options)
    const pending = auth.fetch(`${origin}/write`, { method: 'POST', body: 'synthetic' })
    const rejected = expect(pending).rejects.toThrow(
      'Timed out waiting for authenticated response.'
    )

    await jest.advanceTimersByTimeAsync(expectedMs - 1)
    expect(peer.toPeer).toHaveBeenCalledTimes(1)
    expect(peer.stopListeningForGeneralMessages).not.toHaveBeenCalled()
    await jest.advanceTimersByTimeAsync(1)
    await rejected
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
    expect(Reflect.get(auth, 'pendingRequestNonces').size).toBe(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  test('snapshots the configured deadline instead of reading a later caller mutation', async () => {
    jest.useFakeTimers()
    const options = { responseTimeoutMs: 10 }
    const { auth } = waitingClient(options)
    options.responseTimeoutMs = 60_000
    const rejected = expect(auth.fetch(`${origin}/resource`)).rejects.toThrow(
      'Timed out waiting for authenticated response.'
    )
    await jest.advanceTimersByTimeAsync(10)
    await rejected
    expect(jest.getTimerCount()).toBe(0)
  })

  test('a configured deadline still prevents dispatch after certificate approval finishes late', async () => {
    jest.useFakeTimers()
    const { auth, peer } = waitingClient({ responseTimeoutMs: 10 })
    let finish!: () => void
    const approval = new Promise<void>(resolve => {
      finish = resolve
    })
    auth.peers[origin].pendingCertificateRequests.push(true)
    jest
      .spyOn(auth as never, 'waitForPendingCertificateRequests')
      .mockReturnValue(approval as never)
    const rejected = expect(auth.fetch(`${origin}/write`, { method: 'POST' })).rejects.toThrow(
      'Timed out waiting for authenticated response.'
    )
    await jest.advanceTimersByTimeAsync(10)
    await rejected
    finish()
    await jest.advanceTimersByTimeAsync(0)
    expect(peer.toPeer).not.toHaveBeenCalled()
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
    expect(jest.getTimerCount()).toBe(0)
  })

  test.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648, null, '60000'])(
    'rejects an invalid explicit response timeout %p',
    value => {
      expect(() => waitingClient({ responseTimeoutMs: value as number })).toThrow(RangeError)
    }
  )

  test.each([1, 2_147_483_647])('accepts the supported timer boundary %i', responseTimeoutMs => {
    expect(() => waitingClient({ responseTimeoutMs })).not.toThrow()
  })
})
