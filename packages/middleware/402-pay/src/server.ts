import { type WalletInterface, Utils, Beef } from '@bsv/sdk'
import { HEADERS, DEFAULT_PAYMENT_WINDOW_MS } from './constants.js'

export interface PaymentResult {
  accepted: true
  satoshisPaid: number
  senderIdentityKey: string
  txid: string
}

export interface PaymentError {
  accepted: false
  reason: string
}

export interface PaymentMiddlewareOptions {
  /** The server's wallet instance */
  wallet: WalletInterface
  /** Function that returns the price in satoshis for a given request path. Return 0 or undefined to skip payment. */
  calculatePrice: (path: string) => number | undefined
  /** Payment freshness window in milliseconds (default: 30000) */
  paymentWindowMs?: number
}

/**
 * Generic request/response interface so the middleware is not coupled to Express.
 * Works with Express, Fastify, or any framework that provides headers, path, status, and set.
 */
export interface PaymentRequest {
  path: string
  headers: Record<string, string | string[] | undefined>
}

export interface PaymentResponse {
  status(code: number): PaymentResponse
  set(headers: Record<string, string>): PaymentResponse
  end(): void
}

/**
 * Sends a 402 Payment Required response with price and server identity headers.
 */
export function send402(
  res: PaymentResponse,
  serverIdentityKey: string,
  sats: number
): void {
  res.set({
    [HEADERS.SATS]: String(sats),
    [HEADERS.SERVER]: serverIdentityKey
  })
  res.status(402).end()
}

/**
 * Validates payment headers on an incoming request.
 * Returns a PaymentResult if the payment is valid, a PaymentError with a reason if the payment
 * is structurally invalid or a replay, or null if headers are missing/malformed.
 *
 * @param requiredSats - The minimum satoshi value expected at the specified output index.
 */
export async function validatePayment(
  req: PaymentRequest,
  wallet: WalletInterface,
  requiredSats: number,
  paymentWindowMs: number = DEFAULT_PAYMENT_WINDOW_MS
): Promise<PaymentResult | PaymentError | null> {
  const h = (name: string): string | undefined => {
    const v = req.headers[name]
    return Array.isArray(v) ? v[0] : v
  }

  const sender = h(HEADERS.SENDER)
  const beef = h(HEADERS.BEEF)
  const nonce = h(HEADERS.NONCE)
  const time = h(HEADERS.TIME)
  const vout = h(HEADERS.VOUT)

  if (!sender || !beef || !nonce || !time || !vout) return null

  // Validate timestamp freshness
  const timestamp = Number(time)
  if (Number.isNaN(timestamp) || Math.abs(Date.now() - timestamp) > paymentWindowMs) return null

  const beefArr = Utils.toArray(beef, 'base64')
  const beefObj = Beef.fromBinary(beefArr)
  const lastTx = beefObj.txs.at(-1)
  if (!lastTx?.tx) return null
  const txid = lastTx.tx.id('hex')

  // Verify the specified output carries at least the required satoshi amount
  const voutIndex = Number.parseInt(vout)
  const output = lastTx.tx.outputs[voutIndex]
  if (output?.satoshis === undefined || output.satoshis < requiredSats) return null

  const result = await wallet.internalizeAction({
    tx: beefArr,
    outputs: [{
      outputIndex: voutIndex,
      protocol: 'wallet payment',
      paymentRemittance: {
        derivationPrefix: nonce,
        derivationSuffix: Buffer.from(time).toString('base64'),
        senderIdentityKey: sender
      }
    }],
    description: `Payment for ${req.path}`
  }) as { accepted: boolean; isMerge?: boolean }

  // Reject replayed transactions with an explicit error so callers can log it
  if (result.isMerge) {
    return { accepted: false, reason: `Replayed transaction: txid ${txid} has already been processed` }
  }

  return {
    accepted: true,
    satoshisPaid: output.satoshis,
    senderIdentityKey: sender,
    txid
  }
}

/**
 * Creates an Express-compatible middleware function for BRC-121 payments.
 *
 * Usage:
 * ```ts
 * import { createPaymentMiddleware } from '@bsv/402-pay/server'
 *
 * app.use('/articles/:slug', createPaymentMiddleware({
 *   wallet,
 *   calculatePrice: (path) => 100
 * }))
 * ```
 */
export function createPaymentMiddleware(options: PaymentMiddlewareOptions) {
  const { wallet, calculatePrice, paymentWindowMs } = options
  let identityKey = ''

  return async (req: any, res: any, next: any) => {
    try {
      if (!identityKey) {
        const { publicKey } = await wallet.getPublicKey({ identityKey: true })
        identityKey = publicKey
      }

      const price = calculatePrice(req.path)
      if (!price) return next()

      const hasPayment = req.headers[HEADERS.BEEF]
      if (!hasPayment) {
        return send402(res, identityKey, price)
      }

      const result = await validatePayment(req, wallet, price, paymentWindowMs)
      if (!result) {
        return send402(res, identityKey, price)
      }
      if (!result.accepted) {
        console.error(`Payment rejected: ${req.path} | ${result.reason}`)
        return send402(res, identityKey, price)
      }

      req.payment = { ...result, satoshisPaid: price }
      console.log(`Payment accepted: ${req.path} | ${price} sats | txid: ${result.txid}`)
      next()
    } catch {
      if (identityKey) {
        const price = calculatePrice(req.path) ?? 100
        send402(res, identityKey, price)
      } else {
        res.status(500).end()
      }
    }
  }
}
