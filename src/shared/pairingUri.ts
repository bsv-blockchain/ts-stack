import type { PairingParams, ParseResult } from '../types.js'
import { ProtoWallet, PrivateKey } from '@bsv/sdk'
import { bytesToBase64url, base64urlToBytes } from './encoding.js'

/** Default accepted URI schemes for parsePairingUri. */
export const DEFAULT_ACCEPTED_SCHEMAS: ReadonlySet<string> = new Set(['bsv-wallet:'])

// ── Internal helper ───────────────────────────────────────────────────────────

/** Canonical byte payload over the security-critical QR fields. */
function sigPayload(
  topic: string,
  backendIdentityKey: string,
  origin: string,
  expiry: string | number,
): number[] {
  return Array.from(new TextEncoder().encode(`${topic}|${backendIdentityKey}|${origin}|${expiry}`))
}

// ── parsePairingUri ───────────────────────────────────────────────────────────

/**
 * Parse and validate a bsv-wallet://pair?… QR code URI.
 *
 * Checks performed:
 *   - protocol is in acceptedSchemas (default: bsv-wallet:)
 *   - all required fields present
 *   - expiry not passed
 *   - origin is http:// or https://
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
 */
export function parsePairingUri(raw: string, acceptedSchemas: ReadonlySet<string> = DEFAULT_ACCEPTED_SCHEMAS): ParseResult {
  try {
    const url = new URL(raw)
    if (!acceptedSchemas.has(url.protocol)) return { params: null, error: 'Not a bsv-wallet:// URI' }

    const g = (k: string) => url.searchParams.get(k) ?? ''
    const topic              = g('topic')
    const backendIdentityKey = g('backendIdentityKey')
    const protocolID         = g('protocolID')
    const origin             = g('origin')
    const expiry             = g('expiry')
    const sig                = url.searchParams.get('sig') ?? undefined

    if (!topic || !backendIdentityKey || !protocolID || !origin || !expiry) {
      return { params: null, error: 'QR code is missing required fields' }
    }

    if (Date.now() / 1000 > Number(expiry)) {
      return { params: null, error: 'This QR code has expired — ask the desktop to generate a new one' }
    }

    let originUrl: URL
    try { originUrl = new URL(origin) } catch { return { params: null, error: 'Origin URL is not valid' } }
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return { params: null, error: 'Origin must use http:// or https://' }
    }

    if (!/^0[23][0-9a-fA-F]{64}$/.test(backendIdentityKey)) {
      return { params: null, error: 'Backend identity key is not a valid compressed public key' }
    }

    let proto: unknown
    try { proto = JSON.parse(protocolID) } catch { return { params: null, error: 'protocolID is not valid JSON' } }
    if (!Array.isArray(proto) || proto.length !== 2 || typeof proto[0] !== 'number' || typeof proto[1] !== 'string') {
      return { params: null, error: 'protocolID must be a [number, string] tuple' }
    }

    return { params: { topic, backendIdentityKey, protocolID, origin, expiry, sig }, error: null }
  } catch {
    return { params: null, error: 'Could not read QR code' }
  }
}

// ── buildPairingUri ───────────────────────────────────────────────────────────

/**
 * Build a bsv-wallet://pair?… URI from session parameters.
 * `pairingTtlMs` controls how long the QR code is valid (default 120 s).
 * Pass `expiry` (Unix seconds) to override the computed value — required when
 * signing so the same value is used in both the signature and the URI.
 *
 * Note: the relay URL is intentionally omitted. The mobile fetches it at
 * connect-time from the origin server — see WalletPairingSession.resolveRelay().
 */
export function buildPairingUri(params: {
  sessionId: string
  backendIdentityKey: string
  protocolID: string  // JSON.stringify(PROTOCOL_ID)
  origin: string
  pairingTtlMs?: number
  expiry?: number     // Unix seconds override — keeps expiry consistent with signature
  sig?: string        // base64url DER ECDSA signature
  schema?: string
}): string {
  const expiry = params.expiry ?? Math.floor((Date.now() + (params.pairingTtlMs ?? 120_000)) / 1000)
  const p = new URLSearchParams({
    topic: params.sessionId,
    backendIdentityKey: params.backendIdentityKey,
    protocolID: params.protocolID,
    origin: params.origin,
    expiry: String(expiry),
  })
  if (params.sig) p.set('sig', params.sig)
  return `${params.schema ?? 'bsv-wallet'}://pair?${p.toString()}`
}

// ── verifyPairingSignature ────────────────────────────────────────────────────

/**
 * Verify the `sig` field embedded in a parsed PairingParams object.
 *
 * Uses `ProtoWallet(new PrivateKey(1))` (the "anyone" verifier) to confirm the
 * signature over `topic|backendIdentityKey|origin|expiry` was produced by the
 * private key behind `backendIdentityKey`. No mobile wallet is needed.
 *
 * Returns `true` immediately (no-op) when `params.sig` is absent — backward
 * compatible with servers that have `signQrCodes: false`.
 * Returns `false` on any verification failure.
 */
export async function verifyPairingSignature(params: PairingParams): Promise<boolean> {
  if (!params.sig) return true
  try {
    const anyoneWallet = new ProtoWallet(new PrivateKey(1))
    const { valid } = await anyoneWallet.verifySignature({
      data:         sigPayload(params.topic, params.backendIdentityKey, params.origin, params.expiry),
      signature:    base64urlToBytes(params.sig),
      protocolID:   [0, 'qr pairing'],
      keyID:        params.topic,
      counterparty: params.backendIdentityKey,
    })
    return valid
  } catch {
    return false
  }
}
