import { sha256 } from '@bsv/sdk/primitives/Hash'
import PublicKey from '@bsv/sdk/primitives/PublicKey'
import Random from '@bsv/sdk/primitives/Random'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { BRC29_PROTOCOL_ID, HEADERS } from './constants.js'

export interface Payment402Options {
  /** The client's wallet instance */
  wallet: WalletInterface
  /** Opt-in cache timeout in milliseconds for non-user-specific paid GET content (default: 0). */
  cacheTimeoutMs?: number
  /** Maximum response bytes retained by the opt-in paid-content cache (default: 8 MiB). */
  maxCachedResponseBytes?: number
}

/** The five headers the client must attach to a paid request. */
export interface PaymentHeaders {
  [HEADERS.BEEF]: string
  [HEADERS.SENDER]: string
  [HEADERS.NONCE]: string
  [HEADERS.TIME]: string
  [HEADERS.VOUT]: string
}

interface CacheEntry {
  status: number
  statusText: string
  headers: Headers
  body: ArrayBuffer
  timestamp: number
}

const DEFAULT_MAX_CACHED_RESPONSE_BYTES = 8 * 1024 * 1024
const MAX_PAYMENT_TRANSACTION_BYTES = 1024 * 1024
const PAYMENT_DESCRIPTION = 'BRC-121 web payment'

function isCompressedPublicKey(value: string): boolean {
  if (!/^(02|03)[0-9a-f]{64}$/u.test(value)) return false
  try {
    return PublicKey.fromString(value).toString() === value
  } catch {
    return false
  }
}

function validatedPaymentUrl(url: string): URL {
  const parsed = new URL(url)
  const local =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]'
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
    throw new TypeError('Payment requests require HTTPS except on the local loopback interface')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Payment request URLs must not contain credentials')
  }
  return parsed
}

function exactWalletBytes(value: unknown, name: string, maxBytes: number): number[] {
  const bytes = value instanceof Uint8Array ? Array.from(value) : value
  if (
    !Array.isArray(bytes) ||
    bytes.length === 0 ||
    bytes.length > maxBytes ||
    !bytes.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  ) {
    throw new TypeError(`${name} must be an exact bounded byte array`)
  }
  return bytes
}

function cacheKeyFor(url: string, init: RequestInit, method: string): string {
  const headers = [...new Headers(init.headers).entries()].sort(([a], [b]) => a.localeCompare(b))
  const context = JSON.stringify([method, url, init.credentials ?? 'same-origin', headers])
  return toHex(sha256(toArray(context, 'utf8')))
}

async function readResponseWithinLimit(
  response: Response,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const declaredLength = response.headers.get('content-length')
  if (
    declaredLength != null &&
    /^\d+$/u.test(declaredLength) &&
    Number(declaredLength) > maxBytes
  ) {
    return undefined
  }
  if (response.body == null) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        // A cloned Response tees the stream; awaiting cancellation can wait on
        // the caller-owned branch and deadlock before that branch is returned.
        void reader.cancel()
        return undefined
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return body
}

/**
 * Constructs the five BRC-121 payment headers for a given URL, satoshi amount,
 * and server identity key without performing any fetch.
 *
 * Useful for service workers, custom fetch wrappers, or any environment where
 * you want to build and attach payment headers manually.
 *
 * ```ts
 * import { constructPaymentHeaders } from '@bsv/402-pay/client'
 *
 * const headers = await constructPaymentHeaders(wallet, 'https://example.com/articles/foo', 100, serverKey)
 * const res = await fetch('https://example.com/articles/foo', { headers })
 * ```
 */
export async function constructPaymentHeaders(
  wallet: WalletInterface,
  url: string,
  satoshis: number,
  serverIdentityKey: string
): Promise<PaymentHeaders> {
  if (!Number.isSafeInteger(satoshis) || satoshis <= 0) {
    throw new RangeError('Payment price must be a positive safe integer')
  }
  const parsedUrl = validatedPaymentUrl(url)
  if (!isCompressedPublicKey(serverIdentityKey)) {
    throw new TypeError('Server identity must be a canonical compressed public key')
  }
  const originator = parsedUrl.origin
  const nonce = toBase64(Random(8))
  const time = String(Date.now())
  const timeSuffixB64 = toBase64(toArray(time, 'utf8'))

  // Derive recipient public key via BRC-42
  const { publicKey: derivedPubKey } = await wallet.getPublicKey(
    {
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${nonce} ${timeSuffixB64}`,
      counterparty: serverIdentityKey
    },
    originator
  )

  const pkh = PublicKey.fromString(derivedPubKey).toHash('hex') as string

  // Get sender identity key
  const { publicKey: senderIdentityKey } = await wallet.getPublicKey(
    { identityKey: true },
    originator
  )
  if (!isCompressedPublicKey(senderIdentityKey)) {
    throw new TypeError('Wallet returned an invalid sender identity key')
  }

  // Create payment transaction
  const actionResult = await wallet.createAction(
    {
      description: PAYMENT_DESCRIPTION,
      outputs: [
        {
          satoshis,
          lockingScript: `76a914${pkh}88ac`,
          outputDescription: '402 web payment',
          customInstructions: JSON.stringify({
            derivationPrefix: nonce,
            derivationSuffix: timeSuffixB64,
            serverIdentityKey
          }),
          tags: ['402-payment']
        }
      ],
      labels: ['402-payment'],
      options: { randomizeOutputs: false }
    },
    originator
  )

  const txBase64 = toBase64(
    exactWalletBytes(actionResult.tx, 'Wallet payment transaction', MAX_PAYMENT_TRANSACTION_BYTES)
  )

  return {
    [HEADERS.BEEF]: txBase64,
    [HEADERS.SENDER]: senderIdentityKey,
    [HEADERS.NONCE]: nonce,
    [HEADERS.TIME]: time,
    [HEADERS.VOUT]: '0'
  }
}

/**
 * Creates a fetch wrapper that automatically handles 402 Payment Required responses.
 *
 * When a 402 is received, the wrapper constructs a BRC-121 payment using the
 * provided wallet and retransmits the request with payment headers.
 *
 * Usage:
 * ```ts
 * import { create402Fetch } from '@bsv/402-pay/client'
 *
 * const fetch402 = create402Fetch({ wallet })
 * const response = await fetch402('https://example.com/articles/foo')
 * ```
 */
export function create402Fetch(options: Payment402Options) {
  const {
    wallet,
    cacheTimeoutMs = 0,
    maxCachedResponseBytes = DEFAULT_MAX_CACHED_RESPONSE_BYTES
  } = options
  if (!Number.isSafeInteger(cacheTimeoutMs) || cacheTimeoutMs < 0) {
    throw new RangeError('cacheTimeoutMs must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(maxCachedResponseBytes) || maxCachedResponseBytes < 1) {
    throw new RangeError('maxCachedResponseBytes must be a positive safe integer')
  }
  const cache = new Map<string, CacheEntry>()

  /**
   * Clears the payment cache. Call this when the user clears history
   * or when you want to force re-payment.
   */
  function clearCache() {
    cache.clear()
  }

  async function fetch402(url: string, init: RequestInit = {}): Promise<Response> {
    const initialUrl = validatedPaymentUrl(url)
    const method = (init.method ?? 'GET').toUpperCase()
    const cacheKey = cacheKeyFor(initialUrl.href, init, method)
    const canCache = method === 'GET' && cacheTimeoutMs > 0

    // Check cache
    const cached = canCache ? cache.get(cacheKey) : undefined
    if (cached && Date.now() - cached.timestamp < cacheTimeoutMs) {
      return new Response(cached.body.slice(0), {
        status: cached.status,
        statusText: cached.statusText,
        headers: cached.headers
      })
    }

    // Initial request
    const res = await fetch(initialUrl.href, init)
    if (res.status !== 402) {
      return res
    }

    // Read 402 headers
    const satsHeader = res.headers.get(HEADERS.SATS)
    const serverHeader = res.headers.get(HEADERS.SERVER)
    if (!satsHeader || !serverHeader) return res

    if (!/^[1-9]\d*$/.test(satsHeader)) return res
    const satoshis = Number(satsHeader)
    if (!Number.isSafeInteger(satoshis)) return res

    const paymentUrl = validatedPaymentUrl(res.url || initialUrl.href)
    if (paymentUrl.origin !== initialUrl.origin || !isCompressedPublicKey(serverHeader)) return res

    // Construct payment headers
    const paymentHeaders = await constructPaymentHeaders(
      wallet,
      paymentUrl.href,
      satoshis,
      serverHeader
    )

    // Retransmit with payment headers
    const paidHeaders = new Headers(init.headers)
    for (const [name, value] of Object.entries(paymentHeaders)) {
      paidHeaders.set(name, value)
    }
    const paidRes = await fetch(paymentUrl.href, {
      ...init,
      headers: paidHeaders,
      // Payment headers are bearer-like financial material. Never let fetch
      // forward them automatically to a redirect target.
      redirect: 'manual'
    })

    // Cache successful responses
    if (paidRes.ok && canCache) {
      const body = await readResponseWithinLimit(paidRes.clone(), maxCachedResponseBytes)
      if (body !== undefined) {
        cache.set(cacheKey, {
          status: paidRes.status,
          statusText: paidRes.statusText,
          headers: new Headers(paidRes.headers),
          body: body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength
          ) as ArrayBuffer,
          timestamp: Date.now()
        })
      }
    }

    return paidRes
  }

  return Object.assign(fetch402, { clearCache })
}
