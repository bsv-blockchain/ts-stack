/**
 * Injectable knex/wallet for route handlers.
 * Binary entry and mountMessageBoxRoutes call bindMessageBoxRuntime before serving.
 */
import type { Knex } from 'knex'
import type { WalletInterface } from '@bsv/sdk'

export let knex: Knex
export let wallet: WalletInterface | undefined

export function bindMessageBoxRuntime (deps: {
  knex: Knex
  wallet?: WalletInterface
}): void {
  knex = deps.knex
  wallet = deps.wallet
}

export async function getWallet (): Promise<WalletInterface> {
  if (wallet == null) {
    throw new Error('Wallet is not initialized')
  }
  return wallet
}
