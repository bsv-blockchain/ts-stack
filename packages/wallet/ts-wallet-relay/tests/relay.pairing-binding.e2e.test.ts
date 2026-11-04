/**
 * E2E tests for the two pairing bindings:
 *  - the origin's session lookup reports the backend key and the phone requires
 *    it to equal the QR key, and
 *  - the relay delivers desktop-role traffic to a mobile socket only after the
 *    backend accepted that socket's pairing.
 *
 * Each binding is exercised on its own: the key check with the relay hold
 * switched off, and the relay hold with a phone that does not see the key.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { WebSocket } from 'ws'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { stringifyBRC100 } from '@bsv/sdk/wallet/BRC100ByteEncoding'
import { WalletRelayService } from '../src/server/WalletRelayService.js'
import { WalletPairingSession } from '../src/client/WalletPairingSession.js'
import {
  buildPairingUri,
  parsePairingUri,
  verifyPairingSignature
} from '../src/shared/pairingUri.js'
import { encryptEnvelope } from '../src/shared/crypto.js'
import { bytesToBase64url } from '../src/shared/encoding.js'
import { PROTOCOL_ID, type PairingParams } from '../src/types.js'

;(globalThis as unknown as Record<string, unknown>).WebSocket = WebSocket

const nativeFetch = globalThis.fetch.bind(globalThis)

/** Teardown for sockets, sessions and timers a test opened; runs whether it passes or fails. */
const cleanups: Array<() => void> = []

/** Every frame the phone's sockets receive from the relay, recorded at the transport. */
function recordPhoneFrames(): string[] {
  const frames: string[] = []
  class RecordingWebSocket extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args)
      this.on('message', data => frames.push(`${data}`))
    }
  }
  ;(globalThis as unknown as Record<string, unknown>).WebSocket = RecordingWebSocket
  cleanups.push(() => {
    ;(globalThis as unknown as Record<string, unknown>).WebSocket = WebSocket
  })
  return frames
}

function ciphertextOf(frame: string): string {
  return (JSON.parse(frame) as { ciphertext: string }).ciphertext
}

function startListening(server: http.Server): Promise<number> {
  return new Promise(resolve =>
    server.listen(0, () => resolve((server.address() as { port: number }).port))
  )
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await wait(5)
  }
}

/** Session lookups answered as a pre-0.6.0 origin would: without the backend key. */
function originWithoutKey(): jest.SpyInstance {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await nativeFetch(input, init)
    if (!String(input).includes('/api/session/')) return response
    const body = (await response.json()) as Record<string, unknown>
    delete body.backendIdentityKey
    return new Response(JSON.stringify(body), {
      status: response.status,
      headers: { 'Content-Type': 'application/json' }
    })
  })
}

/** A session created through the public route, paired under a different key. */
async function pairingUnderOtherKey(baseUrl: string) {
  const res = await nativeFetch(`${baseUrl}/api/session`)
  const created = (await res.json()) as { sessionId: string; desktopToken: string }
  const otherWallet = new ProtoWallet(PrivateKey.fromRandom())
  const otherKey = (await otherWallet.getPublicKey({ identityKey: true })).publicKey
  const expiry = Math.floor((Date.now() + 120_000) / 1000)
  const { signature } = await otherWallet.createSignature({
    data: Array.from(
      new TextEncoder().encode(`${created.sessionId}|${otherKey}|${baseUrl}|${expiry}`)
    ),
    protocolID: [0, 'qr pairing'],
    keyID: created.sessionId,
    counterparty: 'anyone'
  })
  const uri = buildPairingUri({
    sessionId: created.sessionId,
    backendIdentityKey: otherKey,
    protocolID: JSON.stringify(PROTOCOL_ID),
    origin: baseUrl,
    expiry,
    sig: bytesToBase64url(signature)
  })
  const { params } = parsePairingUri(uri)
  expect(params).not.toBeNull()
  await expect(verifyPairingSignature(params!)).resolves.toBe(true)
  return { ...created, otherWallet, params: params! }
}

async function openDesktop(port: number, topic: string, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}/ws?topic=${topic}&role=desktop&token=${token}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  cleanups.push(() => ws.terminate())
  return ws
}

async function encryptedRequest(
  wallet: ProtoWallet,
  topic: string,
  counterparty: string,
  seq: number
): Promise<string> {
  const ciphertext = await encryptEnvelope(
    wallet,
    { protocolID: PROTOCOL_ID, keyID: topic, counterparty },
    stringifyBRC100({
      id: randomUUID(),
      seq,
      method: 'createAction',
      params: { description: 'desktop queued action' }
    })
  )
  return stringifyBRC100({ topic, ciphertext })
}

function phone(wallet: ProtoWallet, params: PairingParams, autoApprove = false) {
  const approval = jest.fn(async () => true)
  const handler = jest.fn(async () => ({ txid: '00'.repeat(32) }))
  const errors: string[] = []
  let connected = false
  const session = new WalletPairingSession(wallet, params, {
    implementedMethods: new Set(['getPublicKey', 'createAction']),
    autoApproveMethods: new Set(autoApprove ? ['getPublicKey', 'createAction'] : ['getPublicKey']),
    onApprovalRequired: approval
  }).onRequest(handler)
  cleanups.push(() => session.disconnect())
  session
    .on('error', message => errors.push(message))
    .on('connected', () => {
      connected = true
    })
  return {
    session,
    approval,
    handler,
    errors,
    isConnected: () => connected,
    closed: () => session.status === 'error' || session.status === 'disconnected'
  }
}

describe('pairing key binding and desktop traffic hold', () => {
  let httpServer: http.Server
  let service: WalletRelayService
  let backendWallet: ProtoWallet
  let baseUrl: string
  let port: number

  beforeEach(async () => {
    const app = express()
    app.use(express.json())
    httpServer = http.createServer(app)
    port = await startListening(httpServer)
    baseUrl = `http://localhost:${port}`
    backendWallet = new ProtoWallet(PrivateKey.fromRandom())
    service = new WalletRelayService({
      app,
      server: httpServer,
      wallet: backendWallet,
      relayUrl: `ws://localhost:${port}`,
      origin: baseUrl
    })
  }, 10_000)

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) cleanup()
    jest.restoreAllMocks()
    service.stop()
    await stopServer(httpServer)
  }, 10_000)

  describe('origin-bound pairing key', () => {
    it('reports the backend identity key from GET /api/session/:id', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const res = await nativeFetch(`${baseUrl}/api/session/${created.sessionId}`)
      const body = (await res.json()) as { backendIdentityKey?: string }
      expect(body.backendIdentityKey).toBe(params!.backendIdentityKey)
      expect(service.getSession(created.sessionId)?.backendIdentityKey).toBe(
        params!.backendIdentityKey
      )
    })

    it('rejects a pairing whose key does not match the origin before opening a socket', async () => {
      // Relay hold off: only the phone-side key check is under test.
      ;(service as any).relay.holdDesktopTraffic = false
      const other = await pairingUnderOtherKey(baseUrl)
      const phoneWallet = new ProtoWallet(PrivateKey.fromRandom())
      const phoneKey = (await phoneWallet.getPublicKey({ identityKey: true })).publicKey
      const desktop = await openDesktop(port, other.sessionId, other.desktopToken)
      desktop.send(await encryptedRequest(other.otherWallet, other.sessionId, phoneKey, 1000))
      const mobileConnect = jest.spyOn((service as any).relay, 'onMobileConnectCb')

      const mobile = phone(phoneWallet, other.params)
      await expect(mobile.session.resolveRelay()).rejects.toThrow('does not match the pairing key')
      await expect(mobile.session.connect()).rejects.toThrow('resolveRelay()')
      await wait(50)

      expect(mobileConnect).not.toHaveBeenCalled()
      expect(mobile.approval).not.toHaveBeenCalled()
      expect(mobile.handler).not.toHaveBeenCalled()
      desktop.close()
    }, 10_000)

    it('rejects a pairing under another key with the default service configuration', async () => {
      const other = await pairingUnderOtherKey(baseUrl)
      const phoneWallet = new ProtoWallet(PrivateKey.fromRandom())
      const phoneKey = (await phoneWallet.getPublicKey({ identityKey: true })).publicKey
      const desktop = await openDesktop(port, other.sessionId, other.desktopToken)
      desktop.send(await encryptedRequest(other.otherWallet, other.sessionId, phoneKey, 1000))
      const mobileConnect = jest.spyOn((service as any).relay, 'onMobileConnectCb')

      const mobile = phone(phoneWallet, other.params)
      await expect(mobile.session.resolveRelay()).rejects.toThrow('does not match the pairing key')
      await wait(50)

      expect(mobileConnect).not.toHaveBeenCalled()
      expect(mobile.approval).not.toHaveBeenCalled()
      expect(mobile.handler).not.toHaveBeenCalled()
      desktop.close()
    }, 10_000)

    it('pairs with an origin that reports the matching key', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const mobile = phone(new ProtoWallet(PrivateKey.fromRandom()), params!)
      await mobile.session.resolveRelay()
      await mobile.session.connect()
      await waitFor(() => service.getSession(created.sessionId)?.status === 'connected', 'pairing')
      await waitFor(mobile.isConnected, 'pairing_ack')
      expect(service.getSession(created.sessionId)?.status).toBe('connected')
      expect(mobile.isConnected()).toBe(true)
      mobile.session.disconnect()
    }, 10_000)

    it('pairs with an origin that does not report its key', async () => {
      originWithoutKey()
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const mobile = phone(new ProtoWallet(PrivateKey.fromRandom()), params!)
      await mobile.session.resolveRelay()
      await mobile.session.connect()
      await waitFor(() => service.getSession(created.sessionId)?.status === 'connected', 'pairing')
      await waitFor(mobile.isConnected, 'pairing_ack')
      expect(service.getSession(created.sessionId)?.status).toBe('connected')
      expect(mobile.isConnected()).toBe(true)
      mobile.session.disconnect()
    }, 10_000)
  })

  describe('desktop traffic held until pairing is accepted', () => {
    it('holds queued desktop traffic from a phone whose pairing is not accepted', async () => {
      // A phone that does not see the origin key: only the relay hold is under test.
      originWithoutKey()
      const other = await pairingUnderOtherKey(baseUrl)
      const phoneWallet = new ProtoWallet(PrivateKey.fromRandom())
      const phoneKey = (await phoneWallet.getPublicKey({ identityKey: true })).publicKey
      const desktop = await openDesktop(port, other.sessionId, other.desktopToken)
      const desktopFrame = await encryptedRequest(
        other.otherWallet,
        other.sessionId,
        phoneKey,
        1000
      )
      desktop.send(desktopFrame)
      await waitFor(
        () => (service as any).relay.topics.get(other.sessionId)?.buffer.length === 1,
        'queued desktop message'
      )

      const phoneFrames = recordPhoneFrames()
      const mobile = phone(phoneWallet, other.params)
      await mobile.session.resolveRelay()
      await mobile.session.connect()
      await waitFor(() => mobile.closed(), 'backend to close the unaccepted socket')
      await wait(100)

      // Checked on the wire, so it holds however the phone treats a frame it receives.
      expect(phoneFrames.map(ciphertextOf)).not.toContain(ciphertextOf(desktopFrame))
      expect(mobile.approval).not.toHaveBeenCalled()
      expect(mobile.handler).not.toHaveBeenCalled()
      expect(service.getSession(other.sessionId)?.status).not.toBe('connected')
      desktop.close()
    }, 10_000)

    it('holds live desktop traffic while the backend is still checking the pairing', async () => {
      originWithoutKey()
      const relay = (service as any).relay
      // Record the order in which the relay sees the desktop reply and closes the phone.
      const events: string[] = []
      let desktopFrameReceived!: () => void
      const desktopFrame = new Promise<void>(resolve => (desktopFrameReceived = resolve))
      const onMessage = relay.onMessage
      relay.onMessage = (topic: string, envelope: unknown, role: string, connectionId: number) => {
        if (role === 'desktop') {
          const open = relay.topics.get(topic)?.mobile?.readyState === WebSocket.OPEN
          events.push(open ? 'desktop frame, phone open' : 'desktop frame, phone closed')
          desktopFrameReceived()
        }
        onMessage(topic, envelope, role, connectionId)
      }
      const disconnectMobile = relay.disconnectMobile.bind(relay)
      jest.spyOn(relay, 'disconnectMobile').mockImplementation((topic: unknown) => {
        events.push('disconnectMobile')
        disconnectMobile(topic)
      })
      // Any other ordering surfaces as a failed assertion rather than a stalled decrypt.
      const releaseDecrypt = setTimeout(() => desktopFrameReceived(), 3000)
      cleanups.push(() => clearTimeout(releaseDecrypt))
      // The pairing check finishes only after the relay has received the desktop reply.
      const decrypt = backendWallet.decrypt.bind(backendWallet)
      jest.spyOn(backendWallet, 'decrypt').mockImplementation(async args => {
        await desktopFrame
        return decrypt(args)
      })
      const other = await pairingUnderOtherKey(baseUrl)
      const desktop = await openDesktop(port, other.sessionId, other.desktopToken)
      let replied = false
      const desktopCiphertexts: string[] = []
      desktop.on('message', data => {
        const envelope = JSON.parse(`${data}`) as { mobileIdentityKey?: string }
        if (!envelope.mobileIdentityKey || replied) return
        replied = true
        void encryptedRequest(
          other.otherWallet,
          other.sessionId,
          envelope.mobileIdentityKey,
          1000
        ).then(frame => {
          desktopCiphertexts.push(ciphertextOf(frame))
          desktop.send(frame)
        })
      })

      const phoneFrames = recordPhoneFrames()
      const mobile = phone(new ProtoWallet(PrivateKey.fromRandom()), other.params)
      await mobile.session.resolveRelay()
      await mobile.session.connect()
      await waitFor(() => mobile.closed(), 'backend to close the unaccepted socket')
      await wait(100)

      expect(events).toEqual(['desktop frame, phone open', 'disconnectMobile'])
      // Checked on the wire, so it holds however the phone treats a frame it receives.
      expect(desktopCiphertexts).toHaveLength(1)
      expect(phoneFrames.map(ciphertextOf)).not.toContain(desktopCiphertexts[0])
      expect(mobile.approval).not.toHaveBeenCalled()
      expect(mobile.handler).not.toHaveBeenCalled()
      desktop.close()
    }, 10_000)

    it('delivers queued desktop traffic once the pairing is accepted', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const mobileKey = (await mobileWallet.getPublicKey({ identityKey: true })).publicKey
      const desktop = await openDesktop(port, created.sessionId, created.desktopToken)
      desktop.send(await encryptedRequest(backendWallet, created.sessionId, mobileKey, 1000))
      await waitFor(
        () => (service as any).relay.topics.get(created.sessionId)?.buffer.length === 1,
        'queued desktop message'
      )

      const mobile = phone(mobileWallet, params!, true)
      await mobile.session.resolveRelay()
      await mobile.session.connect()
      await waitFor(() => mobile.handler.mock.calls.length === 1, 'held request delivery')
      expect(service.getSession(created.sessionId)?.status).toBe('connected')
      mobile.session.disconnect()
      desktop.close()
    }, 10_000)

    it('delivers desktop traffic to a reconnecting phone after it pairs again', async () => {
      const created = await service.createSession()
      const { params } = parsePairingUri(created.pairingUri)
      const mobileWallet = new ProtoWallet(PrivateKey.fromRandom())
      const mobileKey = (await mobileWallet.getPublicKey({ identityKey: true })).publicKey
      const mobile = phone(mobileWallet, params!, true)
      await mobile.session.resolveRelay()
      await mobile.session.connect()
      await waitFor(() => service.getSession(created.sessionId)?.status === 'connected', 'pairing')

      // The backend's own HTTP request path is unaffected by the hold. It runs first
      // because the desktop frames below use sequence numbers far above the backend's.
      const res = await nativeFetch(`${baseUrl}/api/request/${created.sessionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Desktop-Token': created.desktopToken },
        body: JSON.stringify({ method: 'createAction', params: { description: 'http action' } })
      })
      expect(res.ok).toBe(true)
      expect(mobile.handler).toHaveBeenCalledTimes(1)

      const desktop = await openDesktop(port, created.sessionId, created.desktopToken)
      desktop.send(await encryptedRequest(backendWallet, created.sessionId, mobileKey, 1000))
      await waitFor(() => mobile.handler.mock.calls.length === 2, 'live desktop delivery')

      const lastSeq = mobile.session.lastSeq
      mobile.session.disconnect()
      await waitFor(
        () => service.getSession(created.sessionId)?.status === 'disconnected',
        'disconnect'
      )
      const pairing = jest.spyOn((service as any).relay, 'acceptMobile')
      await mobile.session.reconnect(lastSeq)
      await waitFor(() => pairing.mock.calls.length === 1, 'reconnect pairing')
      await waitFor(() => service.getSession(created.sessionId)?.status === 'connected', 'pairing')

      desktop.send(await encryptedRequest(backendWallet, created.sessionId, mobileKey, 2000))
      await waitFor(() => mobile.handler.mock.calls.length === 3, 'delivery after re-pairing')
      mobile.session.disconnect()
      desktop.close()
    }, 15_000)
  })
})
