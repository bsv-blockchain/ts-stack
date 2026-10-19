/**
 * Presence: a dial's `knock` and the receiver's `ring`, and the dial timeouts built on them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { PeerLink } from '../src/channel/PeerLink.js'
import { DirectPayClient } from '../src/client/DirectPayClient.js'
import type { DirectPayClientOptions, ReceiveHandlers } from '../src/client/DirectPayClient.js'
import { ReplayCache, openSignal, sealSignal } from '../src/signaling/envelope.js'
import { createMemoryHub } from '../src/signaling/MemorySignaler.js'
import type { MemoryHub } from '../src/signaling/MemorySignaler.js'
import type { SignalKind, SignalPlaintext } from '../src/signaling/types.js'
import { randomBytes, toBase64Url } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import { cleanupRtc, nodeRtc } from './helpers/rtc.js'
import type { NodeRtcOptions } from './helpers/rtc.js'
import { makeToken, makeWallet } from './helpers/wallet.js'
import type { TestWallet } from './helpers/wallet.js'

afterAll(cleanupRtc)

let rtc: NodeRtcOptions
beforeAll(async () => {
  rtc = await nodeRtc()
})

const clients: DirectPayClient[] = []
const rawLinks: PeerLink[] = []
const stops: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const link of rawLinks.splice(0)) link.close()
  await Promise.all(stops.splice(0).map(stop => stop()))
  await Promise.all(clients.splice(0).map(c => c.close()))
})

function hubClient(
  hub: MemoryHub,
  w: TestWallet,
  o: Partial<DirectPayClientOptions> = {}
): DirectPayClient {
  const c = new DirectPayClient({
    wallet: w.wallet,
    rtc,
    signaler: hub.signaler(w.identityKey),
    timeouts: { connectMs: 10000, ackMs: 10000 },
    ...o
  })
  clients.push(c)
  return c
}

const accepting: ReceiveHandlers = { onPayment: () => Promise.resolve('accepted') }

async function failure(p: Promise<unknown>): Promise<WebRTPayError> {
  try {
    await p
  } catch (e) {
    if (e instanceof WebRTPayError) return e
    throw e
  }
  throw new Error('Expected a rejection')
}

function newSid(): string {
  return toBase64Url(randomBytes(16))
}

/** Retry `fn` every 100 ms until it resolves, up to 20 tries. */
async function eventually<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (i >= 20) throw e
      await sleep(100)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * `w` signalling by hand on `hub`: send sealed signals and collect every signal it is sent,
 * in order.
 */
async function handSignaler(
  hub: MemoryHub,
  w: TestWallet
): Promise<{
  send(kind: SignalKind, to: string, sid: string, extra?: Partial<SignalPlaintext>): Promise<void>
  received: SignalPlaintext[]
  next(within?: number): Promise<SignalPlaintext | undefined>
}> {
  const signaler = hub.signaler(w.identityKey)
  const received: SignalPlaintext[] = []
  const waiting: Array<() => void> = []
  const replay = new ReplayCache()
  stops.push(
    await signaler.listen((from, e) => {
      void openSignal(w.wallet, from, e, { me: w.identityKey, replay })
        .then(p => {
          received.push(p)
          for (const wake of waiting.splice(0)) wake()
        })
        .catch(() => undefined)
    })
  )
  let read = 0
  return {
    received,
    async send(kind, to, sid, extra = {}) {
      const e = await sealSignal(w.wallet, {
        v: 1,
        kind,
        sid,
        from: w.identityKey,
        to,
        ts: Date.now(),
        purpose: 'payment',
        ...extra
      })
      await signaler.send(to, e)
    },
    async next(within = 1000) {
      if (read >= received.length) {
        await Promise.race([new Promise<void>(resolve => waiting.push(resolve)), sleep(within)])
      }
      return read < received.length ? received[read++] : undefined
    }
  }
}

/** A real offer SDP from a raw link that is closed after the test. */
async function offerSdp(): Promise<string> {
  const { link, sdp } = await PeerLink.createOffer({ ...rtc, maxMessageBytes: 65536 })
  rawLinks.push(link)
  return sdp
}

describe('DirectPayClient answers knocks (MemoryHub)', () => {
  it('replies ring to a knock while receiving', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee).startReceiving(accepting)
    const hand = await handSignaler(hub, dialer)
    const sid = newSid()
    await hand.send('knock', payee.identityKey, sid)
    expect(await hand.next()).toMatchObject({ kind: 'ring', sid, from: payee.identityKey })
    expect(hand.received.find(p => p.sdp !== undefined)).toBeUndefined()
  })

  it('names its network in a ring', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee, { chain: 'main' }).startReceiving(accepting)
    const hand = await handSignaler(hub, dialer)
    await hand.send('knock', payee.identityKey, newSid(), { chain: 'main' })
    expect(await hand.next()).toMatchObject({ kind: 'ring', chain: 'main' })
  })

  it('replies not_receiving to a knock when not receiving', async () => {
    const hub = createMemoryHub()
    const [payee, dialer, silent] = await Promise.all([makeWallet(), makeWallet(), makeWallet()])
    const payeeClient = hubClient(hub, payee)
    // A dial in progress keeps the payee listening while it is not receiving.
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const ownDial = failure(payeeClient.connect(silent.identityKey, { presenceTimeoutMs: 60000 }))
    await sleep(50)
    const hand = await handSignaler(hub, dialer)
    const sid = newSid()
    await hand.send('knock', payee.identityKey, sid)
    expect(await hand.next()).toMatchObject({ kind: 'reject', sid, reason: 'not_receiving' })
    await payeeClient.close()
    expect((await ownDial).code).toBe('closed')
  })

  it('stays silent to a knock from a sender over its limit', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee, { limits: { offersPerMinutePerSender: 1 } }).startReceiving(
      accepting
    )
    const hand = await handSignaler(hub, dialer)
    // One offer uses the sender's offers for the minute.
    await hand.send('offer', payee.identityKey, newSid(), { sdp: await offerSdp() })
    expect(await hand.next(5000)).toMatchObject({ kind: 'answer' })
    await hand.send('knock', payee.identityKey, newSid())
    expect(await hand.next(500)).toBeUndefined()
  })

  it('replies wrong_network to a knock naming another chain, or none', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee, { chain: 'main' }).startReceiving(accepting)
    const hand = await handSignaler(hub, dialer)
    await hand.send('knock', payee.identityKey, newSid(), { chain: 'test' })
    expect(await hand.next()).toMatchObject({ kind: 'reject', reason: 'wrong_network' })
    // Refusals are answered at most once a second.
    await sleep(1100)
    await hand.send('knock', payee.identityKey, newSid())
    expect(await hand.next()).toMatchObject({ kind: 'reject', reason: 'wrong_network' })
  })

  it('still answers a bare offer (a 0.1.0 payer), and refuses one from another network', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee, { chain: 'main' }).startReceiving(accepting)
    const hand = await handSignaler(hub, dialer)
    await hand.send('offer', payee.identityKey, newSid(), { sdp: await offerSdp(), chain: 'test' })
    expect(await hand.next()).toMatchObject({ kind: 'reject', reason: 'wrong_network' })
    await hand.send('offer', payee.identityKey, newSid(), { sdp: await offerSdp(), chain: 'main' })
    expect(await hand.next(5000)).toMatchObject({ kind: 'answer', chain: 'main' })
  })

  it('replies busy to a knock while every session slot is taken', async () => {
    const hub = createMemoryHub()
    const [payee, holder, dialer] = await Promise.all([makeWallet(), makeWallet(), makeWallet()])
    await hubClient(hub, payee, { limits: { maxConcurrent: 1 } }).startReceiving(accepting)
    const held = await hubClient(hub, holder).connect(payee.identityKey)
    const hand = await handSignaler(hub, dialer)
    await hand.send('knock', payee.identityKey, newSid())
    expect(await hand.next()).toMatchObject({ kind: 'reject', reason: 'busy' })
    held.close()
  })

  it('answers back-to-back knocks with rings, beyond the reject budget', async () => {
    const hub = createMemoryHub()
    const [payee, ...dialers] = await Promise.all(Array.from({ length: 4 }, () => makeWallet()))
    await hubClient(hub, payee).startReceiving(accepting)
    const hands = await Promise.all(dialers.map(d => handSignaler(hub, d)))
    await Promise.all(hands.map(h => h.send('knock', payee.identityKey, newSid())))
    for (const h of hands) expect(await h.next()).toMatchObject({ kind: 'ring' })
  })

  it('takes the offer that follows its ring, with the same sid', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee).startReceiving(accepting)
    const hand = await handSignaler(hub, dialer)
    const sid = newSid()
    await hand.send('knock', payee.identityKey, sid)
    expect(await hand.next()).toMatchObject({ kind: 'ring', sid })
    await hand.send('offer', payee.identityKey, sid, { sdp: await offerSdp() })
    expect(await hand.next(5000)).toMatchObject({ kind: 'answer', sid })
  })

  it('still pays end to end', async () => {
    const hub = createMemoryHub()
    const [payee, payer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee).startReceiving(accepting)
    const sender = hubClient(hub, payer)
    const peer = await sender.connect(payee.identityKey)
    const { token } = await makeToken(payer, payee.identityKey, 1000)
    expect((await sender.sendPayment(peer, token)).status).toBe('accepted')
  })
})

describe('DirectPayClient knock-first dial (MemoryHub, loopback WebRTC)', () => {
  /** A hand-driven payee that rings `ringAfterMs` after each knock and then says nothing. */
  async function ringOnly(
    hub: MemoryHub,
    ringAfterMs: number
  ): Promise<{ identityKey: string; received: SignalPlaintext[] }> {
    const w = await makeWallet()
    const hand = await handSignaler(hub, w)
    void (async () => {
      for (;;) {
        const p = await hand.next(60000)
        if (p === undefined) return
        if (p.kind !== 'knock') continue
        await sleep(ringAfterMs)
        await hand.send('ring', p.from, p.sid)
      }
    })().catch(() => undefined)
    return { identityKey: w.identityKey, received: hand.received }
  }

  it('reports peer_unreachable within presence when nobody answers', async () => {
    const hub = createMemoryHub()
    const silent = await makeWallet()
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const sender = hubClient(hub, await makeWallet())
    const started = Date.now()
    const e = await failure(sender.connect(silent.identityKey))
    const elapsed = Date.now() - started
    expect(e).toMatchObject({
      code: 'peer_unreachable',
      message: 'No answer from the recipient in 2000 ms'
    })
    expect(elapsed).toBeGreaterThanOrEqual(1950)
    expect(elapsed).toBeLessThan(2100)
  })

  it('takes the presence clock from the client options, then from the call', async () => {
    const hub = createMemoryHub()
    const silent = await makeWallet()
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const sender = hubClient(hub, await makeWallet(), {
      timeouts: { connectMs: 10000, presenceMs: 300 }
    })
    let started = Date.now()
    expect((await failure(sender.connect(silent.identityKey))).message).toContain('300 ms')
    expect(Date.now() - started).toBeLessThan(1000)
    started = Date.now()
    const e = await failure(sender.connect(silent.identityKey, { presenceTimeoutMs: 600 }))
    expect(e.message).toContain('600 ms')
    expect(Date.now() - started).toBeGreaterThanOrEqual(550)
  })

  it('fails fast with rejected not_receiving', async () => {
    const hub = createMemoryHub()
    const [payee, payer, silent] = await Promise.all([makeWallet(), makeWallet(), makeWallet()])
    const receiver = hubClient(hub, payee)
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const ownDial = failure(receiver.connect(silent.identityKey, { presenceTimeoutMs: 60000 }))
    await sleep(50)
    const started = Date.now()
    const e = await failure(hubClient(hub, payer).connect(payee.identityKey))
    expect(e).toMatchObject({ code: 'rejected', reason: 'not_receiving' })
    expect(Date.now() - started).toBeLessThan(500)
    await receiver.close()
    expect((await ownDial).code).toBe('closed')
  })

  it('times out from the ring, not from the start of the dial', async () => {
    const hub = createMemoryHub()
    const payee = await ringOnly(hub, 750)
    const sender = hubClient(hub, await makeWallet())
    const started = Date.now()
    const e = await failure(
      sender.connect(payee.identityKey, { presenceTimeoutMs: 1000, dialTimeoutMs: 2000 })
    )
    const elapsed = Date.now() - started
    expect(e).toMatchObject({
      code: 'timeout',
      message: "Connection not established within 2000 ms of the recipient's reply"
    })
    expect(elapsed).toBeGreaterThanOrEqual(2700)
    expect(elapsed).toBeLessThan(3500)
    // the offer went out only after the ring
    expect(payee.received.map(p => p.kind)).toEqual(['knock', 'offer'])
  })

  it('still caps the whole dial with timeoutMs', async () => {
    const hub = createMemoryHub()
    const payee = await ringOnly(hub, 0)
    const sender = hubClient(hub, await makeWallet())
    const e = await failure(sender.connect(payee.identityKey, { timeoutMs: 800 }))
    expect(e).toMatchObject({
      code: 'timeout',
      message: 'Connection not established within 800 ms'
    })
    const silent = await makeWallet()
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const quiet = await failure(sender.connect(silent.identityKey, { timeoutMs: 500 }))
    expect(quiet).toMatchObject({
      code: 'peer_unreachable',
      message: 'No answer from the recipient in 500 ms'
    })
  })

  it('abort signal cancels only that dial', async () => {
    const hub = createMemoryHub()
    const [payee, payer, silent] = await Promise.all([makeWallet(), makeWallet(), makeWallet()])
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    await hubClient(hub, payee).startReceiving(accepting)
    const sender = hubClient(hub, payer)

    const controller = new AbortController()
    const cancelled = failure(
      sender.connect(silent.identityKey, { signal: controller.signal, presenceTimeoutMs: 60000 })
    )
    const other = sender.connect(payee.identityKey)
    await sleep(50)
    const started = Date.now()
    controller.abort()
    expect(await cancelled).toMatchObject({ code: 'closed', message: 'Dial cancelled' })
    expect(Date.now() - started).toBeLessThan(200)

    // the other dial, and the receiver, keep running
    const peer = await other
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
    peer.close()
    const again = await eventually(() =>
      sender.connect(payee.identityKey, { presenceTimeoutMs: 300 })
    )
    expect(again.peerIdentityKey).toBe(payee.identityKey)

    // a signal that has already aborted refuses at once
    expect(
      await failure(sender.connect(payee.identityKey, { signal: AbortSignal.abort() }))
    ).toMatchObject({ code: 'closed', message: 'Dial cancelled' })
  })

  it('closes a link gathered after the dial was refused', async () => {
    const hub = createMemoryHub()
    const [payee, payer] = await Promise.all([makeWallet(), makeWallet()])
    const hand = await handSignaler(hub, payee)
    const createOffer = PeerLink.createOffer.bind(PeerLink)
    const links: PeerLink[] = []
    const spy = jest.spyOn(PeerLink, 'createOffer').mockImplementation(async o => {
      await sleep(300)
      const made = await createOffer(o)
      links.push(made.link)
      return made
    })
    try {
      const dial = failure(hubClient(hub, payer).connect(payee.identityKey))
      const knock = await hand.next()
      await hand.send('reject', payer.identityKey, knock!.sid, { reason: 'busy' })
      expect(await dial).toMatchObject({ code: 'rejected', reason: 'busy' })
      await sleep(400)
      expect(links).toHaveLength(1)
      const reason = await Promise.race([
        new Promise<WebRTPayError | undefined>(resolve => links[0].onClose(resolve)),
        sleep(1000).then(() => 'still open')
      ])
      expect(reason).toMatchObject({ code: 'rejected' })
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses invalid dial timeouts', async () => {
    const hub = createMemoryHub()
    const w = await makeWallet()
    const sender = hubClient(hub, w)
    await expect(sender.connect(w.identityKey, { presenceTimeoutMs: 0 })).rejects.toThrow(
      RangeError
    )
    await expect(sender.connect(w.identityKey, { dialTimeoutMs: -1 })).rejects.toThrow(RangeError)
    expect(() => new DirectPayClient({ wallet: w.wallet, timeouts: { presenceMs: 0 } })).toThrow(
      RangeError
    )
    expect(() => new DirectPayClient({ wallet: w.wallet, timeouts: { dialMs: NaN } })).toThrow(
      RangeError
    )
  })
})
