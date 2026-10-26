/**
 * E2E tests for WalletRelayService.
 *
 * Spins up a real HTTP + WebSocket server, pairs a WalletPairingSession as the
 * mobile side, and exercises the full request/response cycle through both the
 * service API and the HTTP routes.
 */

import http from 'node:http'
import express from 'express'
import { WebSocket } from 'ws'
import { ProtoWallet, PrivateKey, Transaction } from '@bsv/sdk'
import { WalletRelayService } from '../src/server/WalletRelayService.js'
import { WalletPairingSession } from '../src/client/WalletPairingSession.js'
import { parsePairingUri, verifyPairingSignature } from '../src/shared/pairingUri.js'

// WalletPairingSession uses `new WebSocket(...)` via the browser global.
// Polyfill it here so the mobile client works inside Node.js tests.
;(globalThis as unknown as Record<string, unknown>).WebSocket = WebSocket

const VALID_ATOMIC_BEEF = new Transaction().toAtomicBEEF()

// ── Test helpers ──────────────────────────────────────────────────────────────

function makeServer() {
  const app = express()
  app.use(express.json())
  const server = http.createServer(app)
  return { app, server }
}

function startListening(server: http.Server): Promise<number> {
  return new Promise(resolve =>
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  )
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
}

/**
 * Connect a WalletPairingSession as the mobile side and wait until pairing
 * completes (session reaches 'connected'). Rejects after 5 s on timeout.
 */
async function pairMobile(
  pairingUri: string,
  mobileWallet: ProtoWallet,
  onRequest?: (method: string, params: unknown) => Promise<unknown>
): Promise<WalletPairingSession> {
  const { params, error } = parsePairingUri(pairingUri)
  if (!params) throw new Error(error!)

  const session = new WalletPairingSession(mobileWallet, params, {
    implementedMethods: new Set(['getPublicKey', 'createAction']),
    autoApproveMethods: new Set(['getPublicKey', 'createAction'])
  })

  if (onRequest) session.onRequest(onRequest)

  await session.resolveRelay()

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pairMobile timed out')), 5000)
    session
      .on('connected', () => {
        clearTimeout(t)
        resolve()
      })
      .on('error', msg => {
        clearTimeout(t)
        reject(new Error(msg))
      })
    void session.connect()
  })

  return session
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('WalletRelayService E2E', () => {
  let httpServer: http.Server
  let service: WalletRelayService
  let baseUrl: string
  let backendWallet: ProtoWallet

  beforeEach(async () => {
    const { app, server } = makeServer()
    httpServer = server
    const port = await startListening(server)
    baseUrl = `http://localhost:${port}`

    backendWallet = new ProtoWallet(PrivateKey.fromRandom())
    service = new WalletRelayService({
      app,
      server,
      wallet: backendWallet,
      relayUrl: `ws://localhost:${port}`,
      origin: `http://localhost:${port}`
    })
  }, 10_000)

  afterEach(async () => {
    service.stop()
    await stopServer(httpServer)
  }, 10_000)

  // ── Session management ──────────────────────────────────────────────────────

  describe('session management', () => {
    it('createSession() returns the expected shape', async () => {
      const s = await service.createSession()
      expect(s.sessionId).toBeTruthy()
      expect(s.status).toBe('pending')
      expect(s.qrDataUrl).toMatch(/^data:image\/png;base64,/)
      expect(s.pairingUri).toMatch(/^bsv-browser:\/\/pair\?/)
      expect(s.desktopToken).toBeTruthy()
    })

    it('GET /api/session returns a pending session', async () => {
      const res = await fetch(`${baseUrl}/api/session`)
      expect(res.ok).toBe(true)
      expect(res.headers.get('cache-control')).toContain('no-store')
      const body = (await res.json()) as { sessionId: string; status: string }
      expect(body.sessionId).toBeTruthy()
      expect(body.status).toBe('pending')
    })

    it('GET /api/session/:id returns the session status and relay URL', async () => {
      const created = await service.createSession()
      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`)
      expect(res.ok).toBe(true)
      const body = (await res.json()) as { sessionId: string; status: string; relay: string }
      expect(body.sessionId).toBe(created.sessionId)
      expect(body.status).toBe('pending')
      expect(body.relay).toMatch(/^ws:\/\//)
    })

    it('GET /api/session/:id returns 404 for an unknown id', async () => {
      const res = await fetch(`${baseUrl}/api/session/does-not-exist`)
      expect(res.status).toBe(404)
    })

    it('GET /api/session returns 429 when maxSessions is reached', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const capped = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        maxSessions: 1
      })
      try {
        // First session fills the cap
        await capped.createSession()
        // Second should be rejected
        const res = await fetch(`http://localhost:${port}/api/session`)
        expect(res.status).toBe(429)
      } finally {
        capped.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('GET /api/session bounds public session-creation work per minute', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const capped = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        maxSessions: 2,
        maxSessionCreationsPerMinute: 1
      })
      try {
        await capped.createSession()
        const res = await fetch(`http://localhost:${port}/api/session`)
        expect(res.status).toBe(429)
        expect(res.headers.get('cache-control')).toContain('no-store')
      } finally {
        capped.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('releases a session slot when wallet-controlled session setup fails validation', async () => {
      const { server } = makeServer()
      const port = await startListening(server)
      const wallet = new ProtoWallet(PrivateKey.fromRandom())
      jest.spyOn(wallet, 'getPublicKey').mockResolvedValueOnce({ publicKey: 'invalid' } as never)
      const capped = new WalletRelayService({
        server,
        wallet,
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        maxSessions: 1
      })
      try {
        await expect(capped.createSession()).rejects.toThrow(/publicKey/)
        await expect(capped.createSession()).resolves.toMatchObject({ status: 'pending' })
      } finally {
        capped.stop()
        await stopServer(server)
      }
    }, 10_000)
  })

  // ── resolveRelay ────────────────────────────────────────────────────────────

  describe('resolveRelay', () => {
    it('returns the relay URL from the origin server', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const session = new WalletPairingSession(new ProtoWallet(PrivateKey.fromRandom()), params!)
      const relay = await session.resolveRelay()
      expect(relay).toMatch(/^ws:\/\//)
    }, 10_000)

    it('connect() throws if resolveRelay() was not called first', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const session = new WalletPairingSession(new ProtoWallet(PrivateKey.fromRandom()), params!)
      await expect(session.connect()).rejects.toThrow('resolveRelay()')
    })

    it('reconnect() throws if resolveRelay() was not called first', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const session = new WalletPairingSession(new ProtoWallet(PrivateKey.fromRandom()), params!)
      await expect(session.reconnect(0)).rejects.toThrow('resolveRelay()')
    })

    it('resolveRelay() throws when the origin returns 404', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response('{}', { status: 404 }))
      const session = new WalletPairingSession(new ProtoWallet(PrivateKey.fromRandom()), params!)
      try {
        await expect(session.resolveRelay()).rejects.toThrow(/HTTP 404/)
      } finally {
        fetchMock.mockRestore()
      }
    }, 10_000)

    it('resolveRelay() rejects an unsigned pairing before fetching its origin', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const fetchMock = jest.spyOn(globalThis, 'fetch')
      const session = new WalletPairingSession(new ProtoWallet(PrivateKey.fromRandom()), {
        ...params!,
        sig: undefined
      })

      await expect(session.resolveRelay()).rejects.toThrow(/signature is missing or invalid/)
      expect(fetchMock).not.toHaveBeenCalled()
      fetchMock.mockRestore()
    })
  })

  // ── Pairing ─────────────────────────────────────────────────────────────────

  describe('pairing', () => {
    it('session becomes connected after mobile pairs', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      expect(service.getSession(created.sessionId)?.status).toBe('connected')
      mobile.disconnect()
    }, 10_000)

    it('requires a reconnecting mobile to re-prove key possession before keeping the slot', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        mobileAuthTimeoutMs: 250
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(
          created.pairingUri,
          new ProtoWallet(PrivateKey.fromRandom())
        )
        mobile.disconnect()
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(svc.getSession(created.sessionId)?.status).toBe('disconnected')

        const squatter = new WebSocket(
          `ws://localhost:${port}/ws?topic=${created.sessionId}&role=mobile`
        )
        const closed = new Promise<{ code: number; reason: string }>(resolve => {
          squatter.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
        })
        await new Promise<void>((resolve, reject) => {
          squatter.once('open', () => resolve())
          squatter.once('error', reject)
        })
        await expect(closed).resolves.toEqual({
          code: 1008,
          reason: 'Authentication failed'
        })
        expect(svc.getSession(created.sessionId)?.status).toBe('disconnected')
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('does not open a socket after an in-flight connection attempt is cancelled', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const wallet = new ProtoWallet(PrivateKey.fromRandom())
      const publicKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
      let release!: () => void
      const waiting = new Promise<void>(resolve => {
        release = resolve
      })
      jest.spyOn(wallet, 'getPublicKey').mockImplementationOnce(async () => {
        await waiting
        return { publicKey }
      })
      const mobile = new WalletPairingSession(wallet, params!)
      await mobile.resolveRelay()

      const connecting = mobile.connect()
      mobile.disconnect()
      release()

      await expect(connecting).rejects.toThrow(/cancelled/)
      await new Promise(resolve => setTimeout(resolve, 25))
      expect(service.getSession(created.sessionId)?.status).toBe('pending')
      expect(mobile.status).toBe('disconnected')
    }, 10_000)

    it('onSessionConnected fires with the correct session id', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const connectedIds: string[] = []

      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        onSessionConnected: id => connectedIds.push(id)
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(
          created.pairingUri,
          new ProtoWallet(PrivateKey.fromRandom())
        )
        expect(connectedIds).toContain(created.sessionId)
        mobile.disconnect()
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('onSessionDisconnected still fires when socket diagnostics fail', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const disconnectedIds: string[] = []

      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        onSessionDisconnected: id => disconnectedIds.push(id),
        onSocketClosed: () => {
          throw new Error('diagnostic unavailable')
        }
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(
          created.pairingUri,
          new ProtoWallet(PrivateKey.fromRandom())
        )
        mobile.disconnect()
        // Allow the WS close event to propagate through the server
        await new Promise(r => setTimeout(r, 100))
        expect(disconnectedIds).toContain(created.sessionId)
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)
  })

  // ── RPC round-trip ───────────────────────────────────────────────────────────

  describe('RPC round-trip', () => {
    it('rejects privileged methods when no approval handler is configured', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const onRequest = jest.fn().mockResolvedValue({ txid: 'unauthorized' })
      const mobile = new WalletPairingSession(mobileWallet, params!, {
        implementedMethods: new Set(['createAction']),
        autoApproveMethods: new Set()
      }).onRequest(onRequest)

      await mobile.resolveRelay()
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('pairing timed out')), 5000)
        mobile
          .on('connected', () => {
            clearTimeout(timeout)
            resolve()
          })
          .on('error', message => {
            clearTimeout(timeout)
            reject(new Error(message))
          })
        void mobile.connect()
      })

      const rpc = await service.sendRequest(
        created.sessionId,
        'createAction',
        { description: 'unauthorized action' },
        created.desktopToken
      )
      expect(rpc.error).toEqual({
        code: 4001,
        message: 'Approval required but no approval handler is configured'
      })
      expect(onRequest).not.toHaveBeenCalled()
      mobile.disconnect()
    }, 10_000)

    it('getPublicKey returns the mobile wallet public key (service API)', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const { publicKey: expectedKey } = await mobileWallet.getPublicKey({ identityKey: true })

      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, mobileWallet, (_method, params) =>
        mobileWallet.getPublicKey(params as { identityKey: true })
      )

      const rpc = await service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true },
        created.desktopToken
      )

      expect(rpc.result).toMatchObject({ publicKey: expectedKey })
      mobile.disconnect()
    }, 10_000)

    it('getPublicKey returns the mobile wallet public key (HTTP route)', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()

      const mobile = await pairMobile(created.pairingUri, mobileWallet, (_method, params) =>
        mobileWallet.getPublicKey(params as { identityKey: true })
      )

      const res = await fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': created.desktopToken
        },
        body: JSON.stringify({ method: 'getPublicKey', params: { identityKey: true } })
      })

      expect(res.ok).toBe(true)
      const body = (await res.json()) as { result?: { publicKey: string } }
      expect(body.result?.publicKey).toBeTruthy()
      mobile.disconnect()
    }, 10_000)

    it('handler error is returned as an RPC error object (not a thrown exception)', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()

      const mobile = await pairMobile(created.pairingUri, mobileWallet, () =>
        Promise.reject(new Error('wallet unavailable'))
      )

      const rpc = await service.sendRequest(
        created.sessionId,
        'createAction',
        { description: 'test wallet failure' },
        created.desktopToken
      )

      expect(rpc.error?.message).toBe('wallet unavailable')
      mobile.disconnect()
    }, 10_000)

    it('preserves BRC-100 byte fields across the encrypted relay in both directions', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()
      let receivedParams: unknown
      const mobile = await pairMobile(created.pairingUri, mobileWallet, (_method, params) => {
        receivedParams = params
        return Promise.resolve({
          signableTransaction: { tx: new Uint8Array(VALID_ATOMIC_BEEF), reference: 'cmVm' }
        })
      })

      const rpc = await service.sendRequest(
        created.sessionId,
        'createAction',
        {
          description: 'test action',
          inputBEEF: new Uint8Array(VALID_ATOMIC_BEEF),
          options: { signAndProcess: false }
        },
        created.desktopToken
      )

      expect(receivedParams).toMatchObject({ inputBEEF: VALID_ATOMIC_BEEF })
      expect(rpc.result).toEqual({
        signableTransaction: { tx: VALID_ATOMIC_BEEF, reference: 'cmVm' }
      })
      mobile.disconnect()
    }, 10_000)

    it('serializes concurrent encryption so replay-protected request sequences stay ordered', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const mobilePublicKey = (await mobileWallet.getPublicKey({ identityKey: true })).publicKey
      const created = await service.createSession()
      const received: number[] = []
      const mobile = await pairMobile(created.pairingUri, mobileWallet, (_method, params) => {
        received.push((params as { keyID: string }).keyID === 'first' ? 1 : 2)
        return Promise.resolve({ publicKey: mobilePublicKey })
      })

      const originalEncrypt = backendWallet.encrypt.bind(backendWallet)
      let encryption = 0
      jest.spyOn(backendWallet, 'encrypt').mockImplementation(async args => {
        encryption += 1
        if (encryption === 1) await new Promise(resolve => setTimeout(resolve, 50))
        return originalEncrypt(args)
      })

      const first = service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true, keyID: 'first' },
        created.desktopToken
      )
      const second = service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true, keyID: 'second' },
        created.desktopToken
      )

      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(received).toEqual([1, 2])
      mobile.disconnect()
    }, 10_000)

    it('serializes mobile decryption so asynchronous completion cannot discard an earlier request', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const mobilePublicKey = (await mobileWallet.getPublicKey({ identityKey: true })).publicKey
      const originalDecrypt = mobileWallet.decrypt.bind(mobileWallet)
      let decryption = 0
      jest.spyOn(mobileWallet, 'decrypt').mockImplementation(async args => {
        decryption += 1
        if (decryption === 2) await new Promise(resolve => setTimeout(resolve, 50))
        return originalDecrypt(args)
      })

      const created = await service.createSession()
      const received: string[] = []
      const mobile = await pairMobile(created.pairingUri, mobileWallet, (_method, params) => {
        received.push((params as { keyID: string }).keyID)
        return Promise.resolve({ publicKey: mobilePublicKey })
      })

      const first = service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true, keyID: 'first' },
        created.desktopToken
      )
      const second = service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true, keyID: 'second' },
        created.desktopToken
      )

      await expect(Promise.all([first, second])).resolves.toHaveLength(2)
      expect(received).toEqual(['first', 'second'])
      mobile.disconnect()
    }, 10_000)
  })

  // ── QR signing ───────────────────────────────────────────────────────────────

  describe('QR signing', () => {
    it('createSession() embeds a sig in the pairing URI by default', async () => {
      const s = await service.createSession()
      const url = new URL(s.pairingUri)
      expect(url.searchParams.get('sig')).toBeTruthy()
    })

    it('embedded sig verifies against backendIdentityKey', async () => {
      const s = await service.createSession()
      const { params, error } = parsePairingUri(s.pairingUri)
      expect(error).toBeNull()
      expect(await verifyPairingSignature(params!)).toBe(true)
    })

    it('signQrCodes: false produces an unsigned URI that secure clients reject', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const unsigned = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        signQrCodes: false
      })
      try {
        const s = await unsigned.createSession()
        const url = new URL(s.pairingUri)
        expect(url.searchParams.get('sig')).toBeNull()
        const { params } = parsePairingUri(s.pairingUri)
        expect(await verifyPairingSignature(params!)).toBe(false)
      } finally {
        unsigned.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('expiry in URI matches the value covered by the signature', async () => {
      // Guards against a race where expiry is re-computed after signing
      const s = await service.createSession()
      const { params } = parsePairingUri(s.pairingUri)
      expect(await verifyPairingSignature(params!)).toBe(true)
    })

    it('tampered origin fails signature verification', async () => {
      const s = await service.createSession()
      const { params } = parsePairingUri(s.pairingUri)
      const tampered = { ...params!, origin: 'https://evil.example.com' }
      expect(await verifyPairingSignature(tampered)).toBe(false)
    })

    it('tampered backendIdentityKey fails signature verification', async () => {
      const s = await service.createSession()
      const { params } = parsePairingUri(s.pairingUri)
      const fakeKey = PrivateKey.fromRandom().toPublicKey().toString()
      const tampered = { ...params!, backendIdentityKey: fakeKey }
      expect(await verifyPairingSignature(tampered)).toBe(false)
    })

    it('tampered topic fails signature verification', async () => {
      const s = await service.createSession()
      const { params } = parsePairingUri(s.pairingUri)
      const tampered = { ...params!, topic: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }
      expect(await verifyPairingSignature(tampered)).toBe(false)
    })
  })

  // ── Session termination ──────────────────────────────────────────────────────

  describe('session termination', () => {
    it('deleteSession() marks the session expired', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      service.deleteSession(created.sessionId, created.desktopToken)

      expect(service.getSession(created.sessionId)?.status).toBe('expired')
      mobile.disconnect()
    }, 10_000)

    it('deleteSession() rejects in-flight requests immediately', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()

      const mobile = await pairMobile(
        created.pairingUri,
        mobileWallet,
        () =>
          new Promise(() => {
            /* intentionally never resolves */
          })
      )

      const requestPromise = service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true },
        created.desktopToken
      )

      // Give the request one tick to register as pending on the server
      await new Promise(r => setTimeout(r, 50))

      service.deleteSession(created.sessionId, created.desktopToken)

      await expect(requestPromise).rejects.toThrow()
      mobile.disconnect()
    }, 10_000)

    it('stop() cancels an in-flight encryption and revokes its socket authority', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, mobileWallet)
      const originalEncrypt = backendWallet.encrypt.bind(backendWallet)
      let release!: () => void
      const waiting = new Promise<void>(resolve => {
        release = resolve
      })
      jest.spyOn(backendWallet, 'encrypt').mockImplementationOnce(async args => {
        await waiting
        return originalEncrypt(args)
      })

      const request = service.sendRequest(
        created.sessionId,
        'getPublicKey',
        { identityKey: true },
        created.desktopToken
      )
      await Promise.resolve()
      service.stop()

      await expect(request).rejects.toThrow('Server shutting down')
      release()
      await new Promise(resolve => setImmediate(resolve))
      mobile.disconnect()
    }, 10_000)

    it('deleteSession() throws for an unknown session', () => {
      expect(() => service.deleteSession('no-such-id', 'token')).toThrow('Session not found')
    })

    it('deleteSession() throws for an invalid desktop token', async () => {
      const created = await service.createSession()
      expect(() => service.deleteSession(created.sessionId, 'wrong-token')).toThrow(
        'Invalid desktop token'
      )
    })

    it('DELETE /api/session/:id returns 204 and marks session expired', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`, {
        method: 'DELETE',
        headers: { 'X-Desktop-Token': created.desktopToken }
      })

      expect(res.status).toBe(204)
      expect(service.getSession(created.sessionId)?.status).toBe('expired')
      mobile.disconnect()
    }, 10_000)

    it('DELETE /api/session/:id returns 401 with wrong token', async () => {
      const created = await service.createSession()

      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`, {
        method: 'DELETE',
        headers: { 'X-Desktop-Token': 'wrong-token' }
      })

      expect(res.status).toBe(401)
    }, 10_000)

    it('DELETE /api/session/:id returns 401 with missing token', async () => {
      const created = await service.createSession()

      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`, {
        method: 'DELETE'
      })

      expect(res.status).toBe(401)
    }, 10_000)

    it('DELETE /api/session/:id returns 404 for unknown session', async () => {
      const res = await fetch(`${baseUrl}/api/session/does-not-exist`, {
        method: 'DELETE',
        headers: { 'X-Desktop-Token': 'any-token' }
      })

      expect(res.status).toBe(404)
    }, 10_000)

    it('onSessionDisconnected does not fire after deleteSession', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const disconnectedIds: string[] = []

      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        onSessionDisconnected: id => disconnectedIds.push(id)
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(
          created.pairingUri,
          new ProtoWallet(PrivateKey.fromRandom())
        )

        svc.deleteSession(created.sessionId, created.desktopToken)

        // Allow the WS close event to propagate through the server
        await new Promise(r => setTimeout(r, 100))

        expect(disconnectedIds).not.toContain(created.sessionId)
        mobile.disconnect()
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('POST /api/request on a deleted session returns 400', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      service.deleteSession(created.sessionId, created.desktopToken)

      const res = await fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': created.desktopToken
        },
        body: JSON.stringify({ method: 'getPublicKey', params: {} })
      })

      expect(res.status).toBe(400)
      mobile.disconnect()
    }, 10_000)
  })

  // ── Error cases ──────────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('POST /api/request with wrong X-Desktop-Token returns 401', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      const res = await fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': 'bad-token' },
        body: JSON.stringify({ method: 'getPublicKey', params: {} })
      })

      expect(res.status).toBe(401)
      mobile.disconnect()
    }, 10_000)

    it('POST /api/request on a pending (unpaired) session returns 400', async () => {
      const created = await service.createSession()

      const res = await fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': created.desktopToken
        },
        body: JSON.stringify({ method: 'getPublicKey', params: {} })
      })

      expect(res.status).toBe(400)
    }, 10_000)

    it('service.sendRequest throws when token is wrong', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      await expect(
        service.sendRequest(created.sessionId, 'getPublicKey', {}, 'wrong-token')
      ).rejects.toThrow('Invalid desktop token')

      mobile.disconnect()
    }, 10_000)

    it('mobile disconnect rejects an in-flight request with 504', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()

      // Mobile pairs but its handler never resolves, simulating a stalled wallet
      const mobile = await pairMobile(
        created.pairingUri,
        mobileWallet,
        () =>
          new Promise(() => {
            /* intentionally never resolves */
          })
      )

      // Start the request (in-flight on the server)
      const requestPromise = fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': created.desktopToken
        },
        body: JSON.stringify({
          method: 'createAction',
          params: { description: 'test disconnected wallet' }
        })
      })

      // Give the request one tick to register as pending on the server
      await new Promise(r => setTimeout(r, 50))

      // Disconnect the mobile — should immediately reject the pending promise
      mobile.disconnect()

      const res = await requestPromise
      expect(res.status).toBe(504)
      const body = (await res.json()) as { error: string }
      expect(body.error.toLowerCase()).toMatch(/disconnect/)
    }, 10_000)
  })

  // ── Per-session origin & allowedOrigins ─────────────────────────────────────
  //
  // These cover the multi-app deployment shape: one relay shared by N webapps,
  // each passing its own origin per call. The legacy single-`origin` path stays
  // covered by the rest of the suite — every other test in this file is set up
  // with `origin: ${baseUrl}` and no `allowedOrigins`, so back-compat is the
  // implicit baseline.

  describe('per-session origin', () => {
    it('embeds the constructor origin in the QR by default (legacy behavior)', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      expect(params?.origin).toBe(baseUrl)
    })

    it('embeds the per-call origin in the QR when passed', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: /^https:\/\/[a-z0-9-]+\.example\.com$/
      })
      try {
        const created = await svc.createSession({ origin: 'https://app.example.com' })
        const { params } = parsePairingUri(created.pairingUri)
        expect(params?.origin).toBe('https://app.example.com')
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('rejects per-call origin when not in allowedOrigins', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: ['https://app.example.com']
      })
      try {
        await expect(svc.createSession({ origin: 'https://evil.com' })).rejects.toThrow(
          /not in the allowedOrigins list/
        )
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('forwards the request Origin header via GET /api/session', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: /^https:\/\/[a-z0-9-]+\.example\.com$/
      })
      try {
        const res = await fetch(`http://localhost:${port}/api/session`, {
          headers: { Origin: 'https://app.example.com' }
        })
        expect(res.ok).toBe(true)
        const body = (await res.json()) as { pairingUri: string }
        const { params } = parsePairingUri(body.pairingUri)
        expect(params?.origin).toBe('https://app.example.com')
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('returns 403 from GET /api/session when Origin header is not in allowlist', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: ['https://app.example.com']
      })
      try {
        const res = await fetch(`http://localhost:${port}/api/session`, {
          headers: { Origin: 'https://evil.com' }
        })
        expect(res.status).toBe(403)
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('falls back to constructor origin when GET /api/session has no Origin header', async () => {
      // Same-origin / curl / mobile native fetch — no Origin header. Should use
      // the constructor default rather than rejecting.
      const res = await fetch(`${baseUrl}/api/session`)
      expect(res.ok).toBe(true)
      const body = (await res.json()) as { pairingUri: string }
      const { params } = parsePairingUri(body.pairingUri)
      expect(params?.origin).toBe(baseUrl)
    })

    it('signs the QR over the per-session origin (signature verifies)', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: /^https:\/\/[a-z0-9-]+\.example\.com$/
      })
      try {
        const created = await svc.createSession({ origin: 'https://app.example.com' })
        const { params } = parsePairingUri(created.pairingUri)
        // verifyPairingSignature reconstructs the signed string from params.origin —
        // if origin was wrong, signature verification would fail.
        expect(await verifyPairingSignature(params!)).toBe(true)
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)
  })

  // ── Upgrade routing passthrough ──────────────────────────────────────────────

  describe('upgrade routing passthrough', () => {
    it('noServer mode: no upgrade listener until dispatched via service.handleUpgrade', async () => {
      const { app, server } = makeServer()
      const before = server.listenerCount('upgrade')
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app,
        server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        noServer: true
      })
      // Service attached no upgrade listener of its own.
      expect(server.listenerCount('upgrade')).toBe(before)
      server.on('upgrade', (req, socket, head) => {
        const { pathname } = new URL(req.url ?? '', 'http://localhost')
        if (pathname === '/ws') svc.handleUpgrade(req, socket, head)
      })
      try {
        const opened = await new Promise<boolean>(resolve => {
          const ws = new WebSocket(`ws://localhost:${port}/ws?topic=t&role=mobile`)
          const timer = setTimeout(() => {
            ws.terminate()
            resolve(false)
          }, 1500)
          ws.on('open', () => {
            clearTimeout(timer)
            ws.close()
            resolve(true)
          })
          ws.on('error', () => {
            clearTimeout(timer)
            resolve(false)
          })
        })
        expect(opened).toBe(true)
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)
  })
})
