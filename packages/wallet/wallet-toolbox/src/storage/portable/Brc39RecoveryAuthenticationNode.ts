import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import {
  copyBrc38AuthenticatedPrivateStageOptions,
  stageAuthenticatedBrc39PrivateImport,
  type Brc38AuthenticatedPrivateStageOptions
} from './Brc38AuthenticatedPrivateStageNode'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { brc38StagingBinding, type Brc38StagingBoundMetadata } from './Brc38StagingBinding'
import { Brc38NativeRecoveryTemporaryQuota } from './Brc38NativeRecoveryScratchNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

const issuer = Object.freeze({}),
  actualSources = new WeakSet<Brc39RecoveryAuthenticationNode>()
export interface Brc39RecoveryAuthenticationOptions {
  /** The original expired packet is comparison DATA, never renewed/resumed. */
  readonly original: Brc38AuthenticatedPrivateStageOptions
  readonly admission: Brc38StagingAdmissionNode
  readonly temporaryQuota: Brc38NativeRecoveryTemporaryQuota
  readonly expiresAt: number
  readonly executable: string
  /** Cancellation of this NEW purpose; absent retains the original caller signal. */
  readonly signal?: AbortSignal
}

/** A fresh complete BRC39 envelope/grammar/semantic validation in a NEW charged
 * private source reservation. Its expiry and digest belong to this new purpose;
 * original bindings and limits remain immutable comparison data. This scope
 * permits no candidate publication or source/target activation. The enclosing
 * pending recovery still must independently compare every incoming field with
 * the permanent copy and reconstruct all retired local semantics. */
export class Brc39RecoveryAuthenticationNode {
  #live = true
  private constructor(
    token: object,
    readonly original: Readonly<Brc38StagingBoundMetadata>,
    readonly store: KnexBrc38StagingStore,
    readonly reservationId: string,
    readonly expiresAt: number,
    readonly deadline: number,
    readonly signal: AbortSignal
  ) {
    if (token !== issuer) throw new Error('BRC39 recovery authentication requires its actual factory')
    actualSources.add(this)
    Object.freeze(this)
  }
  assertRetained(): void {
    this.signal.throwIfAborted()
    if (
      !actualSources.has(this) ||
      !this.#live ||
      Date.now() >= this.expiresAt ||
      performance.now() >= this.deadline ||
      this.store.binding?.bindingJson !== this.original.bindingJson ||
      this.store.limits.expiresAt !== this.expiresAt ||
      this.store.binding.digest === this.original.digest
    )
      throw new Error('Fresh recovery authentication source is unavailable or changed')
    this.store.assertPrivateNativeDestination(this.store.knex)
  }
  async withSource<T>(work: (store: KnexBrc38StagingStore) => Promise<T>): Promise<T> {
    this.assertRetained()
    await this.store.requirePrivateNativeComparison()
    const value = await this.store.withAuthenticatedPrivateStructuredDestination(async () => {
      this.assertRetained()
      const result = await work(this.store)
      this.assertRetained()
      return result
    })
    await this.store.requirePrivateNativeComparison()
    this.assertRetained()
    return value
  }
  static async with<T>(
    encrypted: AsyncIterable<Uint8Array>,
    password: string,
    selected: Brc39RecoveryAuthenticationOptions,
    work: (source: Brc39RecoveryAuthenticationNode) => Promise<T>
  ): Promise<T> {
    const original = copyBrc38AuthenticatedPrivateStageOptions(selected.original),
      admission = selected.admission,
      temporaryQuota = selected.temporaryQuota,
      executable = selected.executable,
      expiresAt = selected.expiresAt,
      suppliedSignal = selected.signal,
      deadline = performance.now() + Math.max(0, expiresAt - Date.now()),
      originalBound = brc38StagingBinding(original.binding, original.limits)
    if (
      !Number.isSafeInteger(original.limits.expiresAt) ||
      original.limits.expiresAt < 1 ||
      Date.now() < original.limits.expiresAt ||
      original.reservationId === undefined ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(original.reservationId) ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + 3600000 ||
      original.streamedFields === undefined ||
      original.streamedTextFields === undefined ||
      original.streamedStructuredFields === undefined ||
      !(temporaryQuota instanceof Brc38NativeRecoveryTemporaryQuota) ||
      typeof executable !== 'string' ||
      executable.length < 1 ||
      typeof work !== 'function'
    )
      throw new Error('Fresh recovery authentication requires an expired original and a new finite purpose')
    const freshLimits = Object.freeze({ ...original.limits, expiresAt }),
      lifetime = new AbortController(),
      signal =
        (suppliedSignal ?? original.crypto.signal) === undefined
          ? lifetime.signal
          : AbortSignal.any([(suppliedSignal ?? original.crypto.signal)!, lifetime.signal]),
      fresh = Object.freeze({
        ...original,
        reservationId: undefined,
        limits: freshLimits,
        crypto: Object.freeze({ ...original.crypto, signal }),
        streamedStructuredFields: Object.freeze({
          fields: original.streamedStructuredFields.fields,
          staging: Object.freeze({ ...original.streamedStructuredFields.staging, signal })
        })
      }),
      check = (): void => {
        signal?.throwIfAborted()
        if (Date.now() >= expiresAt || performance.now() >= deadline)
          throw new Error('Fresh recovery authentication lifetime expired')
      }
    check()
    const charge = Brc38NativeRecoveryTemporaryQuota.prototype.claim.call(
      temporaryQuota,
      freshLimits.maximumPhysicalBytes
    )
    const expiry = setTimeout(
      () => lifetime.abort(new Error('Fresh recovery authentication monotonic lifetime expired')),
      Math.max(1, Math.ceil(deadline - performance.now()))
    )
    let reservation: Brc38StagingReservation | undefined,
      source: Brc39RecoveryAuthenticationNode | undefined,
      earlierCleanup: Brc38StagingCleanupError | undefined
    const cleanup = async (): Promise<void> => {
      await earlierCleanup?.retryCleanup()
      if (reservation !== undefined) {
        await reservation.store.close()
        await Brc38StagingAdmissionNode.prototype.discardReleased.call(admission, reservation)
      }
      charge.close()
    }
    try {
      const authenticated = await stageAuthenticatedBrc39PrivateImport(encrypted, password, admission, fresh)
      reservation = authenticated.reservation
      if (
        reservation.id === original.reservationId ||
        authenticated.archiveSha256 !== originalBound.binding.archiveSha256 ||
        reservation.store.binding?.bindingJson !== originalBound.bindingJson ||
        reservation.store.binding.digest === originalBound.digest
      )
        throw new Error('Recovery authentication did not create its distinct original-envelope reservation')
      check()
      await reservation.store.close()
      check()
      reservation = await Brc38StagingAdmissionNode.prototype.resumeNative.call(
        admission,
        reservation.id,
        freshLimits,
        originalBound.binding,
        executable
      )
      check()
      await reservation.store.beginPrivateNativeComparison()
      source = new Brc39RecoveryAuthenticationNode(
        issuer,
        originalBound,
        reservation.store,
        reservation.id,
        expiresAt,
        deadline,
        signal
      )
      source.assertRetained()
      const value = await work(source)
      source.assertRetained()
      check()
      source.#live = false
      await cleanup()
      return value
    } catch (cause) {
      if (source !== undefined) source.#live = false
      if (cause instanceof Brc38StagingCleanupError) earlierCleanup = cause
      try {
        await cleanup()
      } catch (error_) {
        throw new Brc38StagingCleanupError(
          [cause, error_],
          'New recovery authentication retains source cleanup and capacity',
          cleanup
        )
      }
      throw cause
    } finally {
      clearTimeout(expiry)
    }
  }
}
