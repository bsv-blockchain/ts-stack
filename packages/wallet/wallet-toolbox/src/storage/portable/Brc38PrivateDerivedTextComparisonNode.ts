import { promiseFromSync } from '../../utility/promiseFromSync'
import { createHash } from 'node:crypto'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import {
  readBrc38NativePackedTextVersionDescriptor,
  readBrc38NativePackedTextVersionDescriptorData,
  readBrc38NativePackedTextVersionExtentData
} from './Brc38NativePackedTextFieldsNode'
import type { Brc38PrivateDerivedTextDescriptor } from './Brc38PrivateDerivedTextVersionNode'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { chargeBrc38ImportDecodedBudget, type Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'

function invalid(): never {
  throw new Error('Private derived TEXT comparison differs from actual sealed bytes or owner')
}

/** Complete bounded byte comparison, independently hashing both actual sealed
 * versions to EOF even when lengths differ. This returns comparison DATA only;
 * final effects must recheck immutable versions and original/current admission.
 * No descriptor digest or producer assertion alone establishes equality. */
export async function compareBrc38PrivateDerivedText(
  store: KnexBrc38StagingStore,
  first: Readonly<Brc38PrivateDerivedTextDescriptor>,
  second: Readonly<Brc38PrivateDerivedTextDescriptor>,
  policy: Readonly<{ expiresAt: number; workingAllocation: Brc38WorkingAllocation; signal?: AbortSignal }>,
  budget: Brc38ImportDecodedBudget
): Promise<boolean> {
  const left = Object.freeze({ bytes: first.bytes, sha256: first.sha256 }),
    right = Object.freeze({ bytes: second.bytes, sha256: second.sha256 }),
    expiresAt = policy.expiresAt,
    signal = policy.signal,
    root = store.knex,
    origin = privateNativeDatabaseIdentity(root),
    working = brc38WorkingAllocation(policy.workingAllocation),
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    origin?.slot !== 0 ||
    working === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > store.operationExpiresAt ||
    budget.signal !== signal ||
    budget.maximum > store.limits.maximumRowAllocationBytes
  )
    invalid()
  for (const descriptor of [left, right])
    if (
      !Number.isSafeInteger(descriptor.bytes) ||
      descriptor.bytes < 2 ||
      descriptor.bytes > 1000000000 ||
      typeof descriptor.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(descriptor.sha256)
    )
      invalid()
  chargeBrc38ImportDecodedBudget(budget, 1048576)
  const reservation = working.claim(1048576)
  let retained: Brc38StagingCleanupError | undefined
  const check = (): void => {
    signal?.throwIfAborted()
    if (
      store.knex !== root ||
      privateNativeDatabaseIdentity(root)?.token !== origin.token ||
      Date.now() >= expiresAt ||
      performance.now() >= deadline
    )
      invalid()
    store.assertPrivateNativeDestination(root)
  }
  const cleanupScope1 = new Brc38CleanupScope(() => {
    return promiseFromSync(() => {
      if (retained !== undefined) {
        const failure = retained
        throw new Brc38StagingCleanupError(
          [failure],
          'Private TEXT comparison retains actual read cleanup',
          async () => {
            await failure.retryCleanup()
            reservation.close()
          }
        )
      }
      reservation.close()
    })
  })
  try {
    return await store.withPrivateNativeDatabase(true, async database => {
      const hashes = [createHash('sha256'), createHash('sha256')],
        descriptors = [left, right]
      let equal = left.bytes === right.bytes
      for (let offset = 0; offset < Math.max(left.bytes, right.bytes); offset += 16384) {
        check()
        await database.transaction(async trx => {
          store.assertPrivateNativeReadTransaction(trx)
          await verifyBrc38AuthenticatedSourceSeal(trx)
          const firstBefore = await readBrc38NativePackedTextVersionDescriptor(trx, left.sha256)
          const bytes: Array<Uint8Array | undefined> = []
          try {
            for (const [index, descriptor] of descriptors.entries()) {
              const actual =
                index === 0 ? firstBefore : await readBrc38NativePackedTextVersionDescriptorData(trx, descriptor.sha256)
              if (actual.bytes !== descriptor.bytes || actual.sha256 !== descriptor.sha256) invalid()
              const length = Math.max(0, Math.min(16384, descriptor.bytes - offset))
              if (length === 0) continue
              const part = await readBrc38NativePackedTextVersionExtentData(
                trx,
                { sha256: descriptor.sha256, totalBytes: descriptor.bytes, offset, length },
                signal
              )
              bytes[index] = part
              if (part.length !== length) invalid()
              hashes[index].update(part)
            }
            if (bytes[0]?.length !== bytes[1]?.length) equal = false
            if (bytes[0] !== undefined && bytes[1] !== undefined)
              for (let index = 0; index < bytes[0].length; index++)
                if (bytes[0][index] !== bytes[1][index]) equal = false
            store.assertPrivateNativeReadTransaction(trx)
            check()
            const lastAfter = await readBrc38NativePackedTextVersionDescriptor(trx, right.sha256)
            if (lastAfter.bytes !== right.bytes || lastAfter.sha256 !== right.sha256) invalid()
            store.assertPrivateNativeReadTransaction(trx)
            check()
          } finally {
            for (const value of bytes) value?.fill(0)
          }
        })
      }
      if (hashes[0].digest('hex') !== left.sha256 || hashes[1].digest('hex') !== right.sha256) invalid()
      check()
      return equal
    })
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) retained = cause
    {
      await cleanupScope1.close()
      throw cause
    }
  } finally {
    await cleanupScope1.close()
  }
}
