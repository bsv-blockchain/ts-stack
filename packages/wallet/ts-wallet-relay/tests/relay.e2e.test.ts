/**
 * E2E tests for WalletRelayService.
 *
 * Spins up a real HTTP + WebSocket server, pairs a WalletPairingSession as the
 * mobile side, and exercises the full request/response cycle through both the
 * service API and the HTTP routes.
 */

import http from 'http'
import express from 'express'
import { WebSocket } from 'ws'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { WalletRelayService } from '../src/server/WalletRelayService.js'
import { WalletPairingSession } from '../src/client/WalletPairingSession.js'
import { parsePairingUri, verifyPairingSignature } from '../src/shared/pairingUri.js'

// WalletPairingSession uses `new WebSocket(...)` via the browser global.
// Polyfill it here so the mobile client works inside Node.js tests.
;(globalThis as unknown as Record<string, unknown>).WebSocket = WebSocket

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
  onRequest?: (method: string, params: unknown) => Promise<unknown>,
): Promise<WalletPairingSession> {
  const { params, error } = parsePairingUri(pairingUri)
  if (!params) throw new Error(error!)

  const session = new WalletPairingSession(mobileWallet, params, {
    implementedMethods: new Set(['getPublicKey', 'createAction']),
    autoApproveMethods: new Set(['getPublicKey', 'createAction']),
  })

  if (onRequest) session.onRequest(onRequest)

  await session.resolveRelay()

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('pairMobile timed out')), 5000)
    session
      .on('connected', () => { clearTimeout(t); resolve() })
      .on('error',     msg => { clearTimeout(t); reject(new Error(msg)) })
    void session.connect()
  })

  return session
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('WalletRelayService E2E', () => {
  let httpServer: http.Server
  let service: WalletRelayService
  let baseUrl: string

  beforeEach(async () => {
    const { app, server } = makeServer()
    httpServer = server
    const port = await startListening(server)
    baseUrl = `http://localhost:${port}`

    service = new WalletRelayService({
      app,
      server,
      wallet: new ProtoWallet(PrivateKey.fromRandom()),
      relayUrl: `ws://localhost:${port}`,
      origin: `http://localhost:${port}`,
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
      const body = await res.json() as { sessionId: string; status: string }
      expect(body.sessionId).toBeTruthy()
      expect(body.status).toBe('pending')
    })

    it('GET /api/session/:id returns the session status and relay URL', async () => {
      const created = await service.createSession()
      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`)
      expect(res.ok).toBe(true)
      const body = await res.json() as { sessionId: string; status: string; relay: string }
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
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        maxSessions: 1,
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
      const { params } = parsePairingUri(
        `bsv-browser://pair?topic=no-such-session&backendIdentityKey=${PrivateKey.fromRandom().toPublicKey()}&protocolID=%5B0%2C%22mobile+wallet+session%22%5D&origin=${encodeURIComponent(baseUrl)}&expiry=${Math.floor(Date.now() / 1000) + 120}`
      )
      const session = new WalletPairingSession(new ProtoWallet(PrivateKey.fromRandom()), params!)
      await expect(session.resolveRelay()).rejects.toThrow(/HTTP 404/)
    }, 10_000)
  })

  // ── Pairing ─────────────────────────────────────────────────────────────────

  describe('pairing', () => {
    it('session becomes connected after mobile pairs', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      expect(service.getSession(created.sessionId)?.status).toBe('connected')
      mobile.disconnect()
    }, 10_000)

    it('onSessionConnected fires with the correct session id', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const connectedIds: string[] = []

      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        onSessionConnected: id => connectedIds.push(id),
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))
        expect(connectedIds).toContain(created.sessionId)
        mobile.disconnect()
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('onSessionDisconnected fires when mobile disconnects', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const disconnectedIds: string[] = []

      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        onSessionDisconnected: id => disconnectedIds.push(id),
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))
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
    it('getPublicKey returns the mobile wallet public key (service API)', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const { publicKey: expectedKey } = await mobileWallet.getPublicKey({ identityKey: true })

      const created = await service.createSession()
      const mobile = await pairMobile(
        created.pairingUri, mobileWallet,
        (_method, params) => mobileWallet.getPublicKey(params as { identityKey: true }),
      )

      const rpc = await service.sendRequest(
        created.sessionId, 'getPublicKey', { identityKey: true }, created.desktopToken
      )

      expect(rpc.result).toMatchObject({ publicKey: expectedKey })
      mobile.disconnect()
    }, 10_000)

    it('getPublicKey returns the mobile wallet public key (HTTP route)', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()

      const mobile = await pairMobile(
        created.pairingUri, mobileWallet,
        (_method, params) => mobileWallet.getPublicKey(params as { identityKey: true }),
      )

      const res = await fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': created.desktopToken,
        },
        body: JSON.stringify({ method: 'getPublicKey', params: { identityKey: true } }),
      })

      expect(res.ok).toBe(true)
      const body = await res.json() as { result?: { publicKey: string } }
      expect(body.result?.publicKey).toBeTruthy()
      mobile.disconnect()
    }, 10_000)

    it('handler error is returned as an RPC error object (not a thrown exception)', async () => {
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const created = await service.createSession()

      const mobile = await pairMobile(
        created.pairingUri, mobileWallet,
        () => Promise.reject(new Error('wallet unavailable')),
      )

      const rpc = await service.sendRequest(
        created.sessionId, 'createAction', {}, created.desktopToken
      )

      expect(rpc.error?.message).toBe('wallet unavailable')
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

    it('signQrCodes: false omits the sig from the pairing URI', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const unsigned = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        signQrCodes: false,
      })
      try {
        const s = await unsigned.createSession()
        const url = new URL(s.pairingUri)
        expect(url.searchParams.get('sig')).toBeNull()
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
        created.pairingUri, mobileWallet,
        () => new Promise(() => { /* intentionally never resolves */ }),
      )

      const requestPromise = service.sendRequest(
        created.sessionId, 'getPublicKey', {}, created.desktopToken
      )

      // Give the request one tick to register as pending on the server
      await new Promise(r => setTimeout(r, 50))

      service.deleteSession(created.sessionId, created.desktopToken)

      await expect(requestPromise).rejects.toThrow()
      mobile.disconnect()
    }, 10_000)

    it('deleteSession() throws for an unknown session', () => {
      expect(() => service.deleteSession('no-such-id', 'token')).toThrow('Session not found')
    })

    it('deleteSession() throws for an invalid desktop token', async () => {
      const created = await service.createSession()
      expect(() => service.deleteSession(created.sessionId, 'wrong-token')).toThrow('Invalid desktop token')
    })

    it('DELETE /api/session/:id returns 204 and marks session expired', async () => {
      const created = await service.createSession()
      const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`, {
        method: 'DELETE',
        headers: { 'X-Desktop-Token': created.desktopToken },
      })

      expect(res.status).toBe(204)
      expect(service.getSession(created.sessionId)?.status).toBe('expired')
      mobile.disconnect()
    }, 10_000)

    it('DELETE /api/session/:id returns 401 with wrong token', async () => {
      const created = await service.createSession()

      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`, {
        method: 'DELETE',
        headers: { 'X-Desktop-Token': 'wrong-token' },
      })

      expect(res.status).toBe(401)
    }, 10_000)

    it('DELETE /api/session/:id returns 401 with missing token', async () => {
      const created = await service.createSession()

      const res = await fetch(`${baseUrl}/api/session/${created.sessionId}`, {
        method: 'DELETE',
      })

      expect(res.status).toBe(401)
    }, 10_000)

    it('DELETE /api/session/:id returns 404 for unknown session', async () => {
      const res = await fetch(`${baseUrl}/api/session/does-not-exist`, {
        method: 'DELETE',
        headers: { 'X-Desktop-Token': 'any-token' },
      })

      expect(res.status).toBe(404)
    }, 10_000)

    it('onSessionDisconnected does not fire after deleteSession', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const disconnectedIds: string[] = []

      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        origin: `http://localhost:${port}`,
        onSessionDisconnected: id => disconnectedIds.push(id),
      })
      try {
        const created = await svc.createSession()
        const mobile = await pairMobile(created.pairingUri, new ProtoWallet(PrivateKey.fromRandom()))

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
          'X-Desktop-Token': created.desktopToken,
        },
        body: JSON.stringify({ method: 'getPublicKey', params: {} }),
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
        body: JSON.stringify({ method: 'getPublicKey', params: {} }),
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
          'X-Desktop-Token': created.desktopToken,
        },
        body: JSON.stringify({ method: 'getPublicKey', params: {} }),
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
        created.pairingUri, mobileWallet,
        () => new Promise(() => { /* intentionally never resolves */ }),
      )

      // Start the request (in-flight on the server)
      const requestPromise = fetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Desktop-Token': created.desktopToken,
        },
        body: JSON.stringify({ method: 'createAction', params: {} }),
      })

      // Give the request one tick to register as pending on the server
      await new Promise(r => setTimeout(r, 50))

      // Disconnect the mobile — should immediately reject the pending promise
      mobile.disconnect()

      const res = await requestPromise
      expect(res.status).toBe(504)
      const body = await res.json() as { error: string }
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
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: /^https:\/\/[a-z0-9-]+\.commonsource\.nl$/,
      })
      try {
        const created = await svc.createSession({ origin: 'https://app.commonsource.nl' })
        const { params } = parsePairingUri(created.pairingUri)
        expect(params?.origin).toBe('https://app.commonsource.nl')
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('rejects per-call origin when not in allowedOrigins', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: ['https://app.commonsource.nl'],
      })
      try {
        await expect(
          svc.createSession({ origin: 'https://evil.com' })
        ).rejects.toThrow(/not in the allowedOrigins list/)
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('forwards the request Origin header via GET /api/session', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: /^https:\/\/[a-z0-9-]+\.commonsource\.nl$/,
      })
      try {
        const res = await fetch(`http://localhost:${port}/api/session`, {
          headers: { Origin: 'https://app.commonsource.nl' },
        })
        expect(res.ok).toBe(true)
        const body = await res.json() as { pairingUri: string }
        const { params } = parsePairingUri(body.pairingUri)
        expect(params?.origin).toBe('https://app.commonsource.nl')
      } finally {
        svc.stop()
        await stopServer(server)
      }
    }, 10_000)

    it('returns 403 from GET /api/session when Origin header is not in allowlist', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: ['https://app.commonsource.nl'],
      })
      try {
        const res = await fetch(`http://localhost:${port}/api/session`, {
          headers: { Origin: 'https://evil.com' },
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
      const body = await res.json() as { pairingUri: string }
      const { params } = parsePairingUri(body.pairingUri)
      expect(params?.origin).toBe(baseUrl)
    })

    it('signs the QR over the per-session origin (signature verifies)', async () => {
      const { app, server } = makeServer()
      const port = await startListening(server)
      const svc = new WalletRelayService({
        app, server,
        wallet: new ProtoWallet(PrivateKey.fromRandom()),
        relayUrl: `ws://localhost:${port}`,
        allowedOrigins: /^https:\/\/[a-z0-9-]+\.commonsource\.nl$/,
      })
      try {
        const created = await svc.createSession({ origin: 'https://app.commonsource.nl' })
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
})
