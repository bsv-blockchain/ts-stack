import { withBrc38NativeCandidateContractFixture } from './Brc38NativeCandidateContractFixture'
import { verifyBrc38PrivateLocalBaselineInventory } from './Brc38PrivateLocalInventoryNode.case'
import {
  verifyBrc38PrivateLocalAllocationHistory,
  verifyBrc38PrivateLocalAllocationRegressionRefusal
} from './Brc38PrivateLocalSequencesNode.case'
import { verifySnapshotJournalNativePayloads } from '../snapshot/journal/SnapshotJournalNativePayload.case'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'
import { wipeIndependentNativeInventory } from './Brc38IndependentNativeInventoryFixture'
import { assertComposedAuxiliaryFixture } from './Brc38ComposedAuxiliaryFixture'
import type { Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import { verifyBrc38NativeLocalSnapshotRecoveryChanges } from './Brc38NativeLocalBaselineGenerationNode.case'
import { Brc38PublishedProfileNode } from './Brc38PublishedProfileNode'

// Full original coverage cases measured about 176 seconds, leaving almost no
// margin in the default three-minute fixture. Select one fixed whole-case
// lifetime; the extra 30 seconds is only for physical cleanup.
const nativeFixtureLifetimeMs = 300000
const nativeFixtureCaseTimeoutMs = nativeFixtureLifetimeMs + 30000

// UNRUN. Each negative runs on a fresh real all47 source/candidate pair. Only
// actual candidate rows/packed writers change; copied progress/point hashes
// remain unchanged so they cannot falsely substitute for the byte comparison.
test.each(['metadata', 'binary', 'text', 'empty-to-null', 'remove', 'extra'] as const)(
  'actual complete candidate inventory refuses an independent %s postimage change',
  async kind => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const rows = Object.values(fixture.initial).reduce((count, values) => count + values.length, 0),
          logicalBytes = Object.values(fixture.initial).reduce(
            (count, values) =>
              count +
              values.reduce(
                (total, row) =>
                  total + Object.values(row.fields).reduce((bytes, value) => bytes + (value?.length ?? 0), 0),
                0
              ),
            0
          )
        await fixture.prepareCopied()
        const copied = await fixture.readCandidate()
        try {
          expect(copied).toEqual(fixture.initial)
        } finally {
          wipeIndependentNativeInventory(copied)
        }
        await verifyBrc38PrivateLocalBaselineInventory(
          {
            withCandidate: fixture.withCandidate,
            workingUsed: () => fixture.options.workingAllocation.used,
            check: fixture.check,
            changeCandidate: async () => {
              await fixture.withWriter(async trx => {
                if (kind === 'metadata') {
                  expect(
                    await trx('monitor_events').where({ id: 400 }).update({ event: 'independent different event' })
                  ).toBe(1)
                } else if (kind === 'binary') {
                  await writeBrc38NativePackedBytes(
                    trx,
                    { table: 'action_batch_blobs', field: 'bytes', rowId: 403 },
                    Uint8Array.from([1, 254, 127, 2, 1])
                  )
                } else if (kind === 'text') {
                  const original = fixture.auxiliary.monitor_events.details
                  if (typeof original !== 'string') throw new Error('Independent monitor TEXT oracle missing')
                  const replacement = Buffer.from(original.replace('auxiliary', 'different'))
                  try {
                    expect(replacement.length).toBe(Buffer.byteLength(original))
                    await writeBrc38NativePackedTextBytes(
                      trx,
                      { table: 'monitor_events', field: 'details', rowId: 400 },
                      replacement
                    )
                  } finally {
                    replacement.fill(0)
                  }
                } else if (kind === 'empty-to-null') {
                  expect(await trx('action_batches').where({ actionBatchId: 402 }).update({ manifest: null })).toBe(1)
                } else if (kind === 'remove') {
                  expect(await trx('action_batch_blobs').where({ actionBatchBlobId: 403 }).delete()).toBe(1)
                } else {
                  await trx('monitor_events').insert({
                    id: -101,
                    created_at: '2026-10-08T00:00:00.000Z',
                    updated_at: '2026-10-08T00:00:00.000Z',
                    event: 'independent unmapped candidate row',
                    details: null
                  })
                }
              })
            }
          },
          { rows, logicalBytes: String(logicalBytes) }
        )
        await assertComposedAuxiliaryFixture(fixture.source.manager, fixture.auxiliary)
      },
      { lifetimeMs: nativeFixtureLifetimeMs }
    )
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'actual candidate preserves deleted-high AUTOINCREMENT history and idempotent sequence copying',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const expected = await withComposedFixtureRead(fixture.source.manager, async trx => {
          const schema = (await trx('sqlite_schema')
              .where({ type: 'table' })
              .whereIn('name', Object.keys(fixture.initial))
              .whereRaw("instr(lower(sql),'autoincrement')>0")
              .select('name')) as Array<{ name: Brc38NativeLocalBaselineTable }>,
            rows = (await trx('sqlite_sequence').select('name', trx.raw('CAST(seq AS TEXT) AS sequence'))) as Array<{
              name: string
              sequence: string
            }>
          return schema.map(row => ({
            table: row.name,
            sequence: rows.find(value => value.name === row.name)?.sequence ?? null
          }))
        })
        expect(expected.find(row => row.table === 'output_baskets')?.sequence).toBe('1600')
        expect(fixture.initial.output_baskets.every(row => row.rowId < 1600)).toBe(true)
        await fixture.prepareCopied()
        await fixture.withSource(
          async source =>
            await verifyBrc38PrivateLocalAllocationHistory(
              fixture.store,
              source,
              fixture.options,
              expected,
              fixture.check
            )
        )
      },
      { lifetimeMs: nativeFixtureLifetimeMs }
    )
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'actual all47 source clock observes snapshot checkpoint, mapping and primary epoch writes',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        const session = fixture.initial.snapshot_sync_sessions,
          mapping = fixture.initial.snapshot_sync_ids,
          primary = fixture.initial.snapshot_sync_primary_epochs
        if (
          session.length !== 1 ||
          mapping.length !== 1 ||
          primary.length !== 1 ||
          (typeof primary[0].metadata.epoch !== 'bigint' && typeof primary[0].metadata.epoch !== 'number')
        )
          throw new Error('Independent actual recovery coordinates differ')
        const epoch = String(BigInt(primary[0].metadata.epoch) + 1n)
        await verifyBrc38NativeLocalSnapshotRecoveryChanges(
          {
            expiresAt: fixture.source.expiresAt,
            withRead: async operation => await withComposedFixtureRead(fixture.source.manager, operation),
            withWriter: async operation =>
              await fixture.source.manager.runAsStorageProvider(async active => {
                if (active !== fixture.source.storage) throw new Error('Recovery fixture selected another source')
                return await Brc38PublishedProfileNode.withNativeImmediateSourceWriter(
                  fixture.source.storage,
                  operation
                )
              })
          },
          {
            sessionRowId: session[0].rowId,
            mappingRowId: mapping[0].rowId,
            epochRowId: primary[0].rowId,
            cursor: 'independent original checkpoint delta',
            localId: 2,
            epoch
          }
        )
      },
      { lifetimeMs: nativeFixtureLifetimeMs }
    )
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'actual candidate allocation history refuses a counter beyond its retained source without regression',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        await fixture.prepareCopied()
        // The helper checks the greater counter, rollback and exact inner
        // error identity. The original coherent source also drains/refuses
        // that failed callback; the owning test must observe its refusal.
        await expect(
          fixture.withSource(
            async source =>
              await verifyBrc38PrivateLocalAllocationRegressionRefusal(
                fixture.store,
                source,
                fixture.options,
                'output_baskets',
                '1601',
                fixture.check
              )
          )
        ).rejects.toThrow(
          'Private local allocation history differs from the original source, actual candidate or complete copy'
        )
      },
      { lifetimeMs: nativeFixtureLifetimeMs }
    )
  },
  nativeFixtureCaseTimeoutMs
)

test(
  'actual packed journal payload writers preserve logical quota and caught outer rollback',
  async () => {
    await withBrc38NativeCandidateContractFixture(
      async fixture => {
        await fixture.prepareCopied()
        const page = fixture.auxiliary.snapshot_reconciliation_stage_pages,
          provenance = fixture.auxiliary.snapshot_reconciliation_provenance,
          original = Uint8Array.from([0, 255, 128, 1, 0]),
          replacement = Uint8Array.from([1, 254, 127, 2, 1])
        try {
          await verifySnapshotJournalNativePayloads(fixture, [
            {
              table: 'snapshot_reconciliation_stage_pages',
              key: {
                userId: page.userId,
                sourceStorageIdentity: page.sourceStorageIdentity,
                sessionId: page.sessionId,
                binding: page.binding,
                sequence: 0,
                ordinal: 0
              },
              original,
              replacement
            },
            {
              table: 'snapshot_reconciliation_provenance',
              key: { userId: provenance.userId, lineage: provenance.lineage, incomingId: 20 },
              original,
              replacement
            }
          ])
        } finally {
          original.fill(0)
          replacement.fill(0)
        }
        await assertComposedAuxiliaryFixture(fixture.source.manager, fixture.auxiliary)
      },
      { lifetimeMs: nativeFixtureLifetimeMs }
    )
  },
  nativeFixtureCaseTimeoutMs
)
