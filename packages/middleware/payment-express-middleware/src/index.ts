import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import { Beef, createNonce, PublicKey, verifyNonce, type AtomicBEEF } from '@bsv/sdk'
import type { RequestHandler, Response } from 'express'
import type {
  BSVPayment,
  PaymentMiddlewareOptions,
  PaymentReplayStore,
  PaymentRequest
} from './types.js'

const PAYMENT_VERSION = '1.0'
const DEFAULT_REPLAY_CAPACITY = 100_000

interface ParsedPayment {
  payment: BSVPayment
  transaction: AtomicBEEF
  transactionId: string
  satoshis: number
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
    return toBase64(toArray(value, 'base64')) === value
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

function parsePaymentHeader(raw: string): BSVPayment | undefined {
  // The HTTP server and edge own transport budgets. A payment that has already
  // arrived must be validated, not discarded by a second header-size policy.
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
    const suppliedTransaction = toArray(payment.transaction, 'base64') as AtomicBEEF
    const suppliedBeef = Beef.fromBinaryStrict(suppliedTransaction)
    const transactionId = suppliedBeef.atomicTxid
    if (typeof transactionId !== 'string') return undefined
    // Historical Atomic BEEF writers could retain unrelated branches after
    // the subject prefix. Give the wallet and downstream receipt only the
    // declared payment transaction and its dependency closure.
    const transaction = suppliedBeef.toBinaryAtomic(transactionId) as AtomicBEEF
    const beef = Beef.fromBinaryStrict(transaction)
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
  try {
    return error instanceof Error ? { errorName: 'Error' } : { errorType: typeof error }
  } catch {
    return { errorType: 'unknown' }
  }
}

function emitLog(
  logger: PaymentMiddlewareOptions['logger'],
  level: 'error' | 'warn',
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

function isNewlyAcceptedInternalization(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  const accepted = Object.getOwnPropertyDescriptor(result, 'accepted')
  if (accepted === undefined || !Object.hasOwn(accepted, 'value') || accepted.value !== true) {
    return false
  }
  const isMerge = Object.getOwnPropertyDescriptor(result, 'isMerge')
  if (isMerge === undefined) return true
  return Object.hasOwn(isMerge, 'value') && isMerge.value === false
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

async function issuePaymentChallenge(
  wallet: PaymentMiddlewareOptions['wallet'],
  res: Response,
  requestPrice: number,
  logger: PaymentMiddlewareOptions['logger']
): Promise<void> {
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
    emitLog(logger, 'error', 'Failed to create a payment challenge.', safeErrorContext(error))
    sendError(res, 503, 'ERR_PAYMENT_UNAVAILABLE', 'Payment processing is temporarily unavailable.')
  }
}

/**
 * Creates middleware that enforces a BRC-29 wallet payment after BRC-103 auth.
 */
export function createPaymentMiddleware(options: PaymentMiddlewareOptions): RequestHandler {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Payment middleware options are required.')
  }

  const {
    calculateRequestPrice = () => 100,
    wallet,
    replayStore = new InMemoryPaymentReplayStore(),
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
  if (!isPaymentLogger(logger)) {
    throw new TypeError('logger error and warn properties must be functions when provided.')
  }

  return async (req, res, next): Promise<void> => {
    const paymentRequest: PaymentRequest = req
    const identityKey = paymentRequest.auth?.identityKey
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
      requestPrice = await calculateRequestPrice(paymentRequest)
    } catch (error) {
      emitLog(logger, 'error', 'Payment pricing failed.', safeErrorContext(error))
      sendError(
        res,
        500,
        'ERR_PAYMENT_INTERNAL',
        'An internal error occurred while determining the payment required for this request.'
      )
      return
    }

    if (requestPrice === 0) {
      paymentRequest.payment = { satoshisPaid: 0, accepted: true, tx: '', txid: '' }
      next()
      return
    }
    if (!isPositiveSafeInteger(requestPrice)) {
      emitLog(logger, 'error', 'Payment pricing returned an invalid value.', { requestPrice })
      sendError(res, 500, 'ERR_PAYMENT_INTERNAL', 'The configured payment price is invalid.')
      return
    }

    const rawPayment = paymentHeader(paymentRequest)
    if (rawPayment === undefined) {
      await issuePaymentChallenge(wallet, res, requestPrice, logger)
      return
    }

    if (rawPayment === null) {
      sendError(res, 400, 'ERR_MALFORMED_PAYMENT', 'The X-BSV-Payment header is malformed.')
      return
    }

    const payment = parsePaymentHeader(rawPayment)
    if (payment === undefined) {
      sendError(res, 400, 'ERR_MALFORMED_PAYMENT', 'The X-BSV-Payment header is malformed.')
      return
    }

    let validPrefix = false
    try {
      validPrefix = await verifyNonce(payment.derivationPrefix, wallet)
    } catch (error) {
      emitLog(
        logger,
        'warn',
        'Payment derivation-prefix verification failed.',
        safeErrorContext(error)
      )
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

    try {
      const result: unknown = await wallet.internalizeAction({
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
      })

      if (!isNewlyAcceptedInternalization(result)) {
        sendError(res, 409, 'ERR_PAYMENT_REPLAYED', 'This payment was not newly accepted.')
        return
      }

      // The wallet is the authority that validates the remittance and records
      // whether it was newly accepted. Claim only after that validation so an
      // attacker cannot poison a transaction ID by pairing a public BEEF with
      // invalid derivation material. A buggy wallet that accepts a duplicate is
      // still contained by the independent atomic replay store.
      let claimed: boolean
      try {
        const claimResult: unknown = await replayStore.claim(parsed.transactionId)
        if (typeof claimResult !== 'boolean') {
          throw new TypeError('The replay store returned an invalid claim result.')
        }
        claimed = claimResult
      } catch (error) {
        emitLog(logger, 'error', 'Payment replay claim failed.', safeErrorContext(error))
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

      paymentRequest.payment = {
        satoshisPaid: parsed.satoshis,
        accepted: true,
        tx: toBase64(parsed.transaction),
        txid: parsed.transactionId
      }
      res.set({
        'x-bsv-payment-satoshis-paid': String(parsed.satoshis)
      })
      next()
    } catch (error) {
      emitLog(logger, 'warn', 'Payment internalization failed.', safeErrorContext(error))
      sendError(res, 400, 'ERR_PAYMENT_FAILED', 'The payment could not be accepted.')
    }
  }
}
