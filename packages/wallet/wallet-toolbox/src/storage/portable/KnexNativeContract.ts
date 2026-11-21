import type { Knex } from 'knex'

/** The three consumed Knex 3.3 internal client hooks, not the public transactor.
 * Structural types carry no connection, profile or transaction authority. */
export interface NativeTransactionOwner {
  isCompleted(): boolean
  _onAcquire(container: (transaction: Knex.Transaction) => unknown, connection: object): Promise<unknown>
}
export interface NativeRuntimeClient {
  readonly nativeSlot?: number
  transaction(
    container: (transaction: Knex.Transaction) => unknown,
    config?: Knex.TransactionConfig,
    outerTransaction?: { isCompleted(): boolean }
  ): NativeTransactionOwner
  acquireRawConnection(): Promise<object>
  destroyRawConnection(connection: object): Promise<void>
}
export type NativeRuntimeClientConstructor = new (config: Knex.Config) => NativeRuntimeClient
export interface NativeRuntimeConfig {
  client: NativeRuntimeClientConstructor
  connection: { filename: string }
  useNullAsDefault: boolean
  pool: { min: number; max: number }
  acquireConnectionTimeout: number
}
export type NativeRuntimeFactory = (config: NativeRuntimeConfig) => Knex
