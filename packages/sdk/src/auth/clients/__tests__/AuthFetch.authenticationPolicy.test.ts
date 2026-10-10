import { jest } from '@jest/globals'
import { PrivateKey, Utils } from '../../../primitives/index.js'

// Register for both the ordinary Jest transform and native ESM mutation runner.
jest.mock('../../Peer.js', () => ({ Peer: jest.fn() }))
jest.unstable_mockModule('../../Peer.js', () => ({ Peer: jest.fn() }))
let AuthFetch: typeof import('../AuthFetch.js').AuthFetch
let PeerMock: jest.Mock
beforeAll(async () => {
  ;({ AuthFetch } = await import('../AuthFetch.js'))
  PeerMock = (await import('../../Peer.js')).Peer as unknown as jest.Mock
})
const url = 'https://service.example/private'
const origin = new URL(url).origin
const identity = new PrivateKey(43).toPublicKey().toString()
const otherIdentity = new PrivateKey(44).toPublicKey().toString()
type Listener = (sender: string, payload: number[]) => void

function responsePayload(nonce: number[], status = 200): number[] {
  const writer = new Utils.Writer()
  writer.write(nonce)
  writer.writeVarIntNum(status)
  writer.writeVarIntNum(0)
  const body = Utils.toArray('authenticated result', 'utf8')
  writer.writeVarIntNum(body.length)
  writer.write(body)
  return writer.toArray()
}

function peer(outcome: 'response' | 'stale' | 'unauthenticated' | 'wait' = 'response') {
  const listeners = new Map<number, Listener>()
  let next = 0
  const state = {
    ready: Promise.resolve(),
    listenForCertificatesReceived: jest.fn(),
    listenForCertificatesRequested: jest.fn(),
    listenForGeneralMessages: jest.fn((listener: Listener) => {
      listeners.set(++next, listener)
      return next
    }),
    stopListeningForGeneralMessages: jest.fn((id: number) => listeners.delete(id)),
    emit(sender: string, nonce: number[], status = 200) {
      for (const listener of listeners.values()) listener(sender, responsePayload(nonce, status))
    },
    toPeer: jest.fn(async (payload: number[], _target?: string) => {
      if (outcome === 'stale') throw new Error('Session not found for nonce')
      if (outcome === 'unauthenticated') throw new Error('HTTP server failed to authenticate')
      if (outcome === 'response') state.emit(identity, payload.slice(0, 32))
    })
  }
  return state
}

function client(endpoint = peer(), identityKey?: string, supportsMutualAuth?: boolean) {
  const wallet = { createAction: jest.fn() }
  const fetchClient = jest.fn<typeof fetch>(async () => new Response('ordinary HTTP'))
  const fetcher = new AuthFetch(wallet as never, undefined, undefined, undefined, {}, fetchClient)
  fetcher.peers[origin] = {
    peer: endpoint as never,
    identityKey,
    supportsMutualAuth,
    pendingCertificateRequests: []
  }
  return { endpoint, wallet, fetchClient, fetcher }
}

const requiredPolicies = [
  { requireMutualAuth: true },
  { expectedIdentityKey: identity },
  { requireMutualAuth: false, expectedIdentityKey: identity }
]

afterEach(() => {
  jest.restoreAllMocks()
  jest.useRealTimers()
  PeerMock.mockReset()
})

describe('AuthFetch explicit peer authentication policy', () => {
  test.each(requiredPolicies)('refuses a cached HTTP-only endpoint: %j', async options => {
    const { endpoint, wallet, fetchClient, fetcher } = client(peer(), undefined, false)
    await expect(
      fetcher.fetch(url, { ...options, method: 'POST', body: 'private' })
    ).rejects.toThrow('Mutual authentication is required')
    expect(endpoint.toPeer).not.toHaveBeenCalled()
    expect(fetchClient).not.toHaveBeenCalled()
    expect(wallet.createAction).not.toHaveBeenCalled()
  })

  test.each(requiredPolicies)('refuses fallback after handshake failure: %j', async options => {
    const { endpoint, fetchClient, fetcher } = client(peer('unauthenticated'))
    await expect(
      fetcher.fetch(url, { ...options, method: 'POST', body: 'private' })
    ).rejects.toThrow('HTTP server failed to authenticate')
    expect(endpoint.toPeer).toHaveBeenCalledTimes(1)
    expect(endpoint.stopListeningForGeneralMessages).toHaveBeenCalledWith(1)
    expect(fetchClient).not.toHaveBeenCalled()
  })

  test.each([undefined, false])(
    'preserves HTTP fallback with requireMutualAuth=%s',
    async value => {
      for (const cached of [false, undefined]) {
        const { fetcher, fetchClient } = client(peer('unauthenticated'), undefined, cached)
        const response = await fetcher.fetch(url, { requireMutualAuth: value })
        expect(await response.text()).toBe('ordinary HTTP')
        expect(fetchClient).toHaveBeenCalledTimes(1)
        expect(fetchClient.mock.calls[0][1]).toMatchObject({ redirect: 'error' })
      }
    }
  )

  test.each([undefined, identity])(
    'pins dispatch before the first await, cached=%s',
    async cached => {
      const { endpoint, fetcher } = client(peer(), cached)
      const options = { expectedIdentityKey: identity, requireMutualAuth: false }
      const pending = fetcher.fetch(url, options)
      options.expectedIdentityKey = otherIdentity
      const response = await pending
      expect(endpoint.toPeer.mock.calls[0][1]).toBe(identity)
      expect(response.headers.get('x-bsv-auth-identity-key')).toBe(identity)
      expect(fetcher.peers[origin].identityKey).toBe(identity)
    }
  )

  test('rejects a conflicting cached identity without dispatch or cache rebinding', async () => {
    const { endpoint, fetcher, fetchClient } = client(peer(), otherIdentity, true)
    await expect(fetcher.fetch(url, { expectedIdentityKey: identity })).rejects.toThrow(
      'Cached peer identity does not match'
    )
    expect(endpoint.toPeer).not.toHaveBeenCalled()
    expect(fetchClient).not.toHaveBeenCalled()
    expect(fetcher.peers[origin].identityKey).toBe(otherIdentity)
  })

  test.each(['response', 'unauthenticated'] as const)(
    'retains required authentication, pin and payment denial through stale recovery: %s',
    async outcome => {
      const { endpoint, fetcher, fetchClient, wallet } = client(peer('stale'), identity, true)
      const replacement = peer(outcome)
      PeerMock.mockImplementation(() => replacement)
      const options = {
        requireMutualAuth: true,
        expectedIdentityKey: identity,
        allowPayments: false
      }
      const pending = fetcher.fetch(url, options)
      options.requireMutualAuth = false
      options.expectedIdentityKey = otherIdentity
      options.allowPayments = true
      if (outcome === 'response') expect((await pending).status).toBe(200)
      else await expect(pending).rejects.toThrow('HTTP server failed to authenticate')
      expect(endpoint.toPeer.mock.calls[0][1]).toBe(identity)
      expect(replacement.toPeer.mock.calls[0][1]).toBe(identity)
      expect(fetchClient).not.toHaveBeenCalled()
      expect(wallet.createAction).not.toHaveBeenCalled()
    }
  )

  test('retains an unpinned mutual-auth requirement when caller options change', async () => {
    const { fetcher, fetchClient } = client(peer('stale'))
    PeerMock.mockImplementation(() => peer('unauthenticated'))
    const options = { requireMutualAuth: true }
    const pending = fetcher.fetch(url, options)
    options.requireMutualAuth = false
    await expect(pending).rejects.toThrow('HTTP server failed to authenticate')
    expect(fetchClient).not.toHaveBeenCalled()
  })

  test('awaits removal of the selected pinned session from an asynchronous store before retrying', async () => {
    const session = { sessionNonce: 'test session', peerIdentityKey: identity }
    let release!: () => void
    let removing!: () => void
    const removed = new Promise<void>(resolve => {
      release = resolve
    })
    const started = new Promise<void>(resolve => {
      removing = resolve
    })
    const manager = {
      getSession: jest.fn(async () => session),
      removeSession: jest.fn(async () => {
        removing()
        await removed
      })
    }
    const first = peer('stale')
    const replacement = peer()
    PeerMock.mockImplementationOnce(() => first).mockImplementationOnce(() => replacement)
    const fetcher = new AuthFetch({} as never, undefined, manager as never)
    const pending = fetcher
      .fetch(url, { expectedIdentityKey: identity })
      .catch((error: unknown) => error)
    await started
    expect(manager.getSession).toHaveBeenCalledWith(identity)
    expect(manager.removeSession).toHaveBeenCalledWith(session)
    expect(PeerMock).toHaveBeenCalledTimes(1)
    expect(replacement.toPeer).not.toHaveBeenCalled()
    release()
    const response = await pending
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(200)
    expect(replacement.toPeer.mock.calls[0][1]).toBe(identity)
  })

  test('stops recovery if durable session invalidation fails', async () => {
    const manager = {
      getSession: jest.fn(async () => ({ peerIdentityKey: identity })),
      removeSession: jest.fn(async () => {
        throw new Error('session storage unavailable')
      })
    }
    PeerMock.mockImplementation(() => peer('stale'))
    const fetcher = new AuthFetch({} as never, undefined, manager as never)
    await expect(fetcher.fetch(url, { expectedIdentityKey: identity })).rejects.toThrow(
      'session storage unavailable'
    )
    expect(PeerMock).toHaveBeenCalledTimes(1)
  })

  test('recognizes a pinned cached session rejected before its first response and bounds retries', async () => {
    const endpoint = peer('wait')
    endpoint.toPeer.mockRejectedValue(
      Object.assign(new Error('request arrived without valid BSV authentication'), {
        details: { status: 401 }
      })
    )
    PeerMock.mockImplementation(() => endpoint)
    const fetcher = new AuthFetch({} as never)
    await expect(
      fetcher.fetch(url, { expectedIdentityKey: identity, retryCounter: 2 })
    ).rejects.toThrow('maximum number of retries')
    expect(endpoint.toPeer).toHaveBeenCalledTimes(2)
    expect(endpoint.toPeer.mock.calls.every(call => call[1] === identity)).toBe(true)
  })

  test('rejects a late mismatched sender without poisoning cache or another pending request', async () => {
    jest.useFakeTimers()
    const { endpoint, fetcher, fetchClient } = client(peer('wait'))
    let dispatch!: () => void
    const dispatched = new Promise<void>(resolve => {
      dispatch = resolve
    })
    endpoint.toPeer.mockImplementation(async () => {
      if (endpoint.toPeer.mock.calls.length === 2) dispatch()
    })
    // Attach both rejection handlers before waiting for dispatch. A deliberately
    // broken implementation must fail assertions, not crash the mutation worker
    // with the other request's unhandled rejection.
    const first = fetcher
      .fetch(url, { expectedIdentityKey: identity })
      .catch((error: unknown) => error)
    const second = fetcher
      .fetch(url, { expectedIdentityKey: identity })
      .catch((error: unknown) => error)
    await dispatched
    const firstNonce = endpoint.toPeer.mock.calls[0][0].slice(0, 32)
    const secondNonce = endpoint.toPeer.mock.calls[1][0].slice(0, 32)
    endpoint.emit(otherIdentity, firstNonce)
    expect(await first).toMatchObject({
      message: 'Authenticated response identity does not match expectedIdentityKey.'
    })
    expect(fetcher.peers[origin].identityKey).toBeUndefined()
    expect(fetcher.peers[origin].supportsMutualAuth).toBeUndefined()
    endpoint.emit(identity, secondNonce)
    const response = await second
    expect(response).toBeInstanceOf(Response)
    expect((response as Response).status).toBe(200)
    expect(fetcher.peers[origin].identityKey).toBe(identity)
    expect(endpoint.stopListeningForGeneralMessages).toHaveBeenCalledTimes(2)
    expect(jest.getTimerCount()).toBe(0)
    expect(fetchClient).not.toHaveBeenCalled()
  })

  test.each([null, 0, 'true', {}])(
    'rejects invalid mutual-auth options before I/O: %s',
    async value => {
      const fetcher = new AuthFetch({} as never)
      await expect(fetcher.fetch(url, { requireMutualAuth: value } as never)).rejects.toThrow(
        'boolean'
      )
      expect(PeerMock).not.toHaveBeenCalled()
    }
  )

  test.each([null, '', 1, '02', identity.toUpperCase(), `02${'ff'.repeat(32)}`])(
    'rejects invalid pins before I/O: %s',
    async value => {
      const fetcher = new AuthFetch({} as never)
      await expect(fetcher.fetch(url, { expectedIdentityKey: value } as never)).rejects.toThrow(
        'compressed public key'
      )
      expect(PeerMock).not.toHaveBeenCalled()
    }
  )
})
