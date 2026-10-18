import { afterAll, afterEach, describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { PeerLink } from '../src/channel/PeerLink.js'
import type { Hello, PaymentWire, WireMessage } from '../src/payments/wire.js'
import type { AuthenticatedPeer } from '../src/session/AuthenticatedPeer.js'
import { authenticate, bindingTranscript } from '../src/session/handshake.js'
import type { AuthenticateOptions } from '../src/session/handshake.js'
import { sdpFingerprints } from '../src/codec/sdp.js'
import { CHANNEL_PROTOCOL_ID } from '../src/types.js'
import { fromHex, randomBytes, toBase64, toHex, utf8Decode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import { cleanupRtc, nodeRtc } from './helpers/rtc.js'

// File scope so a filtered run (-t) still releases node-datachannel's native threads.
afterAll(cleanupRtc)

/** Every link a test opened; closed after each test so no peer outlives it. */
const liveLinks: PeerLink[] = []

afterEach(() => {
  for (const link of liveLinks.splice(0)) link.close()
})

/** The cap DirectPayClient gives a link until its peer authenticates (Ruling 16). */
const PRE_AUTH_CAP = 65536

interface Party {
  wallet: ProtoWallet
  key: string
}

function party(): Party {
  const key = PrivateKey.fromRandom()
  return { wallet: new ProtoWallet(key), key: key.toPublicKey().toString() }
}

function nonce(): string {
  return toBase64(randomBytes(32))
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** The code a promise rejects with, `'resolved'` if it resolves. */
async function rejectionCode(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof WebRTPayError ? e.code : `not a WebRTPayError: ${String(e)}`
  }
  return 'resolved'
}

function closeOf(on: {
  onClose(fn: (e?: WebRTPayError) => void): () => void
}): Promise<WebRTPayError | undefined> {
  return withTimeout(
    new Promise<WebRTPayError | undefined>(resolve => on.onClose(resolve)),
    10000,
    'close'
  )
}

/**
 * Offerer A and answerer B over loopback, signaled but not yet open, both capped at the
 * pre-auth size. Callers authenticate straight away, as DirectPayClient does.
 */
async function linkPair(): Promise<{ a: PeerLink; b: PeerLink }> {
  const rtc = await nodeRtc()
  const offered = await PeerLink.createOffer({ ...rtc, maxMessageBytes: PRE_AUTH_CAP })
  liveLinks.push(offered.link)
  const answered = await PeerLink.acceptOffer(offered.sdp, {
    ...rtc,
    maxMessageBytes: PRE_AUTH_CAP
  })
  liveLinks.push(answered.link)
  await offered.link.acceptAnswer(answered.sdp)
  return { a: offered.link, b: answered.link }
}

async function authenticatedPair(
  oa: Partial<AuthenticateOptions> = {},
  ob: Partial<AuthenticateOptions> = {}
): Promise<{
  A: Party
  B: Party
  a: PeerLink
  b: PeerLink
  pa: AuthenticatedPeer
  pb: AuthenticatedPeer
}> {
  const A = party()
  const B = party()
  const { a, b } = await linkPair()
  const [pa, pb] = await Promise.all([
    authenticate(a, { wallet: A.wallet, ...oa }),
    authenticate(b, { wallet: B.wallet, ...ob })
  ])
  return { A, B, a, b, pa, pb }
}

function payment(id: string, transaction = 'AAAA'): PaymentWire {
  return {
    t: 'payment',
    id,
    token: {
      customInstructions: { derivationPrefix: 'AAAA', derivationSuffix: 'BBBB' },
      transaction,
      amount: 1000,
      outputIndex: 0
    }
  }
}

function isPayment(m: WireMessage): m is PaymentWire {
  return m.t === 'payment'
}

function collect(peer: AuthenticatedPeer, count: number): Promise<WireMessage[]> {
  const seen: WireMessage[] = []
  return withTimeout(
    new Promise<WireMessage[]>(resolve => {
      const off = peer.onMessage(m => {
        seen.push(m)
        if (seen.length === count) {
          off()
          resolve(seen)
        }
      })
    }),
    10000,
    `${count} messages`
  )
}

/** What the scripted peer B knows when A's hello arrives. */
interface Script {
  aHello: Hello
  b: PeerLink
  A: Party
  B: Party
  /** B's own nonce, for the hello it sends. */
  bNonce: string
  hello: Hello
}

/**
 * A authenticates normally; B never runs `authenticate` but answers A's hello with the
 * messages `script` returns, sent in order. Resolves with A's outcome (its session, or
 * its rejection code and close reason) and what B has received so far (`seenByB` keeps
 * growing).
 */
async function scriptedPeer(
  script: (s: Script) => Promise<object[]> | object[],
  o: Partial<AuthenticateOptions> = {}
): Promise<{
  code: string
  session: AuthenticatedPeer | undefined
  aClose: WebRTPayError | undefined
  seenByB: unknown[]
  s: Script
}> {
  const A = party()
  const B = party()
  const { a, b } = await linkPair()
  const bNonce = nonce()
  const hello: Hello = { t: 'hello', v: 1, identityKey: B.key, nonce: bNonce }
  const seenByB: unknown[] = []
  let s: Script | undefined
  b.onMessage(m => {
    seenByB.push(m)
    if (seenByB.length !== 1) return
    s = { aHello: m as Hello, b, A, B, bNonce, hello }
    void (async () => {
      for (const message of await script(s)) await b.send(message)
    })().catch(() => undefined) // A may close the link before B is done
  })
  let session: AuthenticatedPeer | undefined
  const code = await rejectionCode(
    authenticate(a, { wallet: A.wallet, ...o }).then(p => (session = p))
  )
  const aClose = session ? undefined : await closeOf(a)
  return { code, session, aClose, seenByB, s: s! }
}

/** B's signature over the transcript it would sign as signer, optionally altered. */
async function bAuth(
  s: Script,
  o: { swapFingerprints?: boolean; signer?: Party } = {}
): Promise<{ t: 'auth'; signature: string }> {
  const local = s.b.localFingerprints()
  const remote = s.b.remoteFingerprints()
  const data = bindingTranscript({
    signerFingerprints: o.swapFingerprints ? remote : local,
    verifierFingerprints: o.swapFingerprints ? local : remote,
    signerNonce: s.bNonce,
    verifierNonce: s.aHello.nonce,
    signerKey: s.B.key,
    verifierKey: s.aHello.identityKey
  })
  const { signature } = await (o.signer ?? s.B).wallet.createSignature({
    data,
    protocolID: CHANNEL_PROTOCOL_ID,
    keyID: s.bNonce,
    counterparty: s.aHello.identityKey
  })
  return { t: 'auth', signature: toHex(Uint8Array.from(signature)) }
}

describe('bindingTranscript', () => {
  const signer = { fps: ['sha-256 aa', 'sha-512 bb'], nonce: nonce(), key: party().key }
  const verifier = { fps: ['sha-256 cc'], nonce: nonce(), key: party().key }

  it('is the seven lines of the channel binding joined by newlines, as UTF-8', () => {
    const transcript = bindingTranscript({
      signerFingerprints: signer.fps,
      verifierFingerprints: verifier.fps,
      signerNonce: signer.nonce,
      verifierNonce: verifier.nonce,
      signerKey: signer.key,
      verifierKey: verifier.key
    })
    expect(utf8Decode(Uint8Array.from(transcript))).toBe(
      [
        'webrtpay/1 channel-binding',
        'sha-256 aa,sha-512 bb',
        'sha-256 cc',
        signer.nonce,
        verifier.nonce,
        signer.key,
        verifier.key
      ].join('\n')
    )
  })

  it('is the same bytes for the signer and for the verifier checking that signer', () => {
    // Each side's own view: its link's local and remote fingerprints, its nonce and key,
    // and what the peer's hello said.
    const aView = {
      local: ['sha-256 01'],
      remote: ['sha-256 02'],
      nonce: nonce(),
      key: party().key
    }
    const bView = { local: aView.remote, remote: aView.local, nonce: nonce(), key: party().key }
    const helloFromB = { nonce: bView.nonce, identityKey: bView.key }
    const helloFromA = { nonce: aView.nonce, identityKey: aView.key }

    const signedByA = bindingTranscript({
      signerFingerprints: aView.local,
      verifierFingerprints: aView.remote,
      signerNonce: aView.nonce,
      verifierNonce: helloFromB.nonce,
      signerKey: aView.key,
      verifierKey: helloFromB.identityKey
    })
    const checkedByB = bindingTranscript({
      signerFingerprints: bView.remote,
      verifierFingerprints: bView.local,
      signerNonce: helloFromA.nonce,
      verifierNonce: bView.nonce,
      signerKey: helloFromA.identityKey,
      verifierKey: bView.key
    })
    expect(checkedByB).toEqual(signedByA)

    const signedByB = bindingTranscript({
      signerFingerprints: bView.local,
      verifierFingerprints: bView.remote,
      signerNonce: bView.nonce,
      verifierNonce: helloFromA.nonce,
      signerKey: bView.key,
      verifierKey: helloFromA.identityKey
    })
    expect(signedByB).not.toEqual(signedByA)
  })

  it('sorts each fingerprint list, so their order does not matter', () => {
    const base = {
      verifierFingerprints: ['sha-256 cc', 'sha-1 dd'],
      signerNonce: signer.nonce,
      verifierNonce: verifier.nonce,
      signerKey: signer.key,
      verifierKey: verifier.key
    }
    const fps = ['sha-512 bb', 'sha-256 aa']
    expect(bindingTranscript({ ...base, signerFingerprints: fps })).toEqual(
      bindingTranscript({
        ...base,
        signerFingerprints: ['sha-256 aa', 'sha-512 bb'],
        verifierFingerprints: ['sha-1 dd', 'sha-256 cc']
      })
    )
    // The caller's arrays are left as they were.
    expect(fps).toEqual(['sha-512 bb', 'sha-256 aa'])
  })

  it('matches the published test vector, from SDP fingerprint lines to transcript bytes', () => {
    // Fixed inputs other implementations can check their encoding against. The signer's SDP
    // has two fingerprint lines (to show sorting); hex is upper case with colons, as browsers
    // write it, and is normalised to `<alg> <lowercase hex without colons>`.
    const signerSdp = [
      'v=0',
      'a=fingerprint:SHA-256 00:01:02:03:04:05:06:07:08:09:0A:0B:0C:0D:0E:0F:10:11:12:13:14:15:16:17:18:19:1A:1B:1C:1D:1E:1F',
      'a=fingerprint:sha-1 A0:A1:A2:A3:A4:A5:A6:A7:A8:A9:AA:AB:AC:AD:AE:AF:B0:B1:B2:B3',
      ''
    ].join('\r\n')
    const verifierSdp = [
      'v=0',
      'a=fingerprint:sha-256 E0:E1:E2:E3:E4:E5:E6:E7:E8:E9:EA:EB:EC:ED:EE:EF:F0:F1:F2:F3:F4:F5:F6:F7:F8:F9:FA:FB:FC:FD:FE:FF',
      ''
    ].join('\r\n')
    const transcript = bindingTranscript({
      signerFingerprints: sdpFingerprints(signerSdp),
      verifierFingerprints: sdpFingerprints(verifierSdp),
      signerNonce: 'ERERERERERERERERERERERERERERERERERERERERERE=', // 32 bytes of 0x11
      verifierNonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=', // 32 bytes of 0x22
      signerKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', // key 1
      verifierKey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5' // key 2
    })
    expect(toHex(Uint8Array.from(transcript))).toBe(
      [
        '77656272747061792f31206368616e6e656c2d62696e64696e670a7368612d31',
        '2061306131613261336134613561366137613861396161616261636164616561',
        '6662306231623262332c7368612d323536203030303130323033303430353036',
        '3037303830393061306230633064306530663130313131323133313431353136',
        '3137313831393161316231633164316531660a7368612d323536206530653165',
        '3265336534653565366537653865396561656265636564656565666630663166',
        '3266336634663566366637663866396661666266636664666566660a45524552',
        '4552455245524552455245524552455245524552455245524552455245524552',
        '455245524552453d0a4969496949694969496949694969496949694969496949',
        '69496949694969496949694969496949694969493d0a30323739626536363765',
        '6639646362626163353561303632393563653837306230373032396266636462',
        '3264636532386439353966323831356231366638313739380a30326336303437',
        '6639343431656437643664333034353430366539356330376364383563373738',
        '653462386365663363613761626163303962393563373039656535'
      ].join('')
    )
    expect(transcript).toHaveLength(443)
  })

  it('orders fingerprints by UTF-16 code unit whatever the locale, byte for byte as at bd8b26a36', () => {
    // Entries a locale-aware order would arrange differently: case, digits, Latin-1, an
    // astral character (high surrogate D83D) and a fullwidth letter (FF21).
    const transcript = bindingTranscript({
      signerFingerprints: [
        'sha-256 Zz',
        'sha-256 aa',
        'SHA-1 ff',
        'sha-256 é0',
        'sha-256 😀',
        'sha-256 Ａ',
        'sha-256 10',
        'sha-256 9'
      ],
      verifierFingerprints: ['sha-512 b', 'sha-512 B', 'sha-384 ä', 'sha-384 z'],
      signerNonce: 'ERERERERERERERERERERERERERERERERERERERERERE=',
      verifierNonce: 'IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI=',
      signerKey: '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
      verifierKey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
    })
    const lines = utf8Decode(Uint8Array.from(transcript)).split('\n')
    expect(lines[1]).toBe(
      'SHA-1 ff,sha-256 10,sha-256 9,sha-256 Zz,sha-256 aa,sha-256 é0,sha-256 😀,sha-256 Ａ'
    )
    expect(lines[2]).toBe('sha-384 z,sha-384 ä,sha-512 B,sha-512 b')
    expect(toHex(Uint8Array.from(transcript))).toBe(
      [
        '77656272747061792f31206368616e6e656c2d62696e64696e670a5348412d31',
        '2066662c7368612d3235362031302c7368612d32353620392c7368612d323536',
        '205a7a2c7368612d3235362061612c7368612d32353620c3a9302c7368612d32',
        '353620f09f98802c7368612d32353620efbca10a7368612d333834207a2c7368',
        '612d33383420c3a42c7368612d35313220422c7368612d35313220620a455245',
        '5245524552455245524552455245524552455245524552455245524552455245',
        '52455245524552453d0a49694969496949694969496949694969496949694969',
        '4969496949694969496949694969496949694969493d0a303237396265363637',
        '6566396463626261633535613036323935636538373062303730323962666364',
        '623264636532386439353966323831356231366638313739380a303263363034',
        '3766393434316564376436643330343534303665393563303763643835633737',
        '38653462386365663363613761626163303962393563373039656535'
      ].join('')
    )
    expect(transcript).toHaveLength(380)
  })

  it('takes fingerprints from SDP in UTF-16 code unit order, as at bd8b26a36', () => {
    const sdp = [
      'v=0',
      'a=fingerprint:sha-256 AB:CD',
      'a=fingerprint:SHA-1 0A',
      'a=fingerprint:sha-512 É:1',
      'a=fingerprint:sha-256 😀',
      'a=fingerprint:sha-256 Ａ',
      'a=fingerprint:Sha-256 ab:cd:01',
      ''
    ].join('\r\n')
    expect(sdpFingerprints(sdp)).toEqual([
      'sha-1 0a',
      'sha-256 abcd',
      'sha-256 abcd01',
      'sha-256 😀',
      'sha-256 ａ',
      'sha-512 é1'
    ])
  })
})

describe('authenticate over loopback', () => {
  it('authenticates both sides and reports each identity key', async () => {
    const { A, B, pa, pb } = await authenticatedPair()
    expect(pa.localIdentityKey).toBe(A.key)
    expect(pa.peerIdentityKey).toBe(B.key)
    expect(pb.localIdentityKey).toBe(B.key)
    expect(pb.peerIdentityKey).toBe(A.key)
  })

  it('accepts the peer it expects', async () => {
    const A = party()
    const B = party()
    const { a, b } = await linkPair()
    const [pa, pb] = await Promise.all([
      authenticate(a, { wallet: A.wallet, expectedPeer: B.key, originator: 'app.example' }),
      authenticate(b, { wallet: B.wallet, expectedPeer: A.key })
    ])
    expect(pa.peerIdentityKey).toBe(B.key)
    expect(pb.peerIdentityKey).toBe(A.key)
  })

  it('signs and checks with the documented parameters and messages', async () => {
    const r = await scriptedPeer(async s => [s.hello, await bAuth(s), { t: 'ready' }])
    expect(r.code).toBe('resolved')
    // A resolves on B's ready; its own ready may still be in flight.
    if (r.seenByB.length < 3) {
      await withTimeout(
        new Promise<void>(resolve => r.s.b.onMessage(() => r.seenByB.length === 3 && resolve())),
        10000,
        "A's ready"
      )
    }
    const [hello, auth, ready] = r.seenByB as [Hello, { t: 'auth'; signature: string }, object]
    expect(hello).toEqual({ t: 'hello', v: 1, identityKey: r.s.A.key, nonce: r.s.aHello.nonce })
    expect(ready).toEqual({ t: 'ready' })
    expect(auth.signature).toMatch(/^[0-9a-f]+$/)
    const data = bindingTranscript({
      signerFingerprints: r.s.b.remoteFingerprints(),
      verifierFingerprints: r.s.b.localFingerprints(),
      signerNonce: hello.nonce,
      verifierNonce: r.s.bNonce,
      signerKey: r.s.A.key,
      verifierKey: r.s.B.key
    })
    await expect(
      r.s.B.wallet.verifySignature({
        data,
        signature: Array.from(fromHex(auth.signature)),
        protocolID: CHANNEL_PROTOCOL_ID,
        keyID: hello.nonce,
        counterparty: r.s.A.key
      })
    ).resolves.toEqual({ valid: true })
  })

  it('rejects both sides with auth_failed when each expects a third key, before signing', async () => {
    const A = party()
    const B = party()
    const C = party()
    const signA = jest.spyOn(A.wallet, 'createSignature')
    const signB = jest.spyOn(B.wallet, 'createSignature')
    const { a, b } = await linkPair()
    const [ca, cb] = await Promise.all([
      rejectionCode(authenticate(a, { wallet: A.wallet, expectedPeer: C.key })),
      rejectionCode(authenticate(b, { wallet: B.wallet, expectedPeer: C.key }))
    ])
    expect([ca, cb]).toEqual(['auth_failed', 'auth_failed'])
    expect(signA).not.toHaveBeenCalled()
    expect(signB).not.toHaveBeenCalled()
    expect((await closeOf(a))?.code).toBe('auth_failed')
    expect(a.isOpen).toBe(false)
    expect(b.isOpen).toBe(false)
  })

  it('rejects both sides with auth_failed when a relay forwards the handshake between two links', async () => {
    const A = party()
    const B = party()
    const rtc = await nodeRtc()
    const capped = { ...rtc, maxMessageBytes: PRE_AUTH_CAP }
    // A offers to M; M offers to B. M terminates DTLS on each link separately.
    const aOffer = await PeerLink.createOffer(capped)
    liveLinks.push(aOffer.link)
    const mFromA = await PeerLink.acceptOffer(aOffer.sdp, capped)
    liveLinks.push(mFromA.link)
    await aOffer.link.acceptAnswer(mFromA.sdp)
    const mOffer = await PeerLink.createOffer(capped)
    liveLinks.push(mOffer.link)
    const bAnswer = await PeerLink.acceptOffer(mOffer.sdp, capped)
    liveLinks.push(bAnswer.link)
    await mOffer.link.acceptAnswer(bAnswer.sdp)
    const a = aOffer.link
    const b = bAnswer.link

    // M copies every handshake message verbatim to its other link, and nothing else.
    const forwarded: string[] = []
    const relay = (from: PeerLink, to: PeerLink): void => {
      from.onMessage(m => {
        const t = (m as { t?: unknown }).t
        if (t !== 'hello' && t !== 'auth' && t !== 'ready') return
        forwarded.push(t)
        void to.send(m as object).catch(() => undefined)
      })
    }
    relay(mFromA.link, mOffer.link)
    relay(mOffer.link, mFromA.link)
    await Promise.all([a, mFromA.link, mOffer.link, b].map(link => link.waitOpen(10000)))
    // What each end sees as its peer's certificate is M's, not the other end's.
    expect(a.remoteFingerprints()).not.toEqual(b.localFingerprints())
    expect(b.remoteFingerprints()).not.toEqual(a.localFingerprints())

    const [ca, cb] = await Promise.all([
      rejectionCode(authenticate(a, { wallet: A.wallet })),
      rejectionCode(authenticate(b, { wallet: B.wallet }))
    ])
    expect([ca, cb]).toEqual(['auth_failed', 'auth_failed'])
    // Each rejected the other's signature, which covers fingerprints M could not forge.
    expect((await closeOf(a))?.message).toBe('Peer signature does not verify')
    expect((await closeOf(b))?.message).toBe('Peer signature does not verify')
    expect(forwarded).toContain('auth')
    expect(forwarded).not.toContain('ready')
    expect(a.isOpen).toBe(false)
    expect(b.isOpen).toBe(false)
  })

  it('rejects payment before auth', async () => {
    const r = await scriptedPeer(s => [s.hello, payment('early')])
    expect(r.code).toBe('auth_failed')
    expect(r.aClose?.code).toBe('auth_failed')
    // A said hello (and may have signed: closing can drop that frame), never `ready`.
    expect((r.seenByB[0] as Hello).t).toBe('hello')
    expect(r.seenByB).not.toContainEqual({ t: 'ready' })
  })

  it('rejects a payment sent in place of ready, after verifying the peer', async () => {
    const r = await scriptedPeer(async s => [s.hello, await bAuth(s), payment('early')])
    expect(r.code).toBe('auth_failed')
    expect(r.aClose?.code).toBe('auth_failed')
  })

  it('waits for the peer to send ready', async () => {
    const r = await scriptedPeer(async s => [s.hello, await bAuth(s)], { timeoutMs: 1000 })
    expect(r.code).toBe('timeout')
  })

  it('hands a message the peer sent right after ready to the session', async () => {
    const r = await scriptedPeer(async s => {
      // A slow wallet, so ready and the payment arrive while A is still verifying.
      const verify = s.A.wallet.verifySignature.bind(s.A.wallet)
      jest.spyOn(s.A.wallet, 'verifySignature').mockImplementation(async args => {
        await new Promise(resolve => setTimeout(resolve, 200))
        return verify(args)
      })
      return [s.hello, await bAuth(s), { t: 'ready' }, payment('right-after')]
    })
    expect((await r.session!.waitFor(isPayment, 10000)).id).toBe('right-after')
  })

  /** More messages than a compliant peer can have waiting before it has A's ready. */
  const flood = (): PaymentWire[] => Array.from({ length: 20 }, (_, i) => payment(`flood-${i}`))

  it.each<[string, (s: Script, gate: Promise<void>) => Promise<object[]>]>([
    [
      'signs',
      async (s, gate) => {
        const sign = s.A.wallet.createSignature.bind(s.A.wallet)
        jest.spyOn(s.A.wallet, 'createSignature').mockImplementation(async args => {
          await gate
          return sign(args)
        })
        return [s.hello, ...flood()]
      }
    ],
    [
      'verifies',
      async (s, gate) => {
        const verify = s.A.wallet.verifySignature.bind(s.A.wallet)
        jest.spyOn(s.A.wallet, 'verifySignature').mockImplementation(async args => {
          await gate
          return verify(args)
        })
        return [s.hello, await bAuth(s), ...flood()]
      }
    ]
  ])(
    'rejects with auth_failed and closes the link when the peer floods while A %s',
    async (_name, script) => {
      // A's wallet call stays pending until A has given up, so only the queue limit can end
      // the handshake before its timeout.
      let release = (): void => undefined
      const gate = new Promise<void>(resolve => {
        release = () => resolve()
      })
      try {
        const r = await scriptedPeer(s => script(s, gate), { timeoutMs: 2000 })
        expect(r.code).toBe('auth_failed')
        expect(r.aClose?.code).toBe('auth_failed')
        expect(r.aClose?.message).toBe('Peer sent too many messages during the handshake')
        expect(r.seenByB).not.toContainEqual({ t: 'ready' })
      } finally {
        release()
      }
    }
  )

  it.each<[string, (s: Script) => Promise<object[]> | object[]]>([
    ['a payment instead of a hello', () => [payment('early')]],
    ['ready before auth', s => [s.hello, { t: 'ready' }]],
    ['auth before hello', async s => [await bAuth(s), s.hello]],
    ['a second hello instead of auth', s => [s.hello, s.hello]],
    ['an unknown message type', () => [{ t: 'nope' }]],
    ['a hello without a nonce', s => [{ t: 'hello', v: 1, identityKey: s.B.key }]],
    ['a hello of another version', s => [{ ...s.hello, v: 2 }]],
    ['a hello with a non-canonical key', s => [{ ...s.hello, identityKey: s.B.key.toUpperCase() }]],
    ['a hello that echoes our nonce', s => [{ ...s.hello, nonce: s.aHello.nonce }]],
    ['an auth that is not a signature', s => [s.hello, { t: 'auth', signature: '00' }]],
    [
      'an auth signed by another identity',
      async s => [s.hello, await bAuth(s, { signer: party() }), { t: 'ready' }]
    ],
    [
      'an auth over swapped fingerprints',
      async s => [s.hello, await bAuth(s, { swapFingerprints: true }), { t: 'ready' }]
    ],
    ['an error message', s => [s.hello, { t: 'error', code: 'busy' }]]
  ])('rejects with auth_failed and closes the link for %s', async (_name, script) => {
    const r = await scriptedPeer(script)
    expect(r.code).toBe('auth_failed')
    expect(r.aClose?.code).toBe('auth_failed')
    expect(r.seenByB).not.toContainEqual({ t: 'ready' })
  })

  it('rejects with timeout and closes the link when the peer stays silent', async () => {
    const A = party()
    const { a } = await linkPair()
    const started = Date.now()
    const code = await rejectionCode(authenticate(a, { wallet: A.wallet, timeoutMs: 500 }))
    expect(code).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(5000)
    expect((await closeOf(a))?.code).toBe('timeout')
  })

  it('rejects with timeout when the channel never opens', async () => {
    const A = party()
    const rtc = await nodeRtc()
    const { link } = await PeerLink.createOffer(rtc)
    liveLinks.push(link)
    const code = await rejectionCode(authenticate(link, { wallet: A.wallet, timeoutMs: 300 }))
    expect(code).toBe('timeout')
    expect(link.isOpen).toBe(false)
  })

  it('rejects with the close reason when the peer closes mid-handshake', async () => {
    const r = await scriptedPeer(s => {
      s.b.close()
      return []
    })
    expect(r.code).toBe('closed')
  })

  it('rejects with the close reason for a link that is already closed', async () => {
    const A = party()
    const { a } = await linkPair()
    a.close(new WebRTPayError('rejected', 'gone'))
    expect(await rejectionCode(authenticate(a, { wallet: A.wallet }))).toBe('rejected')
  })

  it('rejects with auth_failed and closes the link when the wallet will not sign', async () => {
    const r = await scriptedPeer(s => {
      jest.spyOn(s.A.wallet, 'createSignature').mockRejectedValue(new Error('User denied'))
      return [s.hello]
    })
    expect(r.code).toBe('auth_failed')
    expect(r.aClose?.code).toBe('auth_failed')
  })

  it('starts the timeout once startAfter settles, still listening meanwhile', async () => {
    // A's answer goes out only at 1.5 s (startAfter) and B starts then too; a 1 s timeout
    // counted from the start would have fired long before.
    const A = party()
    const B = party()
    const { a, b } = await linkPair()
    let released!: () => void
    const startAfter = new Promise<void>(resolve => (released = resolve))
    const atA = authenticate(a, { wallet: A.wallet, timeoutMs: 1000, startAfter })
    const atB = new Promise<AuthenticatedPeer>((resolve, reject) =>
      setTimeout(() => {
        authenticate(b, { wallet: B.wallet, timeoutMs: 1000 }).then(resolve, reject)
        released()
      }, 1500)
    )
    const [pa, pb] = await Promise.all([atA, atB])
    expect(pa.peerIdentityKey).toBe(B.key)
    expect(pb.peerIdentityKey).toBe(A.key)
  })

  it('fails with the error startAfter rejects with and closes the link', async () => {
    const A = party()
    const { a } = await linkPair()
    const unsent = new WebRTPayError('peer_unreachable', 'answer not delivered')
    const startAfter = new Promise<void>((_, reject) => setTimeout(() => reject(unsent), 100))
    await expect(authenticate(a, { wallet: A.wallet, startAfter })).rejects.toBe(unsent)
    expect(await closeOf(a)).toBe(unsent)
  })

  it('caps messages at 64 KiB until the peer authenticates, whatever cap the link had (M12)', async () => {
    const rtc = await nodeRtc()
    // links on their own accept 32 MiB
    const offered = await PeerLink.createOffer(rtc)
    liveLinks.push(offered.link)
    const answered = await PeerLink.acceptOffer(offered.sdp, rtc)
    liveLinks.push(answered.link)
    await offered.link.acceptAnswer(answered.sdp)
    const A = party()
    const B = party()
    const outcome = rejectionCode(authenticate(offered.link, { wallet: A.wallet }))
    const b = answered.link
    await b.waitOpen(10000)
    const hello = { t: 'hello', v: 1, identityKey: B.key, nonce: nonce() }
    await b.send({ ...hello, pad: 'x'.repeat(PRE_AUTH_CAP) })
    expect(await outcome).toBe('too_large')
    expect((await closeOf(offered.link))?.code).toBe('too_large')
  })

  it('rejects a maxMessageBytes that is not a size, leaving the link alone', async () => {
    const A = party()
    const { a } = await linkPair()
    await expect(authenticate(a, { wallet: A.wallet, maxMessageBytes: -1 })).rejects.toThrow(
      RangeError
    )
    await a.waitOpen(10000)
    expect(a.isOpen).toBe(true)
  })
})

describe('AuthenticatedPeer', () => {
  it('exchanges messages both ways, in order', async () => {
    const { pa, pb } = await authenticatedPair()
    const atB = collect(pb, 3)
    const atA = collect(pa, 1)
    await Promise.all([pa.send(payment('p1')), pa.send(payment('p2')), pa.send(payment('p3'))])
    await pb.send({ t: 'payment.ack', id: 'p1', status: 'accepted' })
    expect((await atB).map(m => (m as PaymentWire).id)).toEqual(['p1', 'p2', 'p3'])
    expect(await atA).toEqual([{ t: 'payment.ack', id: 'p1', status: 'accepted' }])
  })

  it('carries messages larger than the pre-auth cap once authenticated', async () => {
    const { pa, pb } = await authenticatedPair()
    const big = 'A'.repeat(100 * 1024)
    const atB = pb.waitFor(isPayment, 10000)
    await pa.send(payment('big-a', big))
    expect((await atB).token.transaction).toBe(big)
    const atA = pa.waitFor(isPayment, 10000)
    await pb.send(payment('big-b', big))
    expect((await atA).token.transaction).toBe(big)
  })

  it('applies maxMessageBytes from the options once authenticated', async () => {
    const { pa, pb } = await authenticatedPair({}, { maxMessageBytes: 70000 })
    const closed = closeOf(pb)
    await pa.send(payment('fits', 'A'.repeat(60000)))
    expect((await pb.waitFor(isPayment, 10000)).id).toBe('fits')
    await pa.send(payment('too-big', 'A'.repeat(80000)))
    expect((await closed)?.code).toBe('too_large')
  })

  it('keeps messages that arrive before the first listener and delivers them in order', async () => {
    const { b, pa, pb } = await authenticatedPair()
    // Watch the raw link to know when all three have arrived at B.
    let arrived = 0
    const allArrived = withTimeout(
      new Promise<void>(resolve => b.onMessage(() => ++arrived === 3 && resolve())),
      10000,
      'arrival'
    )
    for (const id of ['k1', 'k2', 'k3']) await pa.send(payment(id))
    await allArrived
    const later = collect(pb, 4)
    await pa.send(payment('k4'))
    expect((await later).map(m => (m as PaymentWire).id)).toEqual(['k1', 'k2', 'k3', 'k4'])
  })

  it('closes with protocol when more than 64 messages wait for a first listener', async () => {
    const { pa, pb } = await authenticatedPair()
    const closed = closeOf(pb)
    for (let i = 0; i < 65; i++) void pa.send(payment(`m${i}`)).catch(() => undefined)
    expect((await closed)?.code).toBe('protocol')
  })

  it('resolves waitFor with the first matching message and skips the others', async () => {
    const { pa, pb } = await authenticatedPair()
    const ack = pa.waitFor(
      (m): m is Extract<WireMessage, { t: 'payment.ack' }> =>
        m.t === 'payment.ack' && m.id === 'p2',
      10000
    )
    await pb.send({ t: 'payment.ack', id: 'p1', status: 'accepted' })
    await pb.send(payment('p2'))
    await pb.send({ t: 'payment.ack', id: 'p2', status: 'received' })
    await pb.send({ t: 'payment.ack', id: 'p2', status: 'rejected' })
    expect(await ack).toEqual({ t: 'payment.ack', id: 'p2', status: 'received' })
  })

  it('rejects waitFor with timeout and leaves the session open', async () => {
    const { pa, pb } = await authenticatedPair()
    expect(await rejectionCode(pa.waitFor(isPayment, 200))).toBe('timeout')
    const next = pb.waitFor(isPayment, 10000)
    await pa.send(payment('after'))
    expect((await next).id).toBe('after')
  })

  it('rejects waitFor with closed when the peer closes', async () => {
    const { pa, pb } = await authenticatedPair()
    const waiting = pa.waitFor(isPayment, 10000)
    pb.close()
    expect(await rejectionCode(waiting)).toBe('closed')
  })

  it('rejects waitFor when the predicate throws', async () => {
    const { pa, pb } = await authenticatedPair()
    const waiting = pa.waitFor((_m): _m is PaymentWire => {
      throw new Error('bad predicate')
    }, 10000)
    await pb.send(payment('p'))
    await expect(waiting).rejects.toThrow('bad predicate')
  })

  it('answers an invalid message with a protocol error and closes', async () => {
    const { a, b, pa } = await authenticatedPair()
    const sent = jest.spyOn(a, 'send')
    const closed = closeOf(pa)
    await b.send({ t: 'payment', id: 'no token' })
    expect((await closed)?.code).toBe('protocol')
    // Sent before closing; the close may still drop it in flight (see PeerLink.close).
    expect(sent).toHaveBeenCalledWith({ t: 'error', code: 'protocol' })
  })

  it.each<[string, (B: Party) => object]>([
    ['hello', B => ({ t: 'hello', v: 1, identityKey: B.key, nonce: nonce() })],
    ['auth', () => ({ t: 'auth', signature: 'ab'.repeat(35) })],
    ['ready', () => ({ t: 'ready' })]
  ])('closes with protocol when the peer sends %s after the handshake', async (_name, make) => {
    const { B, b, pa } = await authenticatedPair()
    const got: WireMessage[] = []
    pa.onMessage(m => got.push(m))
    const closed = closeOf(pa)
    await b.send(make(B))
    expect((await closed)?.code).toBe('protocol')
    expect(got).toEqual([])
  })

  it('closes the link with the reason given to close', async () => {
    const { pa, pb } = await authenticatedPair()
    const atB = closeOf(pb)
    pa.close(new WebRTPayError('rejected', 'done here'))
    expect((await closeOf(pa))?.code).toBe('rejected')
    expect((await atB)?.code).toBe('closed')
    await expect(pa.send({ t: 'bye' })).rejects.toMatchObject({ code: 'rejected' })
  })
})
