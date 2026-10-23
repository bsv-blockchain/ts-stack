import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WebSocket } from 'ws'
import { WalletPairingSession } from '../src/client/WalletPairingSession.js'
import { decryptEnvelope, encryptEnvelope } from '../src/shared/crypto.js'
import type { PairingParams, RpcRequest, RpcResponse } from '../src/types.js'

const TOPIC = 'A'.repeat(43)
const RPC_ID = '00000000-0000-4000-8000-000000000001'

interface FakeSocket {
  readyState: number
  send: jest.Mock
  close: jest.Mock
}

async function fixture(options: ConstructorParameters<typeof WalletPairingSession>[2] = {}) {
  const backend = new ProtoWallet(PrivateKey.fromRandom())
  const mobile = new ProtoWallet(PrivateKey.fromRandom())
  const backendIdentityKey = (await backend.getPublicKey({ identityKey: true })).publicKey
  const mobileIdentityKey = (await mobile.getPublicKey({ identityKey: true })).publicKey
  const params: PairingParams = {
    topic: TOPIC,
    backendIdentityKey,
    protocolID: JSON.stringify([0, 'mobile wallet session']),
    origin: 'http://localhost:3000',
    expiry: String(Math.floor(Date.now() / 1000) + 60)
  }
  const session = new WalletPairingSession(mobile, params, options)
  const socket: FakeSocket = {
    readyState: WebSocket.OPEN,
    send: jest.fn(),
    close: jest.fn()
  }
  ;(session as any).ws = socket

  const response = async (): Promise<RpcResponse> => {
    expect(socket.send).toHaveBeenCalledTimes(1)
    const envelope = JSON.parse(socket.send.mock.calls[0][0] as string) as { ciphertext: string }
    const plaintext = await decryptEnvelope(
      backend,
      {
        protocolID: [0, 'mobile wallet session'],
        keyID: TOPIC,
        counterparty: mobileIdentityKey
      },
      envelope.ciphertext
    )
    return JSON.parse(plaintext) as RpcResponse
  }

  return { backend, mobile, mobileIdentityKey, params, response, session, socket }
}

function request(method: string, params: unknown): RpcRequest {
  return { id: RPC_ID, seq: 1, method, params }
}

describe('WalletPairingSession hostile request boundaries', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('snapshots bounded method declarations and requires auto-approval to be a subset', async () => {
    const base = await fixture()
    expect(
      () =>
        new WalletPairingSession(base.mobile, base.params, {
          implementedMethods: new Set(Array.from({ length: 101 }, (_, i) => `method-${i}`)),
          autoApproveMethods: new Set()
        })
    ).toThrow('at most 100 methods')
    expect(
      () =>
        new WalletPairingSession(base.mobile, base.params, {
          implementedMethods: new Set(['safe']),
          autoApproveMethods: new Set(['not-implemented'])
        })
    ).toThrow('subset of implementedMethods')
    expect(
      () =>
        new WalletPairingSession(base.mobile, base.params, {
          implementedMethods: new Set(['']),
          autoApproveMethods: new Set()
        })
    ).toThrow('implementedMethods method')

    const methods = new Set(['safe'])
    const snapshotted = new WalletPairingSession(base.mobile, base.params, {
      implementedMethods: methods,
      autoApproveMethods: new Set(['safe'])
    })
    methods.add('added-after-construction')
    expect((snapshotted as any).implementedMethods.has('added-after-construction')).toBe(false)
  })

  it('rejects unsafe wallet metadata before any network or wallet work', async () => {
    const base = await fixture()
    const walletMeta: Record<string, unknown> = {}
    Object.defineProperty(walletMeta, 'name', {
      enumerable: true,
      get: () => {
        throw new Error('must not execute')
      }
    })

    expect(() => new WalletPairingSession(base.mobile, base.params, { walletMeta })).toThrow(
      /data propert|accessor/i
    )
  })

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects unsafe reconnect sequence %s before opening a socket',
    async lastSeq => {
      const { session } = await fixture()
      ;(session as any)._resolvedRelay = 'ws://localhost:3000'
      await expect(session.reconnect(lastSeq)).rejects.toThrow('non-negative safe integer')
    }
  )

  it('rejects an authenticated origin response that omits its relay URL', async () => {
    const { session } = await fixture()
    ;(session as any).pairingVerified = true
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ sessionId: TOPIC, status: 'pending' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    )

    await expect(session.resolveRelay()).rejects.toThrow('did not return a relay URL')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  describe('origin-bound pairing key', () => {
    const relay = 'ws://localhost:3000'
    const lookup = (body: Record<string, unknown>) =>
      jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ sessionId: TOPIC, status: 'pending', relay, ...body }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )

    it('rejects an origin response whose key does not match the pairing key', async () => {
      const { session } = await fixture()
      ;(session as any).pairingVerified = true
      lookup({ backendIdentityKey: PrivateKey.fromRandom().toPublicKey().toString() })

      await expect(session.resolveRelay()).rejects.toThrow('does not match the pairing key')
      expect((session as any)._resolvedRelay).toBeNull()
      await expect(session.connect()).rejects.toThrow('resolveRelay()')
    })

    it('accepts an origin response whose key matches the pairing key', async () => {
      const { params, session } = await fixture()
      ;(session as any).pairingVerified = true
      lookup({ backendIdentityKey: params.backendIdentityKey })

      await expect(session.resolveRelay()).resolves.toBe(relay)
    })

    it('compares the origin key case-insensitively', async () => {
      const { params, session } = await fixture()
      ;(session as any).pairingVerified = true
      lookup({ backendIdentityKey: params.backendIdentityKey.toUpperCase() })

      await expect(session.resolveRelay()).resolves.toBe(relay)
    })

    it('accepts an origin response without a key unless requireOriginBoundKey is set', async () => {
      const lenient = await fixture()
      ;(lenient.session as any).pairingVerified = true
      lookup({})
      await expect(lenient.session.resolveRelay()).resolves.toBe(relay)

      const strict = await fixture({ requireOriginBoundKey: true })
      ;(strict.session as any).pairingVerified = true
      lookup({})
      await expect(strict.session.resolveRelay()).rejects.toThrow(
        'did not report its backend identity key'
      )
      expect((strict.session as any)._resolvedRelay).toBeNull()

      lookup({ backendIdentityKey: strict.params.backendIdentityKey })
      await expect(strict.session.resolveRelay()).resolves.toBe(relay)
    })

    it('rejects a malformed origin key', async () => {
      const { params, session } = await fixture()
      ;(session as any).pairingVerified = true
      lookup({ backendIdentityKey: params.backendIdentityKey.slice(0, 64) })

      await expect(session.resolveRelay()).rejects.toThrow('backendIdentityKey')
    })
  })

  it('returns a generic 400 without dispatching malformed standard wallet arguments', async () => {
    const ctx = await fixture({
      implementedMethods: new Set(['getPublicKey']),
      autoApproveMethods: new Set(['getPublicKey'])
    })
    const handler = jest.fn().mockResolvedValue({ publicKey: 'unused' })
    ctx.session.onRequest(handler)

    await (ctx.session as any).handleRpc(
      request('getPublicKey', { identityKey: 'yes' }),
      ctx.socket
    )

    await expect(ctx.response()).resolves.toMatchObject({
      error: { code: 400, message: 'Invalid wallet request' }
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects unimplemented methods before approval or dispatch', async () => {
    const approval = jest.fn().mockResolvedValue(true)
    const handler = jest.fn().mockResolvedValue({ ok: true })
    const ctx = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set(),
      onApprovalRequired: approval
    })
    ctx.session.onRequest(handler)

    await (ctx.session as any).handleRpc(request('unknown', {}), ctx.socket)

    await expect(ctx.response()).resolves.toMatchObject({ error: { code: 501 } })
    expect(approval).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('closes the socket instead of accepting unbounded concurrent wallet work', async () => {
    const ctx = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set(['safe'])
    })
    ;(ctx.session as any).activeRequestCount = 32

    await (ctx.session as any).handleRpc(request('safe', {}), ctx.socket)

    expect(ctx.socket.close).toHaveBeenCalledWith(1013, 'Too many active wallet requests')
    expect(ctx.socket.send).not.toHaveBeenCalled()
  })

  it('fails closed when approval is absent or explicitly denied', async () => {
    const absent = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set()
    })
    absent.session.onRequest(jest.fn())
    await (absent.session as any).handleRpc(request('safe', {}), absent.socket)
    await expect(absent.response()).resolves.toMatchObject({
      error: { code: 4001, message: expect.stringContaining('no approval handler') }
    })

    const approval = jest.fn().mockResolvedValue(false)
    const denied = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set(),
      onApprovalRequired: approval
    })
    const handler = jest.fn()
    denied.session.onRequest(handler)
    await (denied.session as any).handleRpc(request('safe', {}), denied.socket)
    await expect(denied.response()).resolves.toMatchObject({
      error: { code: 4001, message: 'User rejected' }
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it('dispatches only after an approval handler returns exactly true', async () => {
    const approval = jest.fn().mockResolvedValue(true)
    const ctx = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set(),
      onApprovalRequired: approval
    })
    const handler = jest.fn().mockResolvedValue({ ok: true })
    ctx.session.onRequest(handler)

    await (ctx.session as any).handleRpc(request('safe', { action: 'inspect' }), ctx.socket)

    await expect(ctx.response()).resolves.toMatchObject({ result: { ok: true } })
    expect(approval).toHaveBeenCalledWith('safe', { action: 'inspect' })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('reports a missing request handler without leaving an active slot behind', async () => {
    const ctx = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set(['safe'])
    })

    await (ctx.session as any).handleRpc(request('safe', {}), ctx.socket)

    await expect(ctx.response()).resolves.toMatchObject({
      error: { code: 501, message: 'No request handler registered' }
    })
    expect((ctx.session as any).activeRequestCount).toBe(0)
  })

  it('validates standard wallet results and hostile custom results before returning them', async () => {
    const standard = await fixture({
      implementedMethods: new Set(['getPublicKey']),
      autoApproveMethods: new Set(['getPublicKey'])
    })
    standard.session.onRequest(async () => ({ publicKey: 'invalid' }))
    await (standard.session as any).handleRpc(
      request('getPublicKey', { identityKey: true }),
      standard.socket
    )
    await expect(standard.response()).resolves.toMatchObject({ error: { code: 500 } })

    const custom = await fixture({
      implementedMethods: new Set(['custom']),
      autoApproveMethods: new Set(['custom'])
    })
    const unsafeResult: Record<string, unknown> = {}
    unsafeResult.self = unsafeResult
    custom.session.onRequest(async () => unsafeResult)
    await (custom.session as any).handleRpc(request('custom', {}), custom.socket)
    await expect(custom.response()).resolves.toMatchObject({ error: { code: 500 } })
  })

  it('normalizes non-Error handler failures and suppresses responses on stale sockets', async () => {
    const failed = await fixture({
      implementedMethods: new Set(['custom']),
      autoApproveMethods: new Set(['custom'])
    })
    failed.session.onRequest(async () => {
      throw 'not-an-error'
    })
    await (failed.session as any).handleRpc(request('custom', {}), failed.socket)
    await expect(failed.response()).resolves.toMatchObject({
      error: { code: 500, message: 'Handler error' }
    })

    const stale = await fixture({
      implementedMethods: new Set(['custom']),
      autoApproveMethods: new Set(['custom'])
    })
    stale.session.onRequest(async () => ({ ok: true }))
    ;(stale.session as any).ws = null
    await (stale.session as any).handleRpc(request('custom', {}), stale.socket)
    expect(stale.socket.send).not.toHaveBeenCalled()
    expect((stale.session as any).activeRequestCount).toBe(0)
  })

  it('disconnect is idempotent and immediately invalidates the current socket epoch', async () => {
    const { session, socket } = await fixture()
    ;(session as any)._status = 'connecting'
    const epoch = (session as any).lifecycleEpoch

    session.disconnect()
    session.disconnect()

    expect(session.status).toBe('disconnected')
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect((session as any).lifecycleEpoch).toBe(epoch + 2)
  })

  it('keeps an idle session idle when disconnect is called before connection setup', async () => {
    const { session, socket } = await fixture()
    session.disconnect()
    expect(session.status).toBe('idle')
    expect(socket.close).toHaveBeenCalledTimes(1)
  })

  it('drops non-string, unauthenticated, replayed, and malformed inbound frames', async () => {
    const ctx = await fixture()
    const cryptoParams = {
      protocolID: [0, 'mobile wallet session'] as [0, string],
      keyID: TOPIC,
      counterparty: ctx.params.backendIdentityKey
    }
    const connected = jest.fn()
    ctx.session.on('connected', connected)
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    await (ctx.session as any).handleInboundMessage(
      { data: new Uint8Array([1]) },
      ctx.socket,
      cryptoParams,
      TOPIC
    )
    await (ctx.session as any).handleInboundMessage(
      { data: JSON.stringify({ topic: TOPIC, ciphertext: 'AQID' }) },
      ctx.socket,
      cryptoParams,
      TOPIC
    )
    ;(ctx.session as any)._lastSeq = 1

    const replay = await encryptEnvelope(
      ctx.backend,
      {
        protocolID: [0, 'mobile wallet session'],
        keyID: TOPIC,
        counterparty: ctx.mobileIdentityKey
      },
      JSON.stringify({ id: RPC_ID, seq: 1, method: 'pairing_ack', params: {} })
    )
    await (ctx.session as any).handleInboundMessage(
      { data: JSON.stringify({ topic: TOPIC, ciphertext: replay }) },
      ctx.socket,
      cryptoParams,
      TOPIC
    )
    expect(warning).toHaveBeenCalledWith(
      '[WalletPairingSession] dropping message: seq',
      1,
      '<= lastSeq',
      1
    )

    const acknowledged = await encryptEnvelope(
      ctx.backend,
      {
        protocolID: [0, 'mobile wallet session'],
        keyID: TOPIC,
        counterparty: ctx.mobileIdentityKey
      },
      JSON.stringify({ id: RPC_ID, seq: 2, method: 'pairing_ack', params: {} })
    )
    await (ctx.session as any).handleInboundMessage(
      { data: JSON.stringify({ topic: TOPIC, ciphertext: acknowledged }) },
      ctx.socket,
      cryptoParams,
      TOPIC
    )
    expect(connected).toHaveBeenCalledTimes(1)
    expect(ctx.session.status).toBe('connected')
  })

  it('contains asynchronous RPC response failures raised from inbound dispatch', async () => {
    const ctx = await fixture({
      implementedMethods: new Set(['safe']),
      autoApproveMethods: new Set(['safe'])
    })
    const cryptoParams = {
      protocolID: [0, 'mobile wallet session'] as [0, string],
      keyID: TOPIC,
      counterparty: ctx.params.backendIdentityKey
    }
    const error = jest.fn()
    ctx.session.on('error', error)
    const inbound = await encryptEnvelope(
      ctx.backend,
      {
        protocolID: [0, 'mobile wallet session'],
        keyID: TOPIC,
        counterparty: ctx.mobileIdentityKey
      },
      JSON.stringify({ id: RPC_ID, seq: 1, method: 'unknown', params: {} })
    )
    jest.spyOn(ctx.mobile, 'encrypt').mockRejectedValueOnce('encryption failed')

    await (ctx.session as any).handleInboundMessage(
      { data: JSON.stringify({ topic: TOPIC, ciphertext: inbound }) },
      ctx.socket,
      cryptoParams,
      TOPIC
    )
    await new Promise(resolve => setImmediate(resolve))
    expect(error).toHaveBeenCalledWith('Failed to handle wallet request')
  })

  it('ignores stale socket callbacks before and after asynchronous handshake encryption', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sockets: FakeBrowserSocket[] = []
    class FakeBrowserSocket {
      static readonly OPEN = 1
      readonly readyState = FakeBrowserSocket.OPEN
      readonly send = jest.fn()
      readonly close = jest.fn()
      onopen: (() => Promise<void>) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null

      constructor(readonly url: string) {
        sockets.push(this)
      }
    }
    ;(globalThis as any).WebSocket = FakeBrowserSocket
    try {
      const stale = await fixture()
      ;(stale.session as any)._resolvedRelay = 'ws://localhost:3000'
      await stale.session.connect()
      const staleSocket = sockets[sockets.length - 1]!
      stale.session.disconnect()
      await staleSocket.onopen?.()
      staleSocket.onmessage?.({ data: '{}' } as MessageEvent)
      staleSocket.onerror?.()
      staleSocket.onclose?.()
      expect(staleSocket.send).not.toHaveBeenCalled()

      const delayed = await fixture()
      ;(delayed.session as any)._resolvedRelay = 'ws://localhost:3000'
      const originalEncrypt = delayed.mobile.encrypt.bind(delayed.mobile)
      let release!: () => void
      const wait = new Promise<void>(resolve => {
        release = resolve
      })
      jest.spyOn(delayed.mobile, 'encrypt').mockImplementationOnce(async args => {
        await wait
        return originalEncrypt(args)
      })
      await delayed.session.connect()
      const delayedSocket = sockets[sockets.length - 1]!
      const opening = delayedSocket.onopen!()
      delayed.session.disconnect()
      release()
      await opening
      expect(delayedSocket.send).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as any).WebSocket = originalWebSocket
    }
  })

  it('surfaces current socket handshake and transport failures without exposing thrown values', async () => {
    const originalWebSocket = globalThis.WebSocket
    const sockets: FakeBrowserSocket[] = []
    class FakeBrowserSocket {
      static readonly OPEN = 1
      readonly readyState = FakeBrowserSocket.OPEN
      readonly send = jest.fn()
      readonly close = jest.fn()
      onopen: (() => Promise<void>) | null = null
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onclose: (() => void) | null = null

      constructor() {
        sockets.push(this)
      }
    }
    ;(globalThis as any).WebSocket = FakeBrowserSocket
    try {
      const ctx = await fixture()
      ;(ctx.session as any)._resolvedRelay = 'ws://localhost:3000'
      const error = jest.fn()
      ctx.session.on('error', error)
      jest.spyOn(ctx.mobile, 'encrypt').mockRejectedValueOnce('private failure')
      await ctx.session.connect()
      const socket = sockets[sockets.length - 1]!

      await socket.onopen?.()
      expect(error).toHaveBeenCalledWith('Failed to send pairing message')
      socket.onerror?.()
      expect(error).toHaveBeenCalledWith('WebSocket connection failed')
    } finally {
      ;(globalThis as any).WebSocket = originalWebSocket
    }
  })
})
