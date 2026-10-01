import type { Knex } from 'knex'
import type { AsyncSessionManager, AtomicBEEF, SessionManager, WalletInterface } from '@bsv/sdk'
import type { Request } from 'express'
import { createLiveDelivery, type LiveDelivery } from './security/liveDelivery.js'
import type { TransactionalPaymentReplayStore } from './security/TransactionalPaymentReplayStore.js'

export interface MessageBoxContext {
  wallet: WalletInterface
  knex: Knex
  routingPrefix: string
  enableWebSockets: boolean
  enableSwagger: boolean
  calculateRequestPrice: (req: Request) => Promise<number> | number
  sessionManager?: SessionManager | AsyncSessionManager
  paymentReplayStore?: TransactionalPaymentReplayStore
  paymentTransactionVerifier?: (tx: AtomicBEEF) => Promise<boolean>
  logger: Console
  /** Shared with the HTTP routes so an HTTP send can notify joined sockets. */
  liveDelivery: LiveDelivery
}

export interface CreateMessageBoxContextOptions {
  wallet: WalletInterface
  knex: Knex
  routingPrefix?: string
  enableWebSockets?: boolean
  enableSwagger?: boolean
  calculateRequestPrice?: (req: Request) => Promise<number> | number
  sessionManager?: SessionManager | AsyncSessionManager
  paymentReplayStore?: TransactionalPaymentReplayStore
  paymentTransactionVerifier?: (tx: AtomicBEEF) => Promise<boolean>
  logger?: Console
  liveDelivery?: LiveDelivery
}

export function createMessageBoxContext(deps: CreateMessageBoxContextOptions): MessageBoxContext {
  if (deps.wallet == null) {
    throw new Error('createMessageBoxContext requires a wallet')
  }
  if (deps.knex == null) {
    throw new Error('createMessageBoxContext requires a knex instance')
  }

  return {
    wallet: deps.wallet,
    knex: deps.knex,
    routingPrefix: deps.routingPrefix ?? '',
    enableWebSockets: deps.enableWebSockets ?? true,
    enableSwagger: deps.enableSwagger ?? true,
    calculateRequestPrice:
      deps.calculateRequestPrice ??
      (async (req: Request) => {
        if (req.url.includes('/sendMessage')) {
          // configurable via deps.calculateRequestPrice
        }
        return 0
      }),
    sessionManager: deps.sessionManager,
    paymentReplayStore: deps.paymentReplayStore,
    paymentTransactionVerifier: deps.paymentTransactionVerifier,
    logger: deps.logger ?? console,
    liveDelivery: deps.liveDelivery ?? createLiveDelivery()
  }
}
