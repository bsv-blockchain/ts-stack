import { PublicKey, Utils, Random } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { BRC29_PROTOCOL_ID, HEADERS } from './constants.js'

export interface Payment402Options {
  /** The client's wallet instance */
  wallet: WalletInterface
  /** Cache timeout in milliseconds for paid content (default: 30 minutes) */
  cacheTimeoutMs?: number
}

interface CacheEntry {
  response: Response
  body: string
  timestamp: number
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
  const { wallet, cacheTimeoutMs = 30 * 60 * 1000 } = options
  const cache = new Map<string, CacheEntry>()

  /**
   * Clears the payment cache. Call this when the user clears history
   * or when you want to force re-payment.
   */
  function clearCache() {
    cache.clear()
  }

  async function fetch402(url: string, init: RequestInit = {}): Promise<Response> {
    // Check cache
    const cached = cache.get(url)
    if (cached && (Date.now() - cached.timestamp) < cacheTimeoutMs) {
      return new Response(cached.body, {
        status: cached.response.status,
        headers: cached.response.headers
      })
    }

    // Initial request
    const res = await fetch(url, init)
    if (res.status !== 402) {
      return res
    }

    // Read 402 headers
    const satsHeader = res.headers.get(HEADERS.SATS)
    const serverHeader = res.headers.get(HEADERS.SERVER)
    if (!satsHeader || !serverHeader) return res

    const satoshis = Number.parseInt(satsHeader)
    if (isNaN(satoshis) || satoshis <= 0) return res

    // Construct payment
    const serverIdentityKey = serverHeader
    const nonce = Utils.toBase64(Random(8))
    const time = String(Date.now())
    const timeSuffixB64 = Buffer.from(time).toString('base64')
    const originator = new URL(url).origin

    // Derive recipient public key via BRC-42
    const { publicKey: derivedPubKey } = await wallet.getPublicKey({
      protocolID: BRC29_PROTOCOL_ID,
      keyID: `${nonce} ${timeSuffixB64}`,
      counterparty: serverIdentityKey
    }, originator)

    const pkh = PublicKey.fromString(derivedPubKey).toHash('hex') as string

    // Get sender identity key
    const { publicKey: senderIdentityKey } = await wallet.getPublicKey(
      { identityKey: true },
      originator
    )

    // Create payment transaction
    const actionResult = await wallet.createAction({
      description: `Paid Content: ${new URL(url).pathname}`,
      outputs: [{
        satoshis,
        lockingScript: `76a914${pkh}88ac`,
        outputDescription: '402 web payment',
        customInstructions: JSON.stringify({
          derivationPrefix: nonce,
          derivationSuffix: timeSuffixB64,
          serverIdentityKey
        }),
        tags: ['402-payment']
      }],
      labels: ['402-payment'],
      options: { randomizeOutputs: false }
    }, originator)

    const txBase64 = Utils.toBase64(actionResult.tx as number[])

    // Retransmit with payment headers
    const paidRes = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        [HEADERS.BEEF]: txBase64,
        [HEADERS.SENDER]: senderIdentityKey,
        [HEADERS.NONCE]: nonce,
        [HEADERS.TIME]: time,
        [HEADERS.VOUT]: '0'
      }
    })

    // Cache successful responses
    if (paidRes.ok) {
      const body = await paidRes.text()
      cache.set(url, {
        response: paidRes,
        body,
        timestamp: Date.now()
      })
      return new Response(body, {
        status: paidRes.status,
        headers: paidRes.headers
      })
    }

    return paidRes
  }

  return Object.assign(fetch402, { clearCache })
}
