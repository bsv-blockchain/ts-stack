import { WalletRelayClient, WalletRelayError } from '../src/client/WalletRelayClient.js'
import type { SessionInfo } from '../src/types.js'

const pendingSession: SessionInfo = {
  sessionId: 'session-1',
  status: 'pending',
  qrDataUrl: 'data:image/png;base64,test',
  pairingUri: 'wallet://pair?topic=session-1',
  desktopToken: 'desktop-secret'
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body)
  } as unknown as Response
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
  it('normalizes the API URL, creates a session, persists it, and notifies callers', async () => {
    const onSessionChange = jest.fn()
    fetchMock.mockResolvedValueOnce(response(pendingSession))
    const client = new WalletRelayClient({
      apiUrl: 'https://relay.example/',
      onSessionChange
    })

    await expect(client.createSession()).resolves.toEqual(pendingSession)

    expect(fetchMock).toHaveBeenCalledWith('https://relay.example/api/session')
    expect(client.session).toEqual(pendingSession)
    expect(client.error).toBeNull()
    expect(onSessionChange).toHaveBeenCalledWith(pendingSession)
    expect(
      JSON.parse(sessionStorage.getItem('wallet-relay-session:https://relay.example/api')!)
    ).toMatchObject({
      sessionId: 'session-1',
      desktopToken: 'desktop-secret',
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
        sessionId: 'session-1',
        desktopToken: 'desktop-secret',
        qrDataUrl: pendingSession.qrDataUrl,
        pairingUri: pendingSession.pairingUri,
        status: 'pending',
        savedAt: Date.now()
      })
    )
    fetchMock.mockResolvedValueOnce(
      response({ sessionId: 'session-1', status: 'connected' } satisfies SessionInfo)
    )
    const client = new WalletRelayClient({ sessionStorageKey: 'resume-key' })

    await expect(client.resumeSession()).resolves.toEqual({
      sessionId: 'session-1',
      status: 'connected',
      qrDataUrl: pendingSession.qrDataUrl,
      pairingUri: pendingSession.pairingUri
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/session/session-1')
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
        sessionId: 'old',
        desktopToken: 'token',
        status: 'pending',
        savedAt: Date.now() - 11
      })
    )
    await expect(client.resumeSession()).resolves.toBeNull()
    expect(sessionStorage.getItem('resume-key')).toBeNull()

    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: 'gone',
        desktopToken: 'token',
        status: 'pending',
        savedAt: Date.now()
      })
    )
    fetchMock.mockResolvedValueOnce(response({}, 404))
    await expect(client.resumeSession()).resolves.toBeNull()

    sessionStorage.setItem(
      'resume-key',
      JSON.stringify({
        sessionId: 'expired',
        desktopToken: 'token',
        status: 'pending',
        savedAt: Date.now()
      })
    )
    fetchMock.mockResolvedValueOnce(
      response({ sessionId: 'expired', status: 'expired' } satisfies SessionInfo)
    )
    await expect(client.resumeSession()).resolves.toBeNull()
  })

  it('changes polling cadence and stops after two expired responses', async () => {
    const onSessionChange = jest.fn()
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockResolvedValueOnce(
        response({ sessionId: 'session-1', status: 'connected' } satisfies SessionInfo)
      )
      .mockResolvedValueOnce(
        response({ sessionId: 'session-1', status: 'disconnected' } satisfies SessionInfo)
      )
      .mockResolvedValueOnce(
        response({ sessionId: 'session-1', status: 'expired' } satisfies SessionInfo)
      )
      .mockResolvedValueOnce(
        response({ sessionId: 'session-1', status: 'expired' } satisfies SessionInfo)
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
    expect(sessionStorage.length).toBe(0)
  })

  it('disconnects server-side when authenticated and always tears down locally', async () => {
    fetchMock
      .mockResolvedValueOnce(response(pendingSession))
      .mockRejectedValueOnce(new Error('offline'))
    const client = new WalletRelayClient()
    await client.createSession()

    await expect(client.disconnect()).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenLastCalledWith('/api/session/session-1', {
      method: 'DELETE',
      headers: { 'X-Desktop-Token': 'desktop-secret' }
    })
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

  it('sends authenticated requests, resolves the log, and exposes a cached wallet proxy', async () => {
    const onLogChange = jest.fn()
    fetchMock.mockResolvedValueOnce(response({ ...pendingSession, status: 'connected' }))
    const client = new WalletRelayClient({ onLogChange })
    await client.createSession()
    fetchMock.mockResolvedValueOnce(response({ result: { publicKey: '02abc' } }))

    const wallet = client.wallet
    await expect(wallet.getPublicKey({ identityKey: true })).resolves.toEqual({
      publicKey: '02abc'
    })

    expect(client.wallet).toBe(wallet)
    expect(fetchMock).toHaveBeenLastCalledWith('/api/request/session-1', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Desktop-Token': 'desktop-secret'
      },
      body: JSON.stringify({ method: 'getPublicKey', params: { identityKey: true } })
    })
    expect(client.log).toHaveLength(1)
    expect(client.log[0]).toMatchObject({
      pending: false,
      response: { result: { publicKey: '02abc' } }
    })
    expect(onLogChange).toHaveBeenCalledTimes(2)

    fetchMock.mockResolvedValueOnce(response({ error: { code: 42, message: 'wallet rejected' } }))
    await expect(wallet.getPublicKey({ identityKey: true })).rejects.toMatchObject({
      message: 'wallet rejected',
      code: 42
    })
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

    await expect(client.sendRequest('getPublicKey')).rejects.toMatchObject({
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

    await expect(client.sendRequest('getPublicKey')).rejects.toMatchObject({
      message: 'Request failed',
      code: 'NETWORK_ERROR'
    })
    client.destroy()
  })
})
