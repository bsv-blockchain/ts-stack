import { DEFAULTS, SIGNALING_PROTOCOL_ID, isIdentityKey } from '../types.js'
import type { PubKeyHex, WalletLike } from '../types.js'
import { fromBase64, toBase64, utf8Decode, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'
import type { SignalEnvelope, SignalKind, SignalPlaintext } from './types.js'

/** Longest `sdp` accepted in a signal, in characters. */
export const MAX_SIGNAL_SDP_CHARS = 16384
/** Longest `sid` accepted in an envelope, in characters (a 16-byte base64url sid is 22). */
export const MAX_SIGNAL_SID_CHARS = 64
/**
 * Longest `ciphertext` accepted in an envelope, in base64 characters (18 KiB of bytes):
 * room for a {@link MAX_SIGNAL_SDP_CHARS} SDP with ordinary line lengths, the JSON around it
 * and the BRC-2 overhead. Checked before anything is decrypted.
 */
export const MAX_SIGNAL_CIPHERTEXT_CHARS = 24576

const KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>([
  'offer',
  'answer',
  'reject',
  'knock',
  'ring'
])
/** Kinds that carry neither `sdp` nor `reason`. */
const BARE_KINDS: ReadonlySet<SignalKind> = new Set<SignalKind>(['knock', 'ring'])

/** A network name a signal may carry: 1 to 16 characters from `a-z` and `0-9`. */
const CHAIN = /^[a-z0-9]{1,16}$/

/** Kept past the last moment a signal could still pass the freshness check. */
const REPLAY_MARGIN_MS = 60000

/**
 * Remembers session IDs so each signal is opened once. A sid is kept until a signal
 * carrying it could no longer pass the ±120 s freshness check, plus a minute: until
 * `max(seen, ts) + 120 s + 60 s`. Beyond `max` entries only expired ones are dropped, never
 * one that is still needed, so a flood of valid signals cannot flush a sid and open the
 * door to a replay; the cache may then hold more than `max` until entries expire (callers
 * bound how fast signals arrive).
 */
export class ReplayCache {
  /** sid → when it can be forgotten; insertion order. */
  private readonly expiries = new Map<string, number>()
  /** Size at which the next full sweep for expired entries runs. */
  private sweepAt: number

  constructor(private readonly max = 10000) {
    this.sweepAt = max
  }

  /** Number of sids remembered. */
  get size(): number {
    return this.expiries.size
  }

  /**
   * Record `sid`, seen at `now`, from a signal stamped `ts` (defaults to `now`); true when
   * it was not already remembered.
   */
  check(sid: string, now = Date.now(), ts = now): boolean {
    // Cheap upkeep: entries at the front that have expired (insertion is roughly in expiry
    // order, so this keeps the cache small in normal use).
    for (const [key, expiry] of this.expiries) {
      if (now < expiry) break
      this.expiries.delete(key)
    }
    const expiry = this.expiries.get(sid)
    if (expiry !== undefined && now < expiry) return false
    this.expiries.delete(sid)
    this.expiries.set(sid, Math.max(now, ts) + DEFAULTS.signalMaxSkewMs + REPLAY_MARGIN_MS)
    if (this.expiries.size > this.sweepAt) {
      for (const [key, at] of this.expiries) if (now >= at) this.expiries.delete(key)
      // Sweep again only once the cache has grown by half, so a cache full of entries that
      // are all still needed is not rescanned on every check.
      this.sweepAt = Math.max(this.max, Math.ceil(this.expiries.size * 1.5))
    }
    return true
  }
}

/**
 * True for a well-formed envelope: `v` 1, a non-empty bounded `sid`, a string `ciphertext`
 * of at most {@link MAX_SIGNAL_CIPHERTEXT_CHARS} characters.
 */
export function isSignalEnvelope(x: unknown): x is SignalEnvelope {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  return (
    e.v === 1 &&
    typeof e.sid === 'string' &&
    e.sid.length > 0 &&
    e.sid.length <= MAX_SIGNAL_SID_CHARS &&
    typeof e.ciphertext === 'string' &&
    e.ciphertext.length <= MAX_SIGNAL_CIPHERTEXT_CHARS
  )
}

/** True for a network name a signal may carry: 1 to 16 characters from `a-z` and `0-9`. */
export function isSignalChain(x: unknown): x is string {
  return typeof x === 'string' && CHAIN.test(x)
}

/**
 * Encrypt a signal for `p.to` (BRC-2, protocol `[2, 'webrtpay signaling']`, key ID
 * `p.sid`). Only the {@link SignalPlaintext} fields are carried.
 *
 * @throws `TypeError` for a `chain` that is not 1 to 16 characters from `a-z` and `0-9`
 * (nothing is encrypted).
 */
export async function sealSignal(
  wallet: Pick<WalletLike, 'encrypt'>,
  p: SignalPlaintext,
  originator?: string
): Promise<SignalEnvelope> {
  if (p.chain !== undefined && !isSignalChain(p.chain)) {
    throw new TypeError('chain must be 1 to 16 characters from a-z and 0-9')
  }
  const plaintext: SignalPlaintext = {
    v: 1,
    kind: p.kind,
    sid: p.sid,
    from: p.from,
    to: p.to,
    ts: p.ts,
    purpose: p.purpose,
    sdp: p.sdp,
    reason: p.reason,
    chain: p.chain
  }
  const { ciphertext } = await wallet.encrypt(
    {
      plaintext: Array.from(utf8Encode(JSON.stringify(plaintext))),
      protocolID: SIGNALING_PROTOCOL_ID,
      keyID: p.sid,
      counterparty: p.to
    },
    originator
  )
  return { v: 1, sid: p.sid, ciphertext: toBase64(Uint8Array.from(ciphertext)) }
}

/**
 * Decrypt and check a signal received from `from` (the identity the carrier
 * asserts). The envelope must be well formed (ciphertext of at most
 * {@link MAX_SIGNAL_CIPHERTEXT_CHARS} characters, checked before decrypting); the
 * plaintext must name the same sender, be addressed to `me`, carry the envelope's sid, be
 * within ±120 s of `now`, have an sdp of at most 16384 characters, pass `wanted` when it
 * is given, and carry a sid not seen before (a `knock` or `ring` carries no `sdp` or
 * `reason`, and its sid is remembered apart from the offer, answer or reject that share it).
 * The sid is recorded only when every other check passes. Any failure rejects with `WebRTPayError('invalid_signal')`.
 *
 * @param o.wanted - Called last, before the sid is recorded: false rejects the signal and
 * leaves its sid unrecorded, so a signal the caller has no use for (an answer to a dial it
 * is not making, forged with a sid seen in the clear) cannot burn a sid the genuine signal
 * still needs.
 */
export async function openSignal(
  wallet: Pick<WalletLike, 'decrypt'>,
  from: PubKeyHex,
  e: SignalEnvelope,
  o: {
    me: PubKeyHex
    now?: number
    replay: ReplayCache
    originator?: string
    wanted?: (p: SignalPlaintext) => boolean
  }
): Promise<SignalPlaintext> {
  if (!isSignalEnvelope(e)) throw invalid('Malformed signal envelope')
  if (!isIdentityKey(from)) throw invalid('Signal sender is not an identity key')

  let decoded: unknown
  try {
    const { plaintext } = await wallet.decrypt(
      {
        ciphertext: Array.from(fromBase64(e.ciphertext)),
        protocolID: SIGNALING_PROTOCOL_ID,
        keyID: e.sid,
        counterparty: from
      },
      o.originator
    )
    decoded = JSON.parse(utf8Decode(Uint8Array.from(plaintext)))
  } catch (cause) {
    throw invalid('Signal cannot be decrypted', cause)
  }

  const p = toPlaintext(decoded)
  if (p === undefined) throw invalid('Malformed signal')
  if (p.from !== from) throw invalid('Signal sender does not match the carrier')
  if (p.to !== o.me) throw invalid('Signal is not addressed to us')
  if (p.sid !== e.sid) throw invalid('Signal sid does not match its envelope')
  const now = o.now ?? Date.now()
  if (Math.abs(now - p.ts) > DEFAULTS.signalMaxSkewMs) throw invalid('Signal is stale')
  if (p.sdp !== undefined && p.sdp.length > MAX_SIGNAL_SDP_CHARS) {
    throw invalid('Signal sdp is too long')
  }
  if (o.wanted !== undefined && !o.wanted(p)) throw invalid('Signal is not wanted')
  if (!o.replay.check(replayKey(p), now, p.ts)) throw invalid('Signal was replayed')
  return p
}

/**
 * What the replay cache remembers a signal by: its sid, or for a `knock` or `ring` its kind
 * and sid, so the offer and answer of the same dial still open once each.
 */
function replayKey(p: SignalPlaintext): string {
  return BARE_KINDS.has(p.kind) ? `${p.kind} ${p.sid}` : p.sid
}

/** The known fields of a decrypted signal, or undefined when it is not one. */
function toPlaintext(x: unknown): SignalPlaintext | undefined {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return undefined
  const r = x as Record<string, unknown>
  if (
    r.v !== 1 ||
    !KINDS.has(r.kind as SignalKind) ||
    typeof r.sid !== 'string' ||
    typeof r.from !== 'string' ||
    typeof r.to !== 'string' ||
    typeof r.ts !== 'number' ||
    !Number.isFinite(r.ts) ||
    r.purpose !== 'payment' ||
    (r.sdp !== undefined && typeof r.sdp !== 'string') ||
    (r.reason !== undefined && typeof r.reason !== 'string') ||
    (r.chain !== undefined && !isSignalChain(r.chain))
  ) {
    return undefined
  }
  if (BARE_KINDS.has(r.kind as SignalKind) && (r.sdp !== undefined || r.reason !== undefined)) {
    return undefined
  }
  const p: SignalPlaintext = {
    v: 1,
    kind: r.kind as SignalKind,
    sid: r.sid,
    from: r.from,
    to: r.to,
    ts: r.ts,
    purpose: 'payment'
  }
  if (r.sdp !== undefined) p.sdp = r.sdp as string
  if (r.reason !== undefined) p.reason = r.reason as string
  if (r.chain !== undefined) p.chain = r.chain as string
  return p
}

function invalid(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('invalid_signal', message, cause === undefined ? undefined : { cause })
}
