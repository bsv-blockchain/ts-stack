/**
 * Injectable knex/wallet for route handlers.
 * Binary entry and embed hosts call bindMessageBoxRuntime before serving.
 */
import type { Knex } from 'knex'
import type { AtomicBEEF, WalletInterface } from '@bsv/sdk'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { TransactionalPaymentReplayStore } from './security/TransactionalPaymentReplayStore.js'

export interface MessageBoxRuntimeDeps {
  knex: Knex
  wallet?: WalletInterface
  paymentReplayStore?: TransactionalPaymentReplayStore
  paymentTransactionVerifier?: (tx: AtomicBEEF) => Promise<boolean>
}

/** Bound before serving; routes read knex/wallet from here. */
const fallbackRuntime: MessageBoxRuntimeDeps = {
  knex: null as unknown as Knex
}
const requestRuntime = new AsyncLocalStorage<MessageBoxRuntimeDeps>()

function activeRuntime(): MessageBoxRuntimeDeps {
  return requestRuntime.getStore() ?? fallbackRuntime
}

export const runtimeDeps: MessageBoxRuntimeDeps = {
  get knex() {
    return activeRuntime().knex
  },
  set knex(value: Knex) {
    fallbackRuntime.knex = value
  },
  get wallet() {
    return activeRuntime().wallet
  },
  set wallet(value: WalletInterface | undefined) {
    fallbackRuntime.wallet = value
  },
  get paymentReplayStore() {
    return activeRuntime().paymentReplayStore
  },
  set paymentReplayStore(value: TransactionalPaymentReplayStore | undefined) {
    fallbackRuntime.paymentReplayStore = value
  },
  get paymentTransactionVerifier() {
    return activeRuntime().paymentTransactionVerifier
  },
  set paymentTransactionVerifier(value: ((tx: AtomicBEEF) => Promise<boolean>) | undefined) {
    fallbackRuntime.paymentTransactionVerifier = value
  }
}

export function bindMessageBoxRuntime(deps: MessageBoxRuntimeDeps): void {
  fallbackRuntime.knex = deps.knex
  fallbackRuntime.wallet = deps.wallet
  fallbackRuntime.paymentReplayStore = deps.paymentReplayStore
  fallbackRuntime.paymentTransactionVerifier = deps.paymentTransactionVerifier
}

/** Capture the legacy bound runtime so one composed router cannot be rebound by another. */
export function snapshotBoundMessageBoxRuntime(): MessageBoxRuntimeDeps {
  return {
    knex: fallbackRuntime.knex,
    wallet: fallbackRuntime.wallet,
    paymentReplayStore: fallbackRuntime.paymentReplayStore,
    paymentTransactionVerifier: fallbackRuntime.paymentTransactionVerifier
  }
}

export function runWithMessageBoxRuntime<T>(deps: MessageBoxRuntimeDeps, callback: () => T): T {
  return requestRuntime.run(deps, callback)
}

export async function getWallet(): Promise<WalletInterface> {
  if (runtimeDeps.wallet == null) {
    throw new Error('Wallet is not initialized')
  }
  return runtimeDeps.wallet
}
