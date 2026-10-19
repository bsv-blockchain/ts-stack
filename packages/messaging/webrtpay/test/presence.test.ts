/**
 * Presence: a dial's `knock` and the receiver's `ring`, and the dial timeouts built on them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals'
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
    const ownDial = failure(payeeClient.connect(silent.identityKey, { timeoutMs: 60000 }))
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
