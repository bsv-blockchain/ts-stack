import { Beef, createNonce, PublicKey, Utils, verifyNonce, type AtomicBEEF } from '@bsv/sdk'
import type { NextFunction, Response } from 'express'
import type {
  BSVPayment,
  PaymentMiddlewareOptions,
  PaymentReplayStore,
  PaymentRequest
} from './types.js'

const PAYMENT_VERSION = '1.0'
const DEFAULT_MAX_PAYMENT_HEADER_BYTES = 64 * 1024
const DEFAULT_REPLAY_CAPACITY = 100_000
const MAX_NONCE_LENGTH = 512

interface ParsedPayment {
  payment: BSVPayment
  transaction: AtomicBEEF
  transactionId: string
  satoshis: number
}

interface InternalizeResult {
  accepted?: boolean
  isMerge?: boolean
}

export class InMemoryPaymentReplayStore implements PaymentReplayStore {
  private readonly claimed = new Set<string>()

  constructor(private readonly maxEntries: number = DEFAULT_REPLAY_CAPACITY) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError('Replay-store capacity must be a positive safe integer.')
    }
  }

  claim(transactionId: string): boolean {
    if (this.claimed.has(transactionId)) return false
    if (this.claimed.size >= this.maxEntries) {
      throw new Error('Payment replay store capacity exceeded.')
    }
    this.claimed.add(transactionId)
    return true
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function isCanonicalBase64(value: string): boolean {
  if (
    value.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    return false
  }
  try {
    return Utils.toBase64(Utils.toArray(value, 'base64')) === value
  } catch {
    return false
  }
}

function isCompressedPublicKey(value: string): boolean {
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(value)) return false
  try {
    return PublicKey.fromString(value).toString() === value.toLowerCase()
  } catch {
    return false
  }
}

function paymentHeader(req: PaymentRequest): string | null | undefined {
  const value = req.headers['x-bsv-payment']
  if (value === undefined) return undefined
  return typeof value === 'string' ? value : null
}

function parsePaymentHeader(raw: string, maxBytes: number): BSVPayment | undefined {
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.derivationPrefix !== 'string' ||
    typeof record.derivationSuffix !== 'string' ||
    typeof record.transaction !== 'string' ||
    record.derivationPrefix.length > MAX_NONCE_LENGTH ||
    record.derivationSuffix.length > MAX_NONCE_LENGTH ||
    !isCanonicalBase64(record.derivationPrefix) ||
    !isCanonicalBase64(record.derivationSuffix) ||
    !isCanonicalBase64(record.transaction)
  ) {
    return undefined
  }
  return {
    derivationPrefix: record.derivationPrefix,
    derivationSuffix: record.derivationSuffix,
    transaction: record.transaction
  }
}

function parseAtomicPayment(
  payment: BSVPayment,
  requiredSatoshis: number
): ParsedPayment | undefined {
  try {
    const transaction = Utils.toArray(payment.transaction, 'base64') as AtomicBEEF
    const beef = Beef.fromBinary(transaction)
    const transactionId = beef.atomicTxid
    if (typeof transactionId !== 'string') return undefined
    const atomicTransaction = beef.findTxid(transactionId)?.tx
    const satoshis = atomicTransaction?.outputs[0]?.satoshis
    if (typeof satoshis !== 'number' || satoshis < requiredSatoshis) return undefined
    return { payment, transaction, transactionId, satoshis }
  } catch {
    return undefined
  }
}

function sendError(
  res: Response,
  status: number,
  code: string,
  description: string,
  details: Record<string, unknown> = {}
): void {
  res.status(status).json({
    status: 'error',
    code,
    ...details,
    description
  })
}

function safeErrorContext(error: unknown): Record<string, unknown> {
  return error instanceof Error ? { errorName: error.name } : { errorType: typeof error }
}

function isPaymentLogger(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object') return false
  const logger = value as Record<string, unknown>
  return (
    (logger.error === undefined || typeof logger.error === 'function') &&
    (logger.warn === undefined || typeof logger.warn === 'function')
  )
}

/**
 * Creates middleware that enforces a BRC-29 wallet payment after BRC-103 auth.
 */
export function createPaymentMiddleware(
  options: PaymentMiddlewareOptions
): (req: PaymentRequest, res: Response, next: NextFunction) => Promise<void> {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Payment middleware options are required.')
  }

  const {
    calculateRequestPrice = () => 100,
    wallet,
    replayStore = new InMemoryPaymentReplayStore(),
    maxPaymentHeaderBytes = DEFAULT_MAX_PAYMENT_HEADER_BYTES,
    logger
  } = options

  if (typeof calculateRequestPrice !== 'function') {
    throw new TypeError('The calculateRequestPrice option must be a function.')
  }
  if (
    wallet === null ||
    typeof wallet !== 'object' ||
    typeof wallet.internalizeAction !== 'function'
  ) {
    throw new TypeError('A valid wallet instance must be supplied to the payment middleware.')
  }
  if (replayStore === null || typeof replayStore.claim !== 'function') {
    throw new TypeError('A replay store with an atomic claim method is required.')
  }
  if (!Number.isSafeInteger(maxPaymentHeaderBytes) || maxPaymentHeaderBytes < 1) {
    throw new RangeError('maxPaymentHeaderBytes must be a positive safe integer.')
  }
  if (!isPaymentLogger(logger)) {
    throw new TypeError('logger error and warn properties must be functions when provided.')
  }

  return async (req: PaymentRequest, res: Response, next: NextFunction): Promise<void> => {
    const identityKey = req.auth?.identityKey
    if (typeof identityKey !== 'string' || !isCompressedPublicKey(identityKey)) {
      sendError(
        res,
        500,
        'ERR_SERVER_MISCONFIGURED',
        'The payment middleware must run after successful Auth middleware.'
      )
      return
    }

    let requestPrice: number
    try {
      requestPrice = await calculateRequestPrice(req)
    } catch (error) {
      logger?.error?.('Payment pricing failed.', safeErrorContext(error))
      sendError(
        res,
        500,
        'ERR_PAYMENT_INTERNAL',
        'An internal error occurred while determining the payment required for this request.'
      )
      return
    }

    if (requestPrice === 0) {
      req.payment = { satoshisPaid: 0, accepted: true, tx: '', txid: '' }
      next()
      return
    }
    if (!isPositiveSafeInteger(requestPrice)) {
      logger?.error?.('Payment pricing returned an invalid value.', { requestPrice })
      sendError(res, 500, 'ERR_PAYMENT_INTERNAL', 'The configured payment price is invalid.')
      return
    }

    const rawPayment = paymentHeader(req)
    if (rawPayment === undefined) {
      try {
        const derivationPrefix = await createNonce(wallet)
        res
          .status(402)
          .set({
            'x-bsv-payment-version': PAYMENT_VERSION,
            'x-bsv-payment-satoshis-required': String(requestPrice),
            'x-bsv-payment-derivation-prefix': derivationPrefix
          })
          .json({
            status: 'error',
            code: 'ERR_PAYMENT_REQUIRED',
            satoshisRequired: requestPrice,
            description: 'A BSV payment is required. Provide the X-BSV-Payment header.'
          })
      } catch (error) {
        logger?.error?.('Failed to create a payment challenge.', safeErrorContext(error))
        sendError(
          res,
          503,
          'ERR_PAYMENT_UNAVAILABLE',
          'Payment processing is temporarily unavailable.'
        )
      }
      return
    }

    if (rawPayment === null) {
      sendError(res, 400, 'ERR_MALFORMED_PAYMENT', 'The X-BSV-Payment header is malformed.')
      return
    }

    const payment = parsePaymentHeader(rawPayment, maxPaymentHeaderBytes)
    if (payment === undefined) {
      sendError(res, 400, 'ERR_MALFORMED_PAYMENT', 'The X-BSV-Payment header is malformed.')
      return
    }

    let validPrefix = false
    try {
      validPrefix = await verifyNonce(payment.derivationPrefix, wallet)
    } catch (error) {
      logger?.warn?.('Payment derivation-prefix verification failed.', safeErrorContext(error))
    }
    if (!validPrefix) {
      sendError(
        res,
        400,
        'ERR_INVALID_DERIVATION_PREFIX',
        'The payment derivation prefix is invalid.'
      )
      return
    }

    const parsed = parseAtomicPayment(payment, requestPrice)
    if (parsed === undefined) {
      sendError(
        res,
        400,
        'ERR_INVALID_PAYMENT',
        'The payment transaction is invalid or does not cover the required amount.'
      )
      return
    }

    let claimed: boolean
    try {
      const claimResult: unknown = await replayStore.claim(parsed.transactionId)
      if (typeof claimResult !== 'boolean') {
        throw new TypeError('The replay store returned an invalid claim result.')
      }
      claimed = claimResult
    } catch (error) {
      logger?.error?.('Payment replay claim failed.', safeErrorContext(error))
      sendError(
        res,
        503,
        'ERR_PAYMENT_UNAVAILABLE',
        'Payment processing is temporarily unavailable.'
      )
      return
    }
    if (!claimed) {
      sendError(res, 409, 'ERR_PAYMENT_REPLAYED', 'This payment was already used.')
      return
    }

    try {
      const result = (await wallet.internalizeAction({
        tx: parsed.transaction,
        outputs: [
          {
            paymentRemittance: {
              derivationPrefix: payment.derivationPrefix,
              derivationSuffix: payment.derivationSuffix,
              senderIdentityKey: identityKey
            },
            outputIndex: 0,
            protocol: 'wallet payment'
          }
        ],
        description: 'Payment for request'
      })) as InternalizeResult

      if (result.accepted !== true || result.isMerge === true) {
        sendError(res, 409, 'ERR_PAYMENT_REPLAYED', 'This payment was not newly accepted.')
        return
      }

      req.payment = {
        satoshisPaid: parsed.satoshis,
        accepted: true,
        tx: payment.transaction,
        txid: parsed.transactionId
      }
      res.set({
        'x-bsv-payment-satoshis-paid': String(parsed.satoshis)
      })
      next()
    } catch (error) {
      logger?.warn?.('Payment internalization failed.', safeErrorContext(error))
      sendError(res, 400, 'ERR_PAYMENT_FAILED', 'The payment could not be accepted.')
    }
  }
}
