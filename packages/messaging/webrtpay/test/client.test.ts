import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { PeerLink } from '../src/channel/PeerLink.js'
import { decodeCode, encodeAnswerCode } from '../src/codec/codes.js'
import { DirectPayClient } from '../src/client/DirectPayClient.js'
import type { DirectPayClientOptions, ReceiveHandlers } from '../src/client/DirectPayClient.js'
import { KeyedBuckets, TokenBucket } from '../src/client/budget.js'
import { DEFAULT_INBOUND_LIMITS, InboundLimiter } from '../src/client/limits.js'
import { acceptDirectPayment } from '../src/payments/accept.js'
import type { SeenStore } from '../src/payments/accept.js'
import { createPaymentRequestProof } from '../src/payments/requests.js'
import { MAX_DIRECT_TRANSACTION_BYTES, encodePayment } from '../src/payments/wire.js'
import type { PaymentAck } from '../src/payments/wire.js'
import type { AuthenticatedPeer } from '../src/session/AuthenticatedPeer.js'
import { ReplayCache, openSignal, sealSignal } from '../src/signaling/envelope.js'
import { createMemoryHub } from '../src/signaling/MemorySignaler.js'
import type { MemoryHub } from '../src/signaling/MemorySignaler.js'
import { RelaySignaler } from '../src/signaling/RelaySignaler.js'
import type { SignalEnvelope, SignalPlaintext, Signaler } from '../src/signaling/types.js'
import type { IncomingPayment, IncomingPaymentRequest, PaymentToken } from '../src/types.js'
import { randomBytes, toBase64, toBase64Url } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import type { RelayServer } from '../server/index.js'
import { relayFixtures, waitFor } from './helpers/relay.js'
import { cleanupRtc, nodeRtc } from './helpers/rtc.js'
import type { NodeRtcOptions } from './helpers/rtc.js'
import { makeToken, makeWallet } from './helpers/wallet.js'
import type { TestWallet } from './helpers/wallet.js'

// File scope so a filtered run (-t) still releases node-datachannel's native threads.
afterAll(cleanupRtc)

let rtc: NodeRtcOptions
beforeAll(async () => {
  rtc = await nodeRtc()
})

/** Every client a test created; closed after each test so no peer or timer outlives it. */
const clients: DirectPayClient[] = []
/** Links tests drive by hand, closed after each test too. */
const rawLinks: PeerLink[] = []

afterEach(async () => {
  for (const link of rawLinks.splice(0)) link.close()
  await Promise.all(clients.splice(0).map(c => c.close()))
})

/** A client with loopback WebRTC and short timeouts, closed after the test. */
function client(w: TestWallet, o: Partial<DirectPayClientOptions> = {}): DirectPayClient {
  const c = new DirectPayClient({
    wallet: w.wallet,
    rtc,
    timeouts: { connectMs: 3000, ackMs: 10000 },
    ...o
  })
  clients.push(c)
  return c
}

/** A client that signals through `hub` as its wallet's identity. */
function hubClient(
  hub: MemoryHub,
  w: TestWallet,
  o: Partial<DirectPayClientOptions> = {}
): DirectPayClient {
  return client(w, { signaler: hub.signaler(w.identityKey), ...o })
}

function memorySeen(): SeenStore {
  const keys = new Set<string>()
  return {
    has: key => keys.has(key),
    add: key => {
      keys.add(key)
    }
  }
}

/** Handlers that accept every valid payment through `acceptDirectPayment`. */
function accepting(payee: TestWallet, seen?: SeenStore): ReceiveHandlers {
  return {
    onPayment: async p => {
      await acceptDirectPayment(payee.wallet, p, { seen })
      return 'accepted'
    }
  }
}

/** The WebRTPayError a promise rejects with; anything else fails the test. */
async function failure(p: Promise<unknown>): Promise<WebRTPayError> {
  try {
    await p
  } catch (e) {
    if (e instanceof WebRTPayError) return e
    throw e
  }
  throw new Error('Expected a rejection')
}

function closeOf(on: {
  onClose(fn: (e?: WebRTPayError) => void): () => void
}): Promise<WebRTPayError | undefined> {
  return new Promise(resolve => on.onClose(resolve))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Retry `fn` every 100 ms until it resolves, up to `attempts` tries. */
async function eventually<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= attempts) throw e
      await sleep(100)
    }
  }
}

/** An identity that listens on `hub` and never answers; resolves `heard` on the first signal. */
async function silentListener(hub: MemoryHub): Promise<{
  identityKey: string
  heard: Promise<void>
  stop: () => Promise<void>
}> {
  const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
  let hear!: () => void
  const heard = new Promise<void>(resolve => (hear = resolve))
  const stop = await hub.signaler(identityKey).listen(() => hear())
  return { identityKey, heard, stop }
}

function key(): string {
  return PrivateKey.fromRandom().toPublicKey().toString()
}

/** An envelope that is well formed but decrypts to nothing. */
function junkEnvelope(): SignalEnvelope {
  return { v: 1, sid: toBase64Url(randomBytes(16)), ciphertext: toBase64(randomBytes(64)) }
}

/**
 * Dial `payeeKey` by hand as `dialer`: send a sealed offer for a raw link and resolve with
 * the link and the payee's answer SDP, without running the handshake.
 */
async function rawDial(
  hub: MemoryHub,
  dialer: TestWallet,
  payeeKey: string
): Promise<{ link: PeerLink; answer: string }> {
  const { link, sdp } = await PeerLink.createOffer({ ...rtc, maxMessageBytes: 65536 })
  rawLinks.push(link)
  const sid = toBase64Url(randomBytes(16))
  const signaler = hub.signaler(dialer.identityKey)
  let got!: (sdp: string) => void
  const answered = new Promise<string>(resolve => (got = resolve))
  const stop = await signaler.listen((from, e) => {
    void openSignal(dialer.wallet, from, e, { me: dialer.identityKey, replay: new ReplayCache() })
      .then(p => {
        if (p.kind === 'answer' && p.sid === sid && p.sdp !== undefined) got(p.sdp)
      })
      .catch(() => undefined)
  })
  const offer = await sealSignal(dialer.wallet, {
    v: 1,
    kind: 'offer',
    sid,
    from: dialer.identityKey,
    to: payeeKey,
    ts: Date.now(),
    purpose: 'payment',
    sdp
  })
  await signaler.send(payeeKey, offer)
  const answer = await answered
  await stop()
  return { link, answer }
}

// ---------------------------------------------------------------- inbound limiter

describe('InboundLimiter', () => {
  const T0 = 1_792_240_000_000
  const A = key()
  const B = key()

  it('defaults match the spec inbound limits', () => {
    expect(DEFAULT_INBOUND_LIMITS).toEqual({
      maxConcurrent: 3,
      offersPerMinute: 10,
      offersPerMinutePerSender: 3,
      maxMessageBytes: 16 * 1024 * 1024,
      idleTimeoutMs: 60000,
      firstMessageTimeoutMs: 60000,
      maxSessionMs: 120000
    })
    expect(Object.isFrozen(DEFAULT_INBOUND_LIMITS)).toBe(true)
  })

  it('admits up to maxConcurrent sessions and frees a slot on release', () => {
    const l = new InboundLimiter(DEFAULT_INBOUND_LIMITS)
    const senders = [key(), key(), key()]
    expect(senders.map(k => l.tryAdmit(k, T0))).toEqual([true, true, true])
    expect(l.tryAdmit(A, T0)).toBe(false)
    expect(l.refusal(A, T0)).toBe('busy')
    l.release(senders[1])
    expect(l.refusal(A, T0)).toBeUndefined()
    expect(l.tryAdmit(A, T0)).toBe(true)
  })

  it('allows one session per sender at a time', () => {
    const l = new InboundLimiter(DEFAULT_INBOUND_LIMITS)
    expect(l.tryAdmit(A, T0)).toBe(true)
    expect(l.refusal(A, T0)).toBe('sender')
    expect(l.tryAdmit(A, T0)).toBe(false)
    expect(l.tryAdmit(B, T0)).toBe(true)
    // releasing another sender's slot does not free A's
    l.release(B)
    expect(l.tryAdmit(A, T0)).toBe(false)
    l.release(A)
    expect(l.tryAdmit(A, T0)).toBe(true)
  })

  it("checks a sender's own limits before the global ones", () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 1 })
    expect(l.tryAdmit(A, T0)).toBe(true)
    // the only slot is A's: A is refused for itself, anyone else because it is busy
    expect(l.refusal(A, T0)).toBe('sender')
    expect(l.refusal(B, T0)).toBe('busy')
    l.release(A)
    // A's rate (3 a minute) runs out while the global budget (10) does not
    for (let i = 1; i < 3; i++) {
      expect(l.tryAdmit(A, T0 + i)).toBe(true)
      l.release(A)
    }
    expect(l.refusal(A, T0 + 3)).toBe('sender')
    expect(l.refusal(B, T0 + 3)).toBeUndefined()
  })

  it('admits at most offersPerMinutePerSender from one sender per rolling minute', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 100 })
    const admit = (sender: string, now: number): boolean => {
      const admitted = l.tryAdmit(sender, now)
      if (admitted) l.release(sender)
      return admitted
    }
    for (let i = 0; i < 3; i++) expect(admit(A, T0 + i)).toBe(true)
    expect(admit(A, T0 + 10)).toBe(false)
    expect(admit(B, T0 + 10)).toBe(true)
    expect(admit(A, T0 + 59_999)).toBe(false)
    // the first admission (T0) is a minute old
    expect(admit(A, T0 + 60_000)).toBe(true)
    expect(admit(A, T0 + 60_000)).toBe(false)
  })

  it('admits at most offersPerMinute in total per rolling minute', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 100 })
    for (let i = 0; i < 10; i++) expect(l.tryAdmit(key(), T0 + i)).toBe(true)
    expect(l.tryAdmit(A, T0 + 1000)).toBe(false)
    expect(l.tryAdmit(A, T0 + 60_000)).toBe(true)
  })

  it('does not count refused offers against the sender or the total', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 1 })
    expect(l.tryAdmit(A, T0)).toBe(true)
    for (let i = 0; i < 20; i++) expect(l.tryAdmit(B, T0)).toBe(false)
    l.release(A)
    expect(l.tryAdmit(B, T0)).toBe(true)
  })

  it('never releases below zero', () => {
    const l = new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, maxConcurrent: 1 })
    l.release(A)
    l.release(B)
    expect(l.tryAdmit(A, T0)).toBe(true)
    expect(l.tryAdmit(B, T0)).toBe(false)
    l.release(A)
    l.release(A)
    expect(l.tryAdmit(B, T0)).toBe(true)
    expect(l.tryAdmit(A, T0)).toBe(false)
  })

  it('counts its window on the clock it is given, not the wall clock (M24)', () => {
    let t = 5000
    const l = new InboundLimiter(
      { ...DEFAULT_INBOUND_LIMITS, offersPerMinutePerSender: 1 },
      () => t
    )
    const wall = jest.spyOn(Date, 'now').mockReturnValue(T0)
    try {
      expect(l.tryAdmit(A)).toBe(true)
      l.release(A)
      expect(l.refusal(A)).toBe('sender')
      // the wall clock steps back an hour; the window still ends a minute later
      wall.mockReturnValue(T0 - 3_600_000)
      t += 60_000
      expect(l.refusal(A)).toBeUndefined()
      expect(l.tryAdmit(A)).toBe(true)
    } finally {
      wall.mockRestore()
    }
  })

  it('does not read the wall clock by default (M24)', () => {
    const wall = jest.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('the wall clock was read')
    })
    try {
      const l = new InboundLimiter(DEFAULT_INBOUND_LIMITS)
      expect(l.tryAdmit(A)).toBe(true)
      expect(l.refusal(A)).toBe('sender')
      expect(new TokenBucket(1, 1000).take()).toBe(true)
      expect(new KeyedBuckets(1, 1000).take(A)).toBe(true)
    } finally {
      wall.mockRestore()
    }
  })

  it('keeps refilling intake budgets when the wall clock steps back (M24)', async () => {
    const bucket = new TokenBucket(1, 20)
    const keyed = new KeyedBuckets(1, 20)
    expect([bucket.take(), keyed.take(A)]).toEqual([true, true])
    expect([bucket.take(), keyed.take(A)]).toEqual([false, false])
    const wall = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000)
    try {
      await sleep(60)
      expect([bucket.take(), keyed.take(A)]).toEqual([true, true])
    } finally {
      wall.mockRestore()
    }
  })

  it('rejects invalid limits with RangeError', () => {
    const bad = [
      { maxConcurrent: 0 },
      { offersPerMinute: 1.5 },
      { offersPerMinutePerSender: -1 },
      { maxMessageBytes: 0 },
      { maxMessageBytes: Number.MAX_SAFE_INTEGER + 1 },
      { idleTimeoutMs: Number.NaN },
      { idleTimeoutMs: 0 },
      { idleTimeoutMs: 2 ** 31 },
      { firstMessageTimeoutMs: 0 },
      { firstMessageTimeoutMs: 2 ** 31 },
      { maxSessionMs: Number.NaN },
      { maxSessionMs: -1 }
    ]
    for (const b of bad) {
      expect(() => new InboundLimiter({ ...DEFAULT_INBOUND_LIMITS, ...b })).toThrow(RangeError)
    }
  })
})

// ---------------------------------------------------------------- remote payments

describe('DirectPayClient remote payments (MemoryHub, loopback WebRTC)', () => {
  it('full remote payment: acceptDirectPayment on the payee, ack accepted', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const contexts: Array<{ note?: string; txid: string }> = []
    const sessions: string[] = []
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving({
      onPayment: async (p, ctx) => {
        contexts.push(ctx)
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      },
      onSession: k => sessions.push(k)
    })
    expect(receiver.receiving).toBe(true)
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const peer = await sender.connect(payee.identityKey)
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
    expect(peer.localIdentityKey).toBe(payer.identityKey)
    const ack = await sender.sendPayment(peer, token, { note: 'lunch' })

    expect(ack).toEqual({ t: 'payment.ack', id: ack.id, status: 'accepted', txid })
    expect(ack.id).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(contexts).toEqual([{ note: 'lunch', txid }])
    expect(sessions).toEqual([payer.identityKey])
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
    const [args] = payee.internalizeAction.mock.calls[0]
    expect(args.outputs[0].paymentRemittance?.senderIdentityKey).toBe(payer.identityKey)
    // the payer ends the session once it has the ack (Ruling 21)
    await closeOf(peer)
    expect(await sender.getIdentityKey()).toBe(payer.identityKey)
  })

  it('creates every link at the 64 KiB pre-auth cap, and the payments still go through', async () => {
    const createOffer = jest.spyOn(PeerLink, 'createOffer')
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    /** The options of the only link `spy` made since the last check. */
    const onlyLink = (spy: typeof createOffer | typeof acceptOffer): unknown => {
      expect(spy).toHaveBeenCalledTimes(1)
      const call = spy.mock.calls[0]
      spy.mockClear()
      return call[call.length - 1]
    }
    // before authenticate() runs, a link accepts no more than a handshake needs
    const preAuth = { maxMessageBytes: 65536 }
    try {
      const hub = createMemoryHub()
      const payer = await makeWallet()
      const payee = await makeWallet()
      const receiver = hubClient(hub, payee)
      await receiver.startReceiving(accepting(payee))
      const sender = hubClient(hub, payer)

      // a dial: the payer offers, the receiving payee answers
      const peer = await sender.connect(payee.identityKey)
      expect(onlyLink(createOffer)).toMatchObject(preAuth)
      expect(onlyLink(acceptOffer)).toMatchObject(preAuth)
      // authentication raises the cap again
      const dialed = await makeToken(payer, payee.identityKey, 1000)
      expect((await sender.sendPayment(peer, dialed.token)).status).toBe('accepted')

      // a code exchange: the payee's offer code, the payer's answer code
      const offer = await receiver.createOfferCode({ chain: 'test' })
      expect(onlyLink(createOffer)).toMatchObject(preAuth)
      const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'test' })
      expect(onlyLink(acceptOffer)).toMatchObject(preAuth)
      const [, payerSide] = await Promise.all([offer.complete(answer.answerCode), answer.connected])
      const scanned = await makeToken(payer, payee.identityKey, 1000)
      expect((await sender.sendPayment(payerSide, scanned.token)).status).toBe('accepted')
    } finally {
      createOffer.mockRestore()
      acceptOffer.mockRestore()
    }
  })

  it('connect to offline recipient rejects with peer_unreachable within budget', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const sender = hubClient(hub, payer)

    // nobody listening for that identity: the carrier refuses at once
    let started = Date.now()
    expect((await failure(sender.connect(key()))).code).toBe('peer_unreachable')
    expect(Date.now() - started).toBeLessThan(3000)

    // the carrier takes the offer but nobody answers: the budget (connectMs 3000) runs out
    const silent = await silentListener(hub)
    started = Date.now()
    const e = await failure(sender.connect(silent.identityKey))
    const elapsed = Date.now() - started
    expect(e.code).toBe('peer_unreachable')
    expect(elapsed).toBeGreaterThanOrEqual(2900)
    expect(elapsed).toBeLessThan(4500)
    await silent.stop()
  })

  it('receive disabled: peer_unreachable or rejected, and the payee creates no PeerLink', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    try {
      const hub = createMemoryHub()
      const payer = await makeWallet()
      const payee = await makeWallet()
      const sender = hubClient(hub, payer)
      const receiver = hubClient(hub, payee)
      expect(receiver.receiving).toBe(false)

      // not listening at all
      expect((await failure(sender.connect(payee.identityKey))).code).toBe('peer_unreachable')

      // listening only for the answer to its own dial
      const silent = await silentListener(hub)
      const ownDial = failure(receiver.connect(silent.identityKey, { timeoutMs: 2000 }))
      await silent.heard
      const refused = await failure(sender.connect(payee.identityKey))
      expect(refused.code).toBe('rejected')
      expect(refused.reason).toBe('not_receiving')
      expect(refused.message).toContain('not_receiving')
      expect((await ownDial).code).toBe('peer_unreachable')
      await silent.stop()

      // receiving switched on and off again
      await receiver.startReceiving(accepting(payee))
      await receiver.stopReceiving()
      expect(receiver.receiving).toBe(false)
      expect((await failure(sender.connect(payee.identityKey))).code).toBe('peer_unreachable')

      expect(acceptOffer).not.toHaveBeenCalled()
    } finally {
      acceptOffer.mockRestore()
    }
  })

  it('limiter: 4th concurrent offer gets rejected with reason busy', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    try {
      const hub = createMemoryHub()
      const payee = await makeWallet()
      const receiver = hubClient(hub, payee)
      await receiver.startReceiving(accepting(payee))
      const senders = await Promise.all(
        [1, 2, 3, 4].map(async () => hubClient(hub, await makeWallet()))
      )

      const peers: AuthenticatedPeer[] = []
      for (const s of senders.slice(0, 3)) peers.push(await s.connect(payee.identityKey))
      const busy = await failure(senders[3].connect(payee.identityKey))
      expect(busy.code).toBe('rejected')
      expect(busy.reason).toBe('busy')
      expect(busy.message).toContain('busy')
      // refused without gathering ICE
      expect(acceptOffer).toHaveBeenCalledTimes(3)

      // a session that ends frees its slot
      peers[0].close()
      const peer = await eventually(() => senders[3].connect(payee.identityKey))
      expect(peer.peerIdentityKey).toBe(payee.identityKey)
    } finally {
      acceptOffer.mockRestore()
    }
  })

  it('leaves error.reason unset when the peer refuses without a reason', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    // a peer that refuses every offer with a reject that names no reason
    const payeeSignaler = hub.signaler(payee.identityKey)
    const stop = await payeeSignaler.listen((from, e) => {
      void (async () => {
        const p = await openSignal(payee.wallet, from, e, {
          me: payee.identityKey,
          replay: new ReplayCache()
        })
        const reject = await sealSignal(payee.wallet, {
          v: 1,
          kind: 'reject',
          sid: p.sid,
          from: payee.identityKey,
          to: from,
          ts: Date.now(),
          purpose: 'payment'
        })
        await payeeSignaler.send(from, reject)
      })().catch(() => undefined) // a failure here shows as the dial timing out
    })
    try {
      const refused = await failure(hubClient(hub, await makeWallet()).connect(payee.identityKey))
      expect(refused.code).toBe('rejected')
      expect(refused.message).toContain('no reason given')
      // nothing the peer did not say
      expect(refused.reason).toBeUndefined()
      expect('reason' in refused).toBe(false)
    } finally {
      await stop()
    }
  })

  it("payer gets 'closed' error and keeps token when payee drops after receiving", async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const received: IncomingPayment[] = []
    const first = hubClient(hub, payee)
    await first.startReceiving({
      onPayment: async p => {
        received.push(p)
        // the payee goes away after receiving, before it acks (Ruling 6)
        await first.close()
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1500)
    const before = JSON.stringify(token)

    const e = await failure(sender.sendPayment(await sender.connect(payee.identityKey), token))
    expect(e.code).toBe('closed')
    expect(received).toHaveLength(1)
    expect(received[0].sender).toBe(payer.identityKey)
    expect(payee.internalizeAction).not.toHaveBeenCalled()
    expect(JSON.stringify(token)).toBe(before)

    // the same token is delivered once the payee is back
    const second = hubClient(hub, payee)
    await second.startReceiving(accepting(payee, memorySeen()))
    const ack = await sender.sendPayment(await sender.connect(payee.identityKey), token)
    expect(ack).toMatchObject({ status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('second delivery of same token acks accepted once internalized once', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving(accepting(payee, memorySeen()))
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 2000)

    const first = await sender.sendPayment(await sender.connect(payee.identityKey), token)
    const second = await sender.sendPayment(await sender.connect(payee.identityKey), token)

    expect(first).toMatchObject({ status: 'accepted', txid })
    expect(second).toMatchObject({ status: 'accepted', txid })
    expect(second.id).not.toBe(first.id)
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('2 MiB transaction payload delivered (chunking end to end)', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving(accepting(payee))
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 5000, 2 * 1024 * 1024)
    expect(token.transaction.length).toBeGreaterThan(2 * 1024 * 1024)

    const ack = await sender.sendPayment(await sender.connect(payee.identityKey), token)

    expect(ack).toMatchObject({ status: 'accepted', txid })
    const [args] = payee.internalizeAction.mock.calls[0]
    expect(toBase64(Uint8Array.from(args.tx))).toBe(toBase64(Uint8Array.from(token.transaction)))
  })

  it('acks rejected with a reason for an invalid payment or a refusing handler', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const handled: number[] = []
    const receiver = hubClient(hub, payee, { limits: { offersPerMinutePerSender: 10 } })
    await receiver.startReceiving({
      onPayment: async p => {
        handled.push(p.token.amount)
        if (p.token.amount === 777) return { status: 'rejected', reason: 'x'.repeat(600) }
        if (p.token.amount === 778) throw new Error('database is locked at /home/someone')
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const pay = async (token: PaymentToken) =>
      sender.sendPayment(await sender.connect(payee.identityKey), token)

    // decodePayment refuses it before the handler sees it (sendPayment would refuse to send
    // it at all, so it goes out by hand)
    const { token: valid } = await makeToken(payer, payee.identityKey, 1000)
    const peer = await sender.connect(payee.identityKey)
    const acked = peer.waitFor((m): m is PaymentAck => m.t === 'payment.ack', 10000)
    await peer.send(encodePayment('zero', { ...valid, amount: 0 }))
    const zero = await acked
    peer.close()
    expect(zero).toMatchObject({ status: 'rejected', reason: expect.any(String) })
    expect(zero.reason!.length).toBeGreaterThan(0)
    expect(handled).toEqual([])

    // the output pays a key derived for someone else: acceptDirectPayment throws invalid_payment
    const stranger = await makeWallet()
    const { token: misdirected } = await makeToken(payer, stranger.identityKey, 1000)
    const wrong = await pay(misdirected)
    expect(wrong).toMatchObject({ status: 'rejected' })
    expect(wrong.reason).toContain('does not pay')

    // the handler's own rejection, cut to the 500 characters an ack may carry
    const { token: refused } = await makeToken(payer, payee.identityKey, 777)
    const own = await pay(refused)
    expect(own).toMatchObject({ status: 'rejected', reason: 'x'.repeat(500) })

    // an unexpected handler error is not passed on to the payer
    const { token: failing } = await makeToken(payer, payee.identityKey, 778)
    const hidden = await pay(failing)
    expect(hidden.status).toBe('rejected')
    expect(hidden.reason).not.toContain('/home/someone')

    expect(handled).toEqual([1000, 777, 778])
    expect(payee.internalizeAction).not.toHaveBeenCalled()
  })

  it('hands payment requests to onPaymentRequest with the proof checked', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const requests: Array<IncomingPaymentRequest & { proofValid: boolean }> = []
    let gotTwo!: () => void
    const two = new Promise<void>(resolve => (gotTwo = resolve))
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving({
      ...accepting(payee),
      onPaymentRequest: async r => {
        requests.push(r)
        if (requests.length === 2) gotTwo()
      }
    })
    const sender = hubClient(hub, payer)
    const peer = await sender.connect(payee.identityKey)
    const proof = await createPaymentRequestProof(payer.wallet, 'req-1', payee.identityKey)
    const base = {
      senderIdentityKey: payer.identityKey,
      amount: 2500,
      description: 'Invoice 7',
      expiresAt: Date.now() + 60000,
      requestProof: proof
    }

    await peer.send({ t: 'request', request: { ...base, requestId: 'req-1' } })
    // a proof made for another request ID does not verify
    await peer.send({ t: 'request', request: { ...base, requestId: 'req-2' } })
    // cancellations are not handed on
    await peer.send({
      t: 'request',
      request: {
        requestId: 'req-1',
        senderIdentityKey: payer.identityKey,
        requestProof: proof,
        cancelled: true
      }
    })
    await two

    const common = {
      sender: payer.identityKey,
      amount: 2500,
      description: 'Invoice 7',
      expiresAt: base.expiresAt
    }
    expect(requests).toEqual([
      { ...common, messageId: expect.any(String), requestId: 'req-1', proofValid: true },
      { ...common, messageId: expect.any(String), requestId: 'req-2', proofValid: false }
    ])

    // a request in another identity's name ends the session
    await peer.send({
      t: 'request',
      request: { ...base, senderIdentityKey: key(), requestId: 'r' }
    })
    await closeOf(peer)
    expect(requests).toHaveLength(2)
  })

  it('closes an idle inbound session and frees its slot', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee, { limits: { idleTimeoutMs: 300, maxConcurrent: 1 } })
    await receiver.startReceiving(accepting(payee))
    const sender = hubClient(hub, payer)

    const started = Date.now()
    const peer = await sender.connect(payee.identityKey)
    expect((await closeOf(peer))?.code).toBe('closed')
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)

    const again = await sender.connect(payee.identityKey)
    expect(again.peerIdentityKey).toBe(payee.identityKey)
  })

  it('refuses an invalid or oversize token before sending anything, leaving the session open (M19, M20)', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const handled: number[] = []
    await hubClient(hub, payee).startReceiving({
      onPayment: async p => {
        handled.push(p.token.amount)
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const peer = await sender.connect(payee.identityKey)
    const sent = jest.spyOn(peer, 'send')
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const refusals = [
      await failure(sender.sendPayment(peer, { ...token, amount: 999 })),
      await failure(sender.sendPayment(peer, { ...token, outputIndex: 1 })),
      await failure(sender.sendPayment(peer, token, { note: 'x'.repeat(501) })),
      await failure(
        sender.sendPayment(peer, {
          ...token,
          transaction: new Uint8Array(MAX_DIRECT_TRANSACTION_BYTES + 1)
        })
      )
    ]
    expect(refusals.map(e => e.code)).toEqual([
      'invalid_payment',
      'invalid_payment',
      'invalid_payment',
      'too_large'
    ])
    expect(sent).not.toHaveBeenCalled()
    expect(peer.isOpen).toBe(true)

    // the same session still delivers a good token, also as a Uint8Array
    const bytes = { ...token, transaction: Uint8Array.from(token.transaction) }
    expect(await sender.sendPayment(peer, bytes)).toMatchObject({ status: 'accepted', txid })
    expect(handled).toEqual([1000])
  })

  it('sendPayment rejects timeout and closes the session when no ack comes', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving({
      onPayment: async () => {
        await held
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const { token } = await makeToken(payer, payee.identityKey, 1000)
    const peer = await sender.connect(payee.identityKey)

    const e = await failure(sender.sendPayment(peer, token, { timeoutMs: 500 }))

    expect(e.code).toBe('timeout')
    expect((await closeOf(peer))?.code).toBe('timeout')
    release()
  })

  it('marks the signaler active while dialing and listens only while needed', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const a = await silentListener(hub)
    const b = await silentListener(hub)
    const base = hub.signaler(payer.identityKey)
    const active: boolean[] = []
    let listens = 0
    let listening = 0
    const signaler: Signaler = {
      send: (to, e) => base.send(to, e),
      listen: async fn => {
        listens++
        listening++
        const stop = await base.listen(fn)
        return async () => {
          listening--
          await stop()
        }
      },
      setActive: v => {
        active.push(v)
      }
    }
    const sender = client(payer, { signaler })

    const codes = await Promise.all([
      failure(sender.connect(a.identityKey, { timeoutMs: 800 })),
      failure(sender.connect(b.identityKey, { timeoutMs: 1200 }))
    ])

    expect(codes.map(e => e.code)).toEqual(['peer_unreachable', 'peer_unreachable'])
    expect(active).toEqual([true, false])
    expect(listens).toBe(1)
    // stopReceiving queues behind the pending unsubscribe, so it has run by now
    await sender.stopReceiving()
    expect(listening).toBe(0)
    await a.stop()
    await b.stop()
  })

  it('ignores a forged answer to a dial, which neither ends it nor burns its sid', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const intruder = await makeWallet()
    await hubClient(hub, payee).startReceiving(accepting(payee))
    const base = hub.signaler(payer.identityKey)
    const signaler: Signaler = {
      send: async (to, e) => {
        // the sid travels in the clear, so whoever sees the offer can answer it first
        const forged = await sealSignal(intruder.wallet, {
          v: 1,
          kind: 'answer',
          sid: e.sid,
          from: intruder.identityKey,
          to: payer.identityKey,
          ts: Date.now(),
          purpose: 'payment',
          sdp: 'v=0\r\n'
        })
        await hub.signaler(intruder.identityKey).send(payer.identityKey, forged)
        await base.send(to, e)
      },
      listen: fn => base.listen(fn)
    }
    const sender = client(payer, { signaler })

    // the payee's genuine answer, with the same sid, still connects the dial
    const peer = await sender.connect(payee.identityKey)
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
  })

  it('close() ends a pending dial with closed and refuses new work', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const silent = await silentListener(hub)
    const sender = hubClient(hub, payer)
    const dial = failure(sender.connect(silent.identityKey, { timeoutMs: 10000 }))
    await silent.heard

    const started = Date.now()
    await sender.close()

    expect((await dial).code).toBe('closed')
    expect(Date.now() - started).toBeLessThan(1000)
    expect((await failure(sender.connect(silent.identityKey))).code).toBe('closed')
    expect((await failure(sender.startReceiving(accepting(await makeWallet())))).code).toBe(
      'closed'
    )
    expect((await failure(sender.createOfferCode({ chain: 'test' }))).code).toBe('closed')
    await silent.stop()
  })

  it('needs a signaler, an identity key and a valid timeout to dial', async () => {
    const w = await makeWallet()
    const c = client(w)
    expect((await failure(c.connect(key()))).code).toBe('unsupported')
    expect((await failure(c.startReceiving(accepting(w)))).code).toBe('unsupported')
    expect(c.receiving).toBe(false)
    const withSignaler = hubClient(createMemoryHub(), w)
    await expect(withSignaler.connect('not a key')).rejects.toThrow(TypeError)
    await expect(withSignaler.connect(key(), { timeoutMs: 0 })).rejects.toThrow(RangeError)
  })
})

// ---------------------------------------------------------------- network binding

/** A hub signaler for `w` that keeps every envelope it sends. */
function recordingSignaler(
  hub: MemoryHub,
  w: TestWallet
): { signaler: Signaler; sent: SignalEnvelope[] } {
  const base = hub.signaler(w.identityKey)
  const sent: SignalEnvelope[] = []
  return {
    sent,
    signaler: {
      send: async (to, e) => {
        sent.push(e)
        await base.send(to, e)
      },
      listen: fn => base.listen(fn)
    }
  }
}

/** What `to` reads in a signal `from` sent it. */
function readSignal(from: TestWallet, to: TestWallet, e: SignalEnvelope): Promise<SignalPlaintext> {
  return openSignal(to.wallet, from.identityKey, e, {
    me: to.identityKey,
    replay: new ReplayCache()
  })
}

describe('DirectPayClient network binding (chain, MemoryHub, loopback WebRTC)', () => {
  it('refuses a mainnet payer at a testnet payee: wrong_network, no payee link, no payer peer', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    const acceptAnswer = jest.spyOn(PeerLink.prototype, 'acceptAnswer')
    try {
      const hub = createMemoryHub()
      const payer = await makeWallet()
      const payee = await makeWallet()
      const sessions: string[] = []
      const errors: unknown[] = []
      await hubClient(hub, payee, { chain: 'test' }).startReceiving({
        ...accepting(payee),
        onSession: k => sessions.push(k),
        onError: e => errors.push(e)
      })
      const sender = hubClient(hub, payer, { chain: 'main' })

      const refused = await failure(sender.connect(payee.identityKey))
      // a sealed reject: a dial left to time out would be peer_unreachable
      expect(refused.code).toBe('rejected')
      expect(refused.reason).toBe('wrong_network')
      expect(refused.message).toContain('wrong_network')
      // the payee gathered nothing and served nothing; the payer applied no answer
      expect(acceptOffer).not.toHaveBeenCalled()
      expect(acceptAnswer).not.toHaveBeenCalled()
      expect(sessions).toEqual([])
      expect(errors).toEqual([])
      expect(payee.internalizeAction).not.toHaveBeenCalled()
    } finally {
      acceptOffer.mockRestore()
      acceptAnswer.mockRestore()
    }
  })

  it('refuses an offer that names no network at a payee that has one (fail closed)', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    try {
      const hub = createMemoryHub()
      const payee = await makeWallet()
      await hubClient(hub, payee, { chain: 'main' }).startReceiving(accepting(payee))
      const legacy = hubClient(hub, await makeWallet())

      const refused = await failure(legacy.connect(payee.identityKey))
      expect(refused).toMatchObject({ code: 'rejected', reason: 'wrong_network' })
      expect(acceptOffer).not.toHaveBeenCalled()
    } finally {
      acceptOffer.mockRestore()
    }
  })

  it('refuses wrong-network offers within the reject budget, holding no slot', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    await hubClient(hub, payee, { chain: 'main', limits: { maxConcurrent: 1 } }).startReceiving(
      accepting(payee)
    )
    const b = hubClient(hub, await makeWallet(), { chain: 'test' })
    const c = hubClient(hub, await makeWallet(), { chain: 'test' })

    expect(await failure(b.connect(payee.identityKey, { timeoutMs: 1000 }))).toMatchObject({
      code: 'rejected',
      reason: 'wrong_network'
    })
    // the one refusal a second is spent: the next goes unanswered
    expect((await failure(c.connect(payee.identityKey, { timeoutMs: 600 }))).code).toBe(
      'peer_unreachable'
    )
    // and neither took the only slot: a payer on the payee's network still connects
    const peer = await hubClient(hub, await makeWallet(), { chain: 'main' }).connect(
      payee.identityKey
    )
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
  })

  it('answers a wrong-network offer with wrong_network even when every slot is taken', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    await hubClient(hub, payee, { chain: 'main', limits: { maxConcurrent: 1 } }).startReceiving(
      accepting(payee)
    )
    // a payer on the payee's network holds the only slot
    const holder = await hubClient(hub, await makeWallet(), { chain: 'main' }).connect(
      payee.identityKey
    )
    expect(holder.isOpen).toBe(true)

    // redialing cannot fix the network, so that is the answer rather than busy
    const refused = await failure(
      hubClient(hub, await makeWallet(), { chain: 'test' }).connect(payee.identityKey)
    )
    expect(refused).toMatchObject({ code: 'rejected', reason: 'wrong_network' })
    expect(holder.isOpen).toBe(true)
  })

  it('answers a wrong-network offer with not_receiving while it only dials', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const dialer = hubClient(hub, payee, { chain: 'main' })
    const payer = hubClient(hub, await makeWallet(), { chain: 'test' })
    // listening only for the answer to its own dial: nothing about it is disclosed. Nobody
    // answers that dial and its timeout outlasts the test, so the dialer is still listening
    // however slowly the offer below arrives; closing the dialer ends the dial.
    const silent = await silentListener(hub)
    try {
      const ownDial = failure(dialer.connect(silent.identityKey, { timeoutMs: 60_000 }))
      await silent.heard
      const refused = await failure(payer.connect(payee.identityKey))
      expect(refused).toMatchObject({ code: 'rejected', reason: 'not_receiving' })
      await dialer.close()
      expect((await ownDial).code).toBe('closed')
    } finally {
      await dialer.close()
      await silent.stop()
    }
  })

  it('refuses an answer that names no network before applying it', async () => {
    const acceptAnswer = jest.spyOn(PeerLink.prototype, 'acceptAnswer')
    try {
      const hub = createMemoryHub()
      const payee = await makeWallet()
      const sessions: string[] = []
      // a payee without a network answers, and its answer says nothing about one
      await hubClient(hub, payee).startReceiving({
        ...accepting(payee),
        onSession: k => sessions.push(k)
      })
      const sender = hubClient(hub, await makeWallet(), { chain: 'main' })

      const refused = await failure(sender.connect(payee.identityKey))
      expect(refused).toMatchObject({ code: 'rejected', reason: 'wrong_network' })
      expect(acceptAnswer).not.toHaveBeenCalled()
      expect(sessions).toEqual([])
    } finally {
      acceptAnswer.mockRestore()
    }
  })

  it('refuses an answer from another network before applying it', async () => {
    const acceptAnswer = jest.spyOn(PeerLink.prototype, 'acceptAnswer')
    try {
      const hub = createMemoryHub()
      const payer = await makeWallet()
      const payee = await makeWallet()
      // a payee that answers every offer with a genuine SDP, as a testnet wallet
      const offers: SignalPlaintext[] = []
      const payeeSignaler = hub.signaler(payee.identityKey)
      const stop = await payeeSignaler.listen((from, e) => {
        void (async () => {
          const p = await openSignal(payee.wallet, from, e, {
            me: payee.identityKey,
            replay: new ReplayCache()
          })
          offers.push(p)
          const { link, sdp } = await PeerLink.acceptOffer(p.sdp!, rtc)
          rawLinks.push(link)
          const answer = await sealSignal(payee.wallet, {
            v: 1,
            kind: 'answer',
            sid: p.sid,
            from: payee.identityKey,
            to: from,
            ts: Date.now(),
            purpose: 'payment',
            sdp,
            chain: 'test'
          })
          await payeeSignaler.send(from, answer)
        })().catch(() => undefined) // a failure here shows as the dial timing out
      })
      try {
        const sender = hubClient(hub, payer, { chain: 'main' })

        const refused = await failure(sender.connect(payee.identityKey))
        expect(refused).toMatchObject({ code: 'rejected', reason: 'wrong_network' })
        expect(refused.message).toContain('test')
        expect(acceptAnswer).not.toHaveBeenCalled()
        // the offer named the payer's network
        expect(offers.map(p => [p.kind, p.chain])).toEqual([['offer', 'main']])
      } finally {
        await stop()
      }
    } finally {
      acceptAnswer.mockRestore()
    }
  })

  it('pays when both sides are on the same network, each signal naming it', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const payerSide = recordingSignaler(hub, payer)
    const payeeSide = recordingSignaler(hub, payee)
    await client(payee, { signaler: payeeSide.signaler, chain: 'main' }).startReceiving(
      accepting(payee)
    )
    const sender = client(payer, { signaler: payerSide.signaler, chain: 'main' })
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const peer = await sender.connect(payee.identityKey)
    expect(await sender.sendPayment(peer, token)).toMatchObject({ status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)

    expect(payerSide.sent).toHaveLength(1)
    expect(payeeSide.sent).toHaveLength(1)
    const offer = await readSignal(payer, payee, payerSide.sent[0])
    const answer = await readSignal(payee, payer, payeeSide.sent[0])
    expect([offer.kind, offer.chain]).toEqual(['offer', 'main'])
    expect([answer.kind, answer.chain]).toEqual(['answer', 'main'])
  })

  it('keeps the old behaviour when neither side names a network', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const payerSide = recordingSignaler(hub, payer)
    const payeeSide = recordingSignaler(hub, payee)
    await client(payee, { signaler: payeeSide.signaler }).startReceiving(accepting(payee))
    const sender = client(payer, { signaler: payerSide.signaler })
    const { token } = await makeToken(payer, payee.identityKey, 1000)

    const peer = await sender.connect(payee.identityKey)
    expect((await sender.sendPayment(peer, token)).status).toBe('accepted')

    expect(payerSide.sent).toHaveLength(1)
    expect(payeeSide.sent).toHaveLength(1)
    const offer = await readSignal(payer, payee, payerSide.sent[0])
    const answer = await readSignal(payee, payer, payeeSide.sent[0])
    expect(offer.kind).toBe('offer')
    expect(answer.kind).toBe('answer')
    expect('chain' in offer).toBe(false)
    expect('chain' in answer).toBe(false)
  })

  it('takes a network of 1 to 16 characters from a-z and 0-9', async () => {
    const w = await makeWallet()
    for (const chain of ['main', 'test', 'ttn', 'tstn', 'a'.repeat(16)]) {
      expect(() => new DirectPayClient({ wallet: w.wallet, chain })).not.toThrow()
    }
    for (const chain of ['', 'Main', 'main-net', 'a'.repeat(17)]) {
      expect(() => new DirectPayClient({ wallet: w.wallet, chain })).toThrow(TypeError)
    }
  })
})

// ---------------------------------------------------------------- code exchange

describe('DirectPayClient code exchange (no signaler)', () => {
  it('code exchange: offer code, answer code, payment delivered and acked', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = client(payee)
    const sender = client(payer)
    const sessions: string[] = []

    const offer = await receiver.createOfferCode({
      chain: 'test',
      amount: 1000,
      handlers: { ...accepting(payee), onSession: k => sessions.push(k) }
    })
    expect(offer.code.startsWith('webrtpay1:')).toBe(true)
    expect(offer.sid).toBe(toBase64Url(decodeCode(offer.code).sid))
    expect(offer.sid).toMatch(/^[A-Za-z0-9_-]{22}$/)

    const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'test' })
    expect(answer.offer).toMatchObject({
      kind: 'offer',
      identityKey: payee.identityKey,
      chain: 'test',
      amount: 1000
    })
    // the answer does not name the payer: the payee learns who it is from the handshake
    expect(Object.keys(decodeCode(answer.answerCode)).sort()).toEqual(['kind', 'sdp', 'sid'])

    const [payeeSide, payerSide] = await Promise.all([
      offer.complete(answer.answerCode),
      answer.connected
    ])
    expect(payeeSide.peerIdentityKey).toBe(payer.identityKey)
    expect(payerSide.peerIdentityKey).toBe(payee.identityKey)

    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)
    const ack = await sender.sendPayment(payerSide, token)
    expect(ack).toMatchObject({ status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
    expect(sessions).toEqual([payer.identityKey])
  })

  it('uses the receive handlers when createOfferCode is given none', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = hubClient(hub, payee)
    await receiver.startReceiving(accepting(payee))
    const sender = client(payer)

    const offer = await receiver.createOfferCode({ chain: 'main', expiresInMs: 120000 })
    const decoded = decodeCode(offer.code)
    expect(decoded.kind === 'offer' ? decoded.expiresAt : 0).toBeGreaterThan(Date.now() + 100000)
    const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'main' })
    const [, payerSide] = await Promise.all([offer.complete(answer.answerCode), answer.connected])
    const { token } = await makeToken(payer, payee.identityKey, 1200)

    expect((await sender.sendPayment(payerSide, token)).status).toBe('accepted')
  })

  it('refuses a wrong network, swapped code kinds, a foreign answer and missing handlers', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const receiver = client(payee)
    const sender = client(payer)
    const offer = await receiver.createOfferCode({ chain: 'test' })

    expect(
      (await failure(sender.answerOfferCode(offer.code, { expectedChain: 'main' }))).code
    ).toBe('invalid_code')
    const answer = await sender.answerOfferCode(offer.code, { expectedChain: 'test' })
    expect((await failure(sender.answerOfferCode(answer.answerCode))).code).toBe('invalid_code')

    const foreign = encodeAnswerCode({
      sid: randomBytes(16),
      sdp: decodeCode(answer.answerCode).sdp
    })
    expect((await failure(offer.complete(foreign))).code).toBe('invalid_code')
    expect((await failure(offer.complete(offer.code))).code).toBe('invalid_code')
    // no handlers passed and not receiving
    expect((await failure(offer.complete(answer.answerCode))).code).toBe('unsupported')

    answer.cancel()
    offer.cancel()
    expect((await failure(answer.connected)).code).toBe('closed')
  })

  it('takes the network from the client options and needs one for an offer', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    await expect(client(payee).createOfferCode()).rejects.toThrow(TypeError)

    const offer = await client(payee, { chain: 'main' }).createOfferCode()
    expect(decodeCode(offer.code)).toMatchObject({ kind: 'offer', chain: 'main' })
    // the client's own network is the default expectedChain
    const e = await failure(client(payer, { chain: 'test' }).answerOfferCode(offer.code))
    expect(e.code).toBe('invalid_code')
    offer.cancel()
  })

  it('builds links with the RTC options given to updateRtc', async () => {
    const payee = await makeWallet()
    const c = client(payee, { chain: 'test' })
    let constructed = 0
    const Base = rtc.RTCPeerConnection
    class Counting extends Base {
      constructor(config?: RTCConfiguration) {
        super(config)
        constructed++
      }
    }
    c.updateRtc({ ...rtc, RTCPeerConnection: Counting })

    const offer = await c.createOfferCode()

    expect(constructed).toBe(1)
    offer.cancel()
  })
})

// ---------------------------------------------------------------- ICE servers and relay

/** RTC options whose peer connections record the ICE servers they are given, then use none. */
function recordingRtc(): { rtc: NodeRtcOptions; seen: RTCIceServer[][] } {
  const seen: RTCIceServer[][] = []
  const Base = rtc.RTCPeerConnection
  class Recording extends Base {
    constructor(config?: RTCConfiguration) {
      seen.push(config?.iceServers ?? [])
      super({ ...config, iceServers: [] })
    }
  }
  return { rtc: { ...rtc, RTCPeerConnection: Recording }, seen }
}

describe('DirectPayClient iceServersProvider (Ruling 27)', () => {
  const stun: RTCIceServer = { urls: 'stun:stun.example:3478' }
  const staleTurn: RTCIceServer = {
    urls: ['turn:turn.example:3478'],
    username: '1790000000:old',
    credential: 'old'
  }
  const freshTurn: RTCIceServer = {
    urls: ['turn:turn.example:3478'],
    username: '1790000600:new',
    credential: 'new'
  }
  const extra: RTCIceServer = { urls: ['stun:extra.example:3478'] }

  it('is consulted before every gather and its servers win over rtc.iceServers with the same urls', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const recording = recordingRtc()
    let calls = 0
    const o: Partial<DirectPayClientOptions> = {
      rtc: { ...recording.rtc, iceServers: [stun, staleTurn] },
      chain: 'test',
      iceServersProvider: async () => {
        calls++
        return [freshTurn, extra]
      }
    }
    const receiver = hubClient(hub, payee, o)
    await receiver.startReceiving(accepting(payee))
    const sender = hubClient(hub, payer, o)

    // the dial gathers on the payer, the answer on the payee
    const peer = await sender.connect(payee.identityKey)
    expect(calls).toBe(2)
    peer.close()
    const offer = await receiver.createOfferCode()
    const answer = await sender.answerOfferCode(offer.code)
    expect(calls).toBe(4)
    expect(recording.seen).toEqual(Array(4).fill([stun, freshTurn, extra]))
    answer.cancel()
    offer.cancel()
  })

  it('falls back to rtc.iceServers when the provider fails, so the dial still connects', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const recording = recordingRtc()
    const rtcWithStun = { ...recording.rtc, iceServers: [stun] }
    const reported: Record<string, unknown[]> = { payee: [], payer: [], odd: [], notAList: [] }
    const limited = new WebRTPayError('rate_limited', 'Relay rate limit reached')
    const receiver = hubClient(hub, payee, {
      rtc: rtcWithStun,
      iceServersProvider: async () => {
        throw limited
      },
      onIceServersProviderError: e => {
        reported.payee.push(e)
        throw new Error('a throwing hook changes nothing')
      }
    })
    await receiver.startReceiving(accepting(payee))
    const noRelay = new Error('no relay configured')
    const sender = hubClient(hub, payer, {
      rtc: rtcWithStun,
      // a provider that throws before returning a promise
      iceServersProvider: () => {
        throw noRelay
      },
      onIceServersProviderError: e => reported.payer.push(e)
    })
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)
    const peer = await sender.connect(payee.identityKey)
    expect(await sender.sendPayment(peer, token)).toMatchObject({ status: 'accepted', txid })
    expect(reported.payer).toEqual([noRelay])
    expect(reported.payee).toEqual([limited])

    // no list, or entries that are not ICE servers, count as nothing
    const odd = client(payee, {
      rtc: rtcWithStun,
      chain: 'test',
      iceServersProvider: async () => [
        { url: 'stun:old.example' } as unknown as RTCIceServer,
        extra
      ],
      onIceServersProviderError: e => reported.odd.push(e)
    })
    const notAList = client(payee, {
      rtc: rtcWithStun,
      chain: 'test',
      iceServersProvider: async () => 'stun:x' as unknown as RTCIceServer[],
      onIceServersProviderError: e => reported.notAList.push(e)
    })
    ;(await odd.createOfferCode()).cancel()
    ;(await notAList.createOfferCode()).cancel()
    expect(recording.seen).toEqual([[stun], [stun], [stun, extra], [stun]])
    // a list is an answer, even with entries dropped from it
    expect(reported.odd).toEqual([])
    expect(reported.notAList).toEqual([expect.any(TypeError)])
  })

  it('gives up on a provider that has not answered after 5 s', async () => {
    const payee = await makeWallet()
    const recording = recordingRtc()
    const reported: unknown[] = []
    let asked!: () => void
    const providerAsked = new Promise<void>(resolve => (asked = resolve))
    const c = client(payee, {
      rtc: { ...recording.rtc, iceServers: [stun] },
      chain: 'test',
      iceServersProvider: () => {
        asked()
        return new Promise<RTCIceServer[]>(() => {})
      },
      onIceServersProviderError: e => reported.push(e)
    })
    // Only the provider's deadline runs on the fake clock: the clock is real again before the
    // gather that follows it, which is real WebRTC.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
    const pending = c.createOfferCode()
    try {
      await providerAsked // its deadline is set by now
      await jest.advanceTimersByTimeAsync(4999)
      expect(reported).toEqual([])
      expect(recording.seen).toEqual([])
      jest.advanceTimersByTime(1)
    } finally {
      jest.useRealTimers()
    }
    const offer = await pending
    expect(reported).toEqual([expect.objectContaining({ code: 'timeout' })])
    expect(reported[0]).toBeInstanceOf(WebRTPayError)
    expect(recording.seen).toEqual([[stun]])
    offer.cancel()
  })
})

describe('DirectPayClient over a relay (RelaySignaler, loopback WebRTC)', () => {
  const fixtures = relayFixtures()
  afterEach(fixtures.cleanup)

  /** A RelaySignaler at `r` for `w`, closed after the test. */
  function relaySignaler(r: RelayServer, w: TestWallet): RelaySignaler {
    const s = new RelaySignaler({ url: r.url, wallet: w.wallet })
    fixtures.defer(() => s.close())
    return s
  }

  it('full DirectPayClient payment through RelaySignalers (Ruling 7)', async () => {
    const r = await fixtures.relay()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const sessions: string[] = []
    const receiver = client(payee, { signaler: relaySignaler(r, payee) })
    await receiver.startReceiving({ ...accepting(payee), onSession: k => sessions.push(k) })
    const sender = client(payer, { signaler: relaySignaler(r, payer) })
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const peer = await sender.connect(payee.identityKey)
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
    const ack = await sender.sendPayment(peer, token, { note: 'over the relay' })

    expect(ack).toEqual({ t: 'payment.ack', id: ack.id, status: 'accepted', txid })
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
    const [args] = payee.internalizeAction.mock.calls[0]
    expect(args.outputs[0].paymentRemittance?.senderIdentityKey).toBe(payer.identityKey)
    expect(sessions).toEqual([payer.identityKey])
    // the payer's signaler is held only while dialing
    await waitFor(() => r.stats().identities === 1)
  })
})

// ---------------------------------------------------------------- audit hardening

describe('DirectPayClient inbound limits (MemoryHub, loopback WebRTC)', () => {
  it('gives a sender one session at a time; its extra offers get no reply and no budget', async () => {
    const acceptOffer = jest.spyOn(PeerLink, 'acceptOffer')
    try {
      const hub = createMemoryHub()
      const payee = await makeWallet()
      await hubClient(hub, payee, { limits: { maxConcurrent: 1 } }).startReceiving(accepting(payee))
      const a = hubClient(hub, await makeWallet())
      const b = hubClient(hub, await makeWallet())

      const first = await a.connect(payee.identityKey)
      // A already has the only session: its second offer is dropped unanswered...
      expect((await failure(a.connect(payee.identityKey, { timeoutMs: 1000 }))).code).toBe(
        'peer_unreachable'
      )
      // ...without spending the reject budget, so B is still told the payee is busy
      const busy = await failure(b.connect(payee.identityKey, { timeoutMs: 1000 }))
      expect(busy.code).toBe('rejected')
      expect(busy.message).toContain('busy')
      expect(acceptOffer).toHaveBeenCalledTimes(1)

      first.close()
      await sleep(200)
      expect((await a.connect(payee.identityKey)).peerIdentityKey).toBe(payee.identityKey)
    } finally {
      acceptOffer.mockRestore()
    }
  })

  it('answers refusals at most once a second and drops the rest unanswered', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    await hubClient(hub, payee, { limits: { maxConcurrent: 1 } }).startReceiving(accepting(payee))
    await hubClient(hub, await makeWallet()).connect(payee.identityKey)
    const b = hubClient(hub, await makeWallet())
    const c = hubClient(hub, await makeWallet())

    expect((await failure(b.connect(payee.identityKey, { timeoutMs: 1000 }))).code).toBe('rejected')
    const refusedAt = Date.now()
    expect((await failure(c.connect(payee.identityKey, { timeoutMs: 600 }))).code).toBe(
      'peer_unreachable'
    )
    await sleep(Math.max(0, refusedAt + 1100 - Date.now()))
    expect((await failure(c.connect(payee.identityKey, { timeoutMs: 1000 }))).code).toBe('rejected')
  })

  it('caps what a dialer sends before it authenticates at 64 KiB, and says so (M12, M14)', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const errors: unknown[] = []
    await hubClient(hub, payee).startReceiving({
      ...accepting(payee),
      onError: e => errors.push(e)
    })
    const dialer = await makeWallet()
    const { link, answer } = await rawDial(hub, dialer, payee.identityKey)
    const refused = new Promise<unknown>(resolve =>
      link.onMessage(m => {
        if ((m as { t?: unknown }).t === 'error') resolve(m)
      })
    )
    await link.acceptAnswer(answer)
    await link.waitOpen(10000)
    const nonce = toBase64(randomBytes(32))
    await link.send({
      t: 'hello',
      v: 1,
      identityKey: dialer.identityKey,
      nonce,
      pad: 'x'.repeat(65536)
    })
    expect(await refused).toEqual({
      t: 'error',
      code: 'too_large',
      message: 'Message exceeds 65536 bytes'
    })
    await waitFor(() => errors.length === 1)
    expect(errors[0]).toMatchObject({ code: 'too_large' })
  })

  it('rejects sendPayment too_large when the payee says the payment is over its cap (M14)', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    const errors: unknown[] = []
    await hubClient(hub, payee, { limits: { maxMessageBytes: 100_000 } }).startReceiving({
      ...accepting(payee),
      onError: e => errors.push(e)
    })
    const sender = hubClient(hub, payer)
    const { token } = await makeToken(payer, payee.identityKey, 1000, 200_000)
    const peer = await sender.connect(payee.identityKey)
    const e = await failure(sender.sendPayment(peer, token))
    expect(e.code).toBe('too_large')
    expect(e.message).toContain('100000')
    expect(payee.internalizeAction).not.toHaveBeenCalled()
    expect((await closeOf(peer))?.code).toBe('too_large')
  })

  it('rejects sendPayment closed when the payee reports another error before the ack', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    let session: AuthenticatedPeer | undefined
    const offer = await client(payee, { chain: 'main' }).createOfferCode({
      handlers: {
        onPayment: async () => {
          await session!.send({ t: 'error', code: 'storage', message: 'disk full' })
          return new Promise<never>(() => undefined)
        }
      }
    })
    const sender = client(payer, { chain: 'main' })
    const answer = await sender.answerOfferCode(offer.code)
    const [payeeSide, peer] = await Promise.all([
      offer.complete(answer.answerCode),
      answer.connected
    ])
    session = payeeSide
    const { token } = await makeToken(payer, payee.identityKey, 1000)
    const e = await failure(sender.sendPayment(peer, token))
    expect(e.code).toBe('closed')
    expect(e.message).toContain('storage')
  })

  it('reports signals it cannot open to onError, at most once every 10 s (M23)', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const errors: unknown[] = []
    await hubClient(hub, payee).startReceiving({
      ...accepting(payee),
      onError: e => errors.push(e)
    })
    const junk = hub.signaler(key())
    for (let i = 0; i < 5; i++) await junk.send(payee.identityKey, junkEnvelope())
    await waitFor(() => errors.length > 0)
    await sleep(200)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'invalid_signal' })

    // a wallet that cannot decrypt (locked, or refusing the app) is visible the same way
    const locked = await makeWallet()
    const refusal = new Error('wallet is locked')
    jest.spyOn(locked.wallet, 'decrypt').mockRejectedValue(refusal)
    const lockedErrors: unknown[] = []
    await hubClient(hub, locked).startReceiving({
      ...accepting(locked),
      onError: e => lockedErrors.push(e)
    })
    const dialer = hubClient(hub, await makeWallet())
    const dial = failure(dialer.connect(locked.identityKey, { timeoutMs: 1000 }))
    await waitFor(() => lockedErrors.length > 0)
    expect(lockedErrors[0]).toMatchObject({ code: 'invalid_signal', cause: refusal })
    expect((await dial).code).toBe('peer_unreachable')
  })

  it('frees the slot as soon as an inbound handshake fails', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const errors: unknown[] = []
    await hubClient(hub, payee, { limits: { maxConcurrent: 1 } }).startReceiving({
      ...accepting(payee),
      onError: e => errors.push(e)
    })
    const { link, answer } = await rawDial(hub, await makeWallet(), payee.identityKey)
    await link.acceptAnswer(answer)
    await link.waitOpen(5000)
    await link.send({ t: 'hello', v: 1, identityKey: 'not a key', nonce: 'x' })
    await eventually(async () => {
      if (errors.length === 0) throw new Error('no failure yet')
    })
    expect(errors[0]).toMatchObject({ code: 'auth_failed' })

    const sender = hubClient(hub, await makeWallet())
    expect((await sender.connect(payee.identityKey)).peerIdentityKey).toBe(payee.identityKey)
  })

  it('counts the inbound open and handshake budget from when the answer has been sent', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const payer = await makeWallet()
    // The carrier is slow both ways: the answer takes 1 s to send and reaches the payer
    // 1.5 s after that. The payee's 2.5 s budget runs from 1 s, so the handshake (which
    // cannot start before 2.5 s) fits; counted from the offer it would not.
    const payeeBase = hub.signaler(payee.identityKey)
    await client(payee, {
      signaler: {
        send: async (to, e) => {
          await sleep(1000)
          await payeeBase.send(to, e)
        },
        listen: fn => payeeBase.listen(fn)
      },
      timeouts: { connectMs: 2500 }
    }).startReceiving(accepting(payee))
    const payerBase = hub.signaler(payer.identityKey)
    const sender = client(payer, {
      signaler: {
        send: (to, e) => payerBase.send(to, e),
        listen: fn => payerBase.listen((from, e) => void setTimeout(() => fn(from, e), 1500))
      },
      timeouts: { connectMs: 8000 }
    })

    expect((await sender.connect(payee.identityKey)).peerIdentityKey).toBe(payee.identityKey)
  })

  it('drops an inbound dialer that never says hello after connectMs, not 15 s', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const errors: Array<{ e: unknown; at: number }> = []
    await hubClient(hub, payee, { timeouts: { connectMs: 1000 } }).startReceiving({
      ...accepting(payee),
      onError: e => errors.push({ e, at: Date.now() })
    })

    const { link, answer } = await rawDial(hub, await makeWallet(), payee.identityKey)
    const answeredAt = Date.now()
    await link.acceptAnswer(answer)
    await eventually(async () => {
      if (errors.length === 0) throw new Error('no failure yet')
    }, 40)
    expect(errors[0].e).toMatchObject({ code: 'timeout' })
    expect(errors[0].at - answeredAt).toBeLessThan(3000)
  })

  it('frees the slot after connectMs when the answer cannot be sent', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const stuck = await makeWallet()
    const base = hub.signaler(payee.identityKey)
    const signaler: Signaler = {
      send: (to, e) => (to === stuck.identityKey ? new Promise(() => {}) : base.send(to, e)),
      listen: fn => base.listen(fn)
    }
    await client(payee, {
      signaler,
      limits: { maxConcurrent: 1 },
      timeouts: { connectMs: 1000 }
    }).startReceiving(accepting(payee))
    const dial = failure(hubClient(hub, stuck).connect(payee.identityKey, { timeoutMs: 1500 }))
    expect((await dial).code).toBe('peer_unreachable')

    const sender = hubClient(hub, await makeWallet())
    expect((await sender.connect(payee.identityKey)).peerIdentityKey).toBe(payee.identityKey)
  })

  it('closes a session that sends nothing within firstMessageTimeoutMs of the handshake', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    await hubClient(hub, payee, {
      limits: { idleTimeoutMs: 60000, firstMessageTimeoutMs: 300 }
    }).startReceiving(accepting(payee))
    const sender = hubClient(hub, payer)

    const quiet = await sender.connect(payee.identityKey)
    const started = Date.now()
    expect((await closeOf(quiet))?.code).toBe('closed')
    expect(Date.now() - started).toBeLessThan(3000)

    // a peer that speaks first is on the idle timeout from then on
    const chatty = await sender.connect(payee.identityKey)
    await chatty.send({ t: 'payment.ack', id: 'traffic', status: 'accepted' })
    await sleep(1000)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)
    expect(await sender.sendPayment(chatty, token)).toMatchObject({ status: 'accepted', txid })
  })

  it('fails sendPayment fast with closed once the payee has hung up, and a re-dial delivers (R2, M15)', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    await hubClient(hub, payee, {
      limits: { firstMessageTimeoutMs: 300 }
    }).startReceiving(accepting(payee, memorySeen()))
    const sender = hubClient(hub, payer)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)

    const slow = await sender.connect(payee.identityKey)
    expect(slow.isOpen).toBe(true)
    // the payer takes longer than the payee's first-message window to prepare
    await closeOf(slow)
    expect(slow.isOpen).toBe(false)
    const sent = jest.spyOn(slow, 'send')
    const e = await failure(sender.sendPayment(slow, token))
    expect(e.code).toBe('closed')
    expect(sent).not.toHaveBeenCalled()

    const again = await sender.connect(payee.identityKey)
    expect(await sender.sendPayment(again, token)).toMatchObject({ status: 'accepted', txid })
  })

  it('ends an inbound session after maxSessionMs however busy it is', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    await hubClient(hub, payee, {
      limits: { idleTimeoutMs: 60000, maxSessionMs: 800 }
    }).startReceiving(accepting(payee))
    const peer = await hubClient(hub, await makeWallet()).connect(payee.identityKey)
    const started = Date.now()
    const closed = closeOf(peer)
    const chatter = setInterval(() => {
      peer.send({ t: 'payment.ack', id: 'traffic', status: 'accepted' }).catch(() => undefined)
    }, 100)
    try {
      expect((await closed)?.code).toBe('closed')
    } finally {
      clearInterval(chatter)
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(700)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('decrypts at most 10 signals from one sender and a burst of 40 overall', async () => {
    const hub = createMemoryHub()
    const payee = await makeWallet()
    const decrypt = jest.spyOn(payee.wallet, 'decrypt')
    await hubClient(hub, payee).startReceiving(accepting(payee))
    const loud = hub.signaler(key())
    for (let i = 0; i < 25; i++) await loud.send(payee.identityKey, junkEnvelope())
    await sleep(200)
    expect(decrypt).toHaveBeenCalledTimes(10)
    // one loud sender has not used up everyone else's budget
    const sender = hubClient(hub, await makeWallet())
    expect((await sender.connect(payee.identityKey)).peerIdentityKey).toBe(payee.identityKey)

    const other = await makeWallet()
    const opened = jest.spyOn(other.wallet, 'decrypt')
    await hubClient(hub, other).startReceiving(accepting(other))
    await Promise.all(
      Array.from({ length: 80 }, () => hub.signaler(key()).send(other.identityKey, junkEnvelope()))
    )
    await sleep(200)
    expect(opened.mock.calls.length).toBeGreaterThanOrEqual(40)
    expect(opened.mock.calls.length).toBeLessThanOrEqual(45)
  })

  it("lets answers to the client's own dial past the intake budgets", async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    await hubClient(hub, payee).startReceiving(accepting(payee))
    const base = hub.signaler(payer.identityKey)
    const signaler: Signaler = {
      send: async (to, e) => {
        // junk in the payee's name spends the payee's whole per-sender budget first
        const asPayee = hub.signaler(payee.identityKey)
        for (let i = 0; i < 12; i++) await asPayee.send(payer.identityKey, junkEnvelope())
        await base.send(to, e)
      },
      listen: fn => base.listen(fn)
    }
    const sender = client(payer, { signaler })
    expect((await sender.connect(payee.identityKey)).peerIdentityKey).toBe(payee.identityKey)
  })
})

describe('DirectPayClient payments and offers (audit hardening)', () => {
  it('accepts one payment once when two sessions deliver it at the same time', async () => {
    const hub = createMemoryHub()
    const payer = await makeWallet()
    const payee = await makeWallet()
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const handled: string[] = []
    const receiver = hubClient(hub, payee, { chain: 'test' })
    await receiver.startReceiving({
      onPayment: async p => {
        handled.push(p.messageId)
        await gate
        // no SeenStore: only the client's own serialisation prevents a second internalize
        await acceptDirectPayment(payee.wallet, p)
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer, { chain: 'test' })
    // the same payer on two sessions: one dialled, one by code exchange
    const remote = await sender.connect(payee.identityKey)
    const offer = await receiver.createOfferCode()
    const answer = await sender.answerOfferCode(offer.code)
    const [, local] = await Promise.all([offer.complete(answer.answerCode), answer.connected])
    const { token, txid } = await makeToken(payer, payee.identityKey, 3000)

    const first = sender.sendPayment(remote, token)
    const second = eventually(async () => {
      if (handled.length === 0) throw new Error('not delivered yet')
    }).then(() => sender.sendPayment(local, token))
    // Settled either way below; a failed expectation must not leave them unhandled.
    const acked = Promise.all([first, second])
    acked.catch(() => undefined)
    try {
      await eventually(async () => {
        if (handled.length === 0) throw new Error('not delivered yet')
      })
      await sleep(500)
      // the second delivery is waiting for the first one's decision, not deciding again
      expect(handled).toHaveLength(1)
    } finally {
      release()
    }

    const acks = await acked
    expect(acks.map(a => a.status)).toEqual(['accepted', 'accepted'])
    expect(acks.map(a => a.txid)).toEqual([txid, txid])
    expect(payee.internalizeAction).toHaveBeenCalledTimes(1)
  })

  it('will not complete an expired offer, and closes its link when it expires', async () => {
    const createOffer = jest.spyOn(PeerLink, 'createOffer')
    try {
      const payee = await makeWallet()
      const offer = await client(payee).createOfferCode({
        chain: 'test',
        expiresInMs: 1500,
        handlers: accepting(payee)
      })
      const { link } = await (createOffer.mock.results[0].value as Promise<{ link: PeerLink }>)
      const answer = await client(await makeWallet()).answerOfferCode(offer.code)
      const decoded = decodeCode(offer.code, { now: 0 })
      const expiresAt = decoded.kind === 'offer' ? decoded.expiresAt! : 0

      expect((await closeOf(link))?.code).toBe('timeout')
      expect(Date.now()).toBeGreaterThanOrEqual(expiresAt)
      expect((await failure(offer.complete(answer.answerCode))).code).toBe('invalid_code')
      answer.cancel()
    } finally {
      createOffer.mockRestore()
    }
  })

  it('keeps a completed offer session open past the offer expiry', async () => {
    const payer = await makeWallet()
    const payee = await makeWallet()
    const sender = client(payer)
    const offer = await client(payee).createOfferCode({
      chain: 'test',
      expiresInMs: 1500,
      handlers: accepting(payee)
    })
    const answer = await sender.answerOfferCode(offer.code)
    const [, payerSide] = await Promise.all([offer.complete(answer.answerCode), answer.connected])
    await sleep(1600)
    const { token, txid } = await makeToken(payer, payee.identityKey, 1000)
    expect(await sender.sendPayment(payerSide, token)).toMatchObject({ status: 'accepted', txid })
  })
})
