import { describe, expect, it } from '@jest/globals'
import fc from 'fast-check'
import { PrivateKey } from '@bsv/sdk'
import { decodeCode, encodeAnswerCode, encodeOfferCode } from '../src/codec/codes.js'
import { decodeSdp, encodeSdp, sdpFingerprints } from '../src/codec/sdp.js'
import { CODE_PREFIX, isIdentityKey } from '../src/types.js'
import { concatBytes, fromBase64Url, fromHex, toBase64Url, toHex } from '../src/util/bytes.js'
import { WebRTPayError } from '../src/util/errors.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const
const ICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('')

// ---------------------------------------------------------------------------
// Arbitrary SDPs, rendered the way Chromium or node-datachannel would.
// ---------------------------------------------------------------------------

interface CandidateSpec {
  transport: 'udp' | 'UDP' | 'tcp'
  type: (typeof CANDIDATE_TYPES)[number]
  /** The address as written into the SDP. */
  written: string
  /** The address the rebuilt SDP must carry. */
  expected: string
  port: number
}

/** Canonical IPv6 text (RFC 5952) from an independent implementation: the WHATWG URL parser. */
function canonicalIpv6(address: string): string {
  return new URL(`http://[${address}]/`).hostname.slice(1, -1)
}

const ipv4 = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 4, maxLength: 4 })
  .map(octets => ({ written: octets.join('.'), expected: octets.join('.') }))

// Half the groups are zero, so `::` placement and its tie-breaking get exercised.
const ipv6 = fc
  .record({
    groups: fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 0xffff })), {
      minLength: 8,
      maxLength: 8
    }),
    style: fc.constantFrom('full', 'padded', 'upper', 'canonical')
  })
  .map(({ groups, style }) => {
    const hex = groups.map(g => g.toString(16))
    const full = hex.join(':')
    const written =
      style === 'full'
        ? full
        : style === 'padded'
          ? hex.map(g => g.padStart(4, '0')).join(':')
          : style === 'upper'
            ? full.toUpperCase()
            : canonicalIpv6(full)
    return { written, expected: canonicalIpv6(full) }
  })

const mdns = fc.tuple(fc.uuid(), fc.boolean()).map(([uuid, upper]) => ({
  written: `${upper ? uuid.toUpperCase() : uuid}.local`,
  expected: `${uuid.toLowerCase()}.local`
}))

const candidate: fc.Arbitrary<CandidateSpec> = fc
  .record({
    transport: fc.constantFrom('udp' as const, 'UDP' as const, 'tcp' as const),
    type: fc.constantFrom(...CANDIDATE_TYPES),
    address: fc.oneof(ipv4, ipv6, mdns),
    port: fc.integer({ min: 0, max: 65535 })
  })
  .map(({ transport, type, address, port }) => ({ transport, type, port, ...address }))

const sdpFields = fc.record({
  style: fc.constantFrom('chromium', 'ndc'),
  eol: fc.constantFrom('\r\n', '\n'),
  ufrag: fc.string({ unit: fc.constantFrom(...ICE_CHARS), minLength: 1, maxLength: 255 }),
  pwd: fc.string({ unit: fc.constantFrom(...ICE_CHARS), minLength: 1, maxLength: 255 }),
  fingerprint: fc.uint8Array({ minLength: 32, maxLength: 32 }),
  fingerprintUpper: fc.boolean(),
  setup: fc.constantFrom('actpass', 'active', 'passive'),
  maxMessageSize: fc.option(
    fc.oneof(
      fc.constant(0),
      fc.integer({ min: 0, max: 53 }).map(k => 2 ** k)
    ),
    { nil: undefined }
  ),
  candidates: fc.array(candidate, { maxLength: 12 })
})

type SdpFields = typeof sdpFields extends fc.Arbitrary<infer T> ? T : never

function renderSdp(f: SdpFields): string {
  const hex = toHex(f.fingerprint).match(/../g)!.join(':')
  const fp = `a=fingerprint:sha-256 ${f.fingerprintUpper ? hex.toUpperCase() : hex}`
  const candidateLines = f.candidates.map((c, i) => {
    const raddr = c.type === 'host' ? '' : ' raddr 0.0.0.0 rport 0'
    const tcp = c.transport === 'tcp' ? ' tcptype passive' : ''
    return `a=candidate:${i + 1} 1 ${c.transport} ${2000000000 - i} ${c.written} ${c.port} typ ${c.type}${raddr}${tcp} generation 0`
  })
  const mms = f.maxMessageSize === undefined ? [] : [`a=max-message-size:${f.maxMessageSize}`]
  const head = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0']
  const lines =
    f.style === 'chromium'
      ? [
          ...head,
          'a=msid-semantic: WMS',
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
          'c=IN IP4 0.0.0.0',
          ...candidateLines,
          `a=ice-ufrag:${f.ufrag}`,
          `a=ice-pwd:${f.pwd}`,
          'a=ice-options:trickle',
          fp,
          `a=setup:${f.setup}`,
          'a=mid:0',
          'a=sctp-port:5000',
          ...mms
        ]
      : [
          ...head,
          'a=ice-options:ice2,trickle',
          fp,
          'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
          'c=IN IP4 127.0.0.1',
          'a=mid:0',
          'a=sendrecv',
          'a=sctp-port:5000',
          ...mms,
          `a=setup:${f.setup}`,
          `a=ice-ufrag:${f.ufrag}`,
          `a=ice-pwd:${f.pwd}`,
          ...candidateLines,
          'a=end-of-candidates'
        ]
  return lines.join(f.eol) + f.eol
}

/** Values of every `a=<name>:` line in a rebuilt (CRLF) SDP. */
function attr(sdp: string, name: string): string[] {
  const prefix = `a=${name}:`
  return sdp
    .split('\r\n')
    .filter(l => l.startsWith(prefix))
    .map(l => l.slice(prefix.length))
}

/** A data-channel SDP in the codec's canonical (rebuilt) form, or raw text that forces the fallback. */
const codeSdp = fc.oneof(
  sdpFields.map(f => decodeSdp(encodeSdp(renderSdp(f)))),
  fc.string({ maxLength: 400 }),
  fc.string({ unit: 'grapheme', maxLength: 40 })
)

// ---------------------------------------------------------------------------
// Codes
// ---------------------------------------------------------------------------

const MAX_EXPIRY_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

const identityKey = fc
  .integer({ min: 1, max: 2 ** 31 })
  .map(n => new PrivateKey(n).toPublicKey().toString())

const sid = fc.uint8Array({ minLength: 16, maxLength: 16 })

const offerFields = fc.record(
  {
    sid,
    identityKey,
    chain: fc.string({ unit: 'grapheme', maxLength: 16 }),
    amount: fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }),
    expiresAt: fc.integer({ min: 1, max: MAX_EXPIRY_SECONDS }).map(s => s * 1000),
    sdp: codeSdp
  },
  { requiredKeys: ['sid', 'identityKey', 'sdp'] }
)

const answerFields = fc.record({ sid, sdp: codeSdp })

/** LEB128, as the code body uses for TLV lengths and numbers. */
function varint(n: number): Uint8Array {
  const out: number[] = []
  do {
    const low = n % 128
    n = Math.floor(n / 128)
    out.push(n > 0 ? low | 0x80 : low)
  } while (n > 0)
  return Uint8Array.from(out)
}

function tlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.of(tag), varint(value.length), value)
}

/** decodeCode either returns a well-formed code or throws WebRTPayError('invalid_code'). */
function decodesOrRejects(text: string): void {
  let decoded: ReturnType<typeof decodeCode>
  try {
    decoded = decodeCode(text, { now: 0 })
  } catch (e) {
    expect(e).toBeInstanceOf(WebRTPayError)
    expect((e as WebRTPayError).code).toBe('invalid_code')
    return
  }
  expect(['offer', 'answer']).toContain(decoded.kind)
  expect(decoded.sid).toBeInstanceOf(Uint8Array)
  expect(decoded.sid).toHaveLength(16)
  if (decoded.kind === 'offer') expect(isIdentityKey(decoded.identityKey)).toBe(true)
  else expect(Object.keys(decoded).sort()).toEqual(['kind', 'sdp', 'sid'])
  expect(typeof decoded.sdp).toBe('string')
}

const validCodeBody = fc
  .oneof(offerFields.map(encodeOfferCode), answerFields.map(encodeAnswerCode))
  .map(code => fromBase64Url(code.slice(CODE_PREFIX.length)))

// An offer header carries the payee's key; an answer header ends after the sid.
const validHeader = fc.oneof(
  fc.tuple(sid, identityKey).map(([s, key]) => concatBytes(Uint8Array.of(1, 1), s, fromHex(key))),
  sid.map(s => concatBytes(Uint8Array.of(1, 2), s))
)

const hostileTlv = fc
  .record({
    tag: fc.oneof(fc.constantFrom(0x01, 0x02, 0x03, 0x10), fc.integer({ min: 0, max: 255 })),
    value: fc.oneof(
      fc.uint8Array({ maxLength: 40 }),
      fc.uint8Array({ maxLength: 200 }).map(b => concatBytes(Uint8Array.of(1), b)),
      fc.uint8Array({ maxLength: 200 }).map(b => concatBytes(Uint8Array.of(2), b))
    )
  })
  .map(({ tag, value }) => tlv(tag, value))

describe('codes: property tests', () => {
  it('round trips arbitrary offer fields', () => {
    fc.assert(
      fc.property(offerFields, fields => {
        expect(decodeCode(encodeOfferCode(fields), { now: 0 })).toStrictEqual({
          kind: 'offer',
          ...fields
        })
      })
    )
  })

  it('round trips arbitrary answer fields', () => {
    fc.assert(
      fc.property(answerFields, fields => {
        expect(decodeCode(encodeAnswerCode(fields))).toStrictEqual({ kind: 'answer', ...fields })
      })
    )
  })

  it('only ever throws WebRTPayError for arbitrary bytes after the prefix', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2900 }), bytes => {
        decodesOrRejects(CODE_PREFIX + toBase64Url(bytes))
      })
    )
  })

  it('only ever throws WebRTPayError for arbitrary text after the prefix', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), text => {
        decodesOrRejects(CODE_PREFIX + text)
      })
    )
  })

  it('only ever throws WebRTPayError for a valid header followed by hostile TLVs', () => {
    fc.assert(
      fc.property(
        validHeader,
        fc.array(hostileTlv, { maxLength: 6 }),
        fc.uint8Array({ maxLength: 8 }),
        (header, tlvs, tail) => {
          decodesOrRejects(CODE_PREFIX + toBase64Url(concatBytes(header, ...tlvs, tail)))
        }
      )
    )
  })

  it('only ever throws WebRTPayError for mutated valid codes', () => {
    fc.assert(
      fc.property(
        validCodeBody,
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 4
        }),
        fc.nat(),
        (body, edits, cut) => {
          const mutated = Uint8Array.from(body)
          for (const [at, value] of edits) mutated[at % mutated.length] = value
          decodesOrRejects(CODE_PREFIX + toBase64Url(mutated))
          decodesOrRejects(CODE_PREFIX + toBase64Url(body.subarray(0, cut % body.length)))
        }
      )
    )
  })
})

// ---------------------------------------------------------------------------
// Compact SDP
// ---------------------------------------------------------------------------

describe('compact SDP: property tests', () => {
  it('round trips arbitrary candidate lists and transport parameters', () => {
    fc.assert(
      fc.property(sdpFields, f => {
        const sdp = renderSdp(f)
        const bytes = encodeSdp(sdp)
        expect(bytes[0]).toBe(1)

        const rebuilt = decodeSdp(bytes)
        expect(sdpFingerprints(rebuilt)).toEqual(sdpFingerprints(sdp))
        expect(attr(rebuilt, 'ice-ufrag')).toEqual([f.ufrag])
        expect(attr(rebuilt, 'ice-pwd')).toEqual([f.pwd])
        expect(attr(rebuilt, 'setup')).toEqual([f.setup])
        expect(attr(rebuilt, 'max-message-size')).toEqual([String(f.maxMessageSize ?? 65536)])
        expect(
          attr(rebuilt, 'candidate').map(v => {
            const t = v.split(' ')
            return { transport: t[2], address: t[4], port: Number(t[5]), type: t[7] }
          })
        ).toEqual(
          f.candidates
            .filter(c => c.transport !== 'tcp')
            .map(c => ({ transport: 'udp', address: c.expected, port: c.port, type: c.type }))
        )
        expect(rebuilt.endsWith('\r\na=end-of-candidates\r\n')).toBe(true)

        // The rebuilt text is canonical: encoding it again gives the same bytes.
        expect(encodeSdp(rebuilt)).toEqual(bytes)
      })
    )
  })

  it('round trips any text that cannot be compacted, byte for byte', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 200 }), text => {
        const bytes = encodeSdp(text)
        expect(bytes[0]).toBe(2)
        expect(decodeSdp(bytes)).toBe(text)
      })
    )
  })

  it('only ever throws WebRTPayError for arbitrary bytes', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.uint8Array({ maxLength: 300 }),
          fc.uint8Array({ maxLength: 300 }).map(b => concatBytes(Uint8Array.of(1), b))
        ),
        bytes => {
          try {
            expect(typeof decodeSdp(bytes)).toBe('string')
          } catch (e) {
            expect(e).toBeInstanceOf(WebRTPayError)
            expect((e as WebRTPayError).code).toBe('invalid_code')
          }
        }
      )
    )
  })
})
