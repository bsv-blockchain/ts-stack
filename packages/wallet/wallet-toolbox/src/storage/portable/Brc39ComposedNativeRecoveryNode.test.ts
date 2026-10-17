import { nativeTestExecutable } from './Brc38NativeTestPath'
import { brc38ImportRequestIdentity, snapshotSyncRequestMetadata } from '../snapshot/SnapshotSyncRequestMetadata'
import { readNativeSnapshotSyncRequestCurrent } from '../snapshot/NativeSnapshotSyncRequestsCurrentNode'
import { createSyncMap } from '../schema/entities/EntityBase'
import { readBrc38NativeCurrentFieldTargets } from './Brc38ImportExistingRows'
import { writeNativeSnapshotSyncRow } from '../snapshot/writeNativeSnapshotSyncRowNode'
import * as occupiedHistoryText from './Brc38PrivateOccupiedHistoryTextNode'
import { withBrc38PrivateOccupiedHistory, type Brc38PrivateOccupiedHistory } from './Brc38PrivateOccupiedHistoryNode'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import type { TableProvenTxReq } from '../schema/tables'
import { retryInactiveBrc39ComposedNativeImport } from './Brc39ComposedNativeRetryNode'
import * as cutover from './Brc38ComposedNativeCutoverNode'
import { composedNativeFixture as originalComposedNativeFixture } from './Brc38ComposedNativeFixture'
import { importBrc39ComposedNativeProfile } from './Brc39ComposedNativeImportNode'
import { recoverBrc39ComposedNativeImport } from './Brc39ComposedNativeRecoveryNode'
import { authenticatedStagePassword } from './Brc38AuthenticatedPrivateStageFixture'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { StorageKnex } from '../StorageKnex'
import { seedComposedAuxiliaryFixture, assertComposedAuxiliaryFixture } from './Brc38ComposedAuxiliaryFixture'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import {
  Brc38AuthenticatedNativeMergeInterruptedError,
  type Brc38AuthenticatedNativeMergeOptions
} from './Brc38AuthenticatedNativeMergeNode'
import * as nativeBackend from './Brc38NativeBackendNode'
import { WalletStorageManager } from '../WalletStorageManager'
import { bootstrapCurrentBrc38NativeObserver } from './Brc38CurrentNativeObserverNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  captureComposedSemanticFixture,
  composedArchivePostimage,
  composedTransactionPostimage,
  assertComposedSemanticFixture,
  assertComposedIncomingOriginals
} from './Brc38ComposedSemanticFixture'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { captureComposedPriorImports, assertComposedPriorImports } from './Brc38ComposedPriorImportFixture'

// Whole-feature cases explicitly admit the existing 16 KiB native read bound.
// Default/small-buffer fixtures remain 1 KiB; data, crypto chunks and clocks stay exact.
const composedNativeFixture = (...args: Parameters<typeof originalComposedNativeFixture>) => {
  args[6] = { ...args[6], maximumReadBytes: 16384 }
  return originalComposedNativeFixture(...args)
}

// The complete first customer attempt ran for 1057s before a functional refusal,
// and genuine fixture setup alone measured 74-231s. Recovery tests must reach
// real retirement before exercising expiry. Reuse the existing one-hour
// workflow envelope; recovery has its own finite deadline without renewing the
// original authenticated packet. These are test allowances, not product SLOs.
const composedWorkflowLifetimeMs = 3600000
const composedRecoveryCaseTimeoutMs = 2 * composedWorkflowLifetimeMs + 30000
// First comparison/copy alone measured 2509s. The overall customer scenario
// needs time for distinct recovery and repeat-import purposes. Every original
// operation retains its one-hour admission; no reservation expiry is renewed.
const customerScenarioTimeoutMs = 2 * composedWorkflowLifetimeMs + 30000

// Authored UNQUALIFIED. This is the first genuine occupied structured controller /
// current restart integration with nonempty all47 coverage and independent
// auxiliary metadata/byte oracles. Full imported semantics/custody/clocks
// and fault/resource campaigns remain separately required.
test(
  'actual occupied import, current restart and repeat import preserve a later full TEXT customer write',
  async () => {
    const observe = (phase: string): void => {
      console.log(JSON.stringify({ stage: 'composed-customer-workflow', phase, at: new Date().toISOString() }))
    }
    const progressObserver =
      (attempt: 'first' | 'repeat'): NonNullable<Brc38AuthenticatedNativeMergeOptions['progress']> =>
      value => {
        console.log(
          JSON.stringify({
            stage: 'composed-customer-progress',
            attempt,
            phase: value.phase,
            operation: value.operation?.operation,
            elapsedMilliseconds: value.operation?.elapsedMilliseconds,
            mergePhase: value.operation?.progress.phase,
            episode:
              value.operation !== undefined && 'episode' in value.operation.progress
                ? value.operation.progress.episode
                : undefined,
            nextRow:
              value.operation !== undefined && 'nextRow' in value.operation.progress
                ? value.operation.progress.nextRow
                : undefined,
            totalRows:
              value.operation !== undefined && 'totalRows' in value.operation.progress
                ? value.operation.progress.totalRows
                : undefined,
            at: new Date().toISOString()
          })
        )
      }
    observe('started')
    const incomingDescription = 'imported \u0000雪😀"\\\n'.repeat(9000),
      customerDescription = 'customer \u0000雪😀"\\\n'.repeat(10000),
      fixture = await composedNativeFixture(
        nativeTestExecutable(),
        (_source, incoming) => {
          incoming.tables.transactions[0].description = incomingDescription
          incoming.tables.transactions[0].updated_at = '2026-10-04T00:00:00.000Z'
        },
        composedWorkflowLifetimeMs
      )
    observe('fixture-ready')
    const originalSourceLimits = { ...fixture.source.limits },
      originalProjectionExpiry = fixture.merge.structuredResources.projectionPolicy.expiresAt
    try {
      const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager)
      await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      const priorImports = await captureComposedPriorImports(fixture.manager),
        before = await captureComposedSemanticFixture(fixture.manager),
        expectedImport = composedArchivePostimage(before, fixture.incomingData),
        expectedCustomer = composedTransactionPostimage(
          expectedImport,
          customerDescription,
          '2026-10-05T00:00:00.000Z'
        ),
        expectedRepeat = composedArchivePostimage(expectedCustomer, fixture.incomingData)
      const result = await importBrc39ComposedNativeProfile(fixture.chunks(), authenticatedStagePassword, {
        storage: fixture.storage,
        manager: fixture.manager,
        sourceInventory: fixture.sourceInventory,
        sourceProfile: fixture.sourceProfile,
        targetInventory: fixture.targetInventory,
        admission: fixture.admission,
        source: fixture.source,
        merge: fixture.merge,
        executable: fixture.executable,
        maximumOperations: 4096,
        progress: progressObserver('first')
      })
      observe('first-import-completed')
      expect(fixture.sourceProfile.ownershipReleased).toBe(true)
      expect(fixture.manager.getActive()).toBe(result.provider)
      expect(fixture.manager.isActiveEnabled).toBe(true)
      expect(fixture.manager.getActiveStore()).toBe(fixture.source.binding.targetStorageIdentityKey)
      await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      await assertComposedSemanticFixture(fixture.manager, expectedImport)
      await assertComposedIncomingOriginals(fixture.manager, result.inventory.importId, fixture.incomingData)
      await assertComposedPriorImports(fixture.manager, priorImports)
      const imported = await fixture.manager.runAsStorageProvider(
        async active =>
          await active.findTransactions({ partial: { userId: fixture.manager.getActiveUser().userId }, noRawTx: true })
      )
      expect(imported).toHaveLength(1)
      expect(imported[0].description).toBe(incomingDescription)
      await fixture.manager.runAsStorageProvider(async active => {
        expect(
          await active.updateTransaction(imported[0].transactionId, {
            description: customerDescription,
            updated_at: new Date('2026-10-05T00:00:00.000Z')
          })
        ).toBe(1)
      })
      observe('customer-write-completed')
      await assertComposedSemanticFixture(fixture.manager, expectedCustomer)
      const binding = brc38StagingBinding(fixture.source.binding, fixture.source.limits)
      await fixture.targetInventory.closeNamedRecoveryManager(
        result.inventory.importId,
        binding.digest,
        fixture.manager
      )
      let replayed = false
      const noReplay: AsyncIterable<Uint8Array> = {
        [Symbol.asyncIterator]() {
          replayed = true
          throw new Error('Completed wallet must not replay the original import')
        }
      }
      // Completed-current restart is a distinct initial recovery purpose. Its
      // clock grants no new time to the original source reservation.
      const recoveryExpiresAt = Date.now() + composedWorkflowLifetimeMs,
        current = await recoverBrc39ComposedNativeImport(noReplay, '', {
          admission: fixture.admission,
          source: { ...fixture.source, reservationId: result.reservationId },
          merge: fixture.merge,
          sourceInventory: fixture.sourceInventory,
          sourceImportId: fixture.sourceImportId,
          sourceBindingSha256: fixture.sourceBindingSha256,
          targetInventory: fixture.targetInventory,
          targetImportId: result.inventory.importId,
          executable: fixture.executable,
          services: fixture.proof.services,
          recovery: {
            privateParent: fixture.directory,
            expiresAt: recoveryExpiresAt,
            temporaryQuota: fixture.temporaryQuota
          }
        })
      observe('current-recovery-completed')
      expect(current.recovered).toBe('COMPLETED_CURRENT')
      expect(current.manager).not.toBe(fixture.manager)
      expect(current.manager.getActive()).toBeInstanceOf(StorageKnex)
      expect(current.manager.getActiveStore()).toBe(fixture.source.binding.targetStorageIdentityKey)
      const written = await current.manager.runAsStorageProvider(
        async active =>
          await active.findTransactions({ partial: { userId: current.manager.getActiveUser().userId }, noRawTx: true })
      )
      expect(written).toHaveLength(1)
      expect(written[0].transactionId).toBe(imported[0].transactionId)
      expect(written[0].description).toBe(customerDescription)
      expect(written[0].updated_at).toEqual(new Date('2026-10-05T00:00:00.000Z'))
      await assertComposedAuxiliaryFixture(current.manager, auxiliary)
      await assertComposedSemanticFixture(current.manager, expectedCustomer)
      await assertComposedIncomingOriginals(current.manager, result.inventory.importId, fixture.incomingData)
      await assertComposedPriorImports(current.manager, priorImports)
      expect(replayed).toBe(false)
      expect(fixture.temporaryQuota.used).toBe(0)
      expect(fixture.merge.workingAllocation.used).toBe(0)
      const currentProvider = current.manager.getActive()
      if (!(currentProvider instanceof StorageKnex))
        throw new Error('Repeat import requires its actual current native provider')
      const policy = {
        workingAllocation: fixture.merge.workingAllocation,
        maximumReadBytes: 1024,
        expiresAt: recoveryExpiresAt
      }
      expect(
        await fixture.targetInventory.currentNativeProfile(
          result.inventory.importId,
          binding.digest,
          current.manager,
          policy
        )
      ).toBe(current.profile)
      await expect(
        fixture.targetInventory.currentNativeProfile(result.inventory.importId, '0'.repeat(64), current.manager, policy)
      ).rejects.toThrow()
      await expect(
        Brc38ProfileInventoryNode.prototype.currentNativeProfile.call(
          { ...fixture.targetInventory },
          result.inventory.importId,
          binding.digest,
          current.manager,
          policy
        )
      ).rejects.toThrow()
      for await (const _progress of bootstrapCurrentBrc38NativeObserver(
        current.profile,
        currentProvider,
        current.manager,
        fixture.targetInventory,
        {
          maximumRows: 1000,
          ceiling: snapshotJournalRevision('1000000'),
          maximumStepRows: 32,
          maximumOperations: 256,
          expiresAt: recoveryExpiresAt,
          workingAllocation: fixture.merge.workingAllocation
        }
      )) {
        // Fresh current epoch belongs to this actual target; no source epoch or
        // original import admission is transplanted or renewed for the repeat.
      }
      const repeatPriorImports = await captureComposedPriorImports(current.manager),
        // Re-importing the archive starts a new reservation and new initial
        // admission. The old source limits and original reservation stay exact.
        repeatExpiresAt = Date.now() + composedWorkflowLifetimeMs,
        repeatSource = {
          ...fixture.source,
          limits: { ...fixture.source.limits, expiresAt: repeatExpiresAt }
        },
        repeatMerge = {
          ...fixture.merge,
          structuredResources: {
            ...fixture.merge.structuredResources,
            projectionPolicy: {
              ...fixture.merge.structuredResources.projectionPolicy,
              expiresAt: repeatExpiresAt
            }
          }
        }
      const repeated = await importBrc39ComposedNativeProfile(fixture.chunks(), authenticatedStagePassword, {
        storage: currentProvider,
        manager: current.manager,
        sourceInventory: fixture.targetInventory,
        sourceProfile: current.profile,
        targetInventory: fixture.targetInventory,
        admission: fixture.admission,
        source: repeatSource,
        merge: repeatMerge,
        executable: fixture.executable,
        maximumOperations: 4096,
        progress: progressObserver('repeat')
      })
      expect(repeated.inventory.importId).not.toBe(result.inventory.importId)
      expect(repeated.reservationId).not.toBe(result.reservationId)
      expect(fixture.source.limits).toEqual(originalSourceLimits)
      expect(fixture.merge.structuredResources.projectionPolicy.expiresAt).toBe(originalProjectionExpiry)
      expect(repeatSource.limits.expiresAt).toBe(repeatExpiresAt)
      expect(repeatSource.limits.expiresAt).toBeGreaterThan(originalSourceLimits.expiresAt)
      observe('repeat-import-completed')
      expect(repeated.profile).not.toBe(current.profile)
      expect(current.profile.ownershipReleased).toBe(true)
      expect(current.manager.getActive()).toBe(repeated.provider)
      const retained = await current.manager.runAsStorageProvider(
        async active =>
          await active.findTransactions({ partial: { userId: current.manager.getActiveUser().userId }, noRawTx: true })
      )
      expect(retained).toHaveLength(1)
      expect(retained[0].transactionId).toBe(imported[0].transactionId)
      expect(retained[0].description).toBe(customerDescription)
      expect(retained[0].updated_at).toEqual(new Date('2026-10-05T00:00:00.000Z'))
      await assertComposedAuxiliaryFixture(current.manager, auxiliary)
      await assertComposedSemanticFixture(current.manager, expectedRepeat)
      await assertComposedIncomingOriginals(current.manager, repeated.inventory.importId, fixture.incomingData)
      await assertComposedPriorImports(current.manager, repeatPriorImports)
      expect(fixture.merge.workingAllocation.used).toBe(0)
    } finally {
      await fixture.close()
      observe('physically-closed')
    }
  },
  customerScenarioTimeoutMs
)

test.each(['AUTHENTICATED', 'IMPORT'] as const)(
  'cancellation after drained %s work preserves the serving wallet',
  async phase => {
    const fixture = await composedNativeFixture(nativeTestExecutable(), undefined, composedWorkflowLifetimeMs),
      cancel = new AbortController(),
      stopped = new Error('Independent customer cancellation at a drained operation')
    try {
      const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager),
        expected = await captureComposedSemanticFixture(fixture.manager),
        originalUsage = await fixture.targetInventory.usage()
      let requested = false
      await expect(
        importBrc39ComposedNativeProfile(fixture.chunks(), authenticatedStagePassword, {
          ...fixture.importOptions(cancel.signal),
          progress: value => {
            if (
              !requested &&
              (phase === 'AUTHENTICATED' ? value.phase === phase : value.operation?.progress.phase === phase)
            ) {
              expect(fixture.sourceProfile.ownershipReleased).toBe(false)
              expect(fixture.manager.getActive()).toBe(fixture.storage)
              requested = true
              cancel.abort(stopped)
            }
          }
        })
      ).rejects.toMatchObject({ name: 'Brc38AuthenticatedNativeMergeInterruptedError', cause: stopped })
      expect(requested).toBe(true)
      expect(fixture.manager.isActiveEnabled).toBe(true)
      expect(fixture.manager.getActive()).toBe(fixture.storage)
      expect(fixture.sourceProfile.ownershipReleased).toBe(false)
      expect(await fixture.targetInventory.usage()).toEqual(originalUsage)
      await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      await assertComposedSemanticFixture(fixture.manager, expected)
      expect(fixture.merge.workingAllocation.used).toBe(0)
      expect(fixture.temporaryQuota.used).toBe(0)
    } finally {
      await fixture.close()
    }
  },
  composedRecoveryCaseTimeoutMs
)

test(
  'failed READY target cleanup retains its concrete owner until retry, then named recovery completes',
  async () => {
    const fixture = await composedNativeFixture(nativeTestExecutable(), undefined, composedWorkflowLifetimeMs),
      stopped = new Error('Actual target admission interrupted'),
      teardown = new Error('Independent first physical target-close failure'),
      close = Brc38PublishedProfileNode.prototype.close
    let target: Brc38PublishedProfileNode | undefined,
      targetImportId: string | undefined,
      reservationId: string | undefined,
      cleanup: Brc38StagingCleanupError | undefined,
      refuseClose = true
    let restoreSpies: () => void = () => {}
    try {
      const address = jest
        .spyOn(Brc38ProfileInventoryNode, 'admitAndReplaceRetiredComposedTarget')
        .mockImplementationOnce(async (_root, profile, merge) => {
          target = profile
          targetImportId = (await merge.status()).admission?.scope.importId
          expect(fixture.sourceProfile.ownershipReleased).toBe(true)
          expect(fixture.manager.isActiveEnabled).toBe(false)
          throw stopped
        })
      restoreSpies = () => address.mockRestore()
      const interrupt = jest.spyOn(Brc38PublishedProfileNode.prototype, 'close').mockImplementation(async function (
        this: Brc38PublishedProfileNode
      ) {
        if (this === target && refuseClose) {
          refuseClose = false
          throw teardown
        }
        await close.call(this)
      })
      restoreSpies = () => {
        address.mockRestore()
        interrupt.mockRestore()
      }
      const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager),
        expected = composedArchivePostimage(await captureComposedSemanticFixture(fixture.manager), fixture.incomingData)
      try {
        await importBrc39ComposedNativeProfile(fixture.chunks(), authenticatedStagePassword, fixture.importOptions())
        throw new Error('Actual target close fault was not reached')
      } catch (cause) {
        if (
          !(cause instanceof Brc38AuthenticatedNativeMergeInterruptedError) ||
          !(cause.cause instanceof Brc38StagingCleanupError)
        )
          throw cause
        reservationId = cause.reservationId
        cleanup = cause.cause
        expect(cleanup.errors).toEqual([stopped, teardown])
      }
      restoreSpies()
      if (target === undefined || targetImportId === undefined || reservationId === undefined || cleanup === undefined)
        throw new Error('Actual target cleanup did not retain its original owner and addresses')
      expect(target.ownershipReleased).toBe(false)
      await cleanup.retryCleanup()
      expect(target.ownershipReleased).toBe(true)
      await cleanup.retryCleanup() // Concrete successful drainage is idempotent.
      const result = await recoverBrc39ComposedNativeImport(fixture.chunks(), authenticatedStagePassword, {
        admission: fixture.admission,
        source: { ...fixture.source, reservationId },
        merge: fixture.merge,
        sourceInventory: fixture.sourceInventory,
        sourceImportId: fixture.sourceImportId,
        sourceBindingSha256: fixture.sourceBindingSha256,
        targetInventory: fixture.targetInventory,
        targetImportId,
        executable: fixture.executable,
        services: fixture.proof.services,
        recovery: {
          privateParent: fixture.directory,
          expiresAt: fixture.expiresAt,
          temporaryQuota: fixture.temporaryQuota
        }
      })
      expect(result.recovered).toBe('LIVE_PENDING')
      await assertComposedAuxiliaryFixture(result.manager, auxiliary)
      await assertComposedSemanticFixture(result.manager, expected)
      await assertComposedIncomingOriginals(result.manager, targetImportId, fixture.incomingData)
      expect(fixture.merge.workingAllocation.used).toBe(0)
      expect(fixture.temporaryQuota.used).toBe(0)
    } finally {
      restoreSpies()
      try {
        if (cleanup !== undefined) await cleanup.retryCleanup()
      } finally {
        await fixture.close()
      }
    }
  },
  composedRecoveryCaseTimeoutMs
)

test.each([
  ...(['READY', 'DELETE_ACTIVATING', 'DELETE_ACTIVE', 'WAL_ACTIVATING', 'WAL', 'COMPLETED'] as const).map(phase => ({
    phase,
    recovered: phase === 'COMPLETED' ? ('COMPLETED_CURRENT' as const) : ('LIVE_PENDING' as const),
    expired: false
  })),
  ...(['READY', 'DELETE_ACTIVATING', 'DELETE_ACTIVE', 'WAL_ACTIVATING', 'WAL', 'COMPLETED'] as const).map(phase => ({
    phase,
    recovered: phase === 'COMPLETED' ? ('COMPLETED_CURRENT' as const) : ('EXPIRED_PENDING' as const),
    expired: true
  }))
])(
  'actual retired $phase target resumes through $recovered without changing original limits',
  async scenario => {
    const fixture = await composedNativeFixture(nativeTestExecutable(), () => {}, composedWorkflowLifetimeMs),
      stopped = new Error('Actual final retirement committed; target admission ACK interrupted'),
      originalLimits = { ...fixture.source.limits },
      binding = brc38StagingBinding(fixture.source.binding, originalLimits)
    let targetImportId: string | undefined, reservationId: string | undefined
    let restoreInterrupt: () => void = () => {}
    try {
      if (scenario.phase === 'READY') {
        const interrupt = jest
          .spyOn(Brc38ProfileInventoryNode, 'admitAndReplaceRetiredComposedTarget')
          .mockImplementationOnce(async (_root, profile, merge) => {
            const status = await merge.status()
            targetImportId = status.admission?.scope.importId
            expect(targetImportId).toBeDefined()
            expect(await profile.status()).toMatchObject({ state: 'READY' })
            expect(fixture.sourceProfile.ownershipReleased).toBe(true)
            expect(fixture.manager.isActiveEnabled).toBe(false)
            throw stopped
          })
        restoreInterrupt = () => interrupt.mockRestore()
      } else if (scenario.phase === 'COMPLETED') {
        const admit = Brc38ProfileInventoryNode.admitAndReplaceRetiredComposedTarget,
          replace = WalletStorageManager.prototype.replaceProviderInTransition
        const address = jest
          .spyOn(Brc38ProfileInventoryNode, 'admitAndReplaceRetiredComposedTarget')
          .mockImplementationOnce(async (...args) => {
            targetImportId = (await args[2].status()).admission?.scope.importId
            return await admit(...args)
          })
        const interrupt = jest
          .spyOn(WalletStorageManager.prototype, 'replaceProviderInTransition')
          .mockImplementationOnce(async function (this: WalletStorageManager, scope, provider, beforeInstall) {
            expect(this).toBe(fixture.manager)
            if (beforeInstall === undefined)
              throw new Error('Final commit fixture requires the real retained completion callback')
            return await replace.call(this, scope, provider, async () => {
              // The real callback commits the lifecycle transaction, syncs its
              // directory and performs the full postcommit checks. Interrupt
              // after it returns, before original manager selection is exposed.
              await beforeInstall()
              expect(fixture.sourceProfile.ownershipReleased).toBe(true)
              expect(fixture.manager.isActiveEnabled).toBe(false)
              throw stopped
            })
          })
        restoreInterrupt = () => {
          interrupt.mockRestore()
          address.mockRestore()
        }
      } else {
        const read = nativeBackend.readBrc38NativeBackend
        let interrupted = false
        const interrupt = jest
          .spyOn(nativeBackend, 'readBrc38NativeBackend')
          .mockImplementation(async (db, row, build) => {
            const actual = await read(db, row, build),
              fixed = JSON.parse(row.fixedJson) as {
                protocol: string
                bindingSha256: string
                admission: { scope: { importId: string } }
              }
            // Read the real committed catalog through its real facade. Never throw
            // inside the writer (which would roll the phase back), fabricate a phase,
            // intercept another profile, or turn a receipt into activation authority.
            if (
              !interrupted &&
              !db.isTransaction &&
              fixed.protocol === 'brc38-published-profile/v3' &&
              fixed.bindingSha256 === binding.digest &&
              actual?.phase === scenario.phase
            ) {
              interrupted = true
              targetImportId = fixed.admission.scope.importId
              expect(fixture.sourceProfile.ownershipReleased).toBe(true)
              expect(fixture.manager.isActiveEnabled).toBe(false)
              throw stopped
            }
            return actual
          })
        restoreInterrupt = () => interrupt.mockRestore()
      }
      const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager)
      const expected = composedArchivePostimage(
        await captureComposedSemanticFixture(fixture.manager),
        fixture.incomingData
      )
      try {
        await importBrc39ComposedNativeProfile(fixture.chunks(), authenticatedStagePassword, {
          storage: fixture.storage,
          manager: fixture.manager,
          sourceInventory: fixture.sourceInventory,
          sourceProfile: fixture.sourceProfile,
          targetInventory: fixture.targetInventory,
          admission: fixture.admission,
          source: fixture.source,
          merge: fixture.merge,
          executable: fixture.executable,
          maximumOperations: 4096
        })
        throw new Error('Real committed retirement interruption was not reached')
      } catch (cause) {
        if (!(cause instanceof Brc38AuthenticatedNativeMergeInterruptedError)) throw cause
        expect(cause.cause).toBe(stopped)
        reservationId = cause.reservationId
      } finally {
        restoreInterrupt()
      }
      if (targetImportId === undefined || reservationId === undefined)
        throw new Error('Actual pending fixture did not retain original addresses')
      if (scenario.expired) {
        // Real UTC expiry, never a mocked clock, changed original packet, kernel
        // argument rewrite or admission renewal. All first-attempt owners drained.
        await new Promise<void>(resolve => setTimeout(resolve, Math.max(1, fixture.expiresAt - Date.now() + 1)))
        expect(Date.now()).toBeGreaterThanOrEqual(fixture.expiresAt)
      }
      const result = await recoverBrc39ComposedNativeImport(fixture.chunks(), authenticatedStagePassword, {
        admission: fixture.admission,
        source: { ...fixture.source, reservationId },
        merge: fixture.merge,
        sourceInventory: fixture.sourceInventory,
        sourceImportId: fixture.sourceImportId,
        sourceBindingSha256: fixture.sourceBindingSha256,
        targetInventory: fixture.targetInventory,
        targetImportId,
        executable: fixture.executable,
        services: fixture.proof.services,
        recovery: {
          privateParent: fixture.directory,
          expiresAt: Date.now() + composedWorkflowLifetimeMs,
          temporaryQuota: fixture.temporaryQuota
        }
      })
      expect(result.recovered).toBe(scenario.recovered)
      expect(result.originalReservationId).toBe(reservationId)
      expect(result.importId).toBe(targetImportId)
      expect(result.manager).not.toBe(fixture.manager)
      expect(result.manager.isActiveEnabled).toBe(true)
      expect(result.manager.getActiveStore()).toBe(fixture.source.binding.targetStorageIdentityKey)
      await assertComposedAuxiliaryFixture(result.manager, auxiliary)
      await assertComposedSemanticFixture(result.manager, expected)
      await assertComposedIncomingOriginals(result.manager, targetImportId, fixture.incomingData)
      expect(fixture.source.limits).toEqual(originalLimits)
      expect(brc38StagingBinding(fixture.source.binding, fixture.source.limits)).toEqual(binding)
      expect(fixture.temporaryQuota.used).toBe(0)
      expect(fixture.merge.workingAllocation.used).toBe(0)
    } finally {
      restoreInterrupt()
      await fixture.close()
    }
  },
  composedRecoveryCaseTimeoutMs
)

// Actual inactive target + original serving source + SAME private reservation.
// Only the final transition is interrupted; all earlier authentication, row
// composition and physical copy actors execute their ordinary implementation.
test(
  'inactive composed retry withdraws the original copy and preserves its reservation, limits and semantic postimage',
  async () => {
    const fixture = await composedNativeFixture(nativeTestExecutable(), undefined, composedWorkflowLifetimeMs),
      stopped = new Error('Stop before original source retirement'),
      originalLimits = { ...fixture.source.limits },
      originalBinding = brc38StagingBinding(fixture.source.binding, fixture.source.limits)
    let reservationId: string | undefined, targetImportId: string | undefined
    const receive = Brc38ProfileInventoryNode.receiveComparedComposition,
      observeTarget = jest
        .spyOn(Brc38ProfileInventoryNode, 'receiveComparedComposition')
        .mockImplementationOnce(async (...args) => {
          targetImportId = (await args[3].status()).admission?.scope.importId
          return await receive(...args)
        })
    const interrupt = jest.spyOn(cutover, 'cutoverBrc38ComposedNativeProfile').mockImplementationOnce(async options => {
      expect(options.sourceProfile.ownershipReleased).toBe(false)
      expect(fixture.manager.getActive()).toBe(fixture.storage)
      expect(targetImportId).toBeDefined()
      throw stopped
    })
    try {
      const auxiliary = await seedComposedAuxiliaryFixture(fixture.storage, fixture.manager),
        before = await captureComposedSemanticFixture(fixture.manager),
        expected = composedArchivePostimage(before, fixture.incomingData)
      try {
        await importBrc39ComposedNativeProfile(fixture.chunks(), authenticatedStagePassword, fixture.importOptions())
      } catch (cause) {
        if (!(cause instanceof Brc38AuthenticatedNativeMergeInterruptedError) || cause.cause !== stopped) throw cause
        reservationId = cause.reservationId
      }
      interrupt.mockRestore()
      observeTarget.mockRestore()
      if (reservationId === undefined || targetImportId === undefined)
        throw new Error('Actual inactive retry addresses were not retained')
      expect(fixture.sourceProfile.ownershipReleased).toBe(false)
      expect(fixture.manager.isActiveEnabled).toBe(true)
      await assertComposedSemanticFixture(fixture.manager, before)
      await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      const result = await retryInactiveBrc39ComposedNativeImport(fixture.chunks(), authenticatedStagePassword, {
        ...fixture.importOptions(),
        inactiveTargetImportId: targetImportId,
        source: { ...fixture.source, reservationId }
      })
      expect(result.reservationId).toBe(reservationId)
      expect(result.inventory.importId).toBe(targetImportId)
      expect(fixture.source.limits).toEqual(originalLimits)
      expect(brc38StagingBinding(fixture.source.binding, fixture.source.limits).digest).toBe(originalBinding.digest)
      expect(fixture.manager.getActive()).toBe(result.provider)
      expect(fixture.sourceProfile.ownershipReleased).toBe(true)
      await assertComposedSemanticFixture(fixture.manager, expected)
      await assertComposedIncomingOriginals(fixture.manager, result.inventory.importId, fixture.incomingData)
      await assertComposedAuxiliaryFixture(fixture.manager, auxiliary)
      expect(fixture.merge.workingAllocation.used).toBe(0)
      expect(fixture.temporaryQuota.used).toBe(0)
    } finally {
      interrupt.mockRestore()
      observeTarget.mockRestore()
      await fixture.close()
    }
  },
  composedRecoveryCaseTimeoutMs
)

test(
  'retained occupied history callback replays independent legacy bytes and revokes escaped readers',
  async () => {
    const fixture = await composedNativeFixture(
        nativeTestExecutable(),
        (source, incoming) => {
          source.tables.provenTxReqs[0].history = {
            notes: [{ when: source.exportedAt, what: 'original', detail: 'A'.repeat(33000) }]
          }
          incoming.tables.provenTxReqs[0].history = {
            notes: [{ when: incoming.exportedAt, what: 'incoming', detail: 'B'.repeat(33000) }],
            ignored: true
          }
        },
        composedWorkflowLifetimeMs
      ),
      prepare = occupiedHistoryText.prepareBrc38PrivateOccupiedHistoryText
    let legacyHistory = ''
    let retained: Readonly<Brc38PrivateOccupiedHistory> | undefined,
      observed = false
    const intercept = jest
      .spyOn(occupiedHistoryText, 'prepareBrc38PrivateOccupiedHistoryText')
      .mockImplementationOnce(async (...args) => {
        const entity = new EntityProvenTxReq({
          history: legacyHistory,
          notify: '{}',
          created_at: new Date(fixture.sourceData.exportedAt),
          updated_at: new Date(fixture.sourceData.exportedAt)
        } as TableProvenTxReq)
        entity.mergeHistory({
          history: JSON.stringify(fixture.incomingData.tables.provenTxReqs[0].history),
          notify: '{}',
          created_at: new Date(fixture.incomingData.exportedAt),
          updated_at: new Date(fixture.incomingData.exportedAt)
        } as TableProvenTxReq)
        const expected = Buffer.from(JSON.stringify(entity.history), 'utf8')
        await withBrc38PrivateOccupiedHistory(
          args[0],
          args[1],
          args[2],
          args[3],
          args[4],
          args[5],
          args[6],
          async history => {
            retained = history
            const measured: Uint8Array[] = [],
              replayed: Uint8Array[] = []
            for await (const bytes of history.measureChunks(4096)) {
              expect(bytes.byteLength).toBeLessThanOrEqual(4096)
              measured.push(bytes.slice())
            }
            for await (const bytes of history.chunks(4096)) {
              expect(bytes.byteLength).toBeLessThanOrEqual(4096)
              replayed.push(bytes.slice())
            }
            expect(Buffer.concat(measured)).toEqual(expected)
            expect(Buffer.concat(replayed)).toEqual(expected)
            expect(history.addedNotes).toBe(1)
            observed = true
          }
        )
        expect(() => retained!.chunks(4096)).toThrow()
        return await prepare(...args)
      })
    try {
      const capturedHistory = fixture.sourceData.tables.provenTxReqs[0].history
      if (capturedHistory === null || typeof capturedHistory !== 'object' || Array.isArray(capturedHistory))
        throw new Error('Independent legacy history fixture requires its original object')
      legacyHistory = JSON.stringify({ ...capturedHistory, localOnly: null })
      // Nullable legacy current SQL properties are persisted through the actual
      // writer after restoring a canonical archive; the archive itself omits them.
      await fixture.manager.runAsStorageProvider(async active => {
        if (active !== fixture.storage) throw new Error('Legacy history fixture selected another provider')
        const rows = await active.findProvenTxReqs({ partial: { txid: fixture.proof.txid.toUpperCase() } })
        if (rows.length !== 1) throw new Error('Legacy history fixture requires one actual request')
        expect(await active.updateProvenTxReq(rows[0].provenTxReqId, { history: legacyHistory })).toBe(1)
      })
      const expected = composedArchivePostimage(
        await captureComposedSemanticFixture(fixture.manager),
        fixture.incomingData
      )
      const result = await importBrc39ComposedNativeProfile(
        fixture.chunks(),
        authenticatedStagePassword,
        fixture.importOptions()
      )
      expect(observed).toBe(true)
      expect(result.provider).toBe(fixture.manager.getActive())
      await assertComposedSemanticFixture(fixture.manager, expected)
      expect(fixture.merge.workingAllocation.used).toBe(0)
    } finally {
      intercept.mockRestore()
      await fixture.close()
    }
  },
  composedRecoveryCaseTimeoutMs
)

test('actual native request writer preserves omitted legacy broadcast counters', async () => {
  const fixture = await composedNativeFixture(nativeTestExecutable(), undefined, 300000)
  try {
    await fixture.manager.runAsStorageProvider(async () => {
      await fixture.storage.toDb().transaction(async trx => {
        const requests = await trx('proven_tx_reqs').select(
          'provenTxReqId',
          'txid',
          'created_at',
          'updated_at',
          'status',
          'attempts',
          'notified'
        )
        expect(requests).toHaveLength(1)
        const request = requests[0],
          id = request.provenTxReqId as number
        await trx('proven_tx_reqs').where({ provenTxReqId: id }).update({ wasBroadcast: 1, rebroadcastAttempts: 7 })
        const metadata = {
          ...request,
          created_at: new Date('2026-10-03T00:00:00.000Z'),
          updated_at: new Date('2026-10-04T00:00:00.000Z'),
          attempts: 3,
          wasBroadcast: undefined,
          rebroadcastAttempts: undefined
        }
        expect(
          await writeNativeSnapshotSyncRow(
            fixture.storage,
            trx,
            'provenTxReqs',
            metadata,
            { row: {}, fields: [] },
            {},
            id
          )
        ).toBe(id)
        expect(
          await trx('proven_tx_reqs')
            .where({ provenTxReqId: id })
            .first('wasBroadcast', 'rebroadcastAttempts', 'attempts')
        ).toEqual({ wasBroadcast: 1, rebroadcastAttempts: 7, attempts: 3 })
        expect(
          await writeNativeSnapshotSyncRow(
            fixture.storage,
            trx,
            'provenTxReqs',
            { ...metadata, wasBroadcast: false, rebroadcastAttempts: 0 },
            { row: {}, fields: [] },
            {},
            id
          )
        ).toBe(id)
        expect(
          await trx('proven_tx_reqs').where({ provenTxReqId: id }).first('wasBroadcast', 'rebroadcastAttempts')
        ).toEqual({ wasBroadcast: 0, rebroadcastAttempts: 0 })
        expect(
          await writeNativeSnapshotSyncRow(
            fixture.storage,
            trx,
            'provenTxReqs',
            { ...metadata, wasBroadcast: true, rebroadcastAttempts: 3 },
            { row: {}, fields: [] },
            {},
            id
          )
        ).toBe(id)
        expect(
          await trx('proven_tx_reqs').where({ provenTxReqId: id }).first('wasBroadcast', 'rebroadcastAttempts')
        ).toEqual({ wasBroadcast: 1, rebroadcastAttempts: 3 })
      })
    })
  } finally {
    await fixture.close()
  }
  expect(fixture.merge.workingAllocation.used).toBe(0)
}, 330000)

test('actual composed current transaction field selection preserves its physical coordinate', async () => {
  const fixture = await composedNativeFixture(nativeTestExecutable(), undefined, 300000)
  try {
    const userId = fixture.manager.getActiveUser().userId,
      txid = fixture.sourceData.tables.transactions[0].txid
    expect(typeof txid).toBe('string')
    await fixture.manager.runAsStorageProvider(async () => {
      await fixture.storage.toDb().transaction(async trx => {
        const direct: Array<{ physical: number; localId: number; coordinateType: string }> = await trx.raw(
          'SELECT rowid AS physical, transactionId AS localId, typeof(rowid) AS coordinateType FROM transactions WHERE userId=? AND txid=?',
          [userId, txid]
        )
        expect(direct).toHaveLength(1)
        expect(direct[0].coordinateType).toBe('integer')
        expect(Number.isSafeInteger(direct[0].physical)).toBe(true)
        expect(direct[0].physical).toBeGreaterThan(0)
        const target = {
          table: 'transactions' as const,
          index: 'transactions' as const,
          key: { userId, txid: txid! },
          found: true,
          localId: direct[0].localId
        }
        const fields = await readBrc38NativeCurrentFieldTargets(
          trx,
          fixture.storage,
          userId,
          'transactions',
          [target],
          65536
        )
        expect(fields).toHaveLength(1)
        expect(fields[0].binaryRowId).toBe(direct[0].physical)
        expect(fields[0].metadata?.transactionId).toBe(direct[0].localId)
        expect(fields[0].metadata).not.toHaveProperty('__brc38NativeBinaryRowId')
        expect(fields[0].texts?.description?.bytes).toBe(
          Buffer.byteLength(fixture.sourceData.tables.transactions[0].description)
        )
        await expect(
          readBrc38NativeCurrentFieldTargets(
            trx,
            fixture.storage,
            userId,
            'transactions',
            [{ ...target, localId: direct[0].localId + 1 }],
            65536
          )
        ).rejects.toThrow('prepared indexed identity')
        await expect(
          readBrc38NativeCurrentFieldTargets(
            trx,
            fixture.storage,
            userId,
            'transactions',
            [{ ...target, key: { ...target.key, userId: userId + 1 } }],
            65536
          )
        ).rejects.toThrow('prepared indexed identity')
      })
    })
  } finally {
    await fixture.close()
  }
  expect(fixture.merge.workingAllocation.used).toBe(0)
}, 330000)

test('actual occupied native request identity reuses the original legacy archive spelling', async () => {
  const fixture = await composedNativeFixture(nativeTestExecutable(), undefined, 300000)
  try {
    const userId = fixture.manager.getActiveUser().userId,
      archivedTxid = fixture.incomingData.tables.provenTxReqs[0].txid
    expect(archivedTxid).toMatch(/^[0-9A-F]{64}$/)
    await fixture.manager.runAsStorageProvider(async () => {
      await fixture.storage.toDb().transaction(async trx => {
        const stored = await trx('proven_tx_reqs').select('provenTxReqId', 'txid')
        expect(stored).toHaveLength(1)
        expect(stored[0].txid).toBe(archivedTxid)
        const target = {
            table: 'provenTxReqs' as const,
            index: 'provenTxReqs' as const,
            key: { txid: archivedTxid },
            found: true,
            localId: stored[0].provenTxReqId as number
          },
          fields = await readBrc38NativeCurrentFieldTargets(
            trx,
            fixture.storage,
            userId,
            'provenTxReqs',
            [target],
            65536
          )
        expect(fields).toHaveLength(1)
        if (fields[0].metadata === undefined) throw new Error('Actual request metadata is missing')
        const extents: Record<string, import('../snapshot/WalletReadSnapshot').WalletSnapshotFieldDescriptor> = {}
        for (const [name, value] of Object.entries(fields[0].binaries)) extents[name] = { kind: 'binary', ...value }
        for (const [name, value] of Object.entries(fields[0].texts ?? {})) extents[name] = { kind: 'utf8', ...value }
        const original = snapshotSyncRequestMetadata(fields[0].metadata, extents),
          incoming = brc38ImportRequestIdentity(original),
          map = createSyncMap()
        if (incoming.provenTxId !== undefined) map.provenTx.idMap[incoming.provenTxId] = incoming.provenTxId
        const current = await readNativeSnapshotSyncRequestCurrent(fixture.storage, trx, userId, incoming, map)
        expect(current.target).toMatchObject({ found: true, localId: target.localId, key: target.key })
        expect(current.row?.provenTxReqId).toBe(target.localId)
        expect(current.row?.txid).toBe(archivedTxid)
        expect(current.field.binaryRowId).toBe(fields[0].binaryRowId)
        expect(current.revision).toMatch(/^[0-9]+$/)
        expect(current.generation).toMatch(/^[1-9][0-9]*$/)
        expect(current.parents).toHaveLength(incoming.provenTxId === undefined ? 0 : 1)
        expect(await trx('proven_tx_reqs').count({ count: '*' }).first()).toEqual({ count: 1 })
      })
    })
  } finally {
    await fixture.close()
  }
  expect(fixture.merge.workingAllocation.used).toBe(0)
}, 330000)
