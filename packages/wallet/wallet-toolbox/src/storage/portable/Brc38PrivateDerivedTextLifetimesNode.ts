import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { Brc38NativePreparedFieldLifetime } from './Brc38NativePreparedFieldsNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'

const issuer = Object.freeze({})
function invalid(): never {
  throw new Error('Private derived TEXT lifetime differs from its actual owner, scope or original resources')
}

/** Actual lifetime ownership only, never content/source/semantic/row admission.
 * Persisted holds protect staged versions through comparison and the final
 * writer. Releasing an unreferenced version queues ordinary finite collection;
 * a committed row pointer keeps its version. The original expiry is immutable. */
export class Brc38PrivateDerivedTextLifetimes {
  readonly #token: object
  readonly #holds = new Map<string, Brc38NativePreparedFieldLifetime>()
  readonly #io = new Brc38OwnedImportReads()
  readonly #deadline: number
  readonly #expiresAt: number
  #closed = false
  private constructor(
    token: object,
    private readonly store: KnexBrc38StagingStore,
    expiresAt: number,
    private readonly working: Brc38WorkingAllocation,
    private readonly reservation: Brc38WorkingCharge,
    private readonly signal?: AbortSignal
  ) {
    if (token !== issuer) invalid()
    const origin = privateNativeDatabaseIdentity(store.knex)
    if (
      origin?.slot !== 0 ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > store.operationExpiresAt ||
      working.maximum > store.limits.maximumRowAllocationBytes
    )
      invalid()
    this.#token = origin.token
    this.#expiresAt = expiresAt
    this.#deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  }
  static async with<T>(
    store: KnexBrc38StagingStore,
    policy: Readonly<{ expiresAt: number; workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>,
    work: (lifetimes: Brc38PrivateDerivedTextLifetimes) => Promise<T>
  ): Promise<T> {
    const working = brc38WorkingAllocation(policy.workingAllocation)
    if (working === undefined) invalid()
    store.assertPrivateNativeDestination(store.knex)
    const reservation = working.claim(4096)
    let lifetimes: Brc38PrivateDerivedTextLifetimes
    try {
      lifetimes = new Brc38PrivateDerivedTextLifetimes(
        issuer,
        store,
        policy.expiresAt,
        working,
        reservation,
        policy.signal
      )
    } catch (cause) {
      reservation.close()
      throw cause
    }
    let result!: T,
      failed = false,
      failure: unknown
    try {
      result = await work(lifetimes)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await lifetimes.#io.finish()
    } catch (cause) {
      if (failed && cause !== failure)
        failure = new AggregateError(
          [failure, cause],
          'Private derived TEXT callback and retained lifetime operation failed'
        )
      else {
        failed = true
        failure = cause
      }
    }
    try {
      await lifetimes.close()
    } catch (cause) {
      throw new Brc38StagingCleanupError(
        failed ? [failure, cause] : [cause],
        'Private derived TEXT retains actual persisted holds and working metadata',
        async () => {
          await lifetimes.close()
        }
      )
    }
    if (failed) throw failure
    return result
  }
  assert(store: KnexBrc38StagingStore, working: Brc38WorkingAllocation, expiresAt: number, signal?: AbortSignal): void {
    this.signal?.throwIfAborted()
    if (
      this.#closed ||
      store !== this.store ||
      working !== this.working ||
      expiresAt !== this.#expiresAt ||
      signal !== this.signal ||
      privateNativeDatabaseIdentity(store.knex)?.token !== this.#token ||
      Date.now() >= expiresAt ||
      performance.now() >= this.#deadline
    )
      invalid()
    store.assertPrivateNativeDestination(store.knex)
  }
  assertOwner(store: KnexBrc38StagingStore, expiresAt: number, signal?: AbortSignal): void {
    this.assert(store, this.working, expiresAt, signal)
  }
  retain(
    trx: Knex.Transaction,
    sha256: string,
    budget: Brc38ImportDecodedBudget,
    family: 'text' | 'binary' = 'text'
  ): Promise<void> {
    return this.#io.run(async () => {
      this.assert(this.store, this.working, this.#expiresAt, this.signal)
      this.store.assertPrivateNativeWriteTransaction(trx)
      if (
        privateNativeTransactionIdentity(trx)?.token !== this.#token ||
        budget.signal !== this.signal ||
        budget.maximum > this.store.limits.maximumRowAllocationBytes ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        (family !== 'text' && family !== 'binary')
      )
        invalid()
      const key = family + ':' + sha256,
        prior = this.#holds.get(key)
      if (prior !== undefined) {
        await prior.check(trx, this.signal)
        return
      }
      if (this.#holds.size >= 256) invalid()
      chargeBrc38ImportDecodedBudget(budget, 4096)
      this.reservation.resize(4096 + 4096 * (this.#holds.size + 1))
      await verifyBrc38AuthenticatedSourceSeal(trx)
      this.#holds.set(
        key,
        await Brc38NativePreparedFieldLifetime.begin(trx, family, sha256, this.#expiresAt, this.signal)
      )
    })
  }
  /** Discard this owner's obsolete comparison holds after selecting the next
   * finite set of versions. Capture coordinates before queuing I/O. A digest
   * identifies content DATA, never permission to release another owner's hold.
   * Delete in short original-root writers and forget a hold only after commit.
   * On rollback or lost acknowledgement close() can retry the same exact hold;
   * a released instance cannot subsequently be checked or used as a lease.
   * Collection is separate and must freshly check actual pointers/other holds. */
  releaseExcept(selected: readonly Readonly<{ family: 'text' | 'binary'; sha256: string }>[]): Promise<void> {
    this.assert(this.store, this.working, this.#expiresAt, this.signal)
    if (!Array.isArray(selected) || selected.length > 16) invalid()
    const keep = new Set<string>()
    for (const coordinate of selected) {
      if (
        coordinate === undefined ||
        (coordinate.family !== 'text' && coordinate.family !== 'binary') ||
        typeof coordinate.sha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(coordinate.sha256)
      )
        invalid()
      keep.add(coordinate.family + ':' + coordinate.sha256)
    }
    return this.#io.run(async () => {
      this.assert(this.store, this.working, this.#expiresAt, this.signal)
      for (const key of keep) if (!this.#holds.has(key)) invalid()
      for (;;) {
        const group = [...this.#holds.entries()].filter(([key]) => !keep.has(key)).slice(0, 32)
        if (group.length === 0) return
        await this.store.withPrivateNativeDatabase(
          false,
          async database =>
            await database.transaction(async trx => {
              this.assert(this.store, this.working, this.#expiresAt, this.signal)
              this.store.assertPrivateNativeWriteTransaction(trx)
              if (privateNativeTransactionIdentity(trx)?.token !== this.#token) invalid()
              await verifyBrc38AuthenticatedSourceSeal(trx)
              for (const [, lifetime] of group) await lifetime.release(trx)
              this.store.assertPrivateNativeWriteTransaction(trx)
            })
        )
        for (const [key] of group) this.#holds.delete(key)
        this.reservation.resize(4096 + 4096 * this.#holds.size)
        this.assert(this.store, this.working, this.#expiresAt, this.signal)
      }
    })
  }
  private async close(): Promise<void> {
    this.#closed = true
    // Cleanup is owned by the original actual root and ignores cancellation;
    // source expiry cannot be renewed or grant another producer's lease.
    while (this.#holds.size !== 0) {
      const group = [...this.#holds.entries()].slice(0, 32)
      try {
        await this.store.withPrivateNativeDatabase(
          false,
          async database =>
            await database.transaction(async trx => {
              if (
                privateNativeTransactionIdentity(trx)?.slot !== 0 ||
                privateNativeTransactionIdentity(trx)?.token !== this.#token
              )
                invalid()
              for (const [, lifetime] of group) await lifetime.release(trx)
            })
        )
      } catch (cause) {
        if (cause instanceof Brc38StagingCleanupError) throw cause
        // Recovery copies and expired original stages cannot use another SQL
        // lease. Their persisted data remains charged. Release JS metadata
        // only after the SAME actual SQL/kernel owner drains, never on expiry
        // alone and never by renewing an operation or deleting foreign holds.
        const release = (): void => {
          this.#holds.clear()
          this.reservation.close()
        }
        if (this.store.deferRecoveryPhysicalRelease(release) || this.store.deferExpiredPrivatePhysicalRelease(release))
          return
        throw cause
      }
      for (const [sha256] of group) this.#holds.delete(sha256)
      this.reservation.resize(4096 + 4096 * this.#holds.size)
    }
    this.reservation.close()
  }
}
