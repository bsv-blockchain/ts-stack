import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { createOwnedNativeReadDatabase } from '../schema/ownedNativeSqliteConnectionsNode'
import { restoreProofFixture, restorePortableProof } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import {
  stageAuthenticatedBrc39PrivateImport,
  type Brc38AuthenticatedPrivateStageOptions
} from './Brc38AuthenticatedPrivateStageNode'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import { Brc38ProfileInventoryNode } from './Brc38ProfileInventoryNode'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38NativeRecoveryTemporaryQuota } from './Brc38NativeRecoveryScratchNode'
import { brc38StagingBinding } from './Brc38StagingBinding'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { bootstrapCurrentBrc38NativeObserver } from './Brc38CurrentNativeObserverNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import type { Brc38PrivateStructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import type { Brc38PrivateNativeMergeOptions } from './Brc38PrivateNativeMergeNode'
import type { BRC38WalletData } from './index'
import { snapshotMeasurementCases, type SnapshotMeasurementCase } from '../../../benchmarks/snapshot-measurement-cases'
import type { Brc39ComposedNativeImportOptions } from './Brc39ComposedNativeImportNode'

export interface Brc38ComposedNativeBeforeObserver {
  readonly storage: StorageKnex
  readonly manager: import('../WalletStorageManager').WalletStorageManager
  readonly profile: Brc38PublishedProfileNode
  readonly inventory: Brc38ProfileInventoryNode
  readonly identityKey: string
  readonly expiresAt: number
  readonly maximumRows: number
  readonly workingAllocation: Brc38WorkingAllocation
  readonly check: () => void
}

/** Reusable actual native fixture. It authenticates and restores a structured
 * source, publishes it through its real inventory, closes the staging kernel,
 * activates the native profile, and bootstraps current all47 observation.
 * Expected semantic inventories must be authored separately; this helper does
 * not turn an implementation-generated image into an oracle. UNRUN. */
export function composedFixtureChain(storage: import('../StorageKnex').StorageKnex): 'main' | 'test' {
  const chain = storage.chain
  if (chain !== 'main' && chain !== 'test') throw new Error('Composed fixture requires its actual main/test chain')
  return chain
}

export async function composedNativeFixture(
  executable: string,
  customize: (source: BRC38WalletData, incoming: BRC38WalletData) => void = () => {},
  lifetimeMs = 180000,
  measurement?: SnapshotMeasurementCase,
  beforeWal?: (
    profile: Brc38PublishedProfileNode,
    manager: import('../WalletStorageManager').WalletStorageManager,
    expiresAt: number
  ) => Promise<void>,
  beforeObserver?: (fixture: Brc38ComposedNativeBeforeObserver) => Promise<void>,
  selected: Readonly<{
    targetStorageIdentityKey?: string
    proofBytes?: 256 | 32768 | 131073
    maximumReadBytes?: number
  }> = {}
) {
  if (measurement !== undefined && !snapshotMeasurementCases.includes(measurement))
    throw new RangeError('Composed measurement must select an immutable declared shape')
  // Full setup measured 230.8s; a twelve-minute customer workflow lease
  // expired during the first baseline after 46 drained operations. A selected
  // whole-workflow measurement may admit at most one hour, including
  // both complete imports and current recovery. Recovery/cancellation cases
  // explicitly select that same envelope: setup alone measured 74-231s and the
  // first full attempt reached 1057s before a functional refusal. Real-expiry
  // recovery waits out the original packet; it never renews its admission.
  // This is not a production SLO. Every actual UTC/monotonic check remains;
  // the default stays three minutes.
  if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 3600000)
    throw new RangeError('Composed fixture requires one finite original lifetime')
  const maximumReadBytes = selected.maximumReadBytes ?? 1024
  if (!Number.isSafeInteger(maximumReadBytes) || maximumReadBytes < 1 || maximumReadBytes > 16384)
    throw new RangeError('Composed fixture requires an explicitly bounded native read allowance')
  const targetStorageIdentityKey = selected.targetStorageIdentityKey ?? 'synthetic target'
  if (
    typeof targetStorageIdentityKey !== 'string' ||
    targetStorageIdentityKey.length < 1 ||
    targetStorageIdentityKey.length > 256
  )
    throw new RangeError('Composed fixture requires one explicit bounded target identity')
  if (measurement !== undefined && selected.proofBytes !== undefined && selected.proofBytes !== measurement.rawBytes)
    throw new RangeError('Composed measurement cannot replace its immutable proof shape')
  const directory = await mkdtemp(join(tmpdir(), 'brc38-composed-native-')),
    proof = restoreProofFixture(selected.proofBytes ?? measurement?.rawBytes),
    sourceData = semanticStageFixture(),
    incomingData = semanticStageFixture(),
    // Full occupied proof/field/checkpoint preparation shares one bounded ceiling.
    working = new Brc38WorkingAllocation(16777216),
    physical = measurement === undefined ? 16777216 : 134217728,
    logical = measurement === undefined ? 1048576 : 67108864,
    maximumRows = measurement === undefined ? 1000 : 24000,
    structuredBytes = measurement === undefined ? 1048576 : 2097152,
    maximumJournalLogicalBytes = measurement === undefined ? 516096 : 16777216,
    maximumFixtureOperations = measurement === undefined ? 128 : 4096,
    catalogReservation = 3 * 1048576,
    expiresAt = Date.now() + lifetimeMs,
    deadline = performance.now() + lifetimeMs,
    closes: Array<() => Promise<void>> = []
  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    // Dependency order matters: no catalog/root closes while one of its actual
    // profiles or private kernels still owns physical work. Retry leaves the
    // failing closure on the stack and never removes the fixture directory.
    try {
      while (closes.length !== 0) {
        await closes[closes.length - 1]()
        closes.pop()
      }
      await rm(directory, { recursive: true, force: true })
      closed = true
    } catch (cause) {
      throw new Brc38StagingCleanupError([cause], 'Actual composed fixture retains its dependency cleanup stack', close)
    }
  }
  const check = (): void => {
    if (closed || Date.now() >= expiresAt || performance.now() >= deadline)
      throw new Error('Composed fixture exceeded its original lifetime')
  }
  try {
    // Public snapshot entrypoints require a compressed identity. This is the
    // independent secp256k1 generator key, not a provider-produced identity.
    sourceData.user.identityKey = incomingData.user.identityKey =
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    restorePortableProof(sourceData, proof)
    restorePortableProof(incomingData, proof)
    if (measurement !== undefined)
      for (const data of [sourceData, incomingData]) {
        const original = data.tables.txLabels[0]
        for (let index = 0; index < measurement.labels; index++)
          data.tables.txLabels.push({
            ...original,
            txLabelId: 100 + index,
            label: `measurement-${String(index).padStart(6, '0')}`,
            isDeleted: index % 97 === 0
          })
        const rawTx = Buffer.from(proof.tx.toBinary()).toString('base64')
        data.tables.provenTxReqs[0].rawTx = rawTx
        data.tables.transactions[0].rawTx = rawTx
        data.tables.provenTxReqs[0].history = {
          notes: [
            { when: data.exportedAt, what: 'measurement history', detail: 'x'.repeat(measurement.historyCharacters) }
          ]
        }
        data.tables.provenTxReqs[0].notify = { transactionIds: [14] }
      }
    customize(sourceData, incomingData)
    if (
      !/^(02|03)[0-9a-f]{64}$/.test(sourceData.user.identityKey) ||
      incomingData.user.identityKey !== sourceData.user.identityKey
    )
      throw new Error('Composed fixture requires the same independently selected compressed identity')
    const resources: Brc38PrivateStructuredRestoreResources = {
      sourcePolicy: {
        privateIndexParent: directory,
        maximumTemporaryIndexBytes: measurement === undefined ? 2097152 : 8388608,
        maximumIndexMembers: measurement === undefined ? 10000 : 30000,
        maximumStructuredBytes: structuredBytes,
        maximumCanonicalBytes: structuredBytes,
        workingAllocation: working
      },
      projectionPolicy: {
        privateParent: directory,
        maximumTemporaryFileBytes: measurement === undefined ? 6291456 : 16777216,
        maximumMembers: measurement === undefined ? 10000 : 30000,
        maximumOutputBytes: structuredBytes,
        maximumScalarBytes: 65536,
        maximumReadBytes,
        expiresAt,
        workingAllocation: working
      },
      maximumCombinedTemporaryBytes: measurement === undefined ? 10485760 : 33554432
    }
    const packet = (bytes: Uint8Array, data: BRC38WalletData): Brc38AuthenticatedPrivateStageOptions => {
      if (typeof data.user.identityKey !== 'string') throw new Error('Composed fixture user identity differs')
      const value = authenticatedStageOptions(bytes)
      return {
        ...value,
        binding: { ...value.binding, identityKey: data.user.identityKey, targetStorageIdentityKey },
        limits: {
          ...value.limits,
          maximumPhysicalBytes: physical,
          maximumLogicalBytes: logical,
          maximumRows: measurement === undefined ? value.limits.maximumRows : maximumRows,
          maximumRowAllocationBytes: working.maximum,
          maximumRowBytes: 65536,
          expiresAt
        },
        crypto: {
          ...value.crypto,
          policy: { ...value.crypto.policy, maximumFileBytes: measurement === undefined ? 1048576 : 8388608 }
        },
        maximumPlaintextBytes: measurement === undefined ? 1048576 : 8388608,
        maximumCiphertextChunks: measurement === undefined ? value.maximumCiphertextChunks : 65536,
        streamedFields: { maximumBinaryBytes: 1048576, maximumChunkBytes: 1024 },
        streamedTextFields: { maximumTextBytes: 1048576, maximumChunkBytes: 1024 },
        streamedStructuredFields: {
          fields: { maximumStructuredBytes: structuredBytes, maximumChunkBytes: 1024 },
          staging: resources.sourcePolicy
        }
      }
    }
    const makeAdmission = async (name: string): Promise<Brc38StagingAdmissionNode> => {
      const path = join(directory, name)
      await mkdir(path, { mode: 0o700 })
      const root = await Brc38StagingAdmissionNode.create(path, {
        maximumImports: 2,
        maximumPhysicalBytes: catalogReservation + 2 * physical,
        maximumLogicalBytes: measurement === undefined ? 2097152 : 2 * logical
      })
      closes.push(async () => await root.close())
      return root
    }
    const makeInventory = async (name: string): Promise<Brc38ProfileInventoryNode> => {
      const path = join(directory, name)
      await mkdir(path, { mode: 0o700 })
      const root = await Brc38ProfileInventoryNode.create(path, {
        maximumProfiles: 2,
        maximumPhysicalBytes: catalogReservation + 2 * physical
      })
      closes.push(async () => await root.close())
      return root
    }
    const sourceAdmission = await makeAdmission('source-admission'),
      admission = await makeAdmission('incoming-admission'),
      sourceInventory = await makeInventory('source-profiles'),
      targetInventory = await makeInventory('target-profiles'),
      sourceBytes = await encrypted(sourceData, measurement === undefined ? undefined : 'program-measurement'),
      sourceOptions = packet(sourceBytes, sourceData),
      sourceStaged = await stageAuthenticatedBrc39PrivateImport(
        chunks(sourceBytes, measurement === undefined ? 137 : 1024),
        authenticatedStagePassword,
        sourceAdmission,
        sourceOptions
      )
    closes.push(async () => await sourceStaged.reservation.store.close())
    await sourceStaged.reservation.store.close()
    const native = await sourceAdmission.resumeNative(
      sourceStaged.reservation.id,
      sourceOptions.limits,
      sourceOptions.binding,
      executable
    )
    closes.push(async () => await native.store.close())
    const restore = await Brc38PrivateNativeRestoreNode.openStructured(native.store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 16,
      maximumStepBytes: 2097152,
      maximumMappedIds: maximumRows,
      maximumJournalLogicalBytes,
      services: proof.services,
      structuredResources: resources
    })
    closes.push(async () => await restore.close())
    let receipt = await restore.status()
    for (let operations = 0; receipt.state !== 'COMPLETE' && operations < maximumFixtureOperations; operations++)
      receipt = await restore.step(receipt.nextRow)
    if (receipt.state !== 'COMPLETE')
      throw new Error('Structured fixture exceeded its original restore operation bound')
    const sourceProfile = await restore.publishManaged(sourceInventory)
    closes.push(async () => await sourceProfile.close())
    await restore.close()
    await native.store.close()
    const claim = await sourceProfile.prepareNativeClaim(sourceInventory)
    await Brc38PublishedProfileNode.acquireNativeClaim(claim, executable)
    const manager = await sourceProfile.activateNative(proof.services)
    // A source-owned contract test may observe the actual DELETE lifetime.
    // The default fixture and original WAL/observer sequence are unchanged.
    await beforeWal?.(sourceProfile, manager, expiresAt)
    await sourceProfile.promoteNativeWal()
    const storage = manager.getActive()
    if (!(storage instanceof StorageKnex)) throw new Error('Structured fixture has no actual current native provider')
    check()
    await beforeObserver?.({
      storage,
      manager,
      profile: sourceProfile,
      inventory: sourceInventory,
      identityKey: sourceData.user.identityKey,
      expiresAt,
      maximumRows,
      workingAllocation: working,
      check
    })
    check()
    for await (const _progress of bootstrapCurrentBrc38NativeObserver(
      sourceProfile,
      storage,
      manager,
      sourceInventory,
      {
        maximumRows,
        ceiling: snapshotJournalRevision('1000000'),
        maximumStepRows: 32,
        maximumOperations: measurement === undefined ? 256 : 4096,
        expiresAt,
        workingAllocation: working
      }
    )) {
      /* Fully drain actual maintenance. */
    }
    const bytes = await encrypted(incomingData, measurement === undefined ? undefined : 'program-measurement'),
      source = packet(bytes, incomingData),
      merge: Brc38PrivateNativeMergeOptions = {
        receiptPolicy: previewReceiptPolicy,
        maximumStepRows: 16,
        // Occupied merge includes checkpoint scratch, existing-state planning
        // and retained decoded metadata; the empty restore allowance is smaller.
        maximumStepBytes: 16777216,
        maximumMappedIds: maximumRows,
        maximumJournalLogicalBytes,
        maximumLocalRows: maximumRows,
        maximumReadBytes,
        workingAllocation: working,
        structuredResources: resources,
        services: proof.services
      }
    return {
      directory,
      proof,
      sourceData,
      incomingData,
      bytes,
      source,
      merge,
      storage,
      manager,
      sourceImportId: restore.admission.scope.importId,
      sourceBindingSha256: brc38StagingBinding(sourceOptions.binding, sourceOptions.limits).digest,
      admission,
      sourceInventory,
      sourceProfile,
      targetInventory,
      executable,
      expiresAt,
      check,
      temporaryQuota: new Brc38NativeRecoveryTemporaryQuota(3 * physical),
      importOptions(signal?: AbortSignal): Brc39ComposedNativeImportOptions {
        const structured = source.streamedStructuredFields
        if (structured === undefined)
          throw new Error('Concrete composed fixture lost its original structured source packet')
        const sourcePolicy = { ...resources.sourcePolicy, signal },
          projectionPolicy = { ...resources.projectionPolicy, signal }
        return {
          storage,
          manager,
          sourceInventory,
          sourceProfile,
          targetInventory,
          admission,
          source: {
            ...source,
            crypto: { ...source.crypto, signal },
            streamedStructuredFields: { ...structured, staging: sourcePolicy }
          },
          merge: { ...merge, signal, structuredResources: { ...resources, sourcePolicy, projectionPolicy } },
          executable,
          maximumOperations: measurement === undefined ? 4096 : 65536
        }
      },
      chunks: () => chunks(bytes, measurement === undefined ? 137 : 1024),
      /** The low-level exporter retains its caller's pool. Keep the serving
       * writer free by owning an actual separate readonly native lease, with
       * its cleanup enrolled before any constructor or setup can fail. */
      async openPortableReader(provider: StorageKnex): Promise<StorageKnex> {
        check()
        if (provider !== manager.getActive()) throw new Error('Portable reader requires the current fixture provider')
        const options = StorageProvider.createStorageBaseOptions(provider.chain),
          database = createOwnedNativeReadDatabase(provider.knex)
        let reader: StorageKnex | undefined
        closes.push(async () => {
          if (reader === undefined) await database.destroy()
          else await reader.destroy()
        })
        reader = new StorageKnex({
          ...options,
          snapshotSync: false,
          snapshotJournalRetention: false,
          knex: database
        })
        await reader.makeAvailable()
        check()
        if (provider !== manager.getActive()) throw new Error('Portable reader lost the current fixture provider')
        return reader
      },
      retainCleanup(cleanup: () => Promise<void>) {
        closes.push(cleanup)
      },
      close
    }
  } catch (cause) {
    try {
      await close()
    } catch (error_) {
      throw new Brc38StagingCleanupError([cause, error_], 'Actual composed fixture retains cleanup', close)
    }
    throw cause
  }
}

async function* chunks(bytes: Uint8Array, width = 137): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.slice(offset, offset + width)
}

/** Join the original fixture dependency stack while preserving both the
 * assertion/operation failure and any physical cleanup failure. */
export async function withComposedNativeFixture(
  work: (fixture: Awaited<ReturnType<typeof composedNativeFixture>>) => Promise<void>,
  ...args: Parameters<typeof composedNativeFixture>
): Promise<void> {
  const fixture = await composedNativeFixture(...args)
  let failed = false,
    failure: unknown
  try {
    await work(fixture)
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await fixture.close()
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Composed native contract retains original cleanup owners'
    )
  }
  if (failed) throw failure
}
