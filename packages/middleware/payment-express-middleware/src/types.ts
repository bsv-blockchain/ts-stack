import type { WalletInterface } from '@bsv/sdk'
import type { Request } from 'express'

export interface PaymentReceipt {
  satoshisPaid: number
  accepted: true
  tx: string
  txid: string
}

export interface PaymentRequest extends Request {
  auth?: {
    identityKey?: unknown
  }
  payment?: PaymentReceipt
}

/**
 * Replay claims must be atomic. Return false when the transaction ID has
 * already been claimed. Shared deployments should use a durable implementation.
 */
export interface PaymentReplayStore {
  claim: (transactionId: string) => boolean | Promise<boolean>
}

export interface PaymentLogger {
  error?: (message: string, context?: Record<string, unknown>) => void
  warn?: (message: string, context?: Record<string, unknown>) => void
}

export interface PaymentMiddlewareOptions {
  calculateRequestPrice?: (req: PaymentRequest) => number | Promise<number>
  wallet: WalletInterface
  replayStore?: PaymentReplayStore
  maxPaymentHeaderBytes?: number
  logger?: PaymentLogger
}

export interface BSVPayment {
  derivationPrefix: string
  derivationSuffix: string
  transaction: string
}
