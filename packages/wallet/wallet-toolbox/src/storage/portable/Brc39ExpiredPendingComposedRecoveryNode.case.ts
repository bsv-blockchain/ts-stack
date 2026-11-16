import { expect } from '@jest/globals'
import { StorageKnex } from '../StorageKnex'
import { WalletStorageManager } from '../WalletStorageManager'
import {
  recoverExpiredPendingBrc39ComposedNativeImport,
  type Brc39ExpiredPendingComposedRecoveryOptions
} from './Brc39ExpiredPendingComposedRecoveryNode'
import { brc38StagingBinding } from './Brc38StagingBinding'
import {
  recoverBrc39ComposedNativeImport,
  type Brc39ComposedNativeRecoveryOptions
} from './Brc39ComposedNativeRecoveryNode'

/** UNRUN all47 fixture integration case. The independent semantic oracle must
 * inspect all wallet/runtime/history/custody fields from the actual manager,
 * including BLOB/TEXT/structured bytes, IDs, primary, provenance and clocks.
 * It must not compute expected output from this controller or its READY hash.
 * Fixture wiring across every interrupted backend phase remains required. */
export async function brc39ExpiredPendingComposedRecoveryCase(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  options: Brc39ExpiredPendingComposedRecoveryOptions,
  independentOracle: (manager: WalletStorageManager) => Promise<void>
): Promise<WalletStorageManager> {
  const originalLimits = { ...options.source.limits },
    originalBinding = brc38StagingBinding(options.source.binding, originalLimits),
    temporary = options.recovery.temporaryQuota.used,
    working = options.merge.workingAllocation.used,
    oldRoot = options.originalManager === undefined ? undefined : options.originalManager.manager,
    result = await recoverExpiredPendingBrc39ComposedNativeImport(encrypted, password, options)
  expect(result.importId).toBe(options.targetImportId)
  expect(result.originalReservationId).toBe(options.source.reservationId)
  expect(result.archiveSha256).toBe(options.source.binding.archiveSha256)
  expect(result.manager.isActiveEnabled).toBe(true)
  expect(result.manager.getActive()).toBeInstanceOf(StorageKnex)
  expect(result.manager.getActiveStore()).toBe(options.source.binding.targetStorageIdentityKey)
  if (oldRoot !== undefined) expect(result.manager).toBe(oldRoot)
  expect(options.source.limits).toEqual(originalLimits)
  expect(brc38StagingBinding(options.source.binding, options.source.limits)).toEqual(originalBinding)
  expect(options.recovery.temporaryQuota.used).toBe(temporary)
  expect(options.merge.workingAllocation.used).toBe(working)
  await independentOracle(result.manager)
  // A caller-supplied manager lookalike never becomes a source/target owner.
  expect(() => WalletStorageManager.prototype.getActive.call({ ...result.manager })).toThrow()
  return result.manager
}

/** Actual process-recovery integration: finish the named pending target, make
 * a real customer write, physically close that target, then recover the lost
 * final ACK as completed-current without consuming another envelope. The two
 * independent full47 oracles must be authored before either operation. */
export async function brc39NamedComposedRecoveryAndCurrentRestartCase(
  encrypted: AsyncIterable<Uint8Array>,
  password: string,
  options: Brc39ComposedNativeRecoveryOptions,
  expectedPending: 'LIVE_PENDING' | 'EXPIRED_PENDING',
  independentImportedOracle: (manager: WalletStorageManager) => Promise<void>,
  customerWrite: (manager: WalletStorageManager) => Promise<void>,
  independentWrittenOracle: (manager: WalletStorageManager) => Promise<void>
): Promise<WalletStorageManager> {
  const binding = brc38StagingBinding(options.source.binding, options.source.limits),
    temporary = options.recovery.temporaryQuota.used,
    working = options.merge.workingAllocation.used,
    recovered = await recoverBrc39ComposedNativeImport(encrypted, password, options)
  expect(recovered.recovered).toBe(expectedPending)
  expect(recovered.importId).toBe(options.targetImportId)
  expect(recovered.manager.isActiveEnabled).toBe(true)
  await independentImportedOracle(recovered.manager)
  await customerWrite(recovered.manager)
  await independentWrittenOracle(recovered.manager)
  await options.targetInventory.closeNamedRecoveryManager(options.targetImportId, binding.digest, recovered.manager)
  let inputTouched = false
  const noReplay: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      inputTouched = true
      throw new Error('Completed-current restart must preserve writes without replaying the old import')
    }
  }
  const current = await recoverBrc39ComposedNativeImport(noReplay, '', options)
  expect(current.recovered).toBe('COMPLETED_CURRENT')
  expect(current.manager).not.toBe(recovered.manager)
  expect(current.manager.getActiveStore()).toBe(options.source.binding.targetStorageIdentityKey)
  expect(inputTouched).toBe(false)
  await independentWrittenOracle(current.manager)
  expect(options.recovery.temporaryQuota.used).toBe(temporary)
  expect(options.merge.workingAllocation.used).toBe(working)
  expect(brc38StagingBinding(options.source.binding, options.source.limits)).toEqual(binding)
  return current.manager
}
