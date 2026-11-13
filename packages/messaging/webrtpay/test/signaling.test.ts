import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import type { WalletEncryptArgs } from '@bsv/sdk'
import { SIGNALING_PROTOCOL_ID, SIGNALS_MESSAGEBOX } from '../src/types.js'
import { fromBase64, randomBytes, toBase64, toBase64Url, utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import {
  MAX_SIGNAL_CIPHERTEXT_CHARS,
  ReplayCache,
  isSignalEnvelope,
  openSignal,
  sealSignal
} from '../src/signaling/envelope.js'
import { createMemoryHub } from '../src/signaling/MemorySignaler.js'
import { MessageBoxSignaler } from '../src/signaling/MessageBoxSignaler.js'
import type { MessageBoxLike } from '../src/signaling/MessageBoxSignaler.js'
import type { SignalEnvelope, SignalPlaintext } from '../src/signaling/types.js'

interface Party {
  wallet: ProtoWallet
  key: string
}

async function party(): Promise<Party> {
  const wallet = new ProtoWallet(PrivateKey.fromRandom())
  const { publicKey } = await wallet.getPublicKey({ identityKey: true })
  return { wallet, key: publicKey }
}

function newSid(): string {
  return toBase64Url(randomBytes(16))
}

/** Encrypt arbitrary plaintext exactly as `sealSignal` would, to craft hostile envelopes. */
async function craft(
  from: Party,
  to: string,
  sid: string,
  plaintext: unknown,
  keyID = sid
): Promise<SignalEnvelope> {
  const text = typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext)
  const { ciphertext } = await from.wallet.encrypt({
    plaintext: Array.from(utf8Encode(text)),
    protocolID: SIGNALING_PROTOCOL_ID,
    keyID,
    counterparty: to
  })
  return { v: 1, sid, ciphertext: toBase64(Uint8Array.from(ciphertext)) }
}

const NOW = 1_792_240_000_000
const SDP = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\na=group:BUNDLE 0\r\n'

describe('signal envelopes', () => {
  let alice: Party
  let bob: Party
  let carol: Party

  beforeAll(async () => {
    ;[alice, bob, carol] = await Promise.all([party(), party(), party()])
  })

  function offer(over: Partial<SignalPlaintext> = {}): SignalPlaintext {
    return {
      v: 1,
      kind: 'offer',
      sid: newSid(),
      from: alice.key,
      to: bob.key,
      ts: NOW,
      purpose: 'payment',
      sdp: SDP,
      ...over
    }
  }

  async function expectInvalid(p: Promise<unknown>): Promise<void> {
    await expect(p).rejects.toBeInstanceOf(WebRTPayError)
    await expect(p).rejects.toMatchObject({ code: 'invalid_signal' })
  }

  it('round trips an offer between two wallets', async () => {
    const p = offer()
    const e = await sealSignal(alice.wallet, p)
    expect(Object.keys(e).sort()).toEqual(['ciphertext', 'sid', 'v'])
    expect(e.v).toBe(1)
    expect(e.sid).toBe(p.sid)
    expect(fromBase64(e.ciphertext).length).toBeGreaterThan(SDP.length)
    expect(e.ciphertext).not.toContain('v=0')

    const opened = await openSignal(bob.wallet, alice.key, e, {
      me: bob.key,
      now: NOW,
      replay: new ReplayCache()
    })
    expect(opened).toEqual(p)
  })

  it('round trips a reject with a reason and no sdp', async () => {
    const p: SignalPlaintext = {
      v: 1,
      kind: 'reject',
      sid: newSid(),
      from: bob.key,
      to: alice.key,
      ts: NOW,
      purpose: 'payment',
      reason: 'not_receiving'
    }
    const e = await sealSignal(bob.wallet, p, 'example.com')
    const opened = await openSignal(alice.wallet, bob.key, e, {
      me: alice.key,
      now: NOW,
      replay: new ReplayCache(),
      originator: 'example.com'
    })
    expect(opened).toEqual(p)
    expect('sdp' in opened).toBe(false)
  })

  it('seals and opens a knock', async () => {
    const p = offer({ kind: 'knock', sdp: undefined, chain: 'main' })
    delete p.sdp
    const e = await sealSignal(alice.wallet, p)
    const opened = await openSignal(bob.wallet, alice.key, e, {
      me: bob.key,
      now: NOW,
      replay: new ReplayCache()
    })
    expect(opened).toEqual(p)
  })

  it('seals and opens a ring', async () => {
    const p: SignalPlaintext = {
      v: 1,
      kind: 'ring',
      sid: newSid(),
      from: bob.key,
      to: alice.key,
      ts: NOW,
      purpose: 'payment'
    }
    const e = await sealSignal(bob.wallet, p)
    const opened = await openSignal(alice.wallet, bob.key, e, {
      me: alice.key,
      now: NOW,
      replay: new ReplayCache()
    })
    expect(opened).toEqual(p)
  })

  it('rejects a knock that carries sdp, and a ring that carries a reason', async () => {
    for (const body of [
      { ...offer(), kind: 'knock' },
      { ...offer(), kind: 'ring', sdp: undefined, reason: 'busy' }
    ]) {
      const e = await craft(alice, bob.key, body.sid, body)
      await expectInvalid(
        openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
      )
    }
  })

  it('opens a knock and then an offer with the same sid once each', async () => {
    const replay = new ReplayCache()
    const sid = newSid()
    const knock = offer({ kind: 'knock', sid })
    delete knock.sdp
    const k = await sealSignal(alice.wallet, knock)
    const o = await sealSignal(alice.wallet, offer({ sid }))
    const open = (e: SignalEnvelope): Promise<SignalPlaintext> =>
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay })
    expect((await open(k)).kind).toBe('knock')
    expect((await open(o)).kind).toBe('offer')
    await expectInvalid(open(k))
    await expectInvalid(open(o))
  })

  it('round trips the network a signal names, and leaves it out when there is none', async () => {
    const roundTrip = async (p: SignalPlaintext): Promise<SignalPlaintext> =>
      openSignal(bob.wallet, alice.key, await sealSignal(alice.wallet, p), {
        me: bob.key,
        now: NOW,
        replay: new ReplayCache()
      })
    for (const chain of ['main', 'test', 'tstn', '0', 'a'.repeat(16)]) {
      const p = offer({ chain })
      expect(await roundTrip(p)).toEqual(p)
    }
    const answer: SignalPlaintext = { ...offer({ chain: 'main' }), kind: 'answer' }
    expect(await roundTrip(answer)).toEqual(answer)
    expect('chain' in (await roundTrip(offer()))).toBe(false)
  })

  it('rejects a network that is not 1 to 16 characters from a-z and 0-9', async () => {
    const bad: unknown[] = [
      '',
      'MAIN',
      'Main',
      'main-net',
      'main\n',
      'tëst',
      'a'.repeat(17),
      7,
      null
    ]
    for (const chain of bad) {
      const sid = newSid()
      const e = await craft(alice, bob.key, sid, { ...offer({ sid }), chain })
      await expectInvalid(
        openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
      )
    }
  })

  it('refuses to seal a network that is not 1 to 16 characters from a-z and 0-9', async () => {
    const encrypt = jest.fn(async (args: WalletEncryptArgs, _originator?: string) =>
      alice.wallet.encrypt(args)
    )
    for (const chain of ['', 'Main', 'main-net', 'a'.repeat(17)]) {
      await expect(sealSignal({ encrypt }, offer({ chain }))).rejects.toThrow(TypeError)
    }
    expect(encrypt).not.toHaveBeenCalled()
  })

  it('encrypts with the signaling protocol, the sid as key ID and the recipient as counterparty', async () => {
    const encrypt = jest.fn(async (args: WalletEncryptArgs, _originator?: string) =>
      alice.wallet.encrypt(args)
    )
    const p = offer()
    await sealSignal({ encrypt }, p, 'app.example')
    expect(encrypt).toHaveBeenCalledTimes(1)
    const [args, originator] = encrypt.mock.calls[0]
    expect(args.protocolID).toEqual([2, 'webrtpay signaling'])
    expect(args.keyID).toBe(p.sid)
    expect(args.counterparty).toBe(bob.key)
    expect(originator).toBe('app.example')
  })

  it('only carries the plaintext fields of the signal', async () => {
    const p = { ...offer(), extra: 'leak' } as SignalPlaintext
    const e = await sealSignal(alice.wallet, p)
    const { plaintext } = await bob.wallet.decrypt({
      ciphertext: Array.from(fromBase64(e.ciphertext)),
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: e.sid,
      counterparty: alice.key
    })
    expect(new TextDecoder().decode(Uint8Array.from(plaintext))).not.toContain('leak')
  })

  it('rejects a client that is not the intended recipient', async () => {
    const e = await sealSignal(alice.wallet, offer())
    await expectInvalid(
      openSignal(carol.wallet, alice.key, e, { me: carol.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('rejects opening with the wrong me', async () => {
    const e = await sealSignal(alice.wallet, offer())
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: carol.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('rejects a sender other than the one the carrier asserts', async () => {
    const e = await sealSignal(alice.wallet, offer())
    await expectInvalid(
      openSignal(bob.wallet, carol.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('rejects a plaintext from that differs from the carrier-asserted sender', async () => {
    const sid = newSid()
    const e = await craft(alice, bob.key, sid, { ...offer({ sid }), from: carol.key })
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('rejects a carrier-asserted sender that is not an identity key', async () => {
    const anyone = new ProtoWallet('anyone')
    const sid = newSid()
    const { ciphertext } = await anyone.encrypt({
      plaintext: Array.from(utf8Encode(JSON.stringify({ ...offer({ sid }), from: 'anyone' }))),
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: sid,
      counterparty: bob.key
    })
    const e: SignalEnvelope = { v: 1, sid, ciphertext: toBase64(Uint8Array.from(ciphertext)) }
    await expectInvalid(
      openSignal(bob.wallet, 'anyone', e, { me: bob.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('rejects a stale or future timestamp and accepts the exact skew bounds', async () => {
    const replay = new ReplayCache()
    const late = await sealSignal(alice.wallet, offer())
    await expectInvalid(
      openSignal(bob.wallet, alice.key, late, { me: bob.key, now: NOW + 121_000, replay })
    )
    const early = await sealSignal(alice.wallet, offer())
    await expectInvalid(
      openSignal(bob.wallet, alice.key, early, { me: bob.key, now: NOW - 120_001, replay })
    )
    for (const now of [NOW + 120_000, NOW - 120_000]) {
      const e = await sealSignal(alice.wallet, offer())
      await expect(
        openSignal(bob.wallet, alice.key, e, { me: bob.key, now, replay })
      ).resolves.toMatchObject({ sid: e.sid })
    }
  })

  it('checks the timestamp against the current time by default', async () => {
    const fresh = await sealSignal(alice.wallet, offer({ ts: Date.now() }))
    await expect(
      openSignal(bob.wallet, alice.key, fresh, { me: bob.key, replay: new ReplayCache() })
    ).resolves.toMatchObject({ sid: fresh.sid })
    const stale = await sealSignal(alice.wallet, offer({ ts: Date.now() - 121_000 }))
    await expectInvalid(
      openSignal(bob.wallet, alice.key, stale, { me: bob.key, replay: new ReplayCache() })
    )
  })

  it('rejects a replayed sid', async () => {
    const replay = new ReplayCache()
    const e = await sealSignal(alice.wallet, offer())
    await openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay })
    await expectInvalid(openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay }))
  })

  it('rejects tampered ciphertext', async () => {
    const e = await sealSignal(alice.wallet, offer())
    const bytes = fromBase64(e.ciphertext)
    bytes[bytes.length - 20] ^= 1
    const tampered = { ...e, ciphertext: toBase64(bytes) }
    await expectInvalid(
      openSignal(bob.wallet, alice.key, tampered, {
        me: bob.key,
        now: NOW,
        replay: new ReplayCache()
      })
    )
  })

  it('does not burn the sid on an envelope that fails', async () => {
    const replay = new ReplayCache()
    const e = await sealSignal(alice.wallet, offer())
    const bytes = fromBase64(e.ciphertext)
    bytes[bytes.length - 1] ^= 1
    await expectInvalid(
      openSignal(
        bob.wallet,
        alice.key,
        { ...e, ciphertext: toBase64(bytes) },
        {
          me: bob.key,
          now: NOW,
          replay
        }
      )
    )
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW + 121_000, replay })
    )
    await expect(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay })
    ).resolves.toMatchObject({ sid: e.sid })
  })

  it('remembers a sid until a signal with its timestamp could no longer be fresh', async () => {
    // ts is 120 s ahead of the receiver's clock (the most the skew allows), so the signal
    // stays fresh until NOW + 240 s; a cache that ignored ts would forget the sid at
    // NOW + 180 s and take the replay.
    const replay = new ReplayCache()
    const e = await sealSignal(alice.wallet, offer({ ts: NOW + 120_000 }))
    await openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay })
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW + 239_000, replay })
    )
  })

  it('checks wanted last, and an unwanted signal leaves its sid unrecorded', async () => {
    const replay = new ReplayCache()
    const e = await sealSignal(alice.wallet, offer())
    const seen: SignalPlaintext[] = []
    const unwanted = (p: SignalPlaintext): boolean => {
      seen.push(p)
      return false
    }
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay, wanted: unwanted })
    )
    expect(seen).toEqual([expect.objectContaining({ sid: e.sid, from: alice.key })])
    // not consulted for a signal that fails another check
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, {
        me: bob.key,
        now: NOW + 121_000,
        replay,
        wanted: unwanted
      })
    )
    expect(seen).toHaveLength(1)
    await expect(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay, wanted: () => true })
    ).resolves.toMatchObject({ sid: e.sid })
    await expectInvalid(openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay }))
  })

  it('rejects ciphertext longer than 24576 characters before decrypting it', async () => {
    expect(MAX_SIGNAL_CIPHERTEXT_CHARS).toBe(24576)
    const decrypt = jest.spyOn(bob.wallet, 'decrypt')
    try {
      const atCap = { v: 1, sid: newSid(), ciphertext: 'A'.repeat(MAX_SIGNAL_CIPHERTEXT_CHARS) }
      const over = { ...atCap, ciphertext: `${atCap.ciphertext}A` }
      expect(isSignalEnvelope(atCap)).toBe(true)
      expect(isSignalEnvelope(over)).toBe(false)
      await expectInvalid(
        openSignal(bob.wallet, alice.key, over as SignalEnvelope, {
          me: bob.key,
          now: NOW,
          replay: new ReplayCache()
        })
      )
      expect(decrypt).not.toHaveBeenCalled()
    } finally {
      decrypt.mockRestore()
    }
  })

  it('fits a signal carrying the longest SDP allowed under the ciphertext cap', async () => {
    // 16384 characters in 72-character lines, as a large real SDP might be.
    const line = `a=candidate:1 1 udp 2113937151 ${'x'.repeat(36)}.local 5000 typ host\r\n`
    const sdp = line.repeat(Math.ceil(16384 / line.length)).slice(0, 16384)
    const e = await sealSignal(alice.wallet, offer({ sdp }))
    expect(e.ciphertext.length).toBeLessThanOrEqual(MAX_SIGNAL_CIPHERTEXT_CHARS)
    await expect(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
    ).resolves.toMatchObject({ sdp })
  })

  it('rejects an envelope sid that differs from the plaintext sid', async () => {
    const sid = newSid()
    const e = await craft(alice, bob.key, sid, offer({ sid: newSid() }))
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('rejects an sdp longer than 16384 characters and accepts exactly 16384', async () => {
    const replay = new ReplayCache()
    const long = await sealSignal(alice.wallet, offer({ sdp: 'a'.repeat(16385) }))
    await expectInvalid(openSignal(bob.wallet, alice.key, long, { me: bob.key, now: NOW, replay }))
    const max = await sealSignal(alice.wallet, offer({ sdp: 'a'.repeat(16384) }))
    await expect(
      openSignal(bob.wallet, alice.key, max, { me: bob.key, now: NOW, replay })
    ).resolves.toMatchObject({ sdp: 'a'.repeat(16384) })
  })

  it('rejects malformed envelopes', async () => {
    const good = await sealSignal(alice.wallet, offer())
    const bad: unknown[] = [
      null,
      'envelope',
      [],
      { ...good, v: 2 },
      { ...good, sid: '' },
      { ...good, sid: 7 },
      { ...good, sid: 'x'.repeat(65) },
      { ...good, ciphertext: 42 },
      { ...good, ciphertext: 'not base64!' },
      { v: 1, sid: good.sid }
    ]
    for (const e of bad) {
      await expectInvalid(
        openSignal(bob.wallet, alice.key, e as SignalEnvelope, {
          me: bob.key,
          now: NOW,
          replay: new ReplayCache()
        })
      )
    }
  })

  it('rejects plaintexts that are not well-formed signals', async () => {
    const base = offer()
    const bad: unknown[] = [
      'not json',
      '\u0000\u0001',
      JSON.stringify([1, 2]),
      { ...base, v: 2 },
      { ...base, kind: 'payment' },
      { ...base, purpose: 'chat' },
      { ...base, ts: 'now' },
      { ...base, ts: null },
      { ...base, to: 7 },
      { ...base, sdp: 12 },
      { ...base, reason: { text: 'no' } }
    ]
    for (const p of bad) {
      const sid = newSid()
      const body = typeof p === 'object' && p !== null && !Array.isArray(p) ? { ...p, sid } : p
      const e = await craft(alice, bob.key, sid, body)
      await expectInvalid(
        openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
      )
    }
  })

  it('rejects ciphertext that is not valid UTF-8', async () => {
    const sid = newSid()
    const { ciphertext } = await alice.wallet.encrypt({
      plaintext: [0xff, 0xfe, 0x7b],
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: sid,
      counterparty: bob.key
    })
    const e: SignalEnvelope = { v: 1, sid, ciphertext: toBase64(Uint8Array.from(ciphertext)) }
    await expectInvalid(
      openSignal(bob.wallet, alice.key, e, { me: bob.key, now: NOW, replay: new ReplayCache() })
    )
  })

  it('returns only the known plaintext fields', async () => {
    const sid = newSid()
    const e = await craft(alice, bob.key, sid, { ...offer({ sid }), extra: 'x' })
    const opened = await openSignal(bob.wallet, alice.key, e, {
      me: bob.key,
      now: NOW,
      replay: new ReplayCache()
    })
    expect(opened).toEqual(offer({ sid }))
  })
})

describe('ReplayCache', () => {
  /** signalMaxSkewMs (120 s) plus the 60 s margin. */
  const KEEP = 180_000

  it('reports only the first sighting of a sid', () => {
    const c = new ReplayCache()
    expect(c.check('a', 0)).toBe(true)
    expect(c.check('a', 1)).toBe(false)
    expect(c.check('b', 1)).toBe(true)
  })

  it('remembers a sid until max(seen, ts) + 120 s + 60 s', () => {
    const c = new ReplayCache()
    // ts in the past: counted from when it was seen
    expect(c.check('past', 1000, 1000 - 120_000)).toBe(true)
    expect(c.check('past', 1000 + KEEP - 1)).toBe(false)
    expect(c.check('past', 1000 + KEEP)).toBe(true)
    // ts in the future: counted from ts, which can stay fresh until ts + 120 s
    expect(c.check('future', 1000, 1000 + 120_000)).toBe(true)
    expect(c.check('future', 1000 + 120_000 + KEEP - 1)).toBe(false)
    expect(c.check('future', 1000 + 120_000 + KEEP)).toBe(true)
  })

  it('never evicts a sid that could still pass the freshness check, even beyond max', () => {
    // A flood of valid junk from throwaway identities must not flush a captured sid.
    const c = new ReplayCache(100)
    expect(c.check('captured', 0)).toBe(true)
    for (let i = 0; i < 1000; i++) expect(c.check(`junk-${i}`, i)).toBe(true)
    expect(c.size).toBe(1001)
    expect(c.check('captured', 1000)).toBe(false)
  })

  it('evicts only expired sids once beyond max', () => {
    const c = new ReplayCache(2)
    c.check('old', 0)
    c.check('newer', 100_000)
    expect(c.size).toBe(2)
    // 'old' expired at 180 s; 'newer' is kept until 280 s
    c.check('latest', 190_000)
    expect(c.size).toBe(2)
    expect(c.check('newer', 190_000)).toBe(false)
    expect(c.check('old', 190_000)).toBe(true)
  })

  it('sweeps out expired sids kept behind a longer-lived one once the cache has grown', () => {
    const c = new ReplayCache(2)
    c.check('long', 0, 120_000) // kept until 300 s, at the front
    c.check('b', 0)
    c.check('c', 0)
    expect(c.size).toBe(3)
    // b and c expired at 180 s but sit behind 'long'; the sweep runs when the cache has
    // grown by half since the last one
    c.check('d', 200_000)
    c.check('e', 200_000)
    expect(c.size).toBe(5)
    c.check('f', 200_000)
    expect(c.size).toBe(4)
    expect(c.check('long', 200_000)).toBe(false)
  })

  it('stays small when nothing is over max: expired sids at the front are dropped', () => {
    const c = new ReplayCache()
    for (let i = 0; i < 100; i++) c.check(`s${i}`, i * 10_000)
    // at 990 s only the sids seen in the last 180 s are left
    expect(c.size).toBe(18)
  })

  it('defaults to the current time', () => {
    const c = new ReplayCache()
    expect(c.check('a')).toBe(true)
    expect(c.check('a')).toBe(false)
    expect(c.check('a', Date.now() + KEEP + 1000)).toBe(true)
  })
})

const ENV: SignalEnvelope = { v: 1, sid: 'c2lkLTE', ciphertext: 'AAECAw==' }
const ENV2: SignalEnvelope = { v: 1, sid: 'c2lkLTI', ciphertext: 'BAUGBw==' }

function identity(): string {
  return PrivateKey.fromRandom().toPublicKey().toString()
}

describe('MemoryHub', () => {
  const ALICE = identity()
  const BOB = identity()
  const CAROL = identity()

  function nextSignal(
    listen: (fn: (from: string, e: SignalEnvelope) => void) => Promise<() => Promise<void>>
  ): Promise<{ got: Promise<[string, SignalEnvelope]>; stop: () => Promise<void> }> {
    let resolve!: (v: [string, SignalEnvelope]) => void
    const got = new Promise<[string, SignalEnvelope]>(r => (resolve = r))
    return listen((from, e) => resolve([from, e])).then(stop => ({ got, stop }))
  }

  it('delivers to the listening identity with the hub-asserted sender', async () => {
    const hub = createMemoryHub()
    const bob = hub.signaler(BOB)
    const { got, stop } = await nextSignal(fn => bob.listen(fn))
    await hub.signaler(ALICE).send(BOB, ENV)
    await expect(got).resolves.toEqual([ALICE, ENV])
    await stop()
  })

  it('delivers asynchronously and survives throwing listeners', async () => {
    const hub = createMemoryHub()
    const bob = hub.signaler(BOB)
    const calls: string[] = []
    const stopThrow = await bob.listen(() => {
      calls.push('throwing listener')
      throw new Error('listener bug')
    })
    const stopAsync = await bob.listen(() => Promise.reject(new Error('async bug')) as never)
    const { got, stop } = await nextSignal(fn => bob.listen(fn))
    const sending = hub.signaler(ALICE).send(BOB, ENV)
    expect(calls).toEqual([])
    await expect(sending).resolves.toBeUndefined()
    await expect(got).resolves.toEqual([ALICE, ENV])
    expect(calls).toEqual(['throwing listener'])
    await Promise.all([stopThrow(), stopAsync(), stop()])
  })

  it('rejects peer_unreachable for an identity that is not listening', async () => {
    const hub = createMemoryHub()
    await expect(hub.signaler(ALICE).send(CAROL, ENV)).rejects.toMatchObject({
      code: 'peer_unreachable'
    })
  })

  it('rejects, never throws, when send is given an envelope that is not one', async () => {
    const hub = createMemoryHub()
    const { stop } = await nextSignal(fn => hub.signaler(BOB).listen(fn))
    const sending = hub.signaler(ALICE).send(BOB, null as unknown as SignalEnvelope)
    await expect(sending).rejects.toBeInstanceOf(TypeError)
    await stop()
  })

  it('makes an identity unreachable when it goes offline or unsubscribes', async () => {
    const hub = createMemoryHub()
    const alice = hub.signaler(ALICE)
    const bob = hub.signaler(BOB)
    const first = await nextSignal(fn => bob.listen(fn))
    hub.offline(BOB)
    await expect(alice.send(BOB, ENV)).rejects.toMatchObject({ code: 'peer_unreachable' })
    await first.stop()

    const second = await nextSignal(fn => bob.listen(fn))
    await alice.send(BOB, ENV2)
    await expect(second.got).resolves.toEqual([ALICE, ENV2])
    await second.stop()
    await second.stop()
    await expect(alice.send(BOB, ENV)).rejects.toBeInstanceOf(WebRTPayError)
  })
})

interface Stored {
  messageId: string
  sender: string
  recipient: string
  messageBox: string
  body: string | Record<string, unknown>
}

/** In-memory MessageBox server: one box per recipient and box name, records acknowledgements. */
class FakeMessageBox {
  private nextId = 1
  messages: Stored[] = []
  acks: Array<{ identity: string; messageIds: string[]; host?: string }> = []
  /** False keeps acknowledged messages listed, like a server that is slow to delete. */
  removeOnAck = true
  /** Return bodies already parsed, as MessageBoxClient does for JSON bodies. */
  parseBodies = false

  deposit(
    recipient: string,
    sender: string,
    body: string | Record<string, unknown>,
    messageBox = SIGNALS_MESSAGEBOX
  ): string {
    const messageId = `m${this.nextId++}`
    this.messages.push({ messageId, sender, recipient, messageBox, body })
    return messageId
  }

  /** Live listeners by identity. */
  live = new Map<string, LiveFakeClient>()
  /** Advertised hosts by identity (default `https://mb.example`). */
  hosts = new Map<string, string>()

  client(identity: string): FakeClient {
    return new FakeClient(this, identity)
  }

  liveClient(identity: string): LiveFakeClient {
    return new LiveFakeClient(this, identity)
  }
}

type ListArgs = Parameters<MessageBoxLike['listMessages']>[0]

class FakeClient implements MessageBoxLike {
  sent: Array<{ args: unknown; overrideHost: string | undefined }> = []
  lists: Array<ListArgs & { at: number }> = []
  listFailures = 0
  ackFailures = 0
  sendFailure: Error | undefined
  listGate: Promise<void> | undefined
  ackGate: Promise<void> | undefined

  constructor(
    private readonly server: FakeMessageBox,
    readonly identity: string
  ) {}

  async sendMessage(
    a: { recipient: string; messageBox: string; body: string },
    overrideHost?: string
  ): Promise<unknown> {
    this.sent.push({ args: a, overrideHost })
    if (this.sendFailure) throw this.sendFailure
    this.server.deposit(a.recipient, this.identity, a.body, a.messageBox)
    return { status: 'success' }
  }

  /** Like a server or client that ignores `limit`: every stored message is listed. */
  async listMessages(
    a: ListArgs
  ): Promise<Array<{ messageId: string; sender: string; body: string | Record<string, unknown> }>> {
    this.lists.push({ ...a, at: Date.now() })
    if (this.listGate) await this.listGate
    if (this.listFailures > 0) {
      this.listFailures--
      throw new Error('network down')
    }
    return this.server.messages
      .filter(m => m.recipient === this.identity && m.messageBox === a.messageBox)
      .map(m => ({
        messageId: m.messageId,
        sender: m.sender,
        body: this.server.parseBodies && typeof m.body === 'string' ? safeParse(m.body) : m.body
      }))
  }

  async acknowledgeMessage(a: { messageIds: string[]; host?: string }): Promise<unknown> {
    if (this.ackGate) await this.ackGate
    if (this.ackFailures > 0) {
      this.ackFailures--
      throw new Error('ack failed')
    }
    this.server.acks.push({ identity: this.identity, ...a })
    if (this.server.removeOnAck) {
      this.server.messages = this.server.messages.filter(m => !a.messageIds.includes(m.messageId))
    }
    return 'acknowledged'
  }
}

/** A {@link FakeClient} with the live websocket methods; the server delivers live sends. */
class LiveFakeClient extends FakeClient {
  liveSent: unknown[] = []
  liveSendFailure: Error | undefined
  /** A live send that never answers (its message is still delivered). */
  liveSendHangs = false
  liveListenFailure: Error | undefined
  liveGate: Promise<void> | undefined
  liveListens: Array<{ messageBox: string; overrideHost: string | undefined }> = []
  joined: string[] = []
  left: string[] = []
  liveSentHosts: Array<string | undefined> = []
  resolves: string[] = []
  resolveFailure: Error | undefined
  /** Milliseconds each host lookup takes. */
  resolveDelayMs = 0
  private onLive: ((m: unknown) => void) | undefined
  private lastLive: unknown

  constructor(
    private readonly liveServer: FakeMessageBox,
    identity: string
  ) {
    super(liveServer, identity)
  }

  /** Hosts by identity, as advertised; everyone is on `https://mb.example` unless set. */
  async resolveHostForRecipient(identityKey: string): Promise<string> {
    this.resolves.push(identityKey)
    if (this.resolveDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.resolveDelayMs))
    }
    if (this.resolveFailure) throw this.resolveFailure
    return this.liveServer.hosts.get(identityKey) ?? 'https://mb.example'
  }

  async getIdentityKey(): Promise<string> {
    return this.identity
  }

  async sendLiveMessage(
    a: {
      recipient: string
      messageBox: string
      body: string
    },
    overrideHost?: string
  ): Promise<unknown> {
    this.liveSent.push(a)
    this.liveSentHosts.push(overrideHost)
    if (this.liveSendFailure) throw this.liveSendFailure
    if (this.liveSendHangs) {
      this.liveServer.deposit(a.recipient, this.identity, a.body, a.messageBox)
      return new Promise(() => undefined)
    }
    const messageId = this.liveServer.deposit(a.recipient, this.identity, a.body, a.messageBox)
    this.liveServer.live
      .get(a.recipient)
      ?.pushLive({ messageId, sender: this.identity, body: a.body })
    return { status: 'success', messageId }
  }

  async listenForLiveMessages(a: {
    messageBox: string
    onMessage: (m: {
      messageId: string
      sender: string
      body: string | Record<string, unknown>
    }) => void
    overrideHost?: string
  }): Promise<void> {
    this.liveListens.push({ messageBox: a.messageBox, overrideHost: a.overrideHost })
    await (this.liveGate ?? Promise.resolve())
    if (this.liveListenFailure) throw this.liveListenFailure
    this.onLive = a.onMessage as (m: unknown) => void
    this.liveServer.live.set(this.identity, this)
  }

  async joinRoom(messageBox: string): Promise<void> {
    this.joined.push(messageBox)
  }

  async leaveRoom(messageBox: string): Promise<void> {
    this.left.push(messageBox)
  }

  pushLive(m: unknown): void {
    this.lastLive = m
    this.onLive?.(m)
  }

  replayLive(): void {
    this.onLive?.(this.lastLive)
  }
}

function safeParse(s: string): string | Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return s
  }
}

describe('MessageBoxSignaler', () => {
  const ALICE = identity()
  const BOB = identity()

  let t0 = 0
  beforeEach(() => {
    jest.useFakeTimers()
    t0 = Date.now()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  function collect(): {
    got: Array<[string, SignalEnvelope]>
    fn: (from: string, e: SignalEnvelope) => void
  } {
    const got: Array<[string, SignalEnvelope]> = []
    return { got, fn: (from, e) => void got.push([from, e]) }
  }

  it('sends over HTTP to the recipient box and delivers to the listener with the sender', async () => {
    const server = new FakeMessageBox()
    const a = server.client(ALICE)
    const b = server.client(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await new MessageBoxSignaler(a).send(BOB, ENV)
      expect(a.sent).toEqual([
        {
          args: { recipient: BOB, messageBox: 'webrtpay_signals', body: JSON.stringify(ENV) },
          overrideHost: undefined
        }
      ])
      expect(got).toEqual([])
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ['m1'] }])
    } finally {
      await stop()
    }
  })

  it('polls immediately on listen and every 2.5 s while idle', async () => {
    const server = new FakeMessageBox()
    const b = server.client(BOB)
    const stop = await new MessageBoxSignaler(b).listen(() => {})
    try {
      await jest.advanceTimersByTimeAsync(7500)
      expect(b.lists.map(l => l.at - t0)).toEqual([0, 2500, 5000, 7500])
      // one bounded page per poll, and never payments
      expect(b.lists[0]).toEqual({
        messageBox: 'webrtpay_signals',
        limit: 100,
        pageSize: 100,
        maxPages: 1,
        acceptPayments: false,
        at: t0
      })
    } finally {
      await stop()
    }
  })

  /** Deposit `n` distinct envelopes from ALICE to BOB; returns their sids in order. */
  function depositMany(server: FakeMessageBox, n: number): string[] {
    return Array.from({ length: n }, (_, i) => {
      const sid = `sid-${i}`
      server.deposit(BOB, ALICE, JSON.stringify({ ...ENV, sid }))
      return sid
    })
  }

  it('handles at most 100 new messages per poll and leaves the rest for later polls', async () => {
    const server = new FakeMessageBox()
    const sids = depositMany(server, 250)
    const b = server.client(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(got.map(([, e]) => e.sid)).toEqual(sids.slice(0, 100))
      // the rest is neither read nor acknowledged yet
      expect(server.acks.flatMap(a => a.messageIds)).toHaveLength(100)
      expect(server.messages).toHaveLength(150)
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toHaveLength(200)
      await jest.advanceTimersByTimeAsync(2500)
      expect(got.map(([, e]) => e.sid)).toEqual(sids)
      expect(server.messages).toEqual([])
    } finally {
      await stop()
    }
  })

  it('acks in batches of at most 100; a failed batch is retried without backing off', async () => {
    const server = new FakeMessageBox()
    depositMany(server, 150)
    const b = server.client(BOB)
    // the only batch of the first poll and the first batch of the second fail
    b.ackFailures = 2
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    const ids = (from: number, to: number): string[] =>
      Array.from({ length: to - from + 1 }, (_, i) => `m${from + i}`)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(got).toHaveLength(100)
      expect(server.acks).toEqual([])
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toHaveLength(150)
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ids(101, 150) }])
      await jest.advanceTimersByTimeAsync(2500)
      expect(server.acks).toEqual([
        { identity: BOB, messageIds: ids(101, 150) },
        { identity: BOB, messageIds: ids(1, 100) }
      ])
      expect(server.messages).toEqual([])
      // nothing delivered twice, and no backoff after the failed batches
      expect(new Set(got.map(([, e]) => e.sid)).size).toBe(150)
      expect(b.lists.map(l => l.at - t0)).toEqual([0, 2500, 5000])
    } finally {
      await stop()
    }
  })

  it('gives up on a poll stalled for 10 s, backs off, and ignores it if it returns', async () => {
    const server = new FakeMessageBox()
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    const b = server.client(BOB)
    let open!: () => void
    b.listGate = new Promise(resolve => (open = resolve))
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      b.listGate = undefined // only the first list call hangs
      await jest.advanceTimersByTimeAsync(9999)
      expect(b.lists).toHaveLength(1)
      // abandoned at 10 s; the stalled call returns at 12 s and is ignored
      await jest.advanceTimersByTimeAsync(2001)
      open()
      await jest.advanceTimersByTimeAsync(0)
      expect(got).toEqual([])
      expect(server.acks).toEqual([])
      // a failed poll doubles the wait: the next one is at 10 s + 5 s
      await jest.advanceTimersByTimeAsync(2999)
      expect(b.lists).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(b.lists.map(l => l.at - t0)).toEqual([0, 15_000])
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ['m1'] }])
    } finally {
      await stop()
    }
  })

  it('accepts bodies the client has already parsed', async () => {
    const server = new FakeMessageBox()
    server.parseBodies = true
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(server.client(BOB)).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(got).toEqual([[ALICE, ENV]])
    } finally {
      await stop()
    }
  })

  it('acks each read message once per poll and dedupes repeated list results', async () => {
    const server = new FakeMessageBox()
    server.removeOnAck = false
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    server.deposit(BOB, ALICE, JSON.stringify(ENV2))
    const b = server.client(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(5000)
      expect(b.lists).toHaveLength(3)
      expect(got).toEqual([
        [ALICE, ENV],
        [ALICE, ENV2]
      ])
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ['m1', 'm2'] }])

      server.deposit(BOB, ALICE, JSON.stringify(ENV))
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toHaveLength(3)
      expect(server.acks).toEqual([
        { identity: BOB, messageIds: ['m1', 'm2'] },
        { identity: BOB, messageIds: ['m3'] }
      ])
    } finally {
      await stop()
    }
  })

  it('retries a failed ack on the next poll without delivering again', async () => {
    const server = new FakeMessageBox()
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    const b = server.client(BOB)
    b.ackFailures = 1
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([])
      await jest.advanceTimersByTimeAsync(2500)
      expect(b.lists).toHaveLength(2)
      expect(got).toHaveLength(1)
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ['m1'] }])
      expect(server.messages).toEqual([])
    } finally {
      await stop()
    }
  })

  it('acks but ignores bodies that are not envelopes', async () => {
    const server = new FakeMessageBox()
    const junk: Array<string | Record<string, unknown>> = [
      'not json',
      JSON.stringify({ ...ENV, v: 2 }),
      JSON.stringify([ENV]),
      JSON.stringify('a string'),
      { hello: 'world' },
      { v: 1, sid: 'x', ciphertext: 7 },
      { v: 1, sid: '', ciphertext: 'AA==' },
      '[Error: Failed to decrypt or parse message]'
    ]
    for (const body of junk) server.deposit(BOB, ALICE, body)
    server.deposit(BOB, ALICE, { ...ENV, extra: 'dropped' })
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(server.client(BOB)).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([
        { identity: BOB, messageIds: junk.map((_, i) => `m${i + 1}`).concat(`m${junk.length + 1}`) }
      ])
      expect(server.messages).toEqual([])
    } finally {
      await stop()
    }
  })

  it('skips list entries it cannot acknowledge and acks those without a usable sender', async () => {
    const acks: string[][] = []
    const client: MessageBoxLike = {
      sendMessage: async () => undefined,
      listMessages: async () =>
        [
          null,
          { messageId: 7, sender: ALICE, body: ENV },
          { messageId: 'no-sender', sender: 42, body: ENV },
          { messageId: 'ok', sender: ALICE, body: ENV }
        ] as never,
      acknowledgeMessage: async a => void acks.push(a.messageIds)
    }
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(client).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(got).toEqual([[ALICE, ENV]])
      expect(acks).toEqual([['no-sender', 'ok']])
    } finally {
      await stop()
    }
  })

  it('treats a list result that is not an array as a failed poll', async () => {
    let calls = 0
    const client: MessageBoxLike = {
      sendMessage: async () => undefined,
      listMessages: async () => (calls++ === 0 ? ('oops' as never) : []),
      acknowledgeMessage: async () => undefined
    }
    const stop = await new MessageBoxSignaler(client).listen(() => {})
    try {
      await jest.advanceTimersByTimeAsync(4999)
      expect(calls).toBe(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(calls).toBe(2)
    } finally {
      await stop()
    }
  })

  it('survives a listMessages rejection and backs off before the next poll', async () => {
    const server = new FakeMessageBox()
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    const b = server.client(BOB)
    b.listFailures = 1
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(4999)
      expect(b.lists).toHaveLength(1)
      expect(got).toEqual([])
      await jest.advanceTimersByTimeAsync(1)
      expect(b.lists).toHaveLength(2)
      expect(got).toEqual([[ALICE, ENV]])
      await jest.advanceTimersByTimeAsync(2500)
      expect(b.lists).toHaveLength(3)
    } finally {
      await stop()
    }
  })

  it('doubles the backoff on consecutive errors up to 30 s', async () => {
    const server = new FakeMessageBox()
    const b = server.client(BOB)
    b.listFailures = 100
    const stop = await new MessageBoxSignaler(b).listen(() => {})
    try {
      await jest.advanceTimersByTimeAsync(125_000)
      expect(b.lists.map(l => l.at - t0)).toEqual([
        0, 5000, 15_000, 35_000, 65_000, 95_000, 125_000
      ])
    } finally {
      await stop()
    }
  })

  it('polls every second while active and returns to idle polling after', async () => {
    const server = new FakeMessageBox()
    const b = server.client(BOB)
    const signaler = new MessageBoxSignaler(b)
    const stop = await signaler.listen(() => {})
    try {
      await jest.advanceTimersByTimeAsync(0)
      signaler.setActive(true)
      await jest.advanceTimersByTimeAsync(999)
      expect(b.lists).toHaveLength(1)
      await jest.advanceTimersByTimeAsync(1)
      expect(b.lists).toHaveLength(2)
      await jest.advanceTimersByTimeAsync(1000)
      expect(b.lists).toHaveLength(3)

      signaler.setActive(false)
      await jest.advanceTimersByTimeAsync(2499)
      expect(b.lists).toHaveLength(3)
      await jest.advanceTimersByTimeAsync(1)
      expect(b.lists).toHaveLength(4)
    } finally {
      await stop()
    }
  })

  it('polls at once when activated after the active interval has already passed', async () => {
    const server = new FakeMessageBox()
    const b = server.client(BOB)
    const signaler = new MessageBoxSignaler(b, { idlePollMs: 10_000, activePollMs: 500 })
    const stop = await signaler.listen(() => {})
    try {
      await jest.advanceTimersByTimeAsync(2000)
      expect(b.lists).toHaveLength(1)
      signaler.setActive(true)
      await jest.advanceTimersByTimeAsync(0)
      expect(b.lists.map(l => l.at - t0)).toEqual([0, 2000])
      await jest.advanceTimersByTimeAsync(500)
      expect(b.lists.map(l => l.at - t0)).toEqual([0, 2000, 2500])
    } finally {
      await stop()
    }
  })

  it('stops polling on unsubscribe and leaves later messages on the server', async () => {
    const server = new FakeMessageBox()
    const b = server.client(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    await jest.advanceTimersByTimeAsync(0)
    await stop()
    await stop()
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    await jest.advanceTimersByTimeAsync(30_000)
    expect(b.lists).toHaveLength(1)
    expect(got).toEqual([])
    expect(server.acks).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
  })

  it('neither delivers nor acks a poll that returns after unsubscribe', async () => {
    const server = new FakeMessageBox()
    server.deposit(BOB, ALICE, JSON.stringify(ENV))
    const b = server.client(BOB)
    let open!: () => void
    b.listGate = new Promise(r => (open = r))
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    await stop()
    open()
    await jest.advanceTimersByTimeAsync(10_000)
    expect(b.lists).toHaveLength(1)
    expect(got).toEqual([])
    expect(server.acks).toEqual([])
  })

  it('shares one poll loop between listeners and isolates a throwing listener', async () => {
    const server = new FakeMessageBox()
    const b = server.client(BOB)
    const signaler = new MessageBoxSignaler(b)
    const first = collect()
    const second = collect()
    const stopThrow = await signaler.listen(() => {
      throw new Error('listener bug')
    })
    const stopAsync = await signaler.listen(() => Promise.reject(new Error('async bug')) as never)
    const stopFirst = await signaler.listen(first.fn)
    const stopSecond = await signaler.listen(second.fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      server.deposit(BOB, ALICE, JSON.stringify(ENV))
      await jest.advanceTimersByTimeAsync(2500)
      expect(b.lists).toHaveLength(2)
      expect(first.got).toEqual([[ALICE, ENV]])
      expect(second.got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ['m1'] }])

      await Promise.all([stopThrow(), stopAsync(), stopFirst()])
      server.deposit(BOB, ALICE, JSON.stringify(ENV2))
      await jest.advanceTimersByTimeAsync(2500)
      expect(first.got).toHaveLength(1)
      expect(second.got).toEqual([
        [ALICE, ENV],
        [ALICE, ENV2]
      ])
    } finally {
      await stopSecond()
    }
    await jest.advanceTimersByTimeAsync(10_000)
    expect(b.lists).toHaveLength(3)
  })

  it('lists and acks on the configured host and box but sends via the recipient host', async () => {
    const server = new FakeMessageBox()
    const a = server.client(ALICE)
    const b = server.client(BOB)
    const o = { host: 'https://mb.example', messageBox: 'custom_box' }
    const stop = await new MessageBoxSignaler(b, o).listen(() => {})
    try {
      await new MessageBoxSignaler(a, o).send(BOB, ENV)
      expect(a.sent).toEqual([
        {
          args: { recipient: BOB, messageBox: 'custom_box', body: JSON.stringify(ENV) },
          overrideHost: undefined
        }
      ])
      await jest.advanceTimersByTimeAsync(2500)
      expect(b.lists[1]).toEqual({
        messageBox: 'custom_box',
        host: 'https://mb.example',
        limit: 100,
        pageSize: 100,
        maxPages: 1,
        acceptPayments: false,
        at: t0 + 2500
      })
      expect(server.acks).toEqual([
        { identity: BOB, messageIds: ['m1'], host: 'https://mb.example' }
      ])
    } finally {
      await stop()
    }
  })

  it('send failure is unavailable', async () => {
    const server = new FakeMessageBox()
    const a = server.client(ALICE)
    const cause = new Error('no host for recipient')
    a.sendFailure = cause
    const sending = new MessageBoxSignaler(a).send(BOB, ENV)
    await expect(sending).rejects.toBeInstanceOf(WebRTPayError)
    await expect(sending).rejects.toMatchObject({ code: 'unavailable', cause })

    // live and HTTP both failing is unavailable too
    const live = server.liveClient(ALICE)
    live.sendFailure = cause
    live.liveSendFailure = new Error('socket down')
    await expect(new MessageBoxSignaler(live).send(BOB, ENV)).rejects.toMatchObject({
      code: 'unavailable',
      cause
    })
  })

  it('sends live when available', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    const b = server.liveClient(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(b.liveListens).toEqual([{ messageBox: 'webrtpay_signals', overrideHost: undefined }])
      await new MessageBoxSignaler(a).send(BOB, ENV)
      expect(a.liveSent).toEqual([
        { recipient: BOB, messageBox: 'webrtpay_signals', body: JSON.stringify(ENV) }
      ])
      expect(a.sent).toEqual([])
      // delivered as it arrives, before any poll
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([])
      // and acknowledged with the next poll
      await jest.advanceTimersByTimeAsync(2500)
      expect(server.acks).toEqual([{ identity: BOB, messageIds: ['m1'] }])
    } finally {
      await stop()
    }
  })

  it('does not send live when told not to, nor with a client that cannot', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    const b = server.liveClient(BOB)
    const stop = await new MessageBoxSignaler(b, { live: false }).listen(() => undefined)
    try {
      await new MessageBoxSignaler(a, { live: false }).send(BOB, ENV)
      expect(a.liveSent).toEqual([])
      expect(a.sent).toHaveLength(1)
      expect(b.liveListens).toEqual([])
    } finally {
      await stop()
    }
  })

  it('sends over HTTP to a recipient on another host', async () => {
    const server = new FakeMessageBox()
    server.hosts.set(BOB, 'https://other.example')
    const a = server.liveClient(ALICE)
    const signaler = new MessageBoxSignaler(a)
    await signaler.send(BOB, ENV)
    await signaler.send(BOB, ENV2)
    expect(a.liveSent).toEqual([])
    expect(a.sent).toHaveLength(2)
    // the recipient's host is looked up once and remembered
    expect(a.resolves.filter(k => k === BOB)).toHaveLength(1)
  })

  it('compares the recipient host with the configured host, and sends live through it', async () => {
    const server = new FakeMessageBox()
    server.hosts.set(BOB, 'https://mb.example/')
    server.hosts.set(ALICE, 'https://elsewhere.example')
    const a = server.liveClient(ALICE)
    await new MessageBoxSignaler(a, { host: 'https://mb.example' }).send(BOB, ENV)
    expect(a.liveSent).toHaveLength(1)
    expect(a.liveSentHosts).toEqual(['https://mb.example'])
    expect(a.resolves).toEqual([BOB])
    // without the option, its own advertised host decides
    const b = server.liveClient(ALICE)
    await new MessageBoxSignaler(b).send(BOB, ENV)
    expect(b.liveSent).toEqual([])
    expect(b.sent).toHaveLength(1)
  })

  it('sends over HTTP when a host cannot be resolved, or cannot be', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    a.resolveFailure = new Error('overlay down')
    const signaler = new MessageBoxSignaler(a)
    await signaler.send(BOB, ENV)
    expect(a.liveSent).toEqual([])
    expect(a.sent).toHaveLength(1)
    // a failed lookup is not remembered
    a.resolveFailure = undefined
    await signaler.send(BOB, ENV2)
    expect(a.liveSent).toHaveLength(1)

    // a client that cannot resolve hosts never sends live
    const b = server.liveClient(ALICE)
    Object.defineProperty(b, 'resolveHostForRecipient', { value: undefined })
    await new MessageBoxSignaler(b).send(BOB, ENV)
    expect(b.liveSent).toEqual([])
    // nor one that cannot tell its own host
    const c = server.liveClient(ALICE)
    Object.defineProperty(c, 'getIdentityKey', { value: undefined })
    await new MessageBoxSignaler(c).send(BOB, ENV)
    expect(c.liveSent).toEqual([])
    expect(server.messages.length).toBeGreaterThanOrEqual(4)
  })

  it('sends over HTTP when the live send has not answered in 1.5 s', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    a.liveSendHangs = true
    let done = false
    const sending = new MessageBoxSignaler(a).send(BOB, ENV).then(() => (done = true))
    await jest.advanceTimersByTimeAsync(1499)
    expect(done).toBe(false)
    expect(a.sent).toEqual([])
    await jest.advanceTimersByTimeAsync(1)
    await sending
    expect(a.sent).toHaveLength(1)
  })

  it('does not send live once a slow host lookup has run past the 1.5 s', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    a.resolveDelayMs = 2000
    const sending = new MessageBoxSignaler(a).send(BOB, ENV)
    await jest.advanceTimersByTimeAsync(1500)
    await sending
    expect(a.sent).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(5000)
    expect(a.liveSent).toEqual([])
  })

  it('counts a duplicate refusal after a live attempt as delivered, but not without one', async () => {
    const server = new FakeMessageBox()
    const duplicate = new Error('Message Box send failed with HTTP 400 (ERR_DUPLICATE_MESSAGE).')
    const a = server.liveClient(ALICE)
    a.liveSendHangs = true
    a.sendFailure = duplicate
    const sending = new MessageBoxSignaler(a).send(BOB, ENV)
    await jest.advanceTimersByTimeAsync(1500)
    await expect(sending).resolves.toBeUndefined()

    const coded = server.liveClient(ALICE)
    coded.liveSendFailure = new Error('socket down')
    coded.sendFailure = Object.assign(new Error('HTTP 400'), { code: 'ERR_DUPLICATE_MESSAGE' })
    await expect(new MessageBoxSignaler(coded).send(BOB, ENV)).resolves.toBeUndefined()

    // without a live attempt (the recipient is elsewhere) a duplicate is not assumed delivered
    server.hosts.set(BOB, 'https://other.example')
    const http = server.liveClient(ALICE)
    http.sendFailure = duplicate
    await expect(new MessageBoxSignaler(http).send(BOB, ENV)).rejects.toMatchObject({
      code: 'unavailable'
    })
    const plain = server.client(ALICE)
    plain.sendFailure = duplicate
    await expect(new MessageBoxSignaler(plain).send(BOB, ENV)).rejects.toMatchObject({
      code: 'unavailable'
    })
    // nor is any other refusal after one
    const other = server.liveClient(ALICE)
    other.liveSendFailure = new Error('socket down')
    other.sendFailure = Object.assign(new Error('HTTP 500'), { code: 'ERR_INTERNAL' })
    server.hosts.delete(BOB)
    await expect(new MessageBoxSignaler(other).send(BOB, ENV)).rejects.toMatchObject({
      code: 'unavailable'
    })
  })

  it('falls back to http send when live send throws', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    a.liveSendFailure = new Error('socket down')
    await new MessageBoxSignaler(a).send(BOB, ENV)
    expect(a.liveSent).toHaveLength(1)
    expect(a.sent).toHaveLength(1)
    expect(server.messages.map(m => m.recipient)).toEqual([BOB])
  })

  it('delivers a live message once even if a poll lists it again', async () => {
    const server = new FakeMessageBox()
    server.removeOnAck = false
    const a = server.liveClient(ALICE)
    const b = server.liveClient(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b, { host: 'https://mb.example' }).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      expect(b.liveListens).toEqual([
        { messageBox: 'webrtpay_signals', overrideHost: 'https://mb.example' }
      ])
      await new MessageBoxSignaler(a).send(BOB, ENV)
      // the socket hands the same message over twice
      b.replayLive()
      expect(got).toEqual([[ALICE, ENV]])
      await jest.advanceTimersByTimeAsync(2500)
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks).toEqual([
        { identity: BOB, messageIds: ['m1'], host: 'https://mb.example' }
      ])
    } finally {
      await stop()
    }
  })

  it('leaves non-envelopes from the live room to polling', async () => {
    const server = new FakeMessageBox()
    const b = server.liveClient(BOB)
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      b.pushLive({ messageId: 'x1', sender: ALICE, body: '[Error: Failed to decrypt]' })
      b.pushLive(null)
      expect(got).toEqual([])
      await jest.advanceTimersByTimeAsync(2500)
      expect(server.acks).toEqual([])
    } finally {
      await stop()
    }
  })

  it('keeps polling when live listen fails', async () => {
    const server = new FakeMessageBox()
    const b = server.liveClient(BOB)
    b.liveListenFailure = new Error('no socket on this host')
    const { got, fn } = collect()
    const signaler = new MessageBoxSignaler(b)
    let stop = await signaler.listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      server.deposit(BOB, ALICE, JSON.stringify(ENV))
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toEqual([[ALICE, ENV]])
      // a later first subscription tries live again
      await stop()
      b.liveListenFailure = undefined
      stop = await signaler.listen(fn)
      await jest.advanceTimersByTimeAsync(0)
      expect(b.liveListens).toHaveLength(2)
    } finally {
      await stop()
    }
  })

  it('survives a client whose live calls throw synchronously', async () => {
    const server = new FakeMessageBox()
    const b = server.liveClient(BOB)
    const boom = (): never => {
      throw new Error('sync')
    }
    Object.assign(b, { listenForLiveMessages: boom })
    const signaler = new MessageBoxSignaler(b)
    const stop = await signaler.listen(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    await stop()
    // listening live never started, so a new subscription tries again, still safely
    const again = await signaler.listen(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    await again()

    const c = server.liveClient(BOB)
    Object.assign(c, { leaveRoom: boom, joinRoom: boom })
    const s2 = new MessageBoxSignaler(c)
    const first = await s2.listen(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    await first()
    const second = await s2.listen(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    await second()
    expect(c.liveListens).toHaveLength(1)
  })

  it('does not leave a room it could not join again', async () => {
    const server = new FakeMessageBox()
    const b = server.liveClient(BOB)
    Object.defineProperty(b, 'joinRoom', { value: undefined })
    const signaler = new MessageBoxSignaler(b)
    const first = await signaler.listen(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    await first()
    const second = await signaler.listen(() => undefined)
    await jest.advanceTimersByTimeAsync(0)
    await second()
    expect(b.left).toEqual([])
    expect(b.liveListens).toHaveLength(1)
  })

  it('does not ack a live id twice when a poll confirmed it meanwhile', async () => {
    const server = new FakeMessageBox()
    const a = server.liveClient(ALICE)
    const b = server.liveClient(BOB)
    let open!: () => void
    const { got, fn } = collect()
    const stop = await new MessageBoxSignaler(b).listen(fn)
    try {
      await jest.advanceTimersByTimeAsync(0)
      // a poll reads the message and is still acking it when the live copy arrives
      server.deposit(BOB, ALICE, JSON.stringify(ENV))
      b.ackGate = new Promise<void>(resolve => (open = resolve))
      await jest.advanceTimersByTimeAsync(2500)
      b.pushLive({ messageId: 'm1', sender: ALICE, body: JSON.stringify(ENV) })
      b.ackGate = undefined
      open()
      await jest.advanceTimersByTimeAsync(0)
      await jest.advanceTimersByTimeAsync(2500)
      expect(got).toEqual([[ALICE, ENV]])
      expect(server.acks.flatMap(x => x.messageIds)).toEqual(['m1'])
      expect(a.sent).toEqual([])
    } finally {
      await stop()
    }
  })

  it('leaves the live room on the last unsubscribe and joins it again on the next', async () => {
    const server = new FakeMessageBox()
    const b = server.liveClient(BOB)
    const signaler = new MessageBoxSignaler(b)
    const { got, fn } = collect()
    const first = await signaler.listen(fn)
    const second = await signaler.listen(fn)
    await jest.advanceTimersByTimeAsync(0)
    await first()
    expect(b.left).toEqual([])
    await second()
    expect(b.left).toEqual(['webrtpay_signals'])
    // nobody listening: a live message is left on the server
    b.pushLive({ messageId: 'm9', sender: ALICE, body: JSON.stringify(ENV) })
    expect(got).toEqual([])
    const third = await signaler.listen(fn)
    try {
      expect(b.joined).toEqual(['webrtpay_signals'])
      expect(b.liveListens).toHaveLength(1)
    } finally {
      await third()
    }
  })

  it('leaves the live room once listening starts if everyone unsubscribed meanwhile', async () => {
    const server = new FakeMessageBox()
    const b = server.liveClient(BOB)
    let open!: () => void
    b.liveGate = new Promise<void>(resolve => (open = resolve))
    const stop = await new MessageBoxSignaler(b).listen(() => undefined)
    await stop()
    expect(b.left).toEqual([])
    open()
    await jest.advanceTimersByTimeAsync(0)
    expect(b.left).toEqual(['webrtpay_signals'])
  })

  it('refuses a poll interval that is not a positive number', () => {
    const client = new FakeMessageBox().client(BOB)
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new MessageBoxSignaler(client, { idlePollMs: bad })).toThrow(RangeError)
      expect(() => new MessageBoxSignaler(client, { activePollMs: bad })).toThrow(RangeError)
    }
  })
})
