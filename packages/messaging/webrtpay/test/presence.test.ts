/**
 * Presence: a dial's `knock` and the receiver's `ring`, and the dial timeouts built on them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { PeerLink } from '../src/channel/PeerLink.js'
import { DirectPayClient } from '../src/client/DirectPayClient.js'
import type { DirectPayClientOptions, ReceiveHandlers } from '../src/client/DirectPayClient.js'
import { ReplayCache, openSignal, sealSignal } from '../src/signaling/envelope.js'
import { createMemoryHub } from '../src/signaling/MemorySignaler.js'
import { MessageBoxSignaler } from '../src/signaling/MessageBoxSignaler.js'
import type { MessageBoxLike } from '../src/signaling/MessageBoxSignaler.js'
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
  let stopped = false
  // Stopping wakes anyone still waiting, so no timer outlives the test.
  stops.push(() => {
    stopped = true
    for (const wake of waiting.splice(0)) wake()
    return Promise.resolve()
  })
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
      if (read >= received.length && !stopped) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await new Promise<void>(resolve => {
          waiting.push(resolve)
          timer = setTimeout(resolve, within)
        })
        clearTimeout(timer)
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

  it('stays silent to knocks beyond the sender intake budget', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee).startReceiving(accepting)
    const hand = await handSignaler(hub, dialer)
    // 10 signals a sender, then nothing is even opened
    for (let i = 0; i < 11; i++) await hand.send('knock', payee.identityKey, newSid())
    for (let i = 0; i < 10; i++) expect(await hand.next()).toMatchObject({ kind: 'ring' })
    expect(await hand.next(500)).toBeUndefined()
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
    expect(elapsed).toBeLessThan(3000)
  })

  it('counts presence from when the carrier took the knock', async () => {
    const hub = createMemoryHub()
    const silent = await makeWallet()
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const payer = await makeWallet()
    const base = hub.signaler(payer.identityKey)
    const sender = hubClient(hub, payer, {
      signaler: {
        send: async (to, e) => {
          await sleep(800)
          await base.send(to, e)
        },
        listen: fn => base.listen(fn)
      }
    })
    const started = Date.now()
    const e = await failure(sender.connect(silent.identityKey, { presenceTimeoutMs: 500 }))
    expect(e.code).toBe('peer_unreachable')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1250)
  })

  it('reports offline within budget over MessageBox when the live send never answers', async () => {
    const host = 'https://mb.example'
    const payer = await makeWallet()
    const silent = await makeWallet()
    const http: unknown[] = []
    const client: MessageBoxLike = {
      sendMessage: a => {
        http.push(a)
        return Promise.resolve({ status: 'success' })
      },
      listMessages: () => Promise.resolve([]),
      acknowledgeMessage: () => Promise.resolve(),
      resolveHostForRecipient: () => Promise.resolve(host),
      getIdentityKey: () => Promise.resolve(payer.identityKey),
      sendLiveMessage: () => new Promise(() => undefined)
    }
    const signaler = new MessageBoxSignaler(client)
    const sender = hubClient(createMemoryHub(), payer, { signaler })
    const started = Date.now()
    const e = await failure(sender.connect(silent.identityKey))
    const elapsed = Date.now() - started
    expect(e.code).toBe('peer_unreachable')
    // 1.5 s for the live attempt, then the knock goes over HTTP, then 2 s of presence
    expect(http).toHaveLength(1)
    expect(elapsed).toBeGreaterThanOrEqual(3400)
    expect(elapsed).toBeLessThan(5000)
  })

  it('fails at once when no link can be made, without waiting for a reply', async () => {
    const hub = createMemoryHub()
    const silent = await makeWallet()
    stops.push(await hub.signaler(silent.identityKey).listen(() => undefined))
    const sender = hubClient(hub, await makeWallet(), { rtc: {} })
    const started = Date.now()
    const e = await failure(sender.connect(silent.identityKey))
    expect(e.code).toBe('unsupported')
    expect(Date.now() - started).toBeLessThan(1000)
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

  it('cancels a dial after the ring', async () => {
    const hub = createMemoryHub()
    const payee = await ringOnly(hub, 0)
    const sender = hubClient(hub, await makeWallet())
    const controller = new AbortController()
    const dial = failure(sender.connect(payee.identityKey, { signal: controller.signal }))
    // wait for the offer, which goes out only after the ring
    for (let i = 0; i < 50 && !payee.received.some(p => p.kind === 'offer'); i++) await sleep(20)
    expect(payee.received.map(p => p.kind)).toEqual(['knock', 'offer'])
    controller.abort()
    expect(await dial).toMatchObject({ code: 'closed', message: 'Dial cancelled' })
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
    expect(Date.now() - started).toBeLessThan(1000)

    // the other dial, and the receiver, keep running
    const peer = await other
    expect(peer.peerIdentityKey).toBe(payee.identityKey)
    peer.close()
    const again = await sender.connect(payee.identityKey)
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

  it('pays the same payee twice in a row with default presence', async () => {
    const hub = createMemoryHub()
    const [payee, payer] = await Promise.all([makeWallet(), makeWallet()])
    await hubClient(hub, payee).startReceiving(accepting)
    const sender = hubClient(hub, payer)
    for (const amount of [1000, 2000]) {
      const { token } = await makeToken(payer, payee.identityKey, amount)
      const peer = await sender.connect(payee.identityKey)
      expect((await sender.sendPayment(peer, token)).status).toBe('accepted')
    }
  })

  it('serves one session when a second offer supersedes one still gathering', async () => {
    const hub = createMemoryHub()
    const [payee, dialer] = await Promise.all([makeWallet(), makeWallet()])
    const sessions: string[] = []
    const errors: unknown[] = []
    const receiver = hubClient(hub, payee, {
      iceServersProvider: async () => {
        await sleep(300)
        return []
      }
    })
    await receiver.startReceiving({
      ...accepting,
      onSession: k => sessions.push(k),
      onError: e => errors.push(e)
    })
    const hand = await handSignaler(hub, dialer)
    const first = await PeerLink.createOffer({ ...rtc, maxMessageBytes: 65536 })
    const second = await PeerLink.createOffer({ ...rtc, maxMessageBytes: 65536 })
    rawLinks.push(first.link, second.link)
    const [sid1, sid2] = [newSid(), newSid()]
    await hand.send('offer', payee.identityKey, sid1, { sdp: first.sdp })
    await hand.send('offer', payee.identityKey, sid2, { sdp: second.sdp })
    const answer = await hand.next(5000)
    expect(answer).toMatchObject({ kind: 'answer', sid: sid2 })
    // the superseded offer never answers
    expect(await hand.next(1000)).toBeUndefined()
    expect(sessions).toHaveLength(0)
    expect(errors).toEqual([])
    const limiter = (receiver as unknown as { limiter: { active: number } }).limiter
    expect(limiter.active).toBe(1)
  })

  it('lets a payment in progress be acknowledged before a new dial supersedes it', async () => {
    const hub = createMemoryHub()
    const [payee, payer] = await Promise.all([makeWallet(), makeWallet()])
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let deciding!: () => void
    const decidingNow = new Promise<void>(resolve => (deciding = resolve))
    let calls = 0
    await hubClient(hub, payee).startReceiving({
      onPayment: async () => {
        if (++calls === 1) {
          deciding()
          await held
        }
        return 'accepted'
      }
    })
    const sender = hubClient(hub, payer)
    const { token } = await makeToken(payer, payee.identityKey, 1000)
    const first = sender.sendPayment(await sender.connect(payee.identityKey), token)
    await decidingNow
    // a second dial arrives while the first payment is still being decided
    const second = sender.connect(payee.identityKey)
    await sleep(300)
    release()
    expect((await first).status).toBe('accepted')
    expect((await second).peerIdentityKey).toBe(payee.identityKey)
  })

  it('supersedes a stuck payment after waiting 1 s for its ack', async () => {
    const hub = createMemoryHub()
    const [payee, payer] = await Promise.all([makeWallet(), makeWallet()])
    let deciding!: () => void
    const decidingNow = new Promise<void>(resolve => (deciding = resolve))
    await hubClient(hub, payee).startReceiving({
      onPayment: () => {
        deciding()
        return new Promise(() => undefined)
      }
    })
    const sender = hubClient(hub, payer)
    const { token } = await makeToken(payer, payee.identityKey, 1000)
    const first = failure(sender.sendPayment(await sender.connect(payee.identityKey), token))
    await decidingNow
    const started = Date.now()
    const second = await sender.connect(payee.identityKey)
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
    expect(second.peerIdentityKey).toBe(payee.identityKey)
    expect((await first).code).toBe('closed')
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
