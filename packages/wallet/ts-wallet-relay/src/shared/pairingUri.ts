import type { PairingParams, ParseResult } from '../types.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { base64urlToBytes } from './encoding.js'
import {
  type LocalNetworkHttpOptions,
  normalizeHttpOrigin,
  requireBoundedString,
  requireOptionalBoolean,
  requireProtocolId,
  requirePublicKey,
  requirePairingTopic,
  validatePairingParams
} from './validation.js'

/** Default accepted URI schemes for parsePairingUri. */
export const DEFAULT_ACCEPTED_SCHEMAS: ReadonlySet<string> = new Set(['bsv-browser:'])
const textEncoder = new TextEncoder()

// ── Internal helper ───────────────────────────────────────────────────────────

/** Canonical byte payload over the security-critical QR fields. */
function sigPayload(
  topic: string,
  backendIdentityKey: string,
  origin: string,
  expiry: string | number
): Uint8Array {
  return textEncoder.encode(`${topic}|${backendIdentityKey}|${origin}|${expiry}`)
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/gu)!, byte => Number.parseInt(byte, 16))
}

function scalar(bytes: Uint8Array): bigint {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

// ── parsePairingUri ───────────────────────────────────────────────────────────

/**
 * Parse and validate a bsv-browser://pair?… QR code URI.
 *
 * Checks performed:
 *   - protocol is in acceptedSchemas (default: bsv-browser:)
 *   - all required fields present
 *   - expiry not passed
 *   - origin is HTTPS, or HTTP on a loopback host for local development
 *     (private-network IP hosts too, only with `allowLocalNetworkHttp`)
 *   - backendIdentityKey is a compressed secp256k1 public key
 *   - protocolID is a valid [number, string] JSON tuple
 *
 * Note: the relay URL is no longer embedded in the QR. It is fetched at
 * connect-time from the origin server via HTTPS, which is the trust anchor.
 * See WalletPairingSession.resolveRelay().
 *
 * @param raw - The raw URI string to parse.
 * @param acceptedSchemas - Set of accepted URI schemes (e.g. `new Set(['my-app:'])`).
 *   Defaults to `DEFAULT_ACCEPTED_SCHEMAS`. Pass your own set to support custom deep-link
 *   schemes used by third-party wallet apps.
 * @param options - `allowLocalNetworkHttp: true` accepts `http://` origins on
 *   private-network IP addresses. Development wallet builds only: such origins
 *   are unauthenticated. Pass the same value to `WalletPairingSession`.
 */
export function parsePairingUri(
  raw: string,
  acceptedSchemas: ReadonlySet<string> = DEFAULT_ACCEPTED_SCHEMAS,
  options: LocalNetworkHttpOptions = {}
): ParseResult {
  let allowLocalNetworkHttp: boolean
  try {
    allowLocalNetworkHttp = requireOptionalBoolean(
      options.allowLocalNetworkHttp,
      'allowLocalNetworkHttp'
    )
  } catch (error) {
    return { params: null, error: (error as Error).message }
  }
  try {
    const url = new URL(raw)
    if (!acceptedSchemas.has(url.protocol))
      return { params: null, error: 'URI scheme is not a recognised wallet pairing scheme' }
    if (
      url.username !== '' ||
      url.password !== '' ||
      url.hostname !== 'pair' ||
      url.port !== '' ||
      (url.pathname !== '' && url.pathname !== '/') ||
      url.hash !== ''
    ) {
      return { params: null, error: 'QR code must use the exact wallet://pair route' }
    }

    const requiredFields = ['topic', 'backendIdentityKey', 'protocolID', 'origin', 'expiry']
    if (
      requiredFields.some(field => url.searchParams.getAll(field).length !== 1) ||
      url.searchParams.getAll('sig').length > 1
    ) {
      return { params: null, error: 'QR code contains a missing or duplicate security field' }
    }

    const topic = url.searchParams.get('topic')!
    const backendIdentityKey = url.searchParams.get('backendIdentityKey')!
    const protocolID = url.searchParams.get('protocolID')!
    const origin = url.searchParams.get('origin')!
    const expiry = url.searchParams.get('expiry')!
    const sig = url.searchParams.get('sig') ?? undefined

    if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
      return { params: null, error: 'QR code is missing required fields' }
    }

    try {
      requirePairingTopic(topic, 'pairing topic')
    } catch {
      return { params: null, error: 'QR code topic is not a bounded URL-safe identifier' }
    }

    if (!/^(0|[1-9]\d*)$/.test(expiry) || !Number.isSafeInteger(Number(expiry))) {
      return { params: null, error: 'QR code expiry is not a valid Unix timestamp' }
    }
    if (Date.now() / 1000 > Number(expiry)) {
      return {
        params: null,
        error: 'This QR code has expired — ask the desktop to generate a new one'
      }
    }
    try {
      normalizeHttpOrigin(origin, 'origin', { allowLocalNetworkHttp })
    } catch (error) {
      return {
        params: null,
        error: error instanceof Error ? error.message : 'Origin URL is not valid'
      }
    }

    try {
      requirePublicKey(backendIdentityKey, 'Backend identity key')
    } catch {
      return { params: null, error: 'Backend identity key is not a valid compressed public key' }
    }

    let proto: unknown
    try {
      proto = JSON.parse(protocolID)
    } catch {
      return { params: null, error: 'protocolID is not valid JSON' }
    }
    try {
      requireProtocolId(proto)
    } catch {
      return { params: null, error: 'protocolID must be the mobile wallet session protocol' }
    }

    if (sig !== undefined) {
      try {
        const signature = requireBoundedString(sig, 'pairing signature', 1, 128)
        const decoded = base64urlToBytes(signature)
        if (decoded.length < 1 || decoded.length > 80) throw new TypeError()
      } catch {
        return { params: null, error: 'QR code contains a malformed security field' }
      }
    }
    return { params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }, error: null }
  } catch {
    return { params: null, error: 'Could not read QR code' }
  }
}

// ── buildPairingUri ───────────────────────────────────────────────────────────

/**
 * Build a bsv-browser://pair?… URI from session parameters.
 * `pairingTtlMs` controls how long the QR code is valid (default 120 s).
 * Pass `expiry` (Unix seconds) to override the computed value — required when
 * signing so the same value is used in both the signature and the URI.
 *
 * Note: the relay URL is intentionally omitted. The mobile fetches it at
 * connect-time from the origin server — see WalletPairingSession.resolveRelay().
 * `allowLocalNetworkHttp` permits an `http://` origin on a private-network IP
 * address (development only).
 */
export function buildPairingUri(params: {
  sessionId: string
  backendIdentityKey: string
  protocolID: string // JSON.stringify(PROTOCOL_ID)
  origin: string
  pairingTtlMs?: number
  expiry?: number // Unix seconds override — keeps expiry consistent with signature
  sig?: string // base64url DER ECDSA signature
  schema?: string
  allowLocalNetworkHttp?: boolean
}): string {
  const expiry = params.expiry ?? Math.floor((Date.now() + (params.pairingTtlMs ?? 120_000)) / 1000)
  if (!/^[a-z][a-z0-9+.-]{0,31}$/iu.test(params.schema ?? 'bsv-browser')) {
    throw new TypeError('Pairing URI scheme is invalid')
  }
  validatePairingParams(
    {
      topic: params.sessionId,
      backendIdentityKey: params.backendIdentityKey,
      protocolID: params.protocolID,
      origin: params.origin,
      expiry: String(expiry),
      sig: params.sig
    },
    { allowLocalNetworkHttp: params.allowLocalNetworkHttp, developerHint: true }
  )
  const p = new URLSearchParams({
    topic: params.sessionId,
    backendIdentityKey: params.backendIdentityKey,
    protocolID: params.protocolID,
    origin: params.origin,
    expiry: String(expiry)
  })
  if (params.sig) p.set('sig', params.sig)
  return `${params.schema ?? 'bsv-browser'}://pair?${p.toString()}`
}

// ── verifyPairingSignature ────────────────────────────────────────────────────

/**
 * Verify the `sig` field embedded in a parsed PairingParams object.
 *
 * Derives the public BRC-42 key for the "anyone" counterparty and verifies the
 * signature over `topic|backendIdentityKey|origin|expiry`. No mobile wallet is needed.
 *
 * Returns `false` when `params.sig` is absent or on any verification failure,
 * including an `http://` private-network origin without `allowLocalNetworkHttp`.
 */
export function verifyPairingSignature(
  params: PairingParams,
  options: LocalNetworkHttpOptions = {}
): Promise<boolean> {
  // The check is synchronous; a throw from bad input still becomes a
  // rejection, as it was when this function was async.
  try {
    return Promise.resolve(checkPairingSignature(params, options))
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)))
  }
}

function checkPairingSignature(params: PairingParams, options: LocalNetworkHttpOptions): boolean {
  if (!params.sig) return false
  try {
    validatePairingParams(params, options)
    const parentBytes = hexBytes(params.backendIdentityKey)
    const parent = secp256k1.Point.fromBytes(parentBytes)
    const tweak =
      scalar(hmac(sha256, parentBytes, textEncoder.encode(`0-qr pairing-${params.topic}`))) %
      secp256k1.Point.CURVE().n
    const signingKey = tweak === 0n ? parent : parent.add(secp256k1.Point.BASE.multiply(tweak))
    return secp256k1.verify(
      Uint8Array.from(base64urlToBytes(params.sig)),
      sigPayload(params.topic, params.backendIdentityKey, params.origin, params.expiry),
      signingKey.toBytes(true),
      { format: 'der', lowS: false }
    )
  } catch {
    return false
  }
}
