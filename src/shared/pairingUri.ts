import type { PairingParams, ParseResult } from '../types.js'

/**
 * Parse and validate a wallet://pair?… QR code URI.
 *
 * Checks performed:
 *   - protocol is wallet:
 *   - all required fields present
 *   - expiry not passed
 *   - origin is http:// or https://
 *   - backendIdentityKey is a compressed secp256k1 public key
 *   - protocolID is a valid [number, string] JSON tuple
 *   - keyID equals topic (per protocol spec)
 *
 * Note: the relay URL is no longer embedded in the QR. It is fetched at
 * connect-time from the origin server via HTTPS, which is the trust anchor.
 * See WalletPairingSession.resolveRelay().
 */
export function parsePairingUri(raw: string): ParseResult {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'wallet:') return { params: null, error: 'Not a wallet:// URI' }

    const g = (k: string) => url.searchParams.get(k) ?? ''
    const topic              = g('topic')
    const backendIdentityKey = g('backendIdentityKey')
    const protocolID         = g('protocolID')
    const keyID              = g('keyID')
    const origin             = g('origin')
    const expiry             = g('expiry')

    if (!topic || !backendIdentityKey || !protocolID || !keyID || !origin || !expiry) {
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

    if (keyID !== topic) {
      return { params: null, error: 'keyID must match topic — malformed QR code' }
    }

    return { params: { topic, backendIdentityKey, protocolID, keyID, origin, expiry }, error: null }
  } catch {
    return { params: null, error: 'Could not read QR code' }
  }
}

/**
 * Build a wallet://pair?… URI from session parameters.
 * `pairingTtlMs` controls how long the QR code is valid (default 120 s).
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
}): string {
  const ttl = params.pairingTtlMs ?? 120_000
  const expiry = Math.floor((Date.now() + ttl) / 1000)
  const p = new URLSearchParams({
    topic: params.sessionId,
    backendIdentityKey: params.backendIdentityKey,
    protocolID: params.protocolID,
    keyID: params.sessionId,  // sessionId doubles as keyID per protocol spec
    origin: params.origin,
    expiry: String(expiry),
  })
  return `wallet://pair?${p.toString()}`
}
