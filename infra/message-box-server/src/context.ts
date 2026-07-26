import type { Knex } from 'knex'
import type { WalletInterface } from '@bsv/sdk'
import type { Request } from 'express'

export interface MessageBoxContext {
  wallet: WalletInterface
  knex: Knex
  routingPrefix: string
  enableWebSockets: boolean
  enableSwagger: boolean
  calculateRequestPrice: (req: Request) => Promise<number> | number
  logger: Console
}

export interface CreateMessageBoxContextOptions {
  wallet: WalletInterface
  knex: Knex
  routingPrefix?: string
  enableWebSockets?: boolean
  enableSwagger?: boolean
  calculateRequestPrice?: (req: Request) => Promise<number> | number
  logger?: Console
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
    logger: deps.logger ?? console
  }
}
