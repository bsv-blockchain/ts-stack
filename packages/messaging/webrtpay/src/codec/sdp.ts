/**
 * Compact binary form of a data-channel SDP, small enough for a QR code.
 *
 * Only what a data-channel connection needs survives; the decoder rebuilds the rest
 * from a fixed template. Two forms, told apart by the first byte:
 *
 * Form 1, compact:
 * ```
 * [1]
 * [setup u8]               0 actpass, 1 active, 2 passive
 * [max-message-size u8]    log2 of the size; 255 means 0 (no limit)
 * [ufrag length u8][ufrag ASCII]
 * [pwd length u8][pwd ASCII]
 * [sha-256 fingerprint, 32 bytes]
 * [candidate count u8], then per UDP candidate:
 *   [type << 4 | address kind]   type 0 host, 1 srflx, 2 prflx, 3 relay
 *                                kind 0 IPv4 (4 bytes), 1 IPv6 (16), 2 mDNS `<uuid>.local` (16)
 *   [address][port u16 BE]
 * ```
 *
 * Form 2, fallback: `[2]` followed by the SDP text as UTF-8, used whenever the SDP has
 * something form 1 cannot carry, so encoding never fails.
 */
import { toHex, utf8Decode, utf8Encode } from '../util/bytes.js'
import { compareCodeUnits } from '../util/compare.js'
import { WebRTPayError } from '../util/errors.js'

const FORM_COMPACT = 1
const FORM_RAW = 2

const SETUPS = ['actpass', 'active', 'passive']
const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay']
/** RFC 8445 §5.1.2.1 recommended type preferences, indexed like `CANDIDATE_TYPES`. */
const TYPE_PREFERENCES = [126, 100, 110, 0]

const KIND_IPV4 = 0
const KIND_IPV6 = 1
const KIND_MDNS = 2
const ADDRESS_BYTES = [4, 16, 16]

/** RFC 8841: a missing max-message-size means 64 KiB. */
const DEFAULT_MAX_MESSAGE_SIZE = 65536
/** Encoded in place of log2 when max-message-size is 0 (no limit). */
const NO_SIZE_LIMIT = 255
/** Largest exponent whose power of two is still a safe integer. */
const MAX_SIZE_EXPONENT = 53
const FINGERPRINT_BYTES = 32
const MAX_U8 = 255

/** RFC 8839 `ice-char`: the alphabet of ice-ufrag and ice-pwd. */
const ICE_CHARS = /^[A-Za-z0-9+/]+$/
/** A live (non-zero port) data-channel media section; port 0 would mean rejected. */
const DATA_CHANNEL_MEDIA = /^m=application [1-9]\d* UDP\/DTLS\/SCTP webrtc-datachannel$/
const SHA256_FINGERPRINT = /^sha-256 ([0-9a-f]{2}(?::[0-9a-f]{2}){31})$/i
const IPV4_OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`
const IPV4 = new RegExp(String.raw`^${IPV4_OCTET}(?:\.${IPV4_OCTET}){3}$`)
const IPV6_GROUP = /^[0-9a-f]{1,4}$/i
const MDNS_UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i

interface CompactCandidate {
  type: number
  kind: number
  address: Uint8Array
  port: number
}

interface CompactSdp {
  setup: number
  sizeExponent: number
  ufrag: string
  pwd: string
  fingerprint: Uint8Array
  candidates: CompactCandidate[]
}

/** A candidate the compact form leaves out on purpose (TCP) rather than falling back for. */
const DROP = 'drop'

function invalid(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('invalid_code', message, cause === undefined ? undefined : { cause })
}

/**
 * Every `a=fingerprint:` line, session or media level, as `"<alg> <hex>"` with the
 * algorithm and hex lowercased and colons removed, sorted by UTF-16 code unit.
 */
export function sdpFingerprints(sdp: string): string[] {
  const out: string[] = []
  for (const line of sdp.split(/\r?\n/)) {
    if (!line.startsWith('a=fingerprint:')) continue
    const [alg, ...hex] = line.slice('a=fingerprint:'.length).trim().split(/\s+/)
    out.push(`${alg.toLowerCase()} ${hex.join('').replaceAll(':', '').toLowerCase()}`)
  }
  out.sort(compareCodeUnits)
  return out
}

/** Encode an SDP: compact form when it fits the data-channel template, raw text otherwise. */
export function encodeSdp(sdp: string): Uint8Array {
  const c = parseCompact(sdp)
  if (c === undefined) {
    const text = utf8Encode(sdp)
    const out = new Uint8Array(text.length + 1)
    out[0] = FORM_RAW
    out.set(text, 1)
    return out
  }
  const out: number[] = [FORM_COMPACT, c.setup, c.sizeExponent]
  out.push(
    c.ufrag.length,
    ...utf8Encode(c.ufrag),
    c.pwd.length,
    ...utf8Encode(c.pwd),
    ...c.fingerprint,
    c.candidates.length
  )
  for (const k of c.candidates) {
    out.push((k.type << 4) | k.kind, ...k.address, k.port >> 8, k.port & 0xff)
  }
  return Uint8Array.from(out)
}

/**
 * Rebuild an SDP from {@link encodeSdp} bytes. The compact form yields a complete
 * non-trickle data-channel SDP ending in `a=end-of-candidates`; the raw form yields the
 * original text. Throws `WebRTPayError('invalid_code')` on malformed input.
 */
export function decodeSdp(bytes: Uint8Array): string {
  if (bytes.length === 0) throw invalid('SDP is empty')
  if (bytes[0] === FORM_RAW) return rawSdp(bytes)
  if (bytes[0] !== FORM_COMPACT) throw invalid(`Unknown SDP form ${bytes[0]}`)

  const r = new Reader(bytes, 1)
  const lines = templateLines(r)
  const count = r.u8()
  for (let i = 0; i < count; i++) lines.push(candidateLine(r, i))
  if (!r.done()) throw invalid('Unexpected bytes after compact SDP')
  lines.push('a=end-of-candidates')
  return lines.join('\r\n') + '\r\n'
}

/** The SDP text of the raw form: the UTF-8 after the form byte. */
function rawSdp(bytes: Uint8Array): string {
  try {
    return utf8Decode(bytes.subarray(1))
  } catch (cause) {
    throw invalid('SDP is not valid UTF-8', cause)
  }
}

/**
 * The template's session and media lines, filled in from the compact fields `r` reads
 * next: setup role, max-message-size, ufrag, pwd and fingerprint, each checked as it is read.
 */
function templateLines(r: Reader): string[] {
  const setup = SETUPS[r.u8()]
  if (setup === undefined) throw invalid('Unknown DTLS setup role')
  const exponent = r.u8()
  if (exponent > MAX_SIZE_EXPONENT && exponent !== NO_SIZE_LIMIT) {
    throw invalid('Invalid max-message-size')
  }
  const maxMessageSize = exponent === NO_SIZE_LIMIT ? 0 : 2 ** exponent
  const ufrag = iceCredential(r.bytes(r.u8()), 'ice-ufrag')
  const pwd = iceCredential(r.bytes(r.u8()), 'ice-pwd')
  const fingerprint = toHex(r.bytes(FINGERPRINT_BYTES))
    .toUpperCase()
    .replace(/..(?!$)/g, '$&:')

  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    `a=ice-ufrag:${ufrag}`,
    `a=ice-pwd:${pwd}`,
    'a=ice-options:trickle',
    `a=fingerprint:sha-256 ${fingerprint}`,
    `a=setup:${setup}`,
    'a=mid:0',
    'a=sctp-port:5000',
    `a=max-message-size:${maxMessageSize}`
  ]
}

/**
 * The `a=candidate:` line of compact candidate `i` (0-based), read from `r`: its type is
 * checked, then its address kind, before the address and port are read.
 */
function candidateLine(r: Reader, i: number): string {
  const header = r.u8()
  const typeIndex = header >> 4
  const kind = header & 0x0f
  const type = CANDIDATE_TYPES[typeIndex]
  if (type === undefined) throw invalid('Unknown candidate type')
  if (kind > KIND_MDNS) throw invalid('Unknown candidate address kind')
  const address = formatAddress(kind, r.bytes(ADDRESS_BYTES[kind]))
  const port = r.u16()
  // RFC 8445 §5.1.2.1: type preference, then local preference by order, component 1.
  const priority = TYPE_PREFERENCES[typeIndex] * 2 ** 24 + (65535 - i) * 2 ** 8 + (256 - 1)
  const related = relatedAddress(type, kind)
  return `a=candidate:${i + 1} 1 udp ${priority} ${address} ${port} typ ${type}${related}`
}

/**
 * The `raddr`/`rport` part of a rebuilt candidate line: none for a host candidate, a
 * placeholder unspecified address of the candidate's family and port 0 otherwise.
 */
function relatedAddress(type: string, kind: number): string {
  if (type === 'host') return ''
  const unspecified = kind === KIND_IPV6 ? '::' : '0.0.0.0'
  return ` raddr ${unspecified} rport 0`
}

/** The compact fields of `sdp`, or undefined when the compact form cannot carry it. */
function parseCompact(sdp: string): CompactSdp | undefined {
  const lines = scanLines(sdp)
  if (lines === undefined) return undefined
  const { attributes, mediaSections } = lines
  const only = (name: string): string | undefined => {
    const values = attributes.get(name)
    return values?.length === 1 ? values[0] : undefined
  }

  // The template rebuilds a full-ICE agent with one data-channel section.
  if (mediaSections !== 1 || attributes.has('ice-lite')) return undefined
  if (only('mid') !== '0' || only('sctp-port') !== '5000') return undefined

  const setup = SETUPS.indexOf(only('setup') ?? '')
  const sizeExponent = maxMessageSizeExponent(attributes.get('max-message-size'))
  const ufrag = only('ice-ufrag')
  const pwd = only('ice-pwd')
  const fingerprint = SHA256_FINGERPRINT.exec(only('fingerprint') ?? '')
  if (setup < 0 || sizeExponent === undefined || fingerprint === null) return undefined
  if (!isIceCredential(ufrag) || !isIceCredential(pwd)) return undefined

  const candidates = compactCandidates(attributes.get('candidate') ?? [])
  if (candidates === undefined) return undefined
  return {
    setup,
    sizeExponent,
    ufrag,
    pwd,
    fingerprint: fingerprintBytes(fingerprint[1]),
    candidates
  }
}

/** What {@link parseCompact} needs from the lines of an SDP. */
interface SdpLines {
  /** Number of `m=` lines. */
  mediaSections: number
  /** Every `a=` value by attribute name, session and media level alike; `''` for a flag. */
  attributes: Map<string, string[]>
}

/**
 * The media sections and attributes of `sdp`; undefined at an `m=` line that is not a live
 * data channel.
 */
function scanLines(sdp: string): SdpLines | undefined {
  const attributes = new Map<string, string[]>()
  let mediaSections = 0
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith('m=')) {
      if (!DATA_CHANNEL_MEDIA.test(line)) return undefined
      mediaSections++
    } else if (line.startsWith('a=')) {
      addAttribute(attributes, line)
    }
  }
  return { mediaSections, attributes }
}

/** Record the value of an `a=<name>[:<value>]` line under its name; a flag's value is `''`. */
function addAttribute(attributes: Map<string, string[]>, line: string): void {
  const colon = line.indexOf(':')
  const name = colon < 0 ? line.slice(2) : line.slice(2, colon)
  const values = attributes.get(name) ?? []
  values.push(colon < 0 ? '' : line.slice(colon + 1))
  attributes.set(name, values)
}

/**
 * The UDP candidates among `values` (`a=candidate:` values), TCP ones dropped; undefined
 * when one cannot be carried or more than 255 remain.
 */
function compactCandidates(values: string[]): CompactCandidate[] | undefined {
  const candidates: CompactCandidate[] = []
  for (const value of values) {
    const candidate = parseCandidate(value)
    if (candidate === undefined) return undefined
    if (candidate !== DROP) candidates.push(candidate)
  }
  return candidates.length > MAX_U8 ? undefined : candidates
}

/** The 32 bytes of a sha-256 fingerprint written as colon-separated hex pairs. */
function fingerprintBytes(text: string): Uint8Array {
  const hex = text.replaceAll(':', '')
  const bytes = new Uint8Array(FINGERPRINT_BYTES)
  for (let i = 0; i < FINGERPRINT_BYTES; i++) {
    bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)
  }
  return bytes
}

function isIceCredential(v: string | undefined): v is string {
  return v !== undefined && v.length <= MAX_U8 && ICE_CHARS.test(v)
}

/** log2 of max-message-size; absent counts as the RFC 8841 default. */
function maxMessageSizeExponent(values: string[] | undefined): number | undefined {
  if (values === undefined) return Math.log2(DEFAULT_MAX_MESSAGE_SIZE)
  if (values.length !== 1 || !/^\d{1,16}$/.test(values[0])) return undefined
  const size = Number(values[0])
  if (size === 0) return NO_SIZE_LIMIT
  const exponent = Math.round(Math.log2(size))
  return exponent <= MAX_SIZE_EXPONENT && 2 ** exponent === size ? exponent : undefined
}

/**
 * One `a=candidate:` value (RFC 8839 §5.1). TCP candidates are dropped; anything the
 * compact form cannot carry exactly returns undefined.
 */
function parseCandidate(value: string): CompactCandidate | typeof DROP | undefined {
  // foundation component transport priority address port "typ" type [extensions]
  const t = value.split(' ')
  if (t.length < 8 || t[6] !== 'typ') return undefined
  const transport = t[2].toLowerCase()
  if (transport === 'tcp') return DROP
  if (transport !== 'udp' || t[1] !== '1') return undefined
  const type = CANDIDATE_TYPES.indexOf(t[7].toLowerCase())
  const address = parseAddress(t[4])
  const port = /^\d{1,5}$/.test(t[5]) ? Number(t[5]) : 65536
  if (type < 0 || address === undefined || port > 65535) return undefined
  return { type, kind: address.kind, address: address.bytes, port }
}

function parseAddress(text: string): { kind: number; bytes: Uint8Array } | undefined {
  if (IPV4.test(text)) {
    return { kind: KIND_IPV4, bytes: Uint8Array.from(text.split('.'), Number) }
  }
  const uuid = MDNS_UUID.exec(text)
  if (uuid !== null) {
    const hex = uuid.slice(1).join('')
    return {
      kind: KIND_MDNS,
      bytes: Uint8Array.from({ length: 16 }, (_, i) =>
        Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16)
      )
    }
  }
  const ipv6 = parseIpv6(text)
  return ipv6 === undefined ? undefined : { kind: KIND_IPV6, bytes: ipv6 }
}

/** RFC 4291 §2.2 text forms 1 and 2 (hex groups with optional `::`); no zone, no dotted tail. */
function parseIpv6(text: string): Uint8Array | undefined {
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] === '' ? [] : halves[0].split(':')
  const tail = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const groups = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => '0'),
    ...tail
  ]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!IPV6_GROUP.test(groups[i])) return undefined
    const g = Number.parseInt(groups[i], 16)
    out[2 * i] = g >> 8
    out[2 * i + 1] = g & 0xff
  }
  return out
}

function formatAddress(kind: number, b: Uint8Array): string {
  if (kind === KIND_IPV4) return b.join('.')
  if (kind === KIND_MDNS) {
    const h = toHex(b)
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`
  }
  return formatIpv6(b)
}

/**
 * RFC 5952 text: lowercase, no leading zeros, the first longest run of two or more zero
 * groups as `::`. Matches the WHATWG URL serializer.
 */
function formatIpv6(b: Uint8Array): string {
  const groups = Array.from({ length: 8 }, (_, i) => (b[2 * i] << 8) | b[2 * i + 1])
  let runStart = -1
  let runLength = 1
  for (let i = 0; i < 8;) {
    if (groups[i] !== 0) {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === 0) j++
    if (j - i > runLength) {
      runStart = i
      runLength = j - i
    }
    i = j
  }
  const hex = (from: number, to: number): string =>
    groups
      .slice(from, to)
      .map(g => g.toString(16))
      .join(':')
  return runStart < 0 ? hex(0, 8) : `${hex(0, runStart)}::${hex(runStart + runLength, 8)}`
}

/** An ice-ufrag or ice-pwd from compact bytes; only RFC 8839 ice-chars are accepted. */
function iceCredential(b: Uint8Array, what: string): string {
  const text = String.fromCodePoint(...b)
  if (!ICE_CHARS.test(text)) throw invalid(`Invalid ${what}`)
  return text
}

/** Bounds-checked reader over compact SDP bytes. */
class Reader {
  constructor(
    private readonly b: Uint8Array,
    private o: number
  ) {}

  private take(n: number): number {
    if (n > this.b.length - this.o) throw invalid('Compact SDP is truncated')
    const at = this.o
    this.o += n
    return at
  }

  u8(): number {
    return this.b[this.take(1)]
  }

  u16(): number {
    const at = this.take(2)
    return (this.b[at] << 8) | this.b[at + 1]
  }

  bytes(n: number): Uint8Array {
    const at = this.take(n)
    return this.b.subarray(at, at + n)
  }

  done(): boolean {
    return this.o === this.b.length
  }
}
