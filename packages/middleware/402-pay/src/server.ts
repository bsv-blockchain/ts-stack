import PublicKey from '@bsv/sdk/primitives/PublicKey'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { Beef } from '@bsv/sdk/transaction/Beef'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { HEADERS, DEFAULT_PAYMENT_WINDOW_MS } from './constants.js'

const MAX_BEEF_BYTES = 1024 * 1024
const MAX_BEEF_BASE64_LENGTH = Math.ceil(MAX_BEEF_BYTES / 3) * 4
const DEFAULT_REPLAY_CAPACITY = 100_000
const PAYMENT_DESCRIPTION = 'BRC-121 payment'

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
  /** Atomic transaction claim store. Use a shared durable implementation when multiple processes serve a route. */
  replayStore?: PaymentReplayStore
  /** Optional structured diagnostics. The middleware is silent unless a logger is supplied. */
  logger?: PaymentLogger
}

/**
 * Replay claims must be atomic. `expiresAt` is the last millisecond at which
 * the BRC-121 timestamp can still pass the configured freshness window.
 */
export interface PaymentReplayStore {
  claim(transactionId: string, expiresAt: number): boolean | Promise<boolean>
}

export interface PaymentLogger {
  error?: (message: string, context?: Record<string, unknown>) => void
  warn?: (message: string, context?: Record<string, unknown>) => void
  info?: (message: string, context?: Record<string, unknown>) => void
}

/**
 * Process-local bounded replay protection. The default instance is shared by
 * all middleware created with the same wallet object. Clustered services must
 * still supply an atomic shared store.
 */
export class InMemoryPaymentReplayStore implements PaymentReplayStore {
  private readonly claimed = new Map<string, number>()

  constructor(private readonly maxEntries: number = DEFAULT_REPLAY_CAPACITY) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Replay-store capacity must be a positive safe integer')
    }
  }

  claim(transactionId: string, expiresAt: number): boolean {
    if (!/^[0-9a-f]{64}$/u.test(transactionId)) {
      throw new TypeError('Replay claims require a canonical transaction ID')
    }
    if (!Number.isSafeInteger(expiresAt) || expiresAt < 0) {
      throw new RangeError('Replay claims require a safe expiration timestamp')
    }

    const now = Date.now()
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error('The system clock is outside the supported range')
    }
    const existingExpiry = this.claimed.get(transactionId)
    if (existingExpiry !== undefined) {
      if (existingExpiry >= now) return false
      this.claimed.delete(transactionId)
    }

    if (this.claimed.size >= this.maxEntries) {
      for (const [claimedTxid, expiry] of this.claimed) {
        if (expiry < now) this.claimed.delete(claimedTxid)
      }
      if (this.claimed.size >= this.maxEntries) {
        throw new Error('Payment replay store capacity exceeded')
      }
    }

    this.claimed.set(transactionId, expiresAt)
    return true
  }
}

const defaultReplayStores = new WeakMap<object, InMemoryPaymentReplayStore>()

function defaultReplayStoreFor(wallet: WalletInterface): InMemoryPaymentReplayStore {
  const key = wallet as object
  let store = defaultReplayStores.get(key)
  if (store === undefined) {
    store = new InMemoryPaymentReplayStore()
    defaultReplayStores.set(key, store)
  }
  return store
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

function isPaymentLogger(value: unknown): value is PaymentLogger | undefined {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  const logger = value as Record<string, unknown>
  return (
    (logger.error === undefined || typeof logger.error === 'function') &&
    (logger.warn === undefined || typeof logger.warn === 'function') &&
    (logger.info === undefined || typeof logger.info === 'function')
  )
}

function safeErrorContext(error: unknown): Record<string, unknown> {
  try {
    return error instanceof Error ? { errorName: 'Error' } : { errorType: typeof error }
  } catch {
    return { errorType: 'unknown' }
  }
}

function emitLog(
  logger: PaymentLogger | undefined,
  level: 'error' | 'warn' | 'info',
  message: string,
  context?: Record<string, unknown>
): void {
  try {
    const method = logger?.[level]
    if (context === undefined) method?.call(logger, message)
    else method?.call(logger, message, context)
  } catch {
    // Diagnostics are never part of payment authorization or delivery.
  }
}

function internalizationVerdict(result: unknown): 'accepted' | 'replay' | 'rejected' {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return 'rejected'
  try {
    const accepted = Object.getOwnPropertyDescriptor(result, 'accepted')
    if (accepted === undefined || !Object.hasOwn(accepted, 'value') || accepted.value !== true) {
      return 'rejected'
    }
    const isMerge = Object.getOwnPropertyDescriptor(result, 'isMerge')
    if (isMerge === undefined) return 'accepted'
    if (!Object.hasOwn(isMerge, 'value')) return 'rejected'
    if (isMerge.value === true) return 'replay'
    return isMerge.value === false ? 'accepted' : 'rejected'
  } catch {
    return 'rejected'
  }
}

function isCanonicalBase64(value: string): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false
  }
  try {
    return toBase64(toArray(value, 'base64')) === value
  } catch {
    return false
  }
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
  paymentWindowMs: number = DEFAULT_PAYMENT_WINDOW_MS,
  replayStore?: PaymentReplayStore
): Promise<PaymentResult | PaymentError | null> {
  const h = (name: string): string | undefined => {
    const v = req.headers[name]
    return typeof v === 'string' ? v : undefined
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
    beef.length > MAX_BEEF_BASE64_LENGTH ||
    nonce.length > 512 ||
    time.length > 16 ||
    vout.length > 10 ||
    !isCompressedPublicKey(sender) ||
    !isCanonicalBase64(beef) ||
    !isCanonicalBase64(nonce) ||
    !isPositiveSafeInteger(requiredSats) ||
    !isPositiveSafeInteger(paymentWindowMs)
  ) {
    return null
  }

  // Validate timestamp freshness
  const timestamp = parseUnsignedInteger(time)
  const now = Date.now()
  if (
    timestamp === undefined ||
    !Number.isSafeInteger(now) ||
    now < 0 ||
    timestamp > Number.MAX_SAFE_INTEGER - paymentWindowMs ||
    Math.abs(now - timestamp) > paymentWindowMs
  ) {
    return null
  }
  const replayExpiresAt = timestamp + paymentWindowMs

  let beefArr: number[]
  let beefObj: Beef
  try {
    const decodedBeef = toArray(beef, 'base64')
    if (decodedBeef.length > MAX_BEEF_BYTES) return null
    beefObj = Beef.fromBinaryView(Uint8Array.from(decodedBeef))
    const atomicTxid = beefObj.atomicTxid
    if (atomicTxid == null || beefObj.findTxid(atomicTxid) == null) return null

    // Older clients could include unrelated BEEF branches. Restrict both
    // pricing and wallet internalization to the transaction named by the
    // BRC-95 subject prefix and its dependency closure.
    beefArr = beefObj.toBinaryAtomic(atomicTxid)
    beefObj = Beef.fromBinaryStrict(beefArr)
  } catch {
    return null
  }
  const txid = beefObj.atomicTxid
  if (txid == null) return null
  const paymentTx = beefObj.findTxid(txid)?.tx
  if (paymentTx == null) return null

  // Verify the specified output carries at least the required satoshi amount
  const voutIndex = parseUnsignedInteger(vout)
  if (voutIndex === undefined) return null
  const output = paymentTx.outputs[voutIndex]
  if (output?.satoshis === undefined || output.satoshis < requiredSats) return null

  const result: unknown = await wallet.internalizeAction({
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
    description: PAYMENT_DESCRIPTION
  })

  // Reject replayed transactions with an explicit error so callers can log it
  const verdict = internalizationVerdict(result)
  if (verdict !== 'accepted') {
    return {
      accepted: false,
      reason:
        verdict === 'replay'
          ? `Replayed transaction: txid ${txid} has already been processed`
          : `Wallet rejected transaction: txid ${txid}`
    }
  }

  const claimResult: unknown = await (replayStore ?? defaultReplayStoreFor(wallet)).claim(
    txid,
    replayExpiresAt
  )
  if (typeof claimResult !== 'boolean') {
    throw new TypeError('The payment replay store returned an invalid claim verdict')
  }
  if (!claimResult) {
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
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Payment middleware options are required')
  }
  const {
    wallet,
    calculatePrice,
    paymentWindowMs = DEFAULT_PAYMENT_WINDOW_MS,
    replayStore: configuredReplayStore,
    logger
  } = options
  if (
    wallet === null ||
    typeof wallet !== 'object' ||
    typeof wallet.internalizeAction !== 'function'
  ) {
    throw new TypeError('A valid wallet instance is required')
  }
  if (typeof calculatePrice !== 'function') {
    throw new TypeError('calculatePrice must be a function')
  }
  if (!isPositiveSafeInteger(paymentWindowMs)) {
    throw new RangeError('paymentWindowMs must be a positive safe integer')
  }
  const replayStore = configuredReplayStore ?? defaultReplayStoreFor(wallet)
  if (replayStore === null || typeof replayStore.claim !== 'function') {
    throw new TypeError('A replay store with an atomic claim method is required')
  }
  if (!isPaymentLogger(logger)) {
    throw new TypeError('logger methods must be functions when provided')
  }
  let identityKey = ''

  return async (req: any, res: any, next: any) => {
    if (!identityKey) {
      try {
        const { publicKey } = await wallet.getPublicKey({ identityKey: true })
        if (!isCompressedPublicKey(publicKey)) throw new Error('Invalid wallet identity key')
        identityKey = publicKey
      } catch (error) {
        emitLog(logger, 'error', 'Payment identity initialization failed.', safeErrorContext(error))
        res.status(500).end()
        return
      }
    }

    let price: number | undefined
    try {
      price = calculatePrice(req.path)
    } catch (error) {
      emitLog(logger, 'error', 'Payment pricing failed.', safeErrorContext(error))
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
      result = await validatePayment(req, wallet, price, paymentWindowMs, replayStore)
    } catch (error) {
      // The wallet or replay store may have accepted the transaction before
      // failing. Do not issue a fresh payment challenge after an ambiguous
      // state transition, because that can induce a second spend.
      emitLog(logger, 'error', 'Payment validation failed.', safeErrorContext(error))
      res.status(503).end()
      return
    }
    if (!result) {
      return send402(res, identityKey, price)
    }
    if (result.accepted !== true) {
      emitLog(logger, 'warn', 'Payment rejected.')
      return send402(res, identityKey, price)
    }

    req.payment = result
    emitLog(logger, 'info', 'Payment accepted.', {
      satoshisPaid: result.satoshisPaid,
      txid: result.txid
    })
    next()
  }
}
