/**
 * Injectable knex/wallet for route handlers.
 * Binary entry and mountMessageBoxRoutes call bindMessageBoxRuntime before serving.
 */
import type { Knex } from 'knex'
import type { WalletInterface } from '@bsv/sdk'

/** Bound before serving; routes read knex/wallet from here. */
export const runtimeDeps: {
  knex: Knex
  wallet?: WalletInterface
} = {
  knex: null as unknown as Knex
}

export function bindMessageBoxRuntime (deps: {
  knex: Knex
  wallet?: WalletInterface
}): void {
  runtimeDeps.knex = deps.knex
  runtimeDeps.wallet = deps.wallet
}

export async function getWallet (): Promise<WalletInterface> {
  if (runtimeDeps.wallet == null) {
    throw new Error('Wallet is not initialized')
  }
  return runtimeDeps.wallet
}
