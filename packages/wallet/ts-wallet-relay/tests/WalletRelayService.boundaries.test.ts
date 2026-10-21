import http from 'node:http'
import { WebSocket } from 'ws'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletRelayService } from '../src/server/WalletRelayService.js'
import type { RpcResponse, WireEnvelope } from '../src/types.js'

const RPC_ID = '00000000-0000-4000-8000-000000000001'

function createService(
  overrides: Partial<ConstructorParameters<typeof WalletRelayService>[0]> = {}
): { service: WalletRelayService; wallet: ProtoWallet; server: http.Server } {
  const server = http.createServer()
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const service = new WalletRelayService({
    server,
    wallet,
    noServer: true,
    relayUrl: 'ws://localhost:3000',
    origin: 'http://localhost:5173',
    ...overrides
  })
  return { server, service, wallet }
}

async function connectedSession(service: WalletRelayService): Promise<{
  id: string
  desktopToken: string
  mobileIdentityKey: string
}> {
  const sessions = (service as any).sessions
  const session = sessions.createSession()
  const mobileIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
  sessions.setMobileIdentityKey(session.id, mobileIdentityKey)
  sessions.setStatus(session.id, 'connected')
  return { id: session.id, desktopToken: session.desktopToken, mobileIdentityKey }
}

function plaintext(wallet: ProtoWallet, value: unknown): void {
  jest.spyOn(wallet, 'decrypt').mockResolvedValueOnce({
    plaintext: Array.from(new TextEncoder().encode(JSON.stringify(value)))
  } as never)
}

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for service state')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

function responseDouble() {
  const response = {} as {
    statusCode: number
    setHeader: jest.Mock
    status: jest.Mock
    json: jest.Mock
    end: jest.Mock
  }
  response.statusCode = 200
  response.setHeader = jest.fn()
  response.status = jest.fn((status: number) => {
    response.statusCode = status
    return response
  })
  response.json = jest.fn(() => response)
  response.end = jest.fn(() => response)
  return response
}

describe('WalletRelayService boundary and state enforcement', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    [{ schema: '1-invalid' }, 'Pairing schema is invalid'],
    [{ mobileAuthTimeoutMs: 0 }, 'mobileAuthTimeoutMs'],
    [{ mobileAuthTimeoutMs: 1.5 }, 'mobileAuthTimeoutMs'],
    [{ mobileAuthTimeoutMs: 120_001 }, 'mobileAuthTimeoutMs'],
    [{ maxSessionCreationsPerMinute: 0 }, 'maxSessionCreationsPerMinute'],
    [{ maxSessionCreationsPerMinute: Number.NaN }, 'maxSessionCreationsPerMinute'],
    [{ maxSessionCreationsPerMinute: 100_001 }, 'maxSessionCreationsPerMinute']
  ])('rejects unsafe service configuration %#', (options, message) => {
    const server = http.createServer()
    const wallet = new ProtoWallet(PrivateKey.fromRandom())
    expect(
      () =>
        new WalletRelayService({
          server,
          wallet,
          noServer: true,
          ...options
        })
    ).toThrow(message as string)
  })

  it('resets the creation window after clock rollback instead of permanently rate-limiting', () => {
    const { service } = createService({ maxSessionCreationsPerMinute: 1 })
    try {
      ;(service as any).sessionCreationWindowStartedAt = 1_000
      ;(service as any).sessionCreationsInWindow = 1
      jest.spyOn(Date, 'now').mockReturnValue(500)

      expect(() => (service as any).reserveSessionCreation()).not.toThrow()
      expect((service as any).sessionCreationsInWindow).toBe(1)
      expect((service as any).sessionCreationWindowStartedAt).toBe(500)
    } finally {
      service.stop()
    }
  })

  it('starts one mobile proof deadline per topic and replaces an earlier deadline', async () => {
    const { service } = createService({ mobileAuthTimeoutMs: 25 })
    try {
      const sessions = (service as any).sessions
      const session = sessions.createSession()
      const relay = (service as any).relay
      const disconnect = jest.spyOn(relay, 'disconnectMobile')

      relay.onMobileConnectCb('unknown-topic')
      expect((service as any).mobileAuthTimers.size).toBe(0)

      relay.onMobileConnectCb(session.id)
      const firstTimer = (service as any).mobileAuthTimers.get(session.id)
      relay.onMobileConnectCb(session.id)
      expect((service as any).mobileAuthTimers.get(session.id)).not.toBe(firstTimer)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(disconnect).toHaveBeenCalledWith(session.id)
      expect((service as any).mobileAuthTimers.has(session.id)).toBe(false)
    } finally {
      service.stop()
    }
  })

  it('rejects malformed route bodies and UTF-8-oversized method names synchronously', () => {
    const routes = new Map<string, (req: any, res: any) => void>()
    const app = {
      get: (path: string, handler: (req: any, res: any) => void) =>
        routes.set(`GET ${path}`, handler),
      post: (path: string, handler: (req: any, res: any) => void) =>
        routes.set(`POST ${path}`, handler),
      delete: (path: string, handler: (req: any, res: any) => void) =>
        routes.set(`DELETE ${path}`, handler)
    }
    const { service } = createService({ app: app as never })
    try {
      const post = routes.get('POST /api/request/:id')!
      for (const body of [null, [], { method: 1 }, { method: '' }, { method: 'é'.repeat(51) }]) {
        const response = responseDouble()
        post({ body, headers: {}, params: { id: 'invalid' } }, response)
        expect(response.status).toHaveBeenCalledWith(400)
        expect(response.json).toHaveBeenCalled()
      }
    } finally {
      service.stop()
    }
  })

  it('maps bounded-request and rate-limit failures to their HTTP status without leaking tokens', async () => {
    const routes = new Map<string, (req: any, res: any) => void>()
    const app = {
      get: (path: string, handler: (req: any, res: any) => void) =>
        routes.set(`GET ${path}`, handler),
      post: (path: string, handler: (req: any, res: any) => void) =>
        routes.set(`POST ${path}`, handler),
      delete: (path: string, handler: (req: any, res: any) => void) =>
        routes.set(`DELETE ${path}`, handler)
    }
    const { service } = createService({ app: app as never })
    try {
      const post = routes.get('POST /api/request/:id')!
      const error = Object.assign(new Error('Too many active wallet requests'), { code: 429 })
      jest.spyOn(service, 'sendRequest').mockRejectedValueOnce(error)
      const response = responseDouble()
      post(
        {
          body: { method: 'custom', params: {} },
          headers: { 'x-desktop-token': 'secret-token' },
          params: { id: 'session' }
        },
        response
      )
      await new Promise(resolve => setImmediate(resolve))
      expect(response.status).toHaveBeenCalledWith(429)
      expect(JSON.stringify(response.json.mock.calls)).not.toContain('secret-token')
    } finally {
      service.stop()
    }
  })

  it('rejects hostile custom parameters and caps active requests per connected session', async () => {
    const { service } = createService()
    try {
      const session = await connectedSession(service)
      const hostile: Record<string, unknown> = {}
      let getterCalls = 0
      Object.defineProperty(hostile, 'value', {
        enumerable: true,
        get: () => {
          getterCalls += 1
          return 'secret'
        }
      })
      const invalid = service.sendRequest(
        session.id,
        'custom',
        hostile,
        session.desktopToken
      ) as Promise<RpcResponse> & { code?: number }
      await expect(invalid).rejects.toMatchObject({ code: 400 })
      expect(getterCalls).toBe(0)

      ;(service as any).activeRequestCounts.set(session.id, 100)
      const capped = service.sendRequest(
        session.id,
        'custom',
        {},
        session.desktopToken
      ) as Promise<RpcResponse> & { code?: number }
      await expect(capped).rejects.toMatchObject({ code: 429 })
    } finally {
      service.stop()
    }
  })

  it('revalidates connection state after a queued request obtains its send turn', async () => {
    const { service } = createService()
    try {
      const session = await connectedSession(service)
      let release!: () => void
      const blocked = new Promise<void>(resolve => {
        release = resolve
      })
      ;(service as any).outboundQueues.set(session.id, blocked)

      const pending = service.sendRequest(session.id, 'custom', {}, session.desktopToken)
      ;(service as any).sessions.setStatus(session.id, 'disconnected')
      release()

      await expect(pending).rejects.toThrow('Session is disconnected')
      expect((service as any).activeRequestCounts.has(session.id)).toBe(false)
    } finally {
      service.stop()
    }
  })

  it('contains relay-send failures and removes the pending request before rejecting', async () => {
    const { service } = createService()
    try {
      const session = await connectedSession(service)
      jest.spyOn((service as any).relay, 'sendToMobile').mockImplementationOnce(() => {
        throw 'send failed'
      })

      await expect(
        service.sendRequest(session.id, 'custom', {}, session.desktopToken)
      ).rejects.toThrow('Failed to send wallet request')
      expect((service as any).pending.size).toBe(0)
    } finally {
      service.stop()
    }
  })

  it('rejects response/request binding mismatches and invalid wallet results', async () => {
    const { service, wallet } = createService()
    try {
      const session = await connectedSession(service)
      const relay = (service as any).relay
      const disconnect = jest.spyOn(relay, 'disconnectMobile')
      const reject = jest.fn()
      const resolve = jest.fn()

      ;(service as any).pending.set(RPC_ID, {
        sessionId: session.id,
        seq: 7,
        method: 'custom',
        params: {},
        resolve,
        reject,
        timer: setTimeout(() => undefined, 60_000)
      })
      plaintext(wallet, { id: RPC_ID, seq: 8, result: { ok: true } })
      await (service as any).handleMobileMessage(session.id, {
        topic: session.id,
        ciphertext: 'AQID'
      })
      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('bound') })
      )
      expect(disconnect).toHaveBeenCalledWith(session.id)

      reject.mockClear()
      disconnect.mockClear()
      ;(service as any).pending.set(RPC_ID, {
        sessionId: session.id,
        seq: 9,
        method: 'getPublicKey',
        params: { identityKey: true },
        resolve,
        reject,
        timer: setTimeout(() => undefined, 60_000)
      })
      plaintext(wallet, { id: RPC_ID, seq: 9, result: { publicKey: 'invalid' } })
      await (service as any).handleMobileMessage(session.id, {
        topic: session.id,
        ciphertext: 'AQID'
      })
      expect(reject).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Wallet returned an invalid result' })
      )
      expect(disconnect).toHaveBeenCalledWith(session.id)
      expect((service as any).pending.has(RPC_ID)).toBe(false)
    } finally {
      service.stop()
    }
  })

  it('ignores non-response mobile messages and settles error and custom responses', async () => {
    const { service, wallet } = createService()
    try {
      const session = await connectedSession(service)
      const disconnect = jest.spyOn((service as any).relay, 'disconnectMobile')
      const reject = jest.fn()
      const resolve = jest.fn()
      ;(service as any).pending.set(RPC_ID, {
        sessionId: session.id,
        seq: 3,
        method: 'custom',
        params: {},
        resolve,
        reject,
        timer: setTimeout(() => undefined, 60_000)
      })

      plaintext(wallet, { id: RPC_ID, seq: 3, method: 'custom', params: {} })
      await (service as any).handleMobileMessage(session.id, {
        topic: session.id,
        ciphertext: 'AQID'
      })
      expect(resolve).not.toHaveBeenCalled()
      expect((service as any).pending.has(RPC_ID)).toBe(true)

      const error = { code: 42, message: 'wallet rejected' }
      plaintext(wallet, { id: RPC_ID, seq: 3, error })
      await (service as any).handleMobileMessage(session.id, {
        topic: session.id,
        ciphertext: 'AQID'
      })
      expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: RPC_ID, error }))
      expect((service as any).pending.has(RPC_ID)).toBe(false)

      resolve.mockClear()
      ;(service as any).pending.set(RPC_ID, {
        sessionId: session.id,
        seq: 4,
        method: 'custom',
        params: {},
        resolve,
        reject,
        timer: setTimeout(() => undefined, 60_000)
      })
      plaintext(wallet, { id: RPC_ID, seq: 4, result: { ok: true } })
      await (service as any).handleMobileMessage(session.id, {
        topic: session.id,
        ciphertext: 'AQID'
      })
      expect(resolve).toHaveBeenCalledWith(
        expect.objectContaining({ id: RPC_ID, result: { ok: true } })
      )
      expect(reject).not.toHaveBeenCalled()
      expect(disconnect).not.toHaveBeenCalled()
      expect((service as any).pending.has(RPC_ID)).toBe(false)
    } finally {
      service.stop()
    }
  })

  it('disconnects pairing attempts that cannot prove the claimed identity and permissions', async () => {
    const { service, wallet } = createService()
    try {
      const sessions = (service as any).sessions
      const session = sessions.createSession()
      const mobileIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
      const relay = (service as any).relay
      // No real socket: treat every call as coming from the topic's current mobile socket.
      jest.spyOn(relay, 'isCurrentMobile').mockReturnValue(true)
      const disconnect = jest.spyOn(relay, 'disconnectMobile')
      const envelope: WireEnvelope = {
        topic: session.id,
        mobileIdentityKey,
        ciphertext: 'AQID'
      }
      const approval = (params: unknown) => ({
        id: RPC_ID,
        seq: 1,
        method: 'pairing_approved',
        params
      })

      await (service as any).handlePairingApproved(session.id, {
        ...envelope,
        ciphertext: 'not-base64url!'
      })
      expect(disconnect).toHaveBeenCalledWith(session.id)

      disconnect.mockClear()
      jest.spyOn(wallet, 'decrypt').mockResolvedValueOnce({
        plaintext: Array.from(new TextEncoder().encode('not-json'))
      } as never)
      await (service as any).handlePairingApproved(session.id, envelope)
      expect(disconnect).toHaveBeenCalledWith(session.id)

      for (const params of [
        { mobileIdentityKey: PrivateKey.fromRandom().toPublicKey().toString() },
        { mobileIdentityKey, permissions: 'getPublicKey' },
        { mobileIdentityKey, permissions: ['getPublicKey', 'getPublicKey'] },
        { mobileIdentityKey, permissions: Array.from({ length: 101 }, () => 'method') }
      ]) {
        disconnect.mockClear()
        plaintext(wallet, approval(params))
        await (service as any).handlePairingApproved(session.id, envelope)
        expect(disconnect).toHaveBeenCalledWith(session.id)
      }
    } finally {
      service.stop()
    }
  })

  it('accepts the pairing mobile socket only after its pairing proof succeeds', async () => {
    const { service, wallet } = createService()
    try {
      const session = (service as any).sessions.createSession()
      const mobileIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
      const relay = (service as any).relay
      expect(relay.holdDesktopTraffic).toBe(true)
      jest.spyOn(relay, 'isCurrentMobile').mockReturnValue(true)
      const accept = jest.spyOn(relay, 'acceptMobile')
      const envelope: WireEnvelope = { topic: session.id, mobileIdentityKey, ciphertext: 'AQID' }

      relay.onMessage(session.id, envelope, 'mobile', 7)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(accept).not.toHaveBeenCalled()

      plaintext(wallet, {
        id: RPC_ID,
        seq: 1,
        method: 'pairing_approved',
        params: { mobileIdentityKey }
      })
      relay.onMessage(session.id, envelope, 'mobile', 8)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(accept).toHaveBeenCalledTimes(1)
      expect(accept).toHaveBeenCalledWith(session.id, 8)
      expect(service.getSession(session.id)?.status).toBe('connected')
    } finally {
      service.stop()
    }
  })

  it.each(['decrypt', 'failing decrypt', 'encrypt'] as const)(
    'ignores a pairing proof that finishes after its socket was replaced (delayed %s)',
    async delayed => {
      const onSessionConnected = jest.fn()
      const { service, wallet, server } = createService({ noServer: false, onSessionConnected })
      try {
        const port = await new Promise<number>(resolve =>
          server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
        )
        const session = (service as any).sessions.createSession()
        const relay = (service as any).relay
        const url = `ws://127.0.0.1:${port}/ws?topic=${session.id}&role=mobile`
        const mobileIdentityKey = PrivateKey.fromRandom().toPublicKey().toString()
        // The first socket's handler stalls in the delayed wallet call until the test releases it.
        let release!: () => void
        const gate = new Promise<void>(resolve => (release = resolve))
        let stalled = false
        const approval = {
          id: RPC_ID,
          seq: 1,
          method: 'pairing_approved',
          params: { mobileIdentityKey }
        }
        jest.spyOn(wallet, 'decrypt').mockImplementationOnce(async () => {
          if (delayed !== 'encrypt') {
            stalled = true
            await gate
          }
          if (delayed === 'failing decrypt') throw new Error('Decryption failed')
          return { plaintext: Array.from(new TextEncoder().encode(JSON.stringify(approval))) }
        })
        const encrypt = wallet.encrypt.bind(wallet)
        jest.spyOn(wallet, 'encrypt').mockImplementationOnce(async args => {
          if (delayed === 'encrypt') {
            stalled = true
            await gate
          }
          return encrypt(args)
        })

        const first = new WebSocket(url)
        await new Promise(resolve => first.once('open', resolve))
        first.send(JSON.stringify({ topic: session.id, mobileIdentityKey, ciphertext: 'AQID' }))
        await waitUntil(() => stalled)
        first.close()
        await waitUntil(() => relay.topics.get(session.id)?.mobile == null)

        const second = new WebSocket(url)
        const secondReceived: string[] = []
        second.on('message', data => secondReceived.push(`${data}`))
        await new Promise(resolve => second.once('open', resolve))
        await waitUntil(() => (service as any).mobileAuthTimers.has(session.id))
        const secondTimer = (service as any).mobileAuthTimers.get(session.id)

        release()
        await new Promise(resolve => setTimeout(resolve, 100))

        expect({
          authTimerKept: (service as any).mobileAuthTimers.get(session.id) === secondTimer,
          status: service.getSession(session.id)?.status,
          mobileIdentityKey: (service as any).sessions.getSession(session.id)?.mobileIdentityKey,
          sessionConnectedCalls: onSessionConnected.mock.calls.length,
          framesToSecond: secondReceived.length,
          secondOpen: second.readyState === WebSocket.OPEN
        }).toEqual({
          authTimerKept: true,
          status: 'disconnected',
          mobileIdentityKey: undefined,
          sessionConnectedCalls: 0,
          framesToSecond: 0,
          secondOpen: true
        })
        second.close()
      } finally {
        service.stop()
        server.closeAllConnections()
        server.close()
      }
    }
  )

  it('routes asynchronous malformed-mobile failures into immediate socket revocation', async () => {
    const { service } = createService()
    try {
      const relay = (service as any).relay
      const disconnect = jest.spyOn(relay, 'disconnectMobile')
      const session = (service as any).sessions.createSession()
      relay.onMessage(
        session.id,
        {
          topic: session.id,
          mobileIdentityKey: 'invalid',
          ciphertext: 'AQID'
        },
        'mobile'
      )
      await new Promise(resolve => setImmediate(resolve))
      expect(disconnect).toHaveBeenCalledWith(session.id)
    } finally {
      service.stop()
    }
  })

  it('releases request slots through both decrement and delete paths and stops idempotently', () => {
    const { service } = createService()
    ;(service as any).activeRequestCounts.set('session', 2)
    ;(service as any).releaseRequestSlot('session')
    expect((service as any).activeRequestCounts.get('session')).toBe(1)
    ;(service as any).releaseRequestSlot('session')
    expect((service as any).activeRequestCounts.has('session')).toBe(false)
    service.stop()
    expect(() => service.stop()).not.toThrow()
  })
})
