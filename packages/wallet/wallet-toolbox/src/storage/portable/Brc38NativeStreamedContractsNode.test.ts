import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import {
  stageAuthenticatedBrc39PrivateImport,
  authenticateBrc39PrivateNativeImport
} from './Brc38AuthenticatedPrivateStageNode'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { restorePortableProof, restoreProofFixture } from '../../../test/utils/Brc38ImportEntityRestoreFixture'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { nativeTestExecutable } from './Brc38NativeTestPath'
import { withBrc38NativeStreamedContractFixture } from './Brc38NativeStreamedContractFixture'
import {
  verifyNativePackedFieldPreparationRecovery,
  verifyNativePackedFieldPreparationReadDrain
} from './Brc38NativePackedFieldPreparationNode.case'
import { verifyNativePackedTextPreparationRecovery } from './Brc38NativePackedTextPreparationNode.case'
import { verifyNativeScalarTextPreparationRecovery } from './Brc38NativeScalarTextPreparationNode.case'
import { verifyPrivateHistoryReadDrain } from './Brc38PrivateHistoryReadDrainNode.case'
import { verifyNativeStructuredSqlWindowOracle } from './Brc38SqlStructuredChunkWindowNode.case'
import { readBrc38ImportJournal } from './Brc38ImportJournal'
import {
  verifyNativeExistingFieldMetadataBound,
  verifyNativeExistingFieldWriterFence
} from './Brc38ImportExistingFieldRowsNode.case'
import { createHash } from 'node:crypto'

type Fixture = Parameters<Parameters<typeof withBrc38NativeStreamedContractFixture>[1]>[0]
const when = new Date('2026-10-08T00:00:00.000Z')
// The fixture still expires at 180 seconds; allow 30 seconds for its
// original physical-owner cleanup after that independently enforced limit.
const nativeStreamedCaseTimeoutMs = 210000
async function seedTransaction(fixture: Fixture): Promise<{ transactionId: number; userId: number }> {
  return await fixture.withWriter(async trx => {
    const userId = await fixture.storage.insertUser(
        {
          userId: 0,
          created_at: when,
          updated_at: when,
          identityKey: 'independent streamed field user',
          activeStorage: 'synthetic target'
        },
        trx
      ),
      transactionId = await fixture.storage.insertTransaction(
        {
          transactionId: 0,
          userId,
          created_at: when,
          updated_at: when,
          status: 'nosend',
          reference: 'aW5kZXBlbmRlbnQgc3RyZWFtZWQ=',
          isOutgoing: false,
          satoshis: 0,
          description: ''
        },
        trx
      )
    return { userId, transactionId }
  })
}

// Each case has a separate actual authenticated native receiver and original
// finite expiry. Byte oracles are authored before encryption/source staging.
test(
  'actual authenticated multichunk binary staging survives an interrupted installer',
  async () => {
    const expected = Uint8Array.from({ length: 131073 }, (_, index) => (index * 17 + 29) % 251)
    try {
      await withBrc38NativeStreamedContractFixture(
        data => {
          data.tables.outputs[0].lockingScript = Buffer.from(expected).toString('base64')
        },
        async fixture => {
          const parent = await seedTransaction(fixture),
            rowId = await fixture.withWriter(
              async trx =>
                await fixture.storage.insertOutput(
                  {
                    outputId: 0,
                    ...parent,
                    created_at: when,
                    updated_at: when,
                    spendable: false,
                    change: false,
                    vout: 0,
                    satoshis: 0,
                    providedBy: 'you',
                    purpose: 'independent staging',
                    type: 'custom',
                    outputDescription: 'independent pointer-free output'
                  },
                  trx
                )
            )
          await fixture.withPage('outputs', async freshPage => {
            await verifyNativePackedFieldPreparationRecovery(
              fixture.store,
              freshPage,
              rowId,
              expected,
              fixture.expiresAt
            )
            const target = {
                table: 'outputs' as const,
                index: 'outputs' as const,
                key: { userId: parent.userId, transactionId: parent.transactionId, vout: 0 },
                found: true,
                localId: rowId
              },
              descriptor = { bytes: expected.byteLength, sha256: createHash('sha256').update(expected).digest('hex') }
            await fixture.store.withPrivateNativeDatabase(
              true,
              async database =>
                await database.transaction(async trx => {
                  fixture.store.assertPrivateNativeReadTransaction(trx)
                  await verifyNativeExistingFieldMetadataBound(
                    trx,
                    fixture.storage,
                    parent.userId,
                    target,
                    descriptor,
                    65536
                  )
                })
            )
            await verifyNativeExistingFieldWriterFence(fixture.store, fixture.storage, parent.userId, target)
          })
        }
      )
    } finally {
      expected.fill(0)
    }
  },
  nativeStreamedCaseTimeoutMs
)

test(
  'actual binary source leases drain before every private append writer',
  async () => {
    const expected = Uint8Array.from({ length: 131073 }, (_, index) => (index * 19 + 31) % 251)
    try {
      await withBrc38NativeStreamedContractFixture(
        data => {
          data.tables.outputs[0].lockingScript = Buffer.from(expected).toString('base64')
        },
        async fixture =>
          await fixture.withPage(
            'outputs',
            async freshPage =>
              await verifyNativePackedFieldPreparationReadDrain(fixture.store, freshPage, fixture.expiresAt)
          )
      )
    } finally {
      expected.fill(0)
    }
  },
  nativeStreamedCaseTimeoutMs
)

test(
  'actual original multichunk UTF-8 description survives interrupted TEXT staging',
  async () => {
    const description = '\uFEFFindependent\u0000雪😀'.repeat(5000),
      expected = Buffer.from(description, 'utf8')
    try {
      await withBrc38NativeStreamedContractFixture(
        data => {
          data.tables.transactions[0].description = description
        },
        async fixture => {
          const { transactionId } = await seedTransaction(fixture)
          await fixture.withPage(
            'transactions',
            async freshPage =>
              await verifyNativeScalarTextPreparationRecovery(
                fixture.store,
                freshPage,
                transactionId,
                expected,
                fixture.expiresAt
              )
          )
        }
      )
    } finally {
      expected.fill(0)
    }
  },
  nativeStreamedCaseTimeoutMs
)

test(
  'complete authenticated history and notify page retains canonical bytes and drained projection reads',
  async () => {
    const history = { notes: [], unknown: '雪😀'.repeat(14000) },
      notify = { transactionIds: [], unknown: '雪😀' },
      expectedHistory = Buffer.from(JSON.stringify(history), 'utf8'),
      expectedNotify = Buffer.from(JSON.stringify(notify), 'utf8')
    try {
      await withBrc38NativeStreamedContractFixture(
        data => {
          data.tables.provenTxReqs[0].history = history
          data.tables.provenTxReqs[0].notify = notify
        },
        async fixture => {
          await fixture.beforeTable('provenTxReqs')
          // This is a distinct component row. Its empty history is never a
          // replacement for the authenticated source's complete history/notify.
          const rowId = await fixture.withWriter(
            async trx =>
              await fixture.storage.insertProvenTxReq(
                {
                  provenTxReqId: 0,
                  created_at: when,
                  updated_at: when,
                  status: 'unprocessed',
                  attempts: 0,
                  notified: false,
                  txid: '8'.repeat(64),
                  history: '',
                  notify: '{}',
                  rawTx: []
                },
                trx
              )
          )
          await fixture.withPage('provenTxReqs', async freshPage => {
            await verifyPrivateHistoryReadDrain(
              fixture.store,
              fixture.restore.admission,
              'provenTxReqs',
              0,
              fixture.resources.sourcePolicy,
              fixture.resources.projectionPolicy,
              expectedNotify,
              0
            )
            const receipt = await fixture.store.withPrivateNativeDatabase(
                true,
                async database =>
                  await database.transaction(async trx => {
                    fixture.store.assertPrivateNativeReadTransaction(trx)
                    return await readBrc38ImportJournal(trx, fixture.restore.admission)
                  })
              ),
              projection = await fixture.store.stagePrivateNotifyProjection(
                fixture.restore.admission,
                0,
                receipt.nextRow,
                fixture.resources.sourcePolicy,
                fixture.resources.projectionPolicy
              )
            await verifyNativePackedTextPreparationRecovery(
              fixture.store,
              freshPage,
              rowId,
              expectedHistory,
              fixture.expiresAt,
              new Map([[0, projection.descriptor]])
            )
            await fixture.store.withPrivateNativeDatabase(
              true,
              async database =>
                await database.transaction(async trx => {
                  const assertCurrent = (): void => {
                    fixture.check()
                    fixture.store.assertPrivateNativeReadTransaction(trx)
                  }
                  for (const family of ['raw', 'canonical'] as const)
                    await verifyNativeStructuredSqlWindowOracle(
                      trx,
                      family,
                      { table: 'provenTxReqs', position: 0, field: 'history' },
                      expectedHistory,
                      assertCurrent
                    )
                  await verifyNativeStructuredSqlWindowOracle(
                    trx,
                    'projected',
                    { table: 'provenTxReqs', position: 0, field: 'notify' },
                    expectedNotify,
                    assertCurrent
                  )
                })
            )
          })
        }
      )
    } finally {
      expectedHistory.fill(0)
      expectedNotify.fill(0)
    }
  },
  nativeStreamedCaseTimeoutMs
)

test(
  'actual sealed native owned source revalidates original structured bytes and refuses after physical close',
  async () => {
    const history = { notes: [], unknown: 'independent original\u0000雪😀' },
      notify = { transactionIds: [], unknown: 'independent original notify' },
      expectedHistory = Buffer.from(JSON.stringify(history), 'utf8'),
      expectedNotify = Buffer.from(JSON.stringify(notify), 'utf8')
    try {
      // A caller without the original authenticated scope cannot borrow the
      // native profile read. Use its own owner so refusal never grants reuse.
      await withBrc38NativeStreamedContractFixture(
        data => {
          data.tables.provenTxReqs[0].history = history
          data.tables.provenTxReqs[0].notify = notify
        },
        async fixture => {
          const actual = await fixture.store.streamedRow('provenTxReqs', 0)
          if (actual === undefined || actual.structured === undefined)
            throw new Error('Independent unscoped structured source is absent')
          await expect(
            fixture.store.validateOwnedSourceStructuredFields(
              'provenTxReqs',
              0,
              actual.structured,
              fixture.resources.sourcePolicy
            )
          ).rejects.toThrow('Native import journal requires an authenticated published-profile transaction')
        }
      )
      const directory = await mkdtemp(join(tmpdir(), 'brc38-original-native-replay-')),
        data = semanticStageFixture(),
        workingAllocation = new Brc38WorkingAllocation(8388608),
        expiresAt = Date.now() + 180000,
        closes: Array<() => Promise<void>> = []
      try {
        restorePortableProof(data, restoreProofFixture())
        data.tables.provenTxReqs[0].history = history
        data.tables.provenTxReqs[0].notify = notify
        expect(expectedHistory.byteLength).toBeLessThanOrEqual(1024)
        expect(expectedNotify.byteLength).toBeLessThanOrEqual(1024)
        const bytes = await encrypted(data),
          packet = authenticatedStageOptions(bytes),
          // Original source replay uses the same policy as the composed
          // authentication path. Packed destination read enrollment is a
          // separate contract, tested above; it is not a source replay grant.
          policy = {
            privateIndexParent: directory,
            maximumTemporaryIndexBytes: 2097152,
            maximumIndexMembers: 10000,
            maximumStructuredBytes: 1048576,
            maximumCanonicalBytes: 1048576,
            workingAllocation
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
              staging: policy
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
        const original = await stageAuthenticatedBrc39PrivateImport(
          chunks(),
          authenticatedStagePassword,
          root,
          selected
        )
        closes.push(async () => await original.reservation.store.close())
        await original.reservation.store.close()
        const replay = await authenticateBrc39PrivateNativeImport(
            chunks(),
            authenticatedStagePassword,
            root,
            { ...selected, reservationId: original.reservation.id },
            nativeTestExecutable()
          ),
          store = replay.reservation.store
        closes.push(async () => await store.close())
        expect(replay.reservation.id).toBe(original.reservation.id)
        expect(replay.archiveSha256).toBe(original.archiveSha256)
        expect(replay.document).toEqual(original.document)
        expect(store.limits.expiresAt).toBe(expiresAt)
        const actual = await store.streamedRow('provenTxReqs', 0)
        if (actual === undefined || actual.structured === undefined)
          throw new Error('Actual original replay source is absent')
        const descriptors = actual.structured
        expect(Object.keys(descriptors).sort()).toEqual(['history', 'notify'])
        // Validate outside a destination callback: the validator itself owns
        // the exclusive source operation and borrows only its actual slot3.
        await store.validateOwnedSourceStructuredFields('provenTxReqs', 0, descriptors, policy)
        await store.withAuthenticatedPrivateStructuredDestination(async () => {
          await store.withPrivateNativeDatabase(
            true,
            async database =>
              await database.transaction(async trx => {
                const assertCurrent = (): void => {
                  store.assertPrivateNativeReadTransaction(trx)
                }
                for (const family of ['raw', 'canonical'] as const) {
                  await verifyNativeStructuredSqlWindowOracle(
                    trx,
                    family,
                    { table: 'provenTxReqs', position: 0, field: 'history' },
                    expectedHistory,
                    assertCurrent
                  )
                  await verifyNativeStructuredSqlWindowOracle(
                    trx,
                    family,
                    { table: 'provenTxReqs', position: 0, field: 'notify' },
                    expectedNotify,
                    assertCurrent
                  )
                }
              })
          )
        })
        await store.close()
        await expect(store.validateOwnedSourceStructuredFields('provenTxReqs', 0, descriptors, policy)).rejects.toThrow(
          'Private native stage owner is unavailable or expired'
        )
        expect(workingAllocation.used).toBe(0)
      } finally {
        while (closes.length !== 0) {
          await closes[closes.length - 1]()
          closes.pop()
        }
        await rm(directory, { recursive: true, force: true })
      }
    } finally {
      expectedHistory.fill(0)
      expectedNotify.fill(0)
    }
  },
  nativeStreamedCaseTimeoutMs
)
