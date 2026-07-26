import { type WalletInterface, Utils, Beef, PublicKey } from '@bsv/sdk'
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

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function parseUnsignedInteger(value: string): number | undefined {
  if (!/^(0|[1-9]\d*)$/.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function isCompressedPublicKey(value: string): boolean {
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return false
  try {
    return PublicKey.fromString(value).toString() === value.toLowerCase()
  } catch {
    return false
  }
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false
  }
  return Utils.toBase64(Utils.toArray(value, 'base64')) === value
}

/**
 * Sends a 402 Payment Required response with price and server identity headers.
 */
export function send402(res: PaymentResponse, serverIdentityKey: string, sats: number): void {
  if (!isCompressedPublicKey(serverIdentityKey)) {
    throw new TypeError('A valid compressed server identity key is required')
  }
  if (!isPositiveSafeInteger(sats)) {
    throw new RangeError('Payment price must be a positive safe integer')
  }
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

  if (
    !sender ||
    !beef ||
    !nonce ||
    !time ||
    !vout ||
    sender.length > 130 ||
    nonce.length > 512 ||
    time.length > 16 ||
    vout.length > 10 ||
    !isCompressedPublicKey(sender) ||
    !isCanonicalBase64(nonce) ||
    !isPositiveSafeInteger(requiredSats) ||
    !isPositiveSafeInteger(paymentWindowMs)
  ) {
    return null
  }

  // Validate timestamp freshness
  const timestamp = parseUnsignedInteger(time)
  if (timestamp === undefined || Math.abs(Date.now() - timestamp) > paymentWindowMs) return null

  let beefArr: number[]
  let beefObj: Beef
  try {
    beefArr = Utils.toArray(beef, 'base64')
    beefObj = Beef.fromBinary(beefArr)
  } catch {
    return null
  }
  const lastTx = beefObj.txs.at(-1)
  if (!lastTx?.tx) return null
  const txid = lastTx.tx.id('hex')

  // Verify the specified output carries at least the required satoshi amount
  const voutIndex = parseUnsignedInteger(vout)
  if (voutIndex === undefined) return null
  const output = lastTx.tx.outputs[voutIndex]
  if (output?.satoshis === undefined || output.satoshis < requiredSats) return null

  const result = (await wallet.internalizeAction({
    tx: beefArr,
    outputs: [
      {
        outputIndex: voutIndex,
        protocol: 'wallet payment',
        paymentRemittance: {
          derivationPrefix: nonce,
          derivationSuffix: Buffer.from(time).toString('base64'),
          senderIdentityKey: sender
        }
      }
    ],
    description: `Payment for ${req.path}`
  })) as { accepted: boolean; isMerge?: boolean }

  // Reject replayed transactions with an explicit error so callers can log it
  if (result.isMerge) {
    return {
      accepted: false,
      reason: `Replayed transaction: txid ${txid} has already been processed`
    }
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
    if (!identityKey) {
      try {
        const { publicKey } = await wallet.getPublicKey({ identityKey: true })
        if (!isCompressedPublicKey(publicKey)) throw new Error('Invalid wallet identity key')
        identityKey = publicKey
      } catch {
        res.status(500).end()
        return
      }
    }

    let price: number | undefined
    try {
      price = calculatePrice(req.path)
    } catch {
      res.status(500).end()
      return
    }
    if (price === undefined || price === 0) return next()
    if (!isPositiveSafeInteger(price)) {
      res.status(500).end()
      return
    }

    const hasPayment = req.headers[HEADERS.BEEF]
    if (!hasPayment) {
      return send402(res, identityKey, price)
    }

    let result: PaymentResult | PaymentError | null
    try {
      result = await validatePayment(req, wallet, price, paymentWindowMs)
    } catch {
      return send402(res, identityKey, price)
    }
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
  }
}
