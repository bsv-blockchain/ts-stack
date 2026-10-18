import { afterAll, describe, expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { decodeCode, encodeAnswerCode, encodeOfferCode } from '../src/codec/codes.js'
import type { AnswerCode, OfferCode } from '../src/codec/codes.js'
import { decodeSdp, encodeSdp, sdpFingerprints } from '../src/codec/sdp.js'
import { CODE_PREFIX } from '../src/types.js'
import { concatBytes, fromBase64Url, fromHex, toBase64Url, utf8Encode } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'
import type { WebRTPayErrorCode } from '../src/util/errors.js'
import { cleanupRtc, nodeRtc } from './helpers/rtc.js'

/**
 * A Chromium 152 data-channel offer: two mDNS hosts, srflx IPv4 and srflx IPv6. The public
 * addresses are documentation ranges (RFC 5737, RFC 3849), never a real capture's.
 */
const CHROMIUM_OFFER = [
  'v=0',
  'o=- 1545341433245991043 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 50456 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 198.51.100.23',
  'a=candidate:2622344714 1 udp 2113937151 5782404b-578f-45cc-93b2-b088c7b105af.local 50456 typ host generation 0 network-cost 999',
  'a=candidate:3594125055 1 udp 2113939711 240fe1ae-0793-4528-a755-30bd97345e08.local 59971 typ host generation 0 network-cost 999',
  'a=candidate:2372395641 1 udp 1677729535 198.51.100.23 50456 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:2845922083 1 udp 1677732095 2001:db8:85a3:8d3:1319:8a2e:370:7348 59971 typ srflx raddr :: rport 0 generation 0 network-cost 999',
  'a=ice-ufrag:VwaI',
  'a=ice-pwd:BsxR6f1OP+yPowZzWNDUFhlH',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 F5:B1:DF:63:AC:63:C8:82:EA:7C:29:A3:9B:8D:25:10:E8:28:7F:B7:6D:3E:85:4C:C3:D4:12:B6:72:7A:DF:F9',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  ''
].join('\r\n')

/** A node-datachannel answer shape: session-level fingerprint, `\n` line endings. */
const NDC_ANSWER = [
  'v=0',
  'o=rtc 4154589534 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=msid-semantic:WMS *',
  'a=ice-options:ice2,trickle',
  'a=fingerprint:sha-256 31:D2:C2:9C:0C:0A:C4:F3:C6:D4:DD:05:DF:84:B4:20:86:A5:1E:52:5F:4A:76:E8:32:E9:B4:44:5C:24:C1:FC',
  'm=application 58496 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 127.0.0.1',
  'a=mid:0',
  'a=sendrecv',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  'a=setup:active',
  'a=ice-ufrag:7W9F',
  'a=ice-pwd:/8CeqO4kPP1AX4KA36cCOX',
  'a=candidate:1 1 UDP 2114977791 127.0.0.1 58496 typ host',
  'a=end-of-candidates',
  ''
].join('\n')

// File scope: a describe-level afterAll is skipped when a filter (-t) skips that block's
// tests, and node-datachannel's native threads would then keep jest from exiting.
afterAll(cleanupRtc)

const IDENTITY_KEY = new PrivateKey(42).toPublicKey().toString()
const SID = Uint8Array.from({ length: 16 }, (_, i) => i * 17)

/** Values of every `a=<name>:` line, wherever it appears. */
function attr(sdp: string, name: string): string[] {
  const prefix = `a=${name}:`
  return sdp
    .split(/\r?\n/)
    .filter(l => l.startsWith(prefix))
    .map(l => l.slice(prefix.length))
}

interface Candidate {
  transport: string
  address: string
  port: number
  type: string
}

/** The connection-relevant part of each candidate line (foundation and priority are regenerated). */
function candidates(sdp: string, transport = 'udp'): Candidate[] {
  return attr(sdp, 'candidate')
    .map(v => v.split(' '))
    .map(t => ({ transport: t[2].toLowerCase(), address: t[4], port: Number(t[5]), type: t[7] }))
    .filter(c => c.transport === transport)
}

/** Replace each CRLF line starting with `prefix` by `next`, or remove it when `next` is null. */
function replaceLine(sdp: string, prefix: string, next: string | null): string {
  return sdp
    .split('\r\n')
    .flatMap(l => (l.startsWith(prefix) ? (next === null ? [] : [next]) : [l]))
    .join('\r\n')
}

/** Insert `line` after each CRLF line starting with `prefix`. */
function insertAfter(sdp: string, prefix: string, line: string): string {
  return sdp
    .split('\r\n')
    .flatMap(l => (l.startsWith(prefix) ? [l, line] : [l]))
    .join('\r\n')
}

function thrown(fn: () => unknown): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  throw new Error('expected the call to throw')
}

function expectWebRTPayError(fn: () => unknown, code: WebRTPayErrorCode): void {
  const e = thrown(fn)
  expect(e).toBeInstanceOf(WebRTPayError)
  expect((e as WebRTPayError).code).toBe(code)
}

/** Resolve once ICE gathering completes (non-trickle), or reject after `ms`. */
function gathered(pc: RTCPeerConnection, ms = 5000): Promise<void> {
  return withTimeout(
    new Promise<void>(resolve => {
      if (pc.iceGatheringState === 'complete') return resolve()
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') resolve()
      })
    }),
    ms,
    'ICE gathering'
  )
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('sdpFingerprints', () => {
  it('returns sorted "<alg> <hex>" for session- and media-level lines, normalised', () => {
    const sdp = [
      'v=0',
      'a=fingerprint:SHA-256 AA:BB:CC',
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
      'a=fingerprint:sha-1 0A:1b:2C'
    ].join('\r\n')
    expect(sdpFingerprints(sdp)).toEqual(['sha-1 0a1b2c', 'sha-256 aabbcc'])
  })

  it('reads the Chromium media-level fingerprint and returns [] when there is none', () => {
    expect(sdpFingerprints(CHROMIUM_OFFER)).toEqual([
      'sha-256 f5b1df63ac63c882ea7c29a39b8d2510e8287fb76d3e854cc3d412b6727adff9'
    ])
    expect(sdpFingerprints('v=0\r\n')).toEqual([])
  })
})

describe('encodeSdp / decodeSdp: compact form', () => {
  it('packs the Chromium offer into 130 bytes and rebuilds the same transport parameters', () => {
    const bytes = encodeSdp(CHROMIUM_OFFER)
    expect(bytes[0]).toBe(1)
    expect(bytes.length).toBe(130)

    const rebuilt = decodeSdp(bytes)
    expect(sdpFingerprints(rebuilt)).toEqual(sdpFingerprints(CHROMIUM_OFFER))
    expect(attr(rebuilt, 'ice-ufrag')).toEqual(['VwaI'])
    expect(attr(rebuilt, 'ice-pwd')).toEqual(['BsxR6f1OP+yPowZzWNDUFhlH'])
    expect(attr(rebuilt, 'setup')).toEqual(['actpass'])
    expect(attr(rebuilt, 'mid')).toEqual(['0'])
    expect(attr(rebuilt, 'sctp-port')).toEqual(['5000'])
    expect(attr(rebuilt, 'max-message-size')).toEqual(['262144'])
    expect(candidates(rebuilt)).toEqual(candidates(CHROMIUM_OFFER))
    expect(candidates(rebuilt)).toHaveLength(4)
    expect(rebuilt.endsWith('\r\na=end-of-candidates\r\n')).toBe(true)
  })

  it('writes RFC 8445 priorities and raddr for non-host candidates', () => {
    const lines = attr(decodeSdp(encodeSdp(CHROMIUM_OFFER)), 'candidate')
    const prefs = [126, 126, 100, 100]
    lines.forEach((line, i) => {
      const t = line.split(' ')
      expect(t[1]).toBe('1')
      expect(Number(t[3])).toBe(prefs[i] * 2 ** 24 + (65535 - i) * 256 + 255)
    })
    expect(lines[0]).not.toContain('raddr')
    expect(lines[2]).toContain(' typ srflx raddr 0.0.0.0 rport 0')
    expect(lines[3]).toContain(' typ srflx raddr :: rport 0')
  })

  it('handles node-datachannel shape: session-level fingerprint, LF endings, uppercase UDP', () => {
    const bytes = encodeSdp(NDC_ANSWER)
    expect(bytes[0]).toBe(1)
    const rebuilt = decodeSdp(bytes)
    expect(sdpFingerprints(rebuilt)).toEqual(sdpFingerprints(NDC_ANSWER))
    expect(attr(rebuilt, 'setup')).toEqual(['active'])
    expect(candidates(rebuilt)).toEqual([
      { transport: 'udp', address: '127.0.0.1', port: 58496, type: 'host' }
    ])
  })

  it('drops TCP candidates instead of falling back', () => {
    const withTcp = insertAfter(
      CHROMIUM_OFFER,
      'a=candidate:2622344714',
      'a=candidate:9 1 tcp 1518280447 192.168.1.5 9 typ host tcptype active generation 0'
    )
    const bytes = encodeSdp(withTcp)
    expect(bytes[0]).toBe(1)
    const rebuilt = decodeSdp(bytes)
    expect(candidates(rebuilt)).toEqual(candidates(CHROMIUM_OFFER))
    expect(candidates(rebuilt, 'tcp')).toEqual([])
  })

  it('compresses IPv6 to RFC 5952 form and lowercases mDNS names', () => {
    const sdp = insertAfter(
      replaceLine(CHROMIUM_OFFER, 'a=candidate:', null),
      'c=IN IP4',
      [
        'a=candidate:1 1 udp 1 2001:0DB8:0000:0000:0000:0000:0000:0001 5000 typ relay raddr 0.0.0.0 rport 0',
        'a=candidate:2 1 udp 1 5782404B-578F-45CC-93B2-B088C7B105AF.local 5001 typ host',
        'a=candidate:3 1 udp 1 10.0.0.1 5002 typ prflx raddr 0.0.0.0 rport 0',
        'a=candidate:4 1 udp 1 2001:db8:0:0:1:0:0:4 5003 typ host',
        'a=candidate:5 1 udp 1 2001:db8:0:0:1:0:0:0 5004 typ host',
        'a=candidate:6 1 udp 1 2001:db8:0:3:4:5:6:7 5005 typ host'
      ].join('\r\n')
    )
    expect(candidates(decodeSdp(encodeSdp(sdp)))).toEqual([
      { transport: 'udp', address: '2001:db8::1', port: 5000, type: 'relay' },
      {
        transport: 'udp',
        address: '5782404b-578f-45cc-93b2-b088c7b105af.local',
        port: 5001,
        type: 'host'
      },
      { transport: 'udp', address: '10.0.0.1', port: 5002, type: 'prflx' },
      // Equal runs: the first is compressed; a longer later run wins; a single zero group is
      // never compressed.
      { transport: 'udp', address: '2001:db8::1:0:0:4', port: 5003, type: 'host' },
      { transport: 'udp', address: '2001:db8:0:0:1::', port: 5004, type: 'host' },
      { transport: 'udp', address: '2001:db8:0:3:4:5:6:7', port: 5005, type: 'host' }
    ])
  })

  it('treats an absent max-message-size as 65536 and keeps 0 (no limit)', () => {
    const absent = replaceLine(CHROMIUM_OFFER, 'a=max-message-size:', null)
    expect(attr(decodeSdp(encodeSdp(absent)), 'max-message-size')).toEqual(['65536'])
    const zero = replaceLine(CHROMIUM_OFFER, 'a=max-message-size:', 'a=max-message-size:0')
    expect(encodeSdp(zero)[0]).toBe(1)
    expect(attr(decodeSdp(encodeSdp(zero)), 'max-message-size')).toEqual(['0'])
  })

  it('is a fixed point: re-encoding a rebuilt SDP gives the same bytes', () => {
    const bytes = encodeSdp(CHROMIUM_OFFER)
    expect(encodeSdp(decodeSdp(bytes))).toEqual(bytes)
  })
})

describe('encodeSdp / decodeSdp: raw fallback', () => {
  it('falls back for two fingerprints and decodes to the original text', () => {
    const sdp = insertAfter(
      CHROMIUM_OFFER,
      'a=fingerprint:',
      'a=fingerprint:sha-256 00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF'
    )
    const bytes = encodeSdp(sdp)
    expect(bytes[0]).toBe(2)
    expect(decodeSdp(bytes)).toBe(sdp)
  })

  const longUfrag = 'a'.repeat(256)
  const cases: [string, string][] = [
    [
      'sha-1 fingerprint',
      replaceLine(CHROMIUM_OFFER, 'a=fingerprint:', 'a=fingerprint:sha-1 0A:0B')
    ],
    ['no fingerprint', replaceLine(CHROMIUM_OFFER, 'a=fingerprint:', null)],
    [
      'short sha-256 fingerprint',
      replaceLine(CHROMIUM_OFFER, 'a=fingerprint:', 'a=fingerprint:sha-256 AA:BB')
    ],
    ['mid other than 0', replaceLine(CHROMIUM_OFFER, 'a=mid:', 'a=mid:data')],
    ['no mid', replaceLine(CHROMIUM_OFFER, 'a=mid:', null)],
    ['sctp-port other than 5000', replaceLine(CHROMIUM_OFFER, 'a=sctp-port:', 'a=sctp-port:5001')],
    [
      'max-message-size not a power of two',
      replaceLine(CHROMIUM_OFFER, 'a=max-message-size:', 'a=max-message-size:1073741823')
    ],
    ['setup holdconn', replaceLine(CHROMIUM_OFFER, 'a=setup:', 'a=setup:holdconn')],
    [
      'a rejected (port 0) media section',
      replaceLine(CHROMIUM_OFFER, 'm=', 'm=application 0 UDP/DTLS/SCTP webrtc-datachannel')
    ],
    ['no setup', replaceLine(CHROMIUM_OFFER, 'a=setup:', null)],
    [
      'ufrag over 255 bytes',
      replaceLine(CHROMIUM_OFFER, 'a=ice-ufrag:', `a=ice-ufrag:${longUfrag}`)
    ],
    ['no ice-pwd', replaceLine(CHROMIUM_OFFER, 'a=ice-pwd:', null)],
    ['ice-lite', insertAfter(CHROMIUM_OFFER, 't=0 0', 'a=ice-lite')],
    [
      'a second m= section',
      insertAfter(CHROMIUM_OFFER, 'a=max-message-size:', 'm=audio 9 UDP/TLS/RTP/SAVPF 111')
    ],
    [
      'a .local name that is not a UUID',
      insertAfter(CHROMIUM_OFFER, 'c=IN IP4', 'a=candidate:7 1 udp 1 my-laptop.local 5000 typ host')
    ],
    [
      'a hostname candidate',
      insertAfter(CHROMIUM_OFFER, 'c=IN IP4', 'a=candidate:7 1 udp 1 example.com 5000 typ host')
    ],
    [
      'a truncated candidate line',
      insertAfter(CHROMIUM_OFFER, 'c=IN IP4', 'a=candidate:7 1 udp 1 10.0.0.1')
    ],
    [
      'an unknown candidate type',
      insertAfter(CHROMIUM_OFFER, 'c=IN IP4', 'a=candidate:7 1 udp 1 10.0.0.1 5000 typ bogus')
    ],
    [
      'an RTCP component',
      insertAfter(CHROMIUM_OFFER, 'c=IN IP4', 'a=candidate:7 2 udp 1 10.0.0.1 5000 typ host')
    ]
  ]

  it.each(cases)('falls back for %s', (_, sdp) => {
    const bytes = encodeSdp(sdp)
    expect(bytes[0]).toBe(2)
    expect(decodeSdp(bytes)).toBe(sdp)
  })

  it('never throws while encoding, even for text that is not SDP', () => {
    expect(decodeSdp(encodeSdp(''))).toBe('')
    expect(decodeSdp(encodeSdp('not sdp at all'))).toBe('not sdp at all')
  })
})

describe('decodeSdp rejects malformed bytes', () => {
  const compact = encodeSdp(CHROMIUM_OFFER)
  const cases: [string, Uint8Array][] = [
    ['empty input', new Uint8Array(0)],
    ['an unknown form byte', Uint8Array.of(3, 1, 2)],
    ['a truncated compact body', compact.subarray(0, compact.length - 1)],
    ['trailing bytes', concatBytes(compact, Uint8Array.of(0))],
    ['a setup index above 2', Uint8Array.of(1, 3, ...compact.subarray(2))],
    ['a max-message-size exponent of 54', Uint8Array.of(1, 0, 54, ...compact.subarray(3))],
    ['an empty ufrag', concatBytes(Uint8Array.of(1, 0, 18, 0), compact.subarray(8))],
    ['malformed UTF-8 in the raw form', Uint8Array.of(2, 0xff)]
  ]

  it.each(cases)('throws invalid_code for %s', (_, bytes) => {
    expectWebRTPayError(() => decodeSdp(bytes), 'invalid_code')
  })

  it('rejects a ufrag that would inject an SDP line', () => {
    const ufrag = utf8Encode('ab\r\na=x')
    const bytes = concatBytes(Uint8Array.of(1, 0, 18, ufrag.length), ufrag, compact.subarray(8))
    expectWebRTPayError(() => decodeSdp(bytes), 'invalid_code')
  })
})

describe('offer and answer codes', () => {
  const offerSdp = decodeSdp(encodeSdp(CHROMIUM_OFFER))

  it('round trips an offer with every field', () => {
    const fields = {
      sid: SID,
      identityKey: IDENTITY_KEY,
      chain: 'main',
      amount: 1500,
      expiresAt: 1_800_000_000_000,
      sdp: offerSdp
    }
    const code = encodeOfferCode(fields)
    expect(code.startsWith(CODE_PREFIX)).toBe(true)
    const expected: OfferCode = { kind: 'offer', ...fields }
    expect(decodeCode(code, { now: 1_700_000_000_000 })).toStrictEqual(expected)
  })

  it('round trips a minimal offer without adding optional keys', () => {
    const code = encodeOfferCode({ sid: SID, identityKey: IDENTITY_KEY, sdp: offerSdp })
    expect(decodeCode(code)).toStrictEqual({
      kind: 'offer',
      sid: SID,
      identityKey: IDENTITY_KEY,
      sdp: offerSdp
    })
  })

  it('round trips an answer, including a raw-fallback SDP', () => {
    const raw = 'v=0\r\na=custom\r\n'
    const code = encodeAnswerCode({ sid: SID, sdp: raw })
    const expected: AnswerCode = { kind: 'answer', sid: SID, sdp: raw }
    expect(decodeCode(code)).toStrictEqual(expected)
  })

  it('writes no identity key into an answer: [1][2][sid][TLVs]', () => {
    // The payee learns the payer's key from the handshake; a bystander reading the answer
    // QR does not.
    const code = encodeAnswerCode({ sid: SID, sdp: offerSdp })
    const body = fromBase64Url(code.slice(CODE_PREFIX.length))
    const sdpBytes = encodeSdp(offerSdp)
    expect(body.subarray(0, 2)).toEqual(Uint8Array.of(1, 2))
    expect(body.subarray(2, 18)).toEqual(SID)
    expect(body.subarray(18, 21)).toEqual(
      Uint8Array.of(0x10, (sdpBytes.length & 0x7f) | 0x80, sdpBytes.length >> 7)
    )
    expect(body.subarray(21)).toEqual(sdpBytes)
    // An offer still names the payee.
    const offer = encodeOfferCode({ sid: SID, identityKey: IDENTITY_KEY, sdp: offerSdp })
    expect(fromBase64Url(offer.slice(CODE_PREFIX.length)).length).toBe(body.length + 33)
  })

  it('stores expiresAt with second precision, rounded down', () => {
    const code = encodeOfferCode({
      sid: SID,
      identityKey: IDENTITY_KEY,
      expiresAt: 1_800_000_000_999,
      sdp: offerSdp
    })
    expect(decodeCode(code, { now: 0 })).toMatchObject({ expiresAt: 1_800_000_000_000 })
  })

  it('accepts surrounding whitespace from scanners and paste', () => {
    const code = encodeAnswerCode({ sid: SID, sdp: offerSdp })
    expect(decodeCode(`  ${code}\n`).kind).toBe('answer')
  })

  it('keeps a typical node-datachannel offer code under 300 characters', async () => {
    const rtc = await nodeRtc()
    const pc = new rtc.RTCPeerConnection({ iceServers: rtc.iceServers, ...rtc.extraConfig })
    try {
      pc.createDataChannel('webrtpay/1')
      await pc.setLocalDescription(await pc.createOffer())
      await gathered(pc)
      const sdp = pc.localDescription!.sdp
      const code = encodeOfferCode({
        sid: SID,
        identityKey: IDENTITY_KEY,
        chain: 'main',
        amount: 250_000,
        expiresAt: Date.now() + 10 * 60_000,
        sdp
      })
      expect(code.length).toBeLessThan(300)
      const decoded = decodeCode(code, { expectedChain: 'main' })
      expect(decoded.kind).toBe('offer')
      expect(sdpFingerprints(decoded.sdp)).toEqual(sdpFingerprints(sdp))
    } finally {
      pc.close()
    }
  })

  it('skips unknown tags', () => {
    const code = encodeOfferCode({ sid: SID, identityKey: IDENTITY_KEY, amount: 7, sdp: offerSdp })
    const body = fromBase64Url(code.slice(CODE_PREFIX.length))
    const spliced = concatBytes(
      body.subarray(0, 51),
      Uint8Array.of(0x7f, 3, 9, 9, 9),
      body.subarray(51),
      Uint8Array.of(0x20, 0)
    )
    expect(decodeCode(CODE_PREFIX + toBase64Url(spliced))).toStrictEqual(decodeCode(code))
  })
})

describe('decodeCode rejects', () => {
  const offerSdp = decodeSdp(encodeSdp(CHROMIUM_OFFER))
  const testOffer = encodeOfferCode({
    sid: SID,
    identityKey: IDENTITY_KEY,
    chain: 'test',
    sdp: offerSdp
  })
  const header = fromBase64Url(testOffer.slice(CODE_PREFIX.length)).subarray(0, 51)
  const sdpBytes = encodeSdp(offerSdp)
  // 130 bytes: a two-byte LEB128 length.
  const sdpTlv = concatBytes(
    Uint8Array.of(0x10, (sdpBytes.length & 0x7f) | 0x80, sdpBytes.length >> 7),
    sdpBytes
  )
  const code = (...parts: Uint8Array[]): string => CODE_PREFIX + toBase64Url(concatBytes(...parts))

  it('an offer for another chain (expectedChain mismatch)', () => {
    expectWebRTPayError(() => decodeCode(testOffer, { expectedChain: 'main' }), 'invalid_code')
    expect(decodeCode(testOffer, { expectedChain: 'test' }).kind).toBe('offer')
  })

  it('an offer without a chain when a chain is expected', () => {
    const noChain = encodeOfferCode({ sid: SID, identityKey: IDENTITY_KEY, sdp: offerSdp })
    expectWebRTPayError(() => decodeCode(noChain, { expectedChain: 'main' }), 'invalid_code')
  })

  it('an expired offer', () => {
    const expiring = encodeOfferCode({
      sid: SID,
      identityKey: IDENTITY_KEY,
      expiresAt: 1_700_000_000_000,
      sdp: offerSdp
    })
    expect(decodeCode(expiring, { now: 1_699_999_999_999 }).kind).toBe('offer')
    expectWebRTPayError(() => decodeCode(expiring, { now: 1_700_000_000_000 }), 'invalid_code')
    expectWebRTPayError(() => decodeCode(expiring), 'invalid_code')
  })

  it('a wrong prefix', () => {
    const body = testOffer.slice(CODE_PREFIX.length)
    expectWebRTPayError(() => decodeCode(`webrtpay2:${body}`), 'invalid_code')
    expectWebRTPayError(() => decodeCode(`WEBRTPAY1:${body}`), 'invalid_code')
    expectWebRTPayError(() => decodeCode(body), 'invalid_code')
  })

  it('input longer than 4000 characters, even a valid code; exactly 4000 decodes (M11)', () => {
    // A valid answer code padded with an unknown TLV (skipped by decoders) to `length`.
    const padded = (length: number): string => {
      const code = encodeAnswerCode({ sid: new Uint8Array(16).fill(7), sdp: offerSdp })
      const body = fromBase64Url(code.slice(CODE_PREFIX.length))
      // base64url without padding: n bytes take ceil(4n / 3) characters
      const bodyBytes = Math.floor(((length - CODE_PREFIX.length) * 3) / 4)
      const fill = bodyBytes - body.length - 3 // tag and a two-byte varint length
      expect(fill).toBeGreaterThan(127)
      const tlv = concatBytes(
        Uint8Array.of(0x7f, 0x80 | (fill & 0x7f), fill >> 7),
        new Uint8Array(fill)
      )
      const text = CODE_PREFIX + toBase64Url(concatBytes(body, tlv))
      expect(text).toHaveLength(length)
      return text
    }
    const exact = decodeCode(padded(4000))
    expect(exact.kind).toBe('answer')
    expect(exact.sdp).toBe(offerSdp)
    for (const text of [padded(4001), CODE_PREFIX + 'A'.repeat(3991)]) {
      expect(() => decodeCode(text)).toThrow(/longer than 4000 characters/)
      expectWebRTPayError(() => decodeCode(text), 'invalid_code')
    }
  })

  it('a non-string', () => {
    expectWebRTPayError(() => decodeCode(42 as unknown as string), 'invalid_code')
  })

  const cases: [string, () => string][] = [
    ['bad base64url', () => `${CODE_PREFIX}not*base64`],
    ['a truncated header', () => code(header.subarray(0, 50))],
    ['version 2', () => code(Uint8Array.of(2), header.subarray(1), sdpTlv)],
    ['kind 3', () => code(Uint8Array.of(1, 3), header.subarray(2), sdpTlv)],
    [
      'an identity key that is not on the curve',
      () => code(header.subarray(0, 18), Uint8Array.of(2, ...new Uint8Array(32).fill(0xff)), sdpTlv)
    ],
    ['a missing sdp tag', () => code(header, Uint8Array.of(0x02, 1, 5))],
    ['a duplicate tag', () => code(header, Uint8Array.of(0x02, 1, 5, 0x02, 1, 6), sdpTlv)],
    ['a TLV running past the end', () => code(header, sdpTlv, Uint8Array.of(0x7f, 5, 1))],
    ['a TLV with no length', () => code(header, sdpTlv, Uint8Array.of(0x7f))],
    ['a non-minimal length varint', () => code(header, Uint8Array.of(0x02, 0x81, 0x00, 5), sdpTlv)],
    ['a non-minimal amount varint', () => code(header, Uint8Array.of(0x02, 2, 0x81, 0x00), sdpTlv)],
    ['an amount with trailing bytes', () => code(header, Uint8Array.of(0x02, 2, 5, 0), sdpTlv)],
    ['a zero amount', () => code(header, Uint8Array.of(0x02, 1, 0), sdpTlv)],
    [
      'an amount above 2^53 - 1',
      () =>
        code(header, Uint8Array.of(0x02, 8, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10), sdpTlv)
    ],
    ['malformed UTF-8 in chain', () => code(header, Uint8Array.of(0x01, 1, 0xff), sdpTlv)],
    ['a truncated answer header', () => code(Uint8Array.of(1, 2), SID.subarray(0, 15))],
    [
      'an answer carrying offer-only fields',
      () => code(Uint8Array.of(1, 2), SID, Uint8Array.of(0x02, 1, 5), sdpTlv)
    ],
    // The old answer layout, with the payer's 33-byte key after the sid: its first byte (2 or
    // 3) reads as an offer-only tag.
    [
      'an answer in the old layout with an identity key',
      () => code(Uint8Array.of(1, 2), SID, fromHex(IDENTITY_KEY), sdpTlv)
    ],
    ['an sdp tag with malformed compact bytes', () => code(header, Uint8Array.of(0x10, 2, 1, 0))]
  ]

  it.each(cases)('%s', (_, make) => {
    expectWebRTPayError(() => decodeCode(make()), 'invalid_code')
  })
})

describe('encodeOfferCode / encodeAnswerCode validate their input', () => {
  const sdp = decodeSdp(encodeSdp(CHROMIUM_OFFER))
  const base = { sid: SID, identityKey: IDENTITY_KEY, sdp }

  it.each([
    ['a 15-byte sid', { ...base, sid: new Uint8Array(15) }],
    ['an uppercase identity key', { ...base, identityKey: IDENTITY_KEY.toUpperCase() }],
    ['a zero amount', { ...base, amount: 0 }],
    ['a fractional amount', { ...base, amount: 1.5 }],
    ['an unsafe amount', { ...base, amount: 2 ** 53 }],
    ['a negative expiresAt', { ...base, expiresAt: -1 }],
    ['a non-finite expiresAt', { ...base, expiresAt: Infinity }]
  ])('throws RangeError for %s', (_, fields) => {
    expect(() => encodeOfferCode(fields)).toThrow(RangeError)
  })

  it('throws RangeError for an answer sid that is not 16 bytes', () => {
    expect(() => encodeAnswerCode({ sid: new Uint8Array(17), sdp })).toThrow(RangeError)
  })

  it('throws too_large instead of emitting a code longer than 4000 characters', () => {
    const big = `v=0\r\n${'a=x-padding:0123456789\r\n'.repeat(130)}`
    expectWebRTPayError(() => encodeAnswerCode({ sid: SID, sdp: big }), 'too_large')
  })
})

describe('compact SDP over a real node-datachannel connection', () => {
  it('connects two peers using only SDPs rebuilt from compact bytes', async () => {
    const rtc = await nodeRtc()
    const config = { iceServers: rtc.iceServers, ...rtc.extraConfig }
    const a = new rtc.RTCPeerConnection(config)
    const b = new rtc.RTCPeerConnection(config)
    try {
      const dc = a.createDataChannel('webrtpay/1')
      const received = new Promise<unknown>(resolve => {
        b.addEventListener('datachannel', ev => {
          ev.channel.addEventListener('message', m => resolve(m.data))
        })
      })
      dc.addEventListener('open', () => dc.send('via compact SDP'))

      await a.setLocalDescription(await a.createOffer())
      await gathered(a)
      const offer = a.localDescription!.sdp
      const offerBytes = encodeSdp(offer)
      expect(offerBytes[0]).toBe(1)
      expect(offerBytes.length).toBeLessThan(200)
      const rebuiltOffer = decodeSdp(offerBytes)
      expect(sdpFingerprints(rebuiltOffer)).toEqual(sdpFingerprints(offer))

      await b.setRemoteDescription({ type: 'offer', sdp: rebuiltOffer })
      await b.setLocalDescription(await b.createAnswer())
      await gathered(b)
      const answerBytes = encodeSdp(b.localDescription!.sdp)
      expect(answerBytes[0]).toBe(1)
      await a.setRemoteDescription({ type: 'answer', sdp: decodeSdp(answerBytes) })

      expect(await withTimeout(received, 10000, 'data channel message')).toBe('via compact SDP')
      expect(dc.readyState).toBe('open')
    } finally {
      a.close()
      b.close()
    }
  })

  it('accepts a rebuilt offer carrying every candidate kind and still connects', async () => {
    const rtc = await nodeRtc()
    const config = { iceServers: rtc.iceServers, ...rtc.extraConfig }
    const a = new rtc.RTCPeerConnection(config)
    const b = new rtc.RTCPeerConnection(config)
    try {
      const dc = a.createDataChannel('webrtpay/1')
      const opened = new Promise<void>(resolve => dc.addEventListener('open', () => resolve()))
      await a.setLocalDescription(await a.createOffer())
      await gathered(a)
      // Unreachable extras next to the real loopback host: IPv6 srflx and relay (raddr ::),
      // IPv4 prflx and an mDNS host, as a Chromium peer might send.
      const extras = [
        'a=candidate:9 1 udp 1 2001:db8::1 40000 typ srflx raddr :: rport 0',
        'a=candidate:10 1 udp 1 2001:db8::2 40001 typ relay raddr :: rport 0',
        'a=candidate:11 1 udp 1 203.0.113.9 40002 typ prflx raddr 0.0.0.0 rport 0',
        'a=candidate:12 1 udp 1 5782404b-578f-45cc-93b2-b088c7b105af.local 40003 typ host'
      ]
      const offer = a.localDescription!.sdp.replace(
        'a=end-of-candidates',
        [...extras, 'a=end-of-candidates'].join('\r\n')
      )
      const rebuilt = decodeSdp(encodeSdp(offer))
      expect(candidates(rebuilt)).toHaveLength(5)
      expect(rebuilt).toContain(' 2001:db8::1 40000 typ srflx raddr :: rport 0\r\n')

      await b.setRemoteDescription({ type: 'offer', sdp: rebuilt })
      await b.setLocalDescription(await b.createAnswer())
      await gathered(b)
      await a.setRemoteDescription({
        type: 'answer',
        sdp: decodeSdp(encodeSdp(b.localDescription!.sdp))
      })
      await withTimeout(opened, 10000, 'data channel open')
    } finally {
      a.close()
      b.close()
    }
  })
})
