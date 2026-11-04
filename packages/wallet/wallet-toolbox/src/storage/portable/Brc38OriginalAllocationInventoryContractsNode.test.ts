import { chargeBrc38ImportDecodedBudget, reserveBrc38ImportDecodedScratch } from './Brc38ImportDecodedBudget'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { nativeTestExecutable } from './Brc38NativeTestPath'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { restorePortableProof, restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import { Brc38PrivateNativeRestoreNode } from './Brc38PrivateNativeRestoreNode'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38PrivateStructuredRestoreResources } from './Brc38StructuredRestoreResourcesNode'
import {
  verifyOriginal64KiBNativeInventoryOracle,
  verifyMeasured128KiBNativeInventoryOracle
} from './Brc38StreamedNativeInventoryNode.case'
import { previewReceiptPolicy } from './Brc38ImportPreviewFixture'

// Identical all13-table workload:128KiB is the measured positive profile,
// admitted once from authentication through final frozen inventory. Its actual
// shared working peak is69010..102002 bytes across64/256/1024-byte transfers.
// The original64KiB reference remains an explicit fixed-budget refusal, with
// its original failed positive evidence preserved. No admission is renewed.
// Output, disk/index and crypto allocations keep separate finite contracts.
async function verifyAllocationInventory(width: number, originalAllocationBytes: 65536 | 131072): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'brc38-original-allocation-')),
    data = semanticStageFixture(),
    proof = restoreProofFixture(),
    workingAllocation = new Brc38WorkingAllocation(originalAllocationBytes),
    expiresAt = Date.now() + 180000,
    deadline = performance.now() + 180000,
    closes: Array<() => Promise<void>> = []
  let failed = false,
    failure: unknown
  const close = async (): Promise<void> => {
      while (closes.length !== 0) {
        await closes[closes.length - 1]()
        closes.pop()
      }
      await rm(directory, { recursive: true, force: true })
    },
    check = (): void => {
      if (Date.now() >= expiresAt || performance.now() >= deadline)
        throw new Error('Original allocation fixture exceeded its original lifetime')
    }
  try {
    restorePortableProof(data, proof)
    const rawTx = Buffer.from(proof.tx.toBinary()).toString('base64')
    data.tables.provenTxReqs[0].rawTx = data.tables.transactions[0].rawTx = rawTx
    data.tables.outputs[0].lockingScript = Buffer.from(proof.tx.outputs[0].lockingScript.toBinary()).toString('base64')
    data.tables.commissions[0].lockingScript = 'UQ=='
    // Nine numeric import entities; archived syncStates and three composite
    // families are original provenance, not additional numeric mappings.
    const expected = {
        rows: 14,
        mappedIds: 9,
        tableCounts: {
          provenTxs: 1,
          outputBaskets: 1,
          outputTags: 1,
          txLabels: 1,
          transactions: 1,
          outputs: 1,
          txLabelMaps: 1,
          outputTagMaps: 1,
          certificates: 1,
          certificateFields: 1,
          commissions: 1,
          provenTxReqs: 1,
          syncStates: 1
        },
        binaryBytes:
          3 * proof.tx.toBinary().length +
          proof.path.toBinary().length +
          proof.tx.outputs[0].lockingScript.toBinary().length +
          1
      },
      resources: Brc38PrivateStructuredRestoreResources = {
        sourcePolicy: {
          privateIndexParent: directory,
          maximumTemporaryIndexBytes: 1048576,
          maximumIndexMembers: 128,
          maximumStructuredBytes: originalAllocationBytes,
          maximumCanonicalBytes: originalAllocationBytes,
          maximumReadBytes: width,
          maximumIndexAllocationBytes: workingAllocation.maximum,
          // Share the original aggregate ceiling; a 4096 sub-cap admits only
          // the grammar base and cannot admit even its first digest scope.
          maximumGrammarAllocationBytes: workingAllocation.maximum,
          workingAllocation
        },
        projectionPolicy: {
          privateParent: directory,
          maximumTemporaryFileBytes: 2097152,
          maximumMembers: 128,
          maximumOutputBytes: originalAllocationBytes,
          maximumScalarBytes: 4096,
          maximumReadBytes: width,
          maximumIndexAllocationBytes: workingAllocation.maximum,
          maximumGrammarAllocationBytes: workingAllocation.maximum,
          expiresAt,
          workingAllocation
        },
        maximumCombinedTemporaryBytes: 3145728
      },
      bytes = await encrypted(data),
      original = authenticatedStageOptions(bytes),
      selected = {
        ...original,
        limits: {
          ...original.limits,
          maximumPhysicalBytes: 16777216,
          maximumRowAllocationBytes: originalAllocationBytes,
          expiresAt
        },
        streamedFields: { maximumBinaryBytes: originalAllocationBytes, maximumChunkBytes: width },
        streamedTextFields: { maximumTextBytes: originalAllocationBytes, maximumChunkBytes: width },
        streamedStructuredFields: {
          fields: { maximumStructuredBytes: originalAllocationBytes, maximumChunkBytes: width },
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
      for (let offset = 0; offset < bytes.length; offset += 137) {
        check()
        yield bytes.slice(offset, offset + 137)
      }
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
      maximumStepBytes: originalAllocationBytes,
      maximumMappedIds: 1000,
      maximumJournalLogicalBytes: 516096,
      services: proof.services,
      structuredResources: resources
    })
    closes.push(async () => await restore.close())
    let status = await restore.status()
    for (let operations = 0; status.state !== 'COMPLETE' && operations < 128; operations++) {
      check()
      status = await restore.step(status.nextRow)
    }
    expect(status.state).toBe('COMPLETE')
    // Final independent inventory runs in the same irreversible frozen phase
    // as publication comparison; its setting-change refusal belongs to that phase.
    await store.beginPrivateNativeComparison()
    await store.requirePrivateNativeComparison()
    await store.withAuthenticatedPrivateStructuredDestination(async () => {
      await store.withPrivateNativeDatabase(true, async database => {
        await database.transaction(async trx => {
          store.assertPrivateNativeReadTransaction(trx)
          expect(await trx.raw('PRAGMA query_only')).toEqual([{ query_only: 1 }])
          await expect(trx.raw('PRAGMA query_only=OFF')).rejects.toMatchObject({ code: 'SQLITE_AUTH' })
          await (
            originalAllocationBytes === 65536
              ? verifyOriginal64KiBNativeInventoryOracle
              : verifyMeasured128KiBNativeInventoryOracle
          )(
            trx,
            restore.admission,
            'private',
            { ...resources, inspectionExpiresAt: expiresAt, privateSource: store },
            expected,
            () => {
              check()
              store.assertPrivateNativeReadTransaction(trx)
            }
          )
          store.assertPrivateNativeReadTransaction(trx)
        })
      })
    })
    expect(store.limits.maximumRowAllocationBytes).toBe(originalAllocationBytes)
    expect(workingAllocation.maximum).toBe(originalAllocationBytes)
    expect(workingAllocation.used).toBe(0)
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await close()
  } catch (cause) {
    throw new AggregateError(
      failed ? [failure, cause] : [cause],
      'Original64KiB inventory retains original physical cleanup owners'
    )
  }
  if (failed) throw failure
}

test.each([64, 256, 1024] as const)(
  'original64KiB all13 workload refuses fixed decoded allocation exhaustion at %i-byte transfers',
  async width => {
    const result = verifyAllocationInventory(width, 65536)
    await expect(result).rejects.toBeInstanceOf(SnapshotResourceLimitError)
    await expect(result).rejects.toMatchObject({ message: 'Private import merge exceeds its fixed allocation budget' })
  },
  // The complete native refusal shares the same existing 180-second fixture
  // lifetime as the positive matrix; neither clock nor allocation is renewed.
  180000
)

// Measured workload candidate, independently admitted at128KiB from the start.
// The same workload at64KiB is a negative admission boundary, not a positive
// capacity promise. Production sizing still needs the broader workload matrix.
test.each([64, 256, 1024] as const)(
  'measured128KiB initial allocation completes all13 native inventory at %i-byte transfers',
  async width => await verifyAllocationInventory(width, 131072),
  180000
)

test('decoded scratch protects simultaneous retained data and releases only its own reservation once', () => {
  const budget = { maximum: 1024, remaining: 1024 }
  chargeBrc38ImportDecodedBudget(budget, 256)
  const release = reserveBrc38ImportDecodedScratch(budget, 512)
  expect(budget.remaining).toBe(256)
  expect(() => chargeBrc38ImportDecodedBudget(budget, 512)).toThrow(SnapshotResourceLimitError)
  expect(budget.remaining).toBe(256)
  release()
  expect(budget.remaining).toBe(768)
  chargeBrc38ImportDecodedBudget(budget, 512)
  release()
  expect(budget.remaining).toBe(256)
  expect(budget.maximum).toBe(1024)
})

test('refused decoded scratch cannot renew the original small allocation', () => {
  const budget = { maximum: 1024, remaining: 256 }
  expect(() => reserveBrc38ImportDecodedScratch(budget, 257)).toThrow(SnapshotResourceLimitError)
  expect(budget.remaining).toBe(256)
  expect(budget.maximum).toBe(1024)
})

test('cancelled scratch acquisition does not allocate and drained scratch can release after cancellation', () => {
  const controller = new AbortController(),
    budget = { maximum: 1024, remaining: 1024, signal: controller.signal },
    release = reserveBrc38ImportDecodedScratch(budget, 512),
    reason = new Error('original scratch cancellation')
  controller.abort(reason)
  expect(() => reserveBrc38ImportDecodedScratch(budget, 1)).toThrow(reason)
  expect(budget.remaining).toBe(512)
  release()
  expect(budget.remaining).toBe(1024)
})
