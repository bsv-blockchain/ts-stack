import type { AuthId, TrxToken } from '../sdk/WalletStorage.interfaces'

/** @internal A captured operation's restrictions, never a serialized authority.
 * No SQL transaction or manager ownership is retained between calls. Callers
 * prepare transport/proofs outside transaction(), then commit only SQL work.
 * A supported provider compares its actual durable primary epoch on every
 * transaction, including the final pre-commit check. Older providers retain
 * their existing serialized contract through the default implementation.
 */
export interface StorageActiveWrite {
  /** Scheduling capability only. The actual provider must still validate its
   * original durable epoch in every SQL commit; wire data cannot select this. */
  readonly prepareOutsideManager?: true
  transaction: <T>(scope: (trx: TrxToken) => Promise<T>, trx?: TrxToken) => Promise<T>
  assertCurrent: () => Promise<void>
}

/** @internal Scheduling only; the actual SQL writer supplies authority. */
export type StorageWriterAdmission = <T>(operation: () => Promise<T>) => Promise<T>

/** @internal Optional manager scheduling for bounded monitor SQL scopes. */
export interface StorageStatusReviewArgs {
  agedLimit: Date
  trx?: TrxToken
  admission?: StorageWriterAdmission
}

/** Internal provider CODE only. Choosing scheduling never supplies SQL,
 * financial or SOURCE authority; every actual commit retains its own capture. */
export interface StoragePreparedWalletWriter {
  supportsPreparedWalletWrites: () => Promise<boolean>
  withPreparedWalletWrite: <T>(
    auth: AuthId,
    admission: StorageWriterAdmission,
    operation: () => Promise<T>
  ) => Promise<T>
}
