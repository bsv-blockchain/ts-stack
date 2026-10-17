import { nativeTestExecutable } from './Brc38NativeTestPath'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { restorePortableProof, restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import {
  Brc38PrivateNativeRestoreNode,
  type Brc38PrivateStructuredRestoreResources
} from './Brc38PrivateNativeRestoreNode'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import type { Brc38StageTable } from './Brc38SemanticStage'
import { brc38ImportTableOrder } from './Brc38ImportForms'
import { prepareBrc38StructuredImportPage, type Brc38PreparedStreamedPage } from './Brc38ImportPage'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import type { BRC38WalletData } from './index'

/** Actual encrypted archive, semantic seal and native receiver. Pages are
 * prepared by the retained authenticated reader, rather than a structural
 * reader fixture. This component fixture cannot publish or activate a wallet. */
export async function withBrc38NativeStreamedContractFixture(
  customize: (data: BRC38WalletData) => void,
  work: (fixture: {
    readonly store: import('./KnexBrc38StagingStore').KnexBrc38StagingStore
    readonly storage: StorageKnex
    readonly restore: Brc38PrivateNativeRestoreNode
    readonly resources: Brc38PrivateStructuredRestoreResources
    readonly expiresAt: number
    check(): void
    withWriter<T>(operation: (trx: Knex.Transaction) => Promise<T>): Promise<T>
    beforeTable(table: Brc38StageTable): Promise<void>
    withPage(
      table: Brc38StageTable,
      operation: (freshPage: () => Promise<Brc38PreparedStreamedPage>) => Promise<void>
    ): Promise<void>
  }) => Promise<void>
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-native-streamed-contract-')),
    data = semanticStageFixture(),
    proof = restoreProofFixture(),
    workingAllocation = new Brc38WorkingAllocation(8388608),
    expiresAt = Date.now() + 180000,
    monotonicDeadline = performance.now() + 180000,
    closes: Array<() => Promise<void>> = []
  const close = async (): Promise<void> => {
    while (closes.length !== 0) {
      await closes[closes.length - 1]()
      closes.pop()
    }
    await rm(directory, { recursive: true, force: true })
  }
  let failed = false,
    failure: unknown
  try {
    restorePortableProof(data, proof)
    customize(data)
    const bytes = await encrypted(data),
      packet = authenticatedStageOptions(bytes),
      resources: Brc38PrivateStructuredRestoreResources = {
        sourcePolicy: {
          privateIndexParent: directory,
          maximumTemporaryIndexBytes: 2097152,
          maximumIndexMembers: 10000,
          maximumStructuredBytes: 1048576,
          maximumCanonicalBytes: 1048576,
          maximumReadBytes: 1024,
          workingAllocation
        },
        projectionPolicy: {
          privateParent: directory,
          maximumTemporaryFileBytes: 6291456,
          maximumMembers: 10000,
          maximumOutputBytes: 1048576,
          maximumScalarBytes: 65536,
          maximumReadBytes: 1024,
          expiresAt,
          workingAllocation
        },
        maximumCombinedTemporaryBytes: 10485760
      },
      selected = {
        ...packet,
        limits: {
          ...packet.limits,
          maximumPhysicalBytes: 16777216,
          maximumRowAllocationBytes: workingAllocation.maximum,
          expiresAt
        },
        streamedFields: { maximumBinaryBytes: 1048576, maximumChunkBytes: 1024 },
        streamedTextFields: { maximumTextBytes: 1048576, maximumChunkBytes: 1024 },
        streamedStructuredFields: {
          fields: { maximumStructuredBytes: 1048576, maximumChunkBytes: 1024 },
          staging: resources.sourcePolicy
        }
      },
      root = await Brc38StagingAdmissionNode.create(directory, {
        maximumImports: 1,
        maximumPhysicalBytes: 19922944,
        maximumLogicalBytes: 1048576
      })
    closes.push(async () => await root.close())
    async function* chunks(): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
    }
    const staged = await stageAuthenticatedBrc39PrivateImport(chunks(), authenticatedStagePassword, root, selected)
    closes.push(async () => await staged.reservation.store.close())
    await staged.reservation.store.close()
    const native = await root.resumeNative(
        staged.reservation.id,
        selected.limits,
        selected.binding,
        nativeTestExecutable()
      ),
      store = native.store
    closes.push(async () => await store.close())
    const restore = await Brc38PrivateNativeRestoreNode.openStructured(store, {
      receiptPolicy: previewReceiptPolicy,
      maximumStepRows: 1,
      maximumStepBytes: 2097152,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services,
      structuredResources: resources
    })
    closes.push(async () => await restore.close())
    const storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions(selected.binding.chain),
      knex: store.knex,
      snapshotSync: false
    })
    storage.setServices(proof.services)
    const check = (): void => {
        if (Date.now() >= expiresAt || performance.now() >= monotonicDeadline)
          throw new Error('Native streamed contract exceeded its original finite lifetime')
        store.assertPrivateNativeDestination(store.knex)
      },
      fromRow = (table: Brc38StageTable): number => {
        if (!brc38ImportTableOrder.includes(table)) throw new RangeError('Explicit archive table required')
        let position = 1
        for (const prior of brc38ImportTableOrder) {
          if (prior === table) return position
          position += data.tables[prior].length
        }
        throw new Error('Native streamed fixture table is unavailable')
      }
    await work({
      store,
      storage,
      restore,
      resources,
      expiresAt,
      check,
      withWriter: async operation =>
        await store.withAuthenticatedPrivateStructuredDestination(async () => {
          await storage.makeAvailable()
          return await store.withPrivateNativeDatabase(
            false,
            async database =>
              await database.transaction(async trx => {
                check()
                store.assertPrivateNativeWriteTransaction(trx)
                const result = await operation(trx)
                check()
                return result
              })
          )
        }),
      beforeTable: async table => {
        const end = fromRow(table)
        let receipt = await restore.status()
        for (let operations = 0; receipt.nextRow < end && operations < 128; operations++) {
          check()
          receipt = await restore.step(receipt.nextRow)
        }
        if (receipt.nextRow !== end || receipt.state === 'COMPLETE')
          throw new Error('Native streamed fixture did not reach the actual admitted table')
      },
      withPage: async (table, operation) =>
        await store.withAuthenticatedStructuredImportRead(async (_json, metadata, reader) => {
          await storage.makeAvailable()
          check()
          await operation(async () => {
            check()
            const page = await prepareBrc38StructuredImportPage(
              reader,
              metadata,
              restore.admission,
              fromRow(table),
              undefined,
              1
            )
            if (page.data.kind !== 'table' || page.data.table !== table || page.data.rows.length !== 1)
              throw new Error('Actual authenticated native page differs from its selected fixture table')
            return page
          })
          check()
        })
    })
    if (workingAllocation.used !== 0) throw new Error('Native streamed contract retained a working allocation')
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await close()
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Native streamed contract retains its original physical owners'
    )
  }
  if (failed) throw failure
}
