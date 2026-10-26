import { WalletRelayClient, WalletRelayError } from '../src/client/WalletRelayClient.js'
import type { SessionInfo } from '../src/types.js'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import * as validation from '../src/shared/validation.js'
import { LOCAL_NETWORK_AUTHORITIES, PUBLIC_AUTHORITIES } from './fixtures/localDevelopmentHosts.js'

const SESSION_ID = 'A'.repeat(43)
const OLD_SESSION_ID = 'B'.repeat(43)
const GONE_SESSION_ID = 'C'.repeat(43)
const EXPIRED_SESSION_ID = 'D'.repeat(43)
const DESKTOP_TOKEN = 'E'.repeat(32)
const RPC_ID = '00000000-0000-4000-8000-000000000001'
const PUBLIC_KEY = new PrivateKey(1).toPublicKey().toString()
const pendingSession: SessionInfo = {
  sessionId: SESSION_ID,
  status: 'pending',
  qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  pairingUri: `wallet://pair?topic=${SESSION_ID}`,
  desktopToken: DESKTOP_TOKEN
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    }
  }
}

let fetchMock: jest.MockedFunction<typeof fetch>

beforeEach(() => {
  jest.useFakeTimers()
  fetchMock = jest.fn()
  globalThis.fetch = fetchMock
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: storage()
  })
})

afterEach(() => {
  jest.useRealTimers()
})

describe('WalletRelayClient session lifecycle', () => {
  it('requires authenticated transport for absolute relay API URLs', () => {
    expect(() => new WalletRelayClient({ apiUrl: 'http://relay.example' })).toThrow(
      'requires HTTPS'
    )
    for (const authority of PUBLIC_AUTHORITIES) {
      expect(() => new WalletRelayClient({ apiUrl: `http://${authority}` })).toThrow(
        'Relay API URL requires HTTPS, except for loopback development.'
      )
      expect(
        () => new WalletRelayClient({ apiUrl: `http://${authority}`, allowLocalNetworkHttp: true })
      ).toThrow('Relay API URL requires HTTPS, except for loopback or local-network development.')
    }
    for (const authority of LOCAL_NETWORK_AUTHORITIES) {
      expect(() => new WalletRelayClient({ apiUrl: `http://${authority}` })).toThrow(
        'Relay API URL requires HTTPS, except for loopback development (set allowLocalNetworkHttp: true to allow private-network IP addresses in development).'
      )
      expect(
        () => new WalletRelayClient({ apiUrl: `http://${authority}`, allowLocalNetworkHttp: false })
      ).toThrow('allowLocalNetworkHttp')
    }
    expect(
      () =>
        new WalletRelayClient({
          apiUrl: 'https://relay.example',
          allowLocalNetworkHttp: 'yes' as unknown as boolean
        })
    ).toThrow('allowLocalNetworkHttp must be a boolean')
    expect(() => new WalletRelayClient({ apiUrl: '//relay.example' })).toThrow(
      'absolute or a root-relative path'
    )
    expect(() => new WalletRelayClient({ apiUrl: '/relay\\@evil.example' })).toThrow(
      'cannot include backslashes'
    )
    expect(() => new WalletRelayClient({ apiUrl: 'https://user@relay.example' })).toThrow(
      'cannot include credentials'
    )
    expect(() => new WalletRelayClient({ apiUrl: 'https://relay.example?target=other' })).toThrow(
      'cannot include credentials'
    )
    expect(() => new WalletRelayClient({ apiUrl: 'https://relay.example/#fragment' })).toThrow(
      'cannot include credentials'
    )
  })

  it('validates the request-log retention bound', () => {
    expect(() => new WalletRelayClient({ maxLogEntries: -1 })).toThrow(/maxLogEntries/)
    expect(() => new WalletRelayClient({ maxLogEntries: 10_001 })).toThrow(/maxLogEntries/)
  })

  it.each([
    ['http://localhost:3001', 'http://localhost:3001/api/session', false],
    [
      'http://wallet.localhost:3001/relay/',
      'http://wallet.localhost:3001/relay/api/session',
      false
    ],
    ['http://127.0.0.1:3001/api', 'http://127.0.0.1:3001/api/session', false],
    ['http://[::1]:3001', 'http://[::1]:3001/api/session', false],
    ['http://192.168.1.20:3000', 'http://192.168.1.20:3000/api/session', true],
    ['http://10.0.0.5:3000/relay', 'http://10.0.0.5:3000/relay/api/session', true],
    ['http://172.16.4.2:3000', 'http://172.16.4.2:3000/api/session', true],
    ['http://[fd00::20]:3000', 'http://[fd00::20]:3000/api/session', true],
    ['/relay/', '/relay/api/session', false]
  ])(
    'permits loopback, opted-in local-network, or same-origin relay API URL %s',
    async (apiUrl, expected, allowLocalNetworkHttp) => {
      fetchMock.mockResolvedValueOnce(response(pendingSession))
      const client = new WalletRelayClient({ apiUrl, allowLocalNetworkHttp })
      await client.createSession()
      expect(fetchMock).toHaveBeenCalledWith(
        expected,
        expect.objectContaining({ redirect: 'error', signal: expect.anything() })
      )
      client.destroy()
    }
  )

  // The server sends `relay` only in status responses, never in the create response.
  const lanStatus = { sessionId: SESSION_ID, status: 'pending', relay: 'ws://192.168.1.20:3000' }

  it('accepts a private-network ws: relay in status polls with allowLocalNetworkHttp', async () => {
    const onError = jest.fn()
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockImplementation(async () => response(lanStatus))
    const client = new WalletRelayClient({
      allowLocalNetworkHttp: true,
      pollInterval: 100,
      onError
    })
    await client.createSession()

    await jest.advanceTimersByTimeAsync(100)

    expect(client.session).toMatchObject({ relay: 'ws://192.168.1.20:3000', status: 'pending' })
    expect(onError).not.toHaveBeenCalled()
    client.destroy()
  })

  it('stops polling and reports allowLocalNetworkHttp when a status poll carries a private-network ws: relay', async () => {
    const onError = jest.fn()
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockImplementation(async () => response(lanStatus))
    const client = new WalletRelayClient({ pollInterval: 100, onError })
    await client.createSession()

    await jest.advanceTimersByTimeAsync(100)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain('set allowLocalNetworkHttp: true')
    expect(client.error).toBe(onError.mock.calls[0][0])
    await jest.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledTimes(1)
    client.destroy()
  })

  it('keeps polling through transient network errors', async () => {
    const onError = jest.fn()
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response({ sessionId: SESSION_ID, status: 'connected' }))
    const client = new WalletRelayClient({ pollInterval: 100, onError })
    await client.createSession()

    await jest.advanceTimersByTimeAsync(100)
    await jest.advanceTimersByTimeAsync(100)

    expect(client.session?.status).toBe('connected')
    expect(client.error).toBeNull()
    expect(onError).not.toHaveBeenCalled()
    client.destroy()
  })

  it('reports allowLocalNetworkHttp and discards storage when resume sees a private-network ws: relay', async () => {
    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    const onError = jest.fn()
    fetchMock.mockImplementation(async () => response(lanStatus))
    const client = new WalletRelayClient({
      sessionStorageKey: 'resume-key',
      pollInterval: 100,
      onError
    })

    await expect(client.resumeSession()).resolves.toBeNull()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain('set allowLocalNetworkHttp: true')
    expect(client.error).toBe(onError.mock.calls[0][0])
    expect(sessionStorage.getItem('resume-key')).toBeNull()
    await jest.advanceTimersByTimeAsync(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a generic message when session validation throws a non-Error value', async () => {
    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    const onError = jest.fn()
    fetchMock.mockImplementation(async () => response({ sessionId: SESSION_ID, status: 'pending' }))
    const notAnError: unknown = 'not an Error'
    const validate = jest.spyOn(validation, 'validateSessionInfo').mockImplementationOnce(() => {
      throw notAnError
    })
    const client = new WalletRelayClient({ sessionStorageKey: 'resume-key', onError })

    try {
      await expect(client.resumeSession()).resolves.toBeNull()
      expect(onError).toHaveBeenCalledWith('Invalid session response')
      expect(client.error).toBe('Invalid session response')
      expect(sessionStorage.getItem('resume-key')).toBeNull()
    } finally {
      validate.mockRestore()
    }
  })

  it('returns null without reporting when resume hits a transient network error', async () => {
    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    const onError = jest.fn()
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    const client = new WalletRelayClient({ sessionStorageKey: 'resume-key', onError })

    await expect(client.resumeSession()).resolves.toBeNull()

    expect(onError).not.toHaveBeenCalled()
    expect(client.error).toBeNull()
  })

  it('reports allowLocalNetworkHttp when the create response carries a private-network ws: relay', async () => {
    const onError = jest.fn()
    fetchMock.mockResolvedValueOnce(response({ ...pendingSession, relay: lanStatus.relay }))
    const client = new WalletRelayClient({ onError })

    await expect(client.createSession()).rejects.toThrow('set allowLocalNetworkHttp: true')
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0][0]).toContain('set allowLocalNetworkHttp: true')
    expect(client.session).toBeNull()
  })

  function storeResumable(sessionId: string): void {
    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now()
      })
    )
  }

  it('does not report a resume validation error after the client is destroyed', async () => {
    storeResumable(SESSION_ID)
    let resolveResume!: (value: Response) => void
    fetchMock.mockReturnValueOnce(
      new Promise<Response>(resolve => {
        resolveResume = resolve
      })
    )
    const onError = jest.fn()
    const client = new WalletRelayClient({ sessionStorageKey: 'resume-key', onError })

    const resume = client.resumeSession()
    client.destroy()
    resolveResume(response(lanStatus))

    await expect(resume).resolves.toBeNull()
    expect(onError).not.toHaveBeenCalled()
    expect(client.error).toBeNull()
  })

  it.each([
    ['a missing session', () => response({}, 404)],
    [
      'a rejected relay',
      () => response({ sessionId: OLD_SESSION_ID, status: 'pending', relay: lanStatus.relay })
    ],
    ['an expired session', () => response({ sessionId: OLD_SESSION_ID, status: 'expired' })]
  ])(
    "keeps a newer session's stored entry when a stale resume sees %s",
    async (_case, staleResponse) => {
      storeResumable(OLD_SESSION_ID)
      let resolveResume!: (value: Response) => void
      fetchMock
        .mockReturnValueOnce(
          new Promise<Response>(resolve => {
            resolveResume = resolve
          })
        )
        .mockResolvedValueOnce(response(pendingSession))
      const onError = jest.fn()
      const client = new WalletRelayClient({ sessionStorageKey: 'resume-key', onError })

      const resume = client.resumeSession()
      await client.createSession()
      resolveResume(staleResponse())

      await expect(resume).resolves.toBeNull()
      expect(JSON.parse(sessionStorage.getItem('resume-key') ?? 'null')).toMatchObject({
        sessionId: SESSION_ID
      })
      expect(client.session?.sessionId).toBe(SESSION_ID)
      expect(onError).not.toHaveBeenCalled()
      client.destroy()
    }
  )

  it('normalizes the API URL, creates a session, persists it, and notifies callers', async () => {
    const onSessionChange = jest.fn()
    fetchMock.mockResolvedValueOnce(response(pendingSession))
    const client = new WalletRelayClient({
      apiUrl: 'https://relay.example/',
      onSessionChange
    })

    await expect(client.createSession()).resolves.toEqual(pendingSession)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://relay.example/api/session',
      expect.objectContaining({ redirect: 'error', signal: expect.anything() })
    )
    expect(client.session).toEqual(pendingSession)
    expect(client.error).toBeNull()
    expect(onSessionChange).toHaveBeenCalledWith(pendingSession)
    expect(
      JSON.parse(sessionStorage.getItem('wallet-relay-session:https://relay.example/api')!)
    ).toMatchObject({
      sessionId: SESSION_ID,
      desktopToken: DESKTOP_TOKEN,
      status: 'pending'
    })
    client.destroy()
  })

  it('reports session creation failures without leaving stale state', async () => {
    const onError = jest.fn()
    fetchMock.mockResolvedValueOnce(response({}, 503))
    const client = new WalletRelayClient({ onError })

    await expect(client.createSession()).rejects.toThrow('HTTP 503')
    expect(client.error).toBe('HTTP 503')
    expect(onError).toHaveBeenCalledWith('HTTP 503')
    expect(client.session).toBeNull()
  })

  it('resumes a live persisted session and restores QR-only fields', async () => {
    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        qrDataUrl: pendingSession.qrDataUrl,
        pairingUri: pendingSession.pairingUri,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    fetchMock.mockResolvedValueOnce(
      response({ sessionId: SESSION_ID, status: 'connected' } satisfies SessionInfo)
    )
    const client = new WalletRelayClient({ sessionStorageKey: 'resume-key' })

    await expect(client.resumeSession()).resolves.toEqual({
      sessionId: SESSION_ID,
      status: 'connected',
      qrDataUrl: pendingSession.qrDataUrl,
      pairingUri: pendingSession.pairingUri
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/session/${SESSION_ID}`,
      expect.objectContaining({ redirect: 'error', signal: expect.anything() })
    )
    client.destroy()
  })

  it('discards stale, missing, rejected, and expired persisted sessions', async () => {
    const client = new WalletRelayClient({
      sessionStorageKey: 'resume-key',
      sessionStorageTtl: 10
    })
    await expect(client.resumeSession()).resolves.toBeNull()

    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: OLD_SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now() - 11
      })
    )
    await expect(client.resumeSession()).resolves.toBeNull()
    expect(sessionStorage.getItem('resume-key')).toBeNull()

    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: GONE_SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    fetchMock.mockResolvedValueOnce(response({}, 404))
    await expect(client.resumeSession()).resolves.toBeNull()

    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: EXPIRED_SESSION_ID,
        desktopToken: DESKTOP_TOKEN,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    fetchMock.mockResolvedValueOnce(
      response({ sessionId: EXPIRED_SESSION_ID, status: 'expired' } satisfies SessionInfo)
    )
    await expect(client.resumeSession()).resolves.toBeNull()
  })

  it('changes polling cadence and stops after two expired responses', async () => {
    const onSessionChange = jest.fn()
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockResolvedValueOnce(
        response({ sessionId: SESSION_ID, status: 'connected' } satisfies SessionInfo)
      )
      .mockResolvedValueOnce(
        response({ sessionId: SESSION_ID, status: 'disconnected' } satisfies SessionInfo)
      )
      .mockResolvedValueOnce(
        response({ sessionId: SESSION_ID, status: 'expired' } satisfies SessionInfo)
      )
      .mockResolvedValueOnce(
        response({ sessionId: SESSION_ID, status: 'expired' } satisfies SessionInfo)
      )
    const client = new WalletRelayClient({
      pollInterval: 100,
      connectedPollInterval: 500,
      onSessionChange
    })
    await client.createSession()

    await jest.advanceTimersByTimeAsync(100)
    await jest.advanceTimersByTimeAsync(500)
    await jest.advanceTimersByTimeAsync(100)
    await jest.advanceTimersByTimeAsync(100)
    await jest.advanceTimersByTimeAsync(1_000)

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(onSessionChange.mock.calls.map(([session]) => session.status)).toEqual([
      'pending',
      'connected',
      'disconnected',
      'expired',
      'expired'
    ])
    expect(sessionStorage).toHaveLength(0)
  })

  it('does not overlap slow polls or let a stale poll revive a disconnected session', async () => {
    let resolvePoll!: (value: Response) => void
    const slowPoll = new Promise<Response>(resolve => {
      resolvePoll = resolve
    })
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockReturnValueOnce(slowPoll)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const client = new WalletRelayClient({ pollInterval: 10 })
    await client.createSession()
    await jest.advanceTimersByTimeAsync(10)
    await jest.advanceTimersByTimeAsync(100)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await client.disconnect()
    resolvePoll(response({ sessionId: SESSION_ID, status: 'connected' }))
    await Promise.resolve()
    await Promise.resolve()

    expect(client.session).toBeNull()
    expect(sessionStorage).toHaveLength(0)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('retires a session that arrives after creation was cancelled', async () => {
    let resolveCreation!: (value: Response) => void
    const pendingCreation = new Promise<Response>(resolve => {
      resolveCreation = resolve
    })
    fetchMock
      .mockReturnValueOnce(pendingCreation)
      .mockResolvedValueOnce(new Response(null, { status: 204 }))

    const client = new WalletRelayClient()
    const creation = client.createSession()
    await client.disconnect()
    resolveCreation(response(pendingSession))

    await expect(creation).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' })
    await Promise.resolve()
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/session/${SESSION_ID}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Desktop-Token': DESKTOP_TOKEN }
      })
    )
    expect(client.session).toBeNull()
    expect(sessionStorage).toHaveLength(0)
  })

  it('disconnects server-side when authenticated and always tears down locally', async () => {
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockRejectedValueOnce(new Error('offline'))
    const client = new WalletRelayClient()
    await client.createSession()

    await expect(client.disconnect()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/session/${SESSION_ID}`,
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'X-Desktop-Token': DESKTOP_TOKEN },
        redirect: 'error',
        signal: expect.anything()
      })
    )
    expect(client.session).toBeNull()
    expect(sessionStorage).toHaveLength(0)
  })
})

describe('WalletRelayClient requests', () => {
  async function connectedClient(): Promise<WalletRelayClient> {
    fetchMock.mockResolvedValueOnce(response({ ...pendingSession, status: 'connected' }))
    const client = new WalletRelayClient()
    await client.createSession()
    return client
  }

  it('rejects requests without a session', async () => {
    const client = new WalletRelayClient()
    await expect(client.sendRequest('getPublicKey')).rejects.toEqual(
      expect.objectContaining<Partial<WalletRelayError>>({
        code: 'SESSION_NOT_CONNECTED'
      })
    )
  })

  it('rejects malformed wallet arguments before logging or crossing the network', async () => {
    const client = await connectedClient()
    const callsBeforeRequest = fetchMock.mock.calls.length

    await expect(
      client.sendRequest('getPublicKey', { identityKey: 'true' } as never)
    ).rejects.toThrow(/identityKey/)
    expect(fetchMock).toHaveBeenCalledTimes(callsBeforeRequest)
    expect(client.log).toHaveLength(0)
    client.destroy()
  })

  it('sends authenticated requests, resolves the log, and exposes a cached wallet proxy', async () => {
    const onLogChange = jest.fn()
    fetchMock.mockResolvedValueOnce(response({ ...pendingSession, status: 'connected' }))
    const client = new WalletRelayClient({ onLogChange })
    await client.createSession()
    fetchMock.mockResolvedValueOnce(
      response({ id: RPC_ID, seq: 1, result: { publicKey: PUBLIC_KEY } })
    )

    const wallet = client.wallet
    await expect(wallet.getPublicKey({ identityKey: true })).resolves.toEqual({
      publicKey: PUBLIC_KEY
    })

    expect(client.wallet).toBe(wallet)
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/request/${SESSION_ID}`,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': DESKTOP_TOKEN
        },
        body: JSON.stringify({ method: 'getPublicKey', params: { identityKey: true } }),
        redirect: 'error',
        signal: expect.anything()
      })
    )
    expect(client.log).toHaveLength(1)
    expect(client.log[0]).toMatchObject({
      pending: false,
      response: { result: { publicKey: PUBLIC_KEY } }
    })
    expect(onLogChange).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(
      response({ id: RPC_ID, seq: 2, error: { code: 42, message: 'wallet rejected' } })
    )
    await expect(wallet.getPublicKey({ identityKey: true })).rejects.toMatchObject({
      message: 'wallet rejected',
      code: 42
    })
    client.destroy()
  })

  it('bounds or disables retention of security-sensitive request results', async () => {
    fetchMock.mockResolvedValueOnce(response({ ...pendingSession, status: 'connected' }))
    const onLogChange = jest.fn()
    const client = new WalletRelayClient({ maxLogEntries: 1, onLogChange })
    await client.createSession()
    fetchMock
      .mockResolvedValueOnce(response({ id: RPC_ID, seq: 1, result: { publicKey: PUBLIC_KEY } }))
      .mockResolvedValueOnce(response({ id: RPC_ID, seq: 2, result: { publicKey: PUBLIC_KEY } }))

    await client.sendRequest('getPublicKey', { identityKey: true, keyID: 'first' })
    await client.sendRequest('getPublicKey', { identityKey: true, keyID: 'second' })
    expect(client.log).toHaveLength(1)
    expect(onLogChange.mock.calls.every(([log]) => log.length <= 1)).toBe(true)
    client.destroy()

    const disabled = new WalletRelayClient({ maxLogEntries: 0 })
    fetchMock.mockResolvedValueOnce(response({ ...pendingSession, status: 'connected' }))
    await disabled.createSession()
    fetchMock.mockResolvedValueOnce(
      response({ id: RPC_ID, seq: 3, result: { publicKey: PUBLIC_KEY } })
    )
    await disabled.sendRequest('getPublicKey', { identityKey: true })
    expect(disabled.log).toEqual([])
    disabled.destroy()
  })

  it('keeps request bytes portable and repairs responses from historical relay JSON', async () => {
    const client = await connectedClient()
    const mangledPlaintext = JSON.parse(JSON.stringify(new Uint8Array([4, 5, 6])))
    fetchMock.mockResolvedValueOnce(
      response({
        id: RPC_ID,
        seq: 1,
        result: { plaintext: mangledPlaintext }
      })
    )

    const result = await client.sendRequest('decrypt', {
      protocolID: [0, 'test encryption'],
      keyID: 'portable-bytes',
      counterparty: 'self',
      ciphertext: new Uint8Array([1, 2, 3])
    })

    const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    expect(JSON.parse(String(lastCall?.[1]?.body))).toMatchObject({
      params: { ciphertext: [1, 2, 3] }
    })
    expect(result.result).toEqual({ plaintext: [4, 5, 6] })
    client.destroy()
  })

  it.each([
    [401, 'bad token', 'INVALID_TOKEN'],
    [400, 'not connected', 'SESSION_NOT_CONNECTED'],
    [504, 'mobile disconnected', 'SESSION_DISCONNECTED'],
    [504, 'mobile timed out', 'REQUEST_TIMEOUT'],
    [500, 'server failed', 'NETWORK_ERROR']
  ] as const)('maps HTTP %i (%s) to %s', async (status, message, code) => {
    const client = await connectedClient()
    fetchMock.mockResolvedValueOnce(response({ error: message }, status))

    await expect(client.sendRequest('getPublicKey', { identityKey: true })).rejects.toMatchObject({
      message,
      code
    })
    expect(client.log[0]).toMatchObject({
      pending: false,
      response: { error: { message } }
    })
    client.destroy()
  })

  it('normalizes thrown non-relay failures as network errors', async () => {
    const client = await connectedClient()
    fetchMock.mockRejectedValueOnce('offline')

    await expect(client.sendRequest('getPublicKey', { identityKey: true })).rejects.toMatchObject({
      message: 'Request failed',
      code: 'NETWORK_ERROR'
    })
    client.destroy()
  })

  it('rejects authoritative-looking false verification verdicts from a hostile relay', async () => {
    const client = await connectedClient()
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    const args = {
      data: [1, 2, 3],
      protocolID: [0, 'test signing'] as [0, string],
      keyID: 'test',
      counterparty: 'anyone' as const,
      ...(await wallet.createSignature({
        data: [1, 2, 3],
        protocolID: [0, 'test signing'],
        keyID: 'test',
        counterparty: 'anyone'
      }))
    }
    fetchMock.mockResolvedValueOnce(response({ id: RPC_ID, seq: 1, result: { valid: false } }))

    await expect(client.sendRequest('verifySignature', args)).rejects.toMatchObject({
      code: 'NETWORK_ERROR'
    })
    expect(client.log[0]).toMatchObject({ pending: false })
    client.destroy()
  })

  it('rejects malformed wallet results before exposing them through the wallet proxy', async () => {
    const client = await connectedClient()
    fetchMock.mockResolvedValueOnce(
      response({ id: RPC_ID, seq: 1, result: { publicKey: '02abc' } })
    )

    await expect(client.wallet.getPublicKey({ identityKey: true })).rejects.toThrow(/publicKey/)
    client.destroy()
  })
})
