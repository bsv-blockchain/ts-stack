import { nativeTestExecutable } from './Brc38NativeTestPath'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Brc38StagingAdmissionNode } from './Brc38StagingAdmissionNode'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import {
  brc38PrivateRequestTxidAccepted,
  withBrc38PrivateOccupiedRequestSources
} from './Brc38PrivateOccupiedRequestSourcesNode'
import { brc38PrivateRequestPostimageMetadata } from './Brc38PrivateRequestInventoryNode'
import { brc38ImportRequestMetadata } from '../snapshot/SnapshotSyncRequestMetadata'
import { brc38NativeLocalPackedFamilyDefinitions } from './Brc38NativeLocalPackedLayout'
import { insertBrc38PackedRestoreMetadata, updateBrc38PackedPrivateMetadata } from './Brc38PackedRestoreMetadataNode'
import { writeBrc38NativePackedBytes } from './Brc38NativePackedFieldsNode'
import { writeBrc38NativePackedTextBytes } from './Brc38NativePackedTextFieldsNode'
import { hasBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { snapshotJournalNativeDestinationExtras } from '../snapshot/journal/SnapshotJournalNativeDestinationSchema'
import { verifySnapshotJournalDestinationSchema } from '../snapshot/journal/SnapshotJournalDestinationSchema'
import { brc38NativeCompactPackedDefinitions } from './Brc38NativeLocalPackedLayout'
import { brc38PreparedFieldVersionGuard } from './Brc38NativePreparedFieldSchemaNode'
import {
  brc38NativePackedTextBaseDefinitions,
  brc38NativePackedTextSourceDefinitions
} from './Brc38NativePackedTextSchemaNode'
import { compactBrc38NativeTargetIndexes } from './Brc38NativeTargetIndexCompactionNode'
import {
  withBrc38NativePrivateContractFixture,
  type Brc38NativePrivateContractFixture
} from './Brc38NativePrivateContractFixture'
import {
  verifyBrc38NativeLocalPackedLayout,
  verifyBrc38NativeLocalPackedOccupiedRefusal,
  verifyBrc38NativeLocalPackedProofSeedRefusal
} from './Brc38NativeLocalPackedLayoutNode.case'
import { verifyNativePreparedFieldLifetimes } from './Brc38NativePreparedFieldsNode.case'
import { verifyNativePackedMissingPointerRefusal } from './Brc38NativePackedDescriptorNode.case'
import {
  verifyBrc38NativeLocalBaselineRevisionExhaustion,
  verifyBrc38NativeLocalBaselineCapacityExhaustion,
  verifyBrc38NativeLocalBaselineUnsafeKeyRefusal,
  verifyBrc38NativeLocalBaselineGeneration
} from './Brc38NativeLocalBaselineGenerationNode.case'
import {
  verifyBrc38NativeLocalEpochRecovery,
  verifyBrc38NativeLocalEpochUnsafeActivationRefusal
} from './Brc38NativeLocalEpochRecoveryNode.case'
import { brc38NativeLocalBaselineTables, type Brc38NativeLocalBaselineTable } from './Brc38NativeLocalBaselineTables'
import { verifyPrivatePageIds } from './Brc38PrivatePageIdsNode.case'
import { verifyBrc38NativeLocalPackedTransfer } from './Brc38NativeLocalPackedWalletNode.case'
import { installBrc38NativeLocalPackedLayout } from './Brc38NativeLocalPackedLayoutNode'
import { KnexSyncTransferStore } from '../remoting/KnexSyncTransferStore'
import { validateSyncTransferCapabilities } from '../remoting/SyncTransfer'
import { verifyPrivateDerivedTextVersions } from './Brc38PrivateDerivedTextVersionNode.case'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import {
  verifyBrc38PrivateLocalCandidateJournal,
  verifyBrc38PrivateLocalCandidateTwoPassJournal,
  verifyBrc38PrivateLocalCandidateClearJournal
} from './Brc38PrivateLocalCandidateJournalNode.case'
import { createHash } from 'node:crypto'
import {
  installBrc38NativeLocalBaselineGeneration,
  hasBrc38NativeLocalBaselineGenerationSchema,
  brc38NativeLocalBaselineSourceDefinitions,
  readBrc38NativeLocalBaselineGeneration
} from './Brc38NativeLocalBaselineGenerationNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  metadata,
  readPlan,
  validateInstalled,
  addSnapshotSqliteSourceIndexes
} from '../schema/snapshotSqliteIndexGeneration'
import {
  hasBrc38NativePackedSchema,
  brc38NativePackedBinaryBaseDefinitions,
  brc38NativePackedBinarySourceDefinitions
} from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import { hasBrc38NativePreparedFieldsSchema } from './Brc38NativePreparedFieldSchemaNode'
import { readBoundedSnapshotJournalSqliteSchema } from '../snapshot/journal/SnapshotJournalSqliteGeneration'

import {
  brc38ImportTargetIndexName,
  brc38ImportTargetIndexStatements,
  verifyBrc38ImportTargetIndexes
} from './Brc38ImportTargetIndexes'

import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { readBrc38NativeLocalFieldBytes, withBrc38NativeLocalFieldExtent } from './Brc38NativeLocalFieldReadNode'
import { readBrc38NativeTextBytes, readBrc38NativeTextExtent } from './Brc38NativeTextReadNode'
import {
  SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL,
  snapshotJournalSqliteObserverSql,
  snapshotJournalSharedClockObserverSql
} from '../snapshot/journal/SnapshotJournalSqliteObservers'

import { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { withBrc38PrivateContentVersion } from './Brc38PrivateContentVersionNode'
import { compareBrc38PrivateDerivedText } from './Brc38PrivateDerivedTextComparisonNode'

test.each([
  { name: 'lowercase', txid: 'ab'.repeat(32), accepted: true },
  { name: 'uppercase', txid: 'AB'.repeat(32), accepted: true },
  { name: 'mixed case', txid: 'aB'.repeat(32), accepted: true },
  { name: 'short', txid: 'ab'.repeat(31), accepted: false },
  { name: 'long', txid: 'ab'.repeat(33), accepted: false },
  { name: 'nonhex', txid: 'ag'.repeat(32), accepted: false },
  { name: 'leading space', txid: ' ' + 'ab'.repeat(32), accepted: false },
  { name: 'trailing space', txid: 'ab'.repeat(32) + ' ', accepted: false },
  { name: 'final newline', txid: 'ab'.repeat(32) + '\n', accepted: false },
  { name: 'nonASCII', txid: '\u0430b'.repeat(32), accepted: false }
])('occupied request source accepts exactly the portable HEX grammar: $name', ({ txid, accepted }) => {
  expect(brc38PrivateRequestTxidAccepted(txid)).toBe(accepted)
})

test('actual occupied request source preserves uppercase indexed identity and revokes readers', async () => {
  await withBrc38NativePrivateContractFixture(
    async fixture => {
      const txid = 'A'.repeat(64),
        metadata = {
          created_at: new Date('2026-10-03T00:00:00.000Z'),
          updated_at: new Date('2026-10-03T00:00:00.000Z'),
          provenTxReqId: 0,
          status: 'completed',
          attempts: 2,
          notified: false,
          txid
        },
        id = await fixture.withWriter(async trx => {
          const id = await insertBrc38PackedRestoreMetadata(
            fixture.storage,
            trx,
            'provenTxReqs',
            metadata,
            [],
            { maximum: 16777216, remaining: 16777216 },
            ['history', 'notify']
          )
          if (typeof id !== 'number') throw new Error('Actual request insert did not return its physical ID')
          for (const field of ['history', 'notify'] as const)
            await writeBrc38NativePackedTextBytes(trx, { table: 'provenTxReqs', field, rowId: id }, Buffer.from('{}'))
          return id
        }),
        working = new Brc38WorkingAllocation(16777216),
        source = {
          privateIndexParent: fixture.privateIndexParent,
          maximumTemporaryIndexBytes: 2097152,
          maximumIndexMembers: 10000,
          maximumStructuredBytes: 65536,
          maximumCanonicalBytes: 65536,
          maximumReadBytes: 1024,
          maximumCombinedTemporaryBytes: 10485760,
          workingAllocation: working,
          expiresAt: fixture.store.limits.expiresAt
        },
        projection = {
          maximumTemporaryIndexBytes: 6291456,
          maximumMembers: 10000,
          maximumOutputBytes: 65536,
          maximumReadBytes: 1024,
          workingAllocation: working,
          expiresAt: fixture.store.limits.expiresAt
        }
      let escaped: import('./Brc38StructuredJson').Brc38StreamedStructured | undefined,
        consumed = false
      await withBrc38PrivateOccupiedRequestSources(
        fixture.store,
        fixture.storage,
        0,
        id,
        txid,
        'history',
        source,
        projection,
        async sources => {
          sources.owners.check()
          const incoming = await sources.incoming.read(0, sources.incoming.length),
            current = await sources.current.read(0, sources.current.length)
          try {
            expect(JSON.parse(Buffer.from(incoming).toString(sources.incoming.encoding))).toEqual({ notes: [] })
            expect(Buffer.from(current).toString(sources.current.encoding)).toBe('{}')
            expect(sources.prior.bytes).toBe(2)
            escaped = sources.current
            consumed = true
          } finally {
            incoming.fill(0)
            current.fill(0)
          }
          sources.owners.check()
        }
      )
      expect(consumed).toBe(true)
      await expect(escaped!.read(0, 1)).rejects.toThrow()
      for (const wrong of [
        { id, txid: txid.toLowerCase() },
        { id: id + 1, txid }
      ]) {
        let reached = false
        await expect(
          withBrc38PrivateOccupiedRequestSources(
            fixture.store,
            fixture.storage,
            0,
            wrong.id,
            wrong.txid,
            'history',
            source,
            projection,
            async () => {
              reached = true
            }
          )
        ).rejects.toThrow()
        expect(reached).toBe(false)
        expect(working.used).toBe(0)
      }
      expect(await fixture.withRead(async trx => await trx('proven_tx_reqs').select('provenTxReqId', 'txid'))).toEqual([
        { provenTxReqId: id, txid }
      ])
      expect(working.used).toBe(0)
    },
    'before-journal',
    16777216,
    undefined,
    16777216,
    data => {
      for (const table of ['provenTxs', 'provenTxReqs', 'transactions'] as const)
        data.tables[table][0].txid = 'A'.repeat(64)
    },
    true
  )
}, 30000)

test.each([
  { name: 'omitted', fields: {}, expected: { wasBroadcast: 0, rebroadcastAttempts: 0 } },
  {
    name: 'own undefined',
    fields: { wasBroadcast: undefined, rebroadcastAttempts: undefined },
    expected: { wasBroadcast: 0, rebroadcastAttempts: 0 }
  },
  {
    name: 'explicit false and zero',
    fields: { wasBroadcast: false, rebroadcastAttempts: 0 },
    expected: { wasBroadcast: 0, rebroadcastAttempts: 0 }
  },
  {
    name: 'explicit true and retries',
    fields: { wasBroadcast: true, rebroadcastAttempts: 3 },
    expected: { wasBroadcast: 1, rebroadcastAttempts: 3 }
  }
])(
  'native request metadata preserves legacy defaults and explicit counters: $name',
  async ({ fields, expected }) => {
    await withBrc38NativePrivateContractFixture(async fixture => {
      const bytes = Uint8Array.from([0, 255, 7, 8]),
        metadata = {
          created_at: new Date('2026-10-03T00:00:00.000Z'),
          updated_at: new Date('2026-10-03T00:00:00.000Z'),
          provenTxReqId: 0,
          status: 'completed',
          attempts: 2,
          notified: false,
          txid: 'ab'.repeat(32),
          ...fields
        },
        budget = () => ({ maximum: 16777216, remaining: 16777216 }),
        insert = async (trx: import('knex').Knex.Transaction): Promise<number> => {
          const id = await insertBrc38PackedRestoreMetadata(
            fixture.storage,
            trx,
            'provenTxReqs',
            metadata,
            ['rawTx'],
            budget(),
            ['history', 'notify']
          )
          if (typeof id !== 'number') throw new Error('Actual request insert did not return its physical ID')
          expect(Number.isSafeInteger(id)).toBe(true)
          expect(id).toBeGreaterThan(0)
          await writeBrc38NativePackedBytes(trx, { table: 'provenTxReqs', field: 'rawTx', rowId: id }, bytes)
          for (const field of ['history', 'notify'] as const)
            await writeBrc38NativePackedTextBytes(trx, { table: 'provenTxReqs', field, rowId: id }, Buffer.from('{}'))
          expect(
            await trx('proven_tx_reqs').where({ provenTxReqId: id }).first('wasBroadcast', 'rebroadcastAttempts')
          ).toEqual(expected)
          expect(
            await trx.raw(
              'SELECT typeof(wasBroadcast) AS broadcastType,typeof(rebroadcastAttempts) AS retriesType FROM proven_tx_reqs WHERE provenTxReqId=?',
              [id]
            )
          ).toEqual([{ broadcastType: 'integer', retriesType: 'integer' }])
          // Compare the actual SQL postimage to the complete reconstruction,
          // using genuine parsed legacy omissions rather than assuming NULL.
          const parsed = brc38ImportRequestMetadata(
              { ...metadata, provenTxReqId: id },
              {
                rawTx: { kind: 'binary', bytes: bytes.length },
                history: { kind: 'utf8', bytes: 2 },
                notify: { kind: 'utf8', bytes: 2 }
              }
            ),
            reconstructed = brc38PrivateRequestPostimageMetadata({
              ...parsed,
              rawTx: { origin: 'inline', value: bytes },
              history: { origin: 'inline', value: '{}' },
              notify: { origin: 'inline', value: '{}' }
            }),
            stored = await trx('proven_tx_reqs')
              .where({ provenTxReqId: id })
              .select(Object.keys(reconstructed))
              .options({ safeIntegers: true })
          expect(stored).toEqual([reconstructed])
          return id
        },
        rollback = new Error('Independent complete request metadata rollback')
      await expect(
        fixture.withWriter(async trx => {
          await insert(trx)
          throw rollback
        })
      ).rejects.toBe(rollback)
      expect(await fixture.withRead(async trx => await trx('proven_tx_reqs').count({ count: '*' }).first())).toEqual({
        count: 0
      })
      const id = await fixture.withWriter(insert)
      await fixture.withWriter(async trx => {
        await trx('proven_tx_reqs').where({ provenTxReqId: id }).update({ wasBroadcast: 1, rebroadcastAttempts: 7 })
        expect(
          await updateBrc38PackedPrivateMetadata(
            fixture.storage,
            trx,
            'provenTxReqs',
            { ...metadata, provenTxReqId: id, wasBroadcast: undefined, rebroadcastAttempts: undefined, attempts: 3 },
            [],
            { table: 'provenTxReqs', index: 'provenTxReqs', key: { txid: metadata.txid }, found: true, localId: id },
            budget()
          )
        ).toBe(id)
        expect(
          await trx('proven_tx_reqs')
            .where({ provenTxReqId: id })
            .first('wasBroadcast', 'rebroadcastAttempts', 'attempts')
        ).toEqual({ wasBroadcast: 1, rebroadcastAttempts: 7, attempts: 3 })
      })
    })
  },
  30000
)

test('native destination extras retain actual literal and occupied compact packed guards', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const rollback = new Error('Independent destination family rollback')
    await expect(
      fixture.withWriter(async trx => {
        const base = brc38NativeCompactPackedDefinitions('binary', brc38NativePackedBinaryBaseDefinitions)
        await installBrc38NativeLocalPackedLayout(trx)
        const tables = ['snapshot_reconciliation_stage_pages', 'snapshot_reconciliation_provenance']
        const inspect = async (literal: boolean): Promise<void> => {
          expect(await hasBrc38NativePackedSchema(trx)).toBe(true)
          const extra = await snapshotJournalNativeDestinationExtras(trx, tables)
          expect(extra.length).toBe(16)
          expect(new Set(extra).size).toBe(16)
          for (const sql of extra) {
            const name = /^CREATE TRIGGER (\w+) /.exec(sql)![1]
            expect((await trx('main.sqlite_schema').where({ name, type: 'trigger' }).first('sql'))?.sql).toBe(sql)
          }
          for (const table of tables)
            expect(extra).toContain(
              `CREATE TRIGGER brc38_native_binary_${table}_payload_insert BEFORE INSERT ON ${table} WHEN (NEW.payload IS NOT NULL AND (${literal ? "NEW.payload IS NOT X''" : "typeof(NEW.payload)!='blob' OR length(NEW.payload)!=0"})) BEGIN SELECT RAISE(ABORT,'Packed native payload requires its bounded field writer'); END`
            )
          await verifySnapshotJournalDestinationSchema(trx)
        }
        await inspect(true)
        const compact = brc38NativeCompactPackedDefinitions(
          'binary',
          brc38NativeLocalPackedFamilyDefinitions('binary', base)
        )
        for (const original of compact) {
          if (!original.startsWith('CREATE TRIGGER ')) continue
          const sql = original.startsWith('CREATE TRIGGER brc38_native_binary_versions_update_guard ')
            ? brc38PreparedFieldVersionGuard('binary', original)
            : original
          const name = /^CREATE TRIGGER (\w+) /.exec(sql)![1]
          const current = await trx('main.sqlite_schema').where({ name, type: 'trigger' }).first('sql')
          if (current?.sql !== sql) {
            await trx.raw('DROP TRIGGER ??', [name])
            await trx.raw(sql)
          }
        }
        await inspect(false)
        await trx.raw('SAVEPOINT independent_destination_extra')
        await trx.raw('DROP TRIGGER brc38_native_binary_snapshot_reconciliation_stage_pages_payload_insert')
        await expect(snapshotJournalNativeDestinationExtras(trx, tables)).rejects.toThrow()
        await trx.raw('ROLLBACK TO independent_destination_extra')
        await trx.raw('RELEASE independent_destination_extra')
        await inspect(false)
        throw rollback
      })
    ).rejects.toBe(rollback)
    expect(await fixture.withRead(hasBrc38NativeLocalPackedLayout)).toBe(false)
    fixture.check()
  })
}, 30000)

test('native fresh local observer owns one primary tree and refuses mixed historical emitters', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const physical = async () => ({
          pages: (await trx.raw('PRAGMA page_count'))[0].page_count,
          maximumPages: (await trx.raw('PRAGMA max_page_count'))[0].max_page_count,
          freePages: (await trx.raw('PRAGMA freelist_count'))[0].freelist_count,
          schema: (await trx('sqlite_schema').first(
            trx.raw('sum(length(CAST(sql AS BLOB))) AS sqlBytes,sum(rootpage>0) AS roots')
          )) as { sqlBytes: number; roots: number }
        }),
        before = await physical()
      await installBrc38NativeLocalBaselineGeneration(trx, {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('100000')
      })
      expect(await hasBrc38NativeLocalBaselineGenerationSchema(trx)).toBe(true)
      console.info(
        JSON.stringify({
          stage: 'independent-local-layout-geometry',
          before,
          after: await physical(),
          fullSystemQualified: false
        })
      )
      const row = await trx('sqlite_schema').where({ type: 'table', name: 'brc38_local_baseline_rows' }).first('sql')
      expect(row.sql).toMatch(/ WITHOUT ROWID$/)
      expect(
        await trx('sqlite_schema')
          .where({ type: 'index', tbl_name: 'brc38_local_baseline_rows' })
          .whereNull('sql')
          .select('name')
      ).toEqual([])
      expect(
        (
          await trx('sqlite_schema')
            .where({ type: 'index', tbl_name: 'brc38_local_baseline_rows' })
            .orderBy('name')
            .select('name')
        ).map(({ name }) => name)
      ).toEqual([
        'brc38_local_baseline_deleted_order',
        'brc38_local_baseline_present_revision',
        'brc38_local_baseline_revision'
      ])
      // SQLite resolves rowid to the declared rowId column, case-insensitively.
      // Observe physical layout rather than treating that alias as a hidden key.
      const tables: Array<{ name: string; wr: number }> = await trx.raw('PRAGMA table_list'),
        indexes: Array<{ origin: string; name: string }> = await trx.raw('PRAGMA index_list(brc38_local_baseline_rows)')
      expect(tables.find(table => table.name === 'brc38_local_baseline_rows')?.wr).toBe(1)
      expect(indexes.filter(index => index.origin === 'pk')).toHaveLength(1)
      await trx('monitor_events').select(trx.raw('rowid')).limit(1)
      const selected = await brc38NativeLocalBaselineSourceDefinitions(trx),
        original = selected.find(sql => sql.startsWith('CREATE TRIGGER brc38_local_baseline_monitor_events_insert '))!
      expect(original).toBe(
        'CREATE TRIGGER brc38_local_baseline_monitor_events_insert AFTER INSERT ON monitor_events BEGIN INSERT INTO brc38_local_baseline_event VALUES(15,NULL,NEW.rowid,1); END'
      )
      await trx.raw('SAVEPOINT independent_mixed_local_observer')
      try {
        await trx.raw('DROP TRIGGER brc38_local_baseline_monitor_events_insert')
        await trx.raw(
          original.replace(
            'brc38_local_baseline_event VALUES',
            'brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES'
          )
        )
        await expect(hasBrc38NativeLocalBaselineGenerationSchema(trx)).rejects.toThrow(
          'Local baseline original generation, schema or progress differs'
        )
      } finally {
        await trx.raw('ROLLBACK TO independent_mixed_local_observer')
        await trx.raw('RELEASE independent_mixed_local_observer')
      }
      expect(await hasBrc38NativeLocalBaselineGenerationSchema(trx)).toBe(true)
      expect((await readBrc38NativeLocalBaselineGeneration(trx)).records).toBe(0)
    })
  })
}, 30000)

test('positional native journal preserves actual source events and occupied complete emitters', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const before = await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)
      const orders = [
        ['guard', ['valid']],
        ['scope', ['tableId', 'userId', 'id1', 'id2', 'exactText', 'revision', 'present']],
        ['physical', ['tableId', 'id1', 'id2', 'exactText', 'revision', 'generation', 'present', 'fresh']],
        ['advance', ['event']],
        ['member', ['tableId', 'userId', 'id1', 'id2', 'exactText', 'present']],
        [
          'source',
          [
            'event',
            'tableId',
            'id1',
            'id2',
            'exactText',
            'userId',
            'oldId1',
            'oldId2',
            'oldExactText',
            'oldUserId',
            'fresh'
          ]
        ],
        ['pointer', ['tableId', 'rowId']]
      ] as const
      for (const [name, columns] of orders) {
        fixture.check()
        const actual = await trx.raw('PRAGMA main.table_xinfo(??)', ['snapshot_journal_' + name + '_event'])
        expect(actual.map((row: { name: string }) => row.name)).toEqual(columns)
        expect(actual.every((row: { dflt_value: unknown }) => row.dflt_value === null)).toBe(true)
      }
      const fresh = await trx('main.sqlite_schema')
        .where({ name: 'snapshot_journal_physical_0_UPDATE', type: 'trigger' })
        .first('sql')
      expect(fresh.sql).toContain('INSERT INTO snapshot_journal_source_event VALUES(')
      expect(fresh.sql).not.toContain('INSERT INTO snapshot_journal_source_event(')
      const exercise = async (signed = false) => {
        const originalId = signed ? -17 : 17,
          movedId = signed ? -19 : 19
        await trx.raw('SAVEPOINT __positional_source_events')
        try {
          await trx('users').insert({
            userId: 76,
            identityKey: 'synthetic-positional-owner',
            activeStorage: 'synthetic-positional-storage',
            created_at: 0,
            updated_at: 0
          })
          await trx('sync_states').insert({
            syncStateId: originalId,
            userId: 76,
            storageName: 'synthetic source',
            refNum: 'synthetic-positional-ref',
            syncMap: '',
            created_at: 0,
            updated_at: 0
          })
          await trx('sync_states')
            .where({ syncStateId: originalId })
            .update({ syncStateId: movedId, storageName: 'synthetic moved' })
          await trx('sync_states').where({ syncStateId: movedId }).delete()
          const physical = (await trx('snapshot_journal_physical')
            .where({ tableId: 7 })
            .orderBy('id1')
            .select('id1', 'id2', 'exactText', 'present', 'revision', 'generation')) as Array<{
            id1: number
            id2: number
            exactText: string
            present: number
            revision: number
            generation: number
          }>
          const scope = (await trx('snapshot_journal_scope')
            .where({ tableId: 7, userId: 76 })
            .orderBy('id1')
            .select('id1', 'id2', 'exactText', 'present', 'revision')) as Array<{
            id1: number
            id2: number
            exactText: string
            present: number
            revision: number
          }>
          const expected = [originalId, movedId]
            .sort((left, right) => left - right)
            .map(id1 => ({ id1, id2: 0, exactText: '', present: 0 }))
          expect(physical.map(({ id1, id2, exactText, present }) => ({ id1, id2, exactText, present }))).toEqual(
            expected
          )
          expect(scope.map(({ id1, id2, exactText, present }) => ({ id1, id2, exactText, present }))).toEqual(expected)
          expect(await trx('snapshot_journal_clock').where({ id: 1 }).first('enabled', 'reason')).toEqual({
            enabled: 1,
            reason: null
          })
          for (const [name] of orders) expect(await trx('snapshot_journal_' + name + '_event')).toEqual([])
          return { physical, scope, clock: await trx('snapshot_journal_clock').where({ id: 1 }).first() }
        } finally {
          await trx.raw('ROLLBACK TO __positional_source_events')
          await trx.raw('RELEASE __positional_source_events')
        }
      }
      const currentEffects = await exercise()
      const signedEffects = await exercise(true)
      expect(await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).toEqual(before)
      await trx.raw('SAVEPOINT __positional_historical_family')
      try {
        const historical = [
          ...SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL,
          ...snapshotJournalSharedClockObserverSql(
            await snapshotJournalSqliteObserverSql(trx, true, true, true),
            true,
            true
          )
        ]
        for (const sql of historical) {
          const match = /^CREATE TRIGGER (snapshot_journal_\w+) /.exec(sql)
          if (match === null) continue
          fixture.check()
          const installed = await trx('main.sqlite_schema').where({ name: match[1], type: 'trigger' }).first('sql')
          if (installed.sql === sql) continue
          await trx.raw('DROP TRIGGER ??', [match[1]])
          await trx.raw(sql)
        }
        expect(await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).toEqual(before)
        expect(await exercise()).toEqual(currentEffects)
        // Exact complete old helpers cannot adopt one new positional emitter.
        await trx.raw('DROP TRIGGER snapshot_journal_physical_0_UPDATE')
        await trx.raw(fresh.sql)
        await expect(readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).rejects.toThrow(
          'Invalid or unowned'
        )
      } finally {
        await trx.raw('ROLLBACK TO __positional_historical_family')
        await trx.raw('RELEASE __positional_historical_family')
      }
      expect(await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).toEqual(before)
      expect(await exercise()).toEqual(currentEffects)
      expect(await exercise(true)).toEqual(signedEffects)
      expect((await trx.raw('PRAGMA max_page_count'))[0].max_page_count).toBe(1360)
    })
  }, 'after-journal')
}, 30000)

test('native content subleases preserve the original deadline and refuse renewal or invalid bounds', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const working = new Brc38WorkingAllocation(fixture.store.limits.maximumRowAllocationBytes),
      budget = () => ({ maximum: working.maximum, remaining: working.maximum }),
      descriptor = Object.freeze({ bytes: 2, sha256: '7'.repeat(64) }),
      rejected = jest.fn(async () => undefined)
    expect(await fixture.store.knex.raw('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }])
    const released = jest.fn()
    expect(fixture.store.deferExpiredPrivatePhysicalRelease(released)).toBe(false)
    expect(released).not.toHaveBeenCalled()
    for (const expiresAt of [NaN, Infinity, Date.now() - 1, fixture.store.operationExpiresAt + 1]) {
      const policy = { expiresAt, workingAllocation: working }
      await expect(Brc38PrivateDerivedTextLifetimes.with(fixture.store, policy, rejected)).rejects.toThrow()
      await expect(
        withBrc38PrivateContentVersion(
          'structured-text',
          fixture.store,
          { ...policy, maximumBytes: 2 },
          budget(),
          rejected
        )
      ).rejects.toThrow()
      await expect(
        compareBrc38PrivateDerivedText(fixture.store, descriptor, descriptor, policy, budget())
      ).rejects.toThrow()
      expect(working.used).toBe(0)
    }
    expect(rejected).not.toHaveBeenCalled()
    const expiresAt = Math.min(fixture.expiresAt, Date.now() + 60000),
      policy = { expiresAt, workingAllocation: working }
    expect(expiresAt).toBeLessThan(fixture.store.operationExpiresAt)
    let escaped: Brc38PrivateDerivedTextLifetimes | undefined
    await Brc38PrivateDerivedTextLifetimes.with(fixture.store, policy, async lifetimes => {
      escaped = lifetimes
      lifetimes.assertOwner(fixture.store, expiresAt)
      // A caller-visible property cannot replace the captured private deadline.
      Object.assign(lifetimes, { expiresAt: fixture.store.operationExpiresAt })
      lifetimes.assertOwner(fixture.store, expiresAt)
      expect(() => lifetimes.assertOwner(fixture.store, fixture.store.operationExpiresAt)).toThrow()
      expect(() => lifetimes.assert(fixture.store, new Brc38WorkingAllocation(8388608), expiresAt)).toThrow()
      await expect(
        withBrc38PrivateContentVersion(
          'structured-text',
          fixture.store,
          { ...policy, expiresAt: fixture.store.operationExpiresAt, maximumBytes: 2 },
          budget(),
          rejected,
          undefined,
          lifetimes
        )
      ).rejects.toThrow()
      expect(working.used).toBe(4096)
    })
    expect(escaped).toBeDefined()
    expect(() => escaped!.assertOwner(fixture.store, expiresAt)).toThrow()
    expect(rejected).not.toHaveBeenCalled()
    expect(working.used).toBe(0)
  })
}, 30000)

test('actual original native expiry retains derived TEXT charges until physical owner drainage', async () => {
  let working: Brc38WorkingAllocation | undefined,
    lifetimeClosed = false,
    privateDirectory: string | undefined
  await expect(
    withBrc38NativePrivateContractFixture(async fixture => {
      privateDirectory = fixture.privateIndexParent
      working = new Brc38WorkingAllocation(fixture.store.limits.maximumRowAllocationBytes)
      const expiresAt = fixture.store.limits.expiresAt,
        policy = { expiresAt, workingAllocation: working },
        bytes = Buffer.from('{}'),
        descriptor = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
        rejectedWriter = jest.fn(async () => undefined)
      await expect(
        Brc38PrivateDerivedTextLifetimes.with(fixture.store, policy, async lifetimes => {
          await withBrc38PrivateContentVersion(
            'structured-text',
            fixture.store,
            { ...policy, maximumBytes: bytes.length },
            { maximum: working!.maximum, remaining: working!.maximum },
            async version => {
              await version.begin(descriptor)
              await version.append(0, bytes)
              expect(await version.finish()).toEqual(descriptor)
            },
            undefined,
            lifetimes
          )
          expect(working!.used).toBe(8192)
          await fixture.withRead(async trx => {
            const holds = await trx('brc38_native_prepared_fields').select('family', 'sha256', 'expiresAt')
            expect(holds).toEqual([{ family: 'text', sha256: descriptor.sha256, expiresAt }])
          })
          // Wait for the real original three-minute admission. No fake clock,
          // renewed reservation, shorter sublease or changed fixture default.
          await new Promise(resolve => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 25))
          expect(Date.now()).toBeGreaterThanOrEqual(expiresAt)
          expect(fixture.store.limits.expiresAt).toBe(expiresAt)
          expect(() => lifetimes.assertOwner(fixture.store, expiresAt)).toThrow()
          await expect(fixture.store.withPrivateNativeDatabase(false, rejectedWriter)).rejects.toThrow('expired')
          expect(rejectedWriter).not.toHaveBeenCalled()
        })
      ).resolves.toBeUndefined()
      lifetimeClosed = true
      // The lifetime callback has ended, but the real store's kernel and SQL
      // facade still belong to the fixture. Expiry alone refunds no metadata.
      expect(working.used).toBe(8192)
      expect(() => fixture.store.assertPrivateNativeDestination(fixture.store.knex)).toThrow()
    }, 'after-journal')
  ).rejects.toThrow(/expired|original finite lifetime/)
  expect(lifetimeClosed).toBe(true)
  expect(working).toBeDefined()
  expect(working!.used).toBe(0)
  expect(privateDirectory).toBeDefined()
  await expect(import('node:fs/promises').then(async fs => await fs.stat(privateDirectory!))).rejects.toMatchObject({
    code: 'ENOENT'
  })
}, 240000)

test.each(['discard', 'close'] as const)(
  'actual expired native disposal retries retained metadata through %s without repeating physical removal',
  async retry => {
    const directory = await fs.mkdtemp(join(tmpdir(), 'brc38-native-disposal-retry-')),
      root = await Brc38StagingAdmissionNode.create(directory, {
        maximumImports: 1,
        maximumPhysicalBytes: 7340032,
        maximumLogicalBytes: 1048576
      })
    let native: Awaited<ReturnType<typeof root.resumeNative>> | undefined
    try {
      const bytes = await encrypted(),
        selected = authenticatedStageOptions(bytes),
        limits = { ...selected.limits, expiresAt: Date.now() + 10000 }
      selected.limits = limits
      async function* chunks() {
        for (let offset = 0; offset < bytes.length; offset += 137) yield bytes.slice(offset, offset + 137)
      }
      const first = await stageAuthenticatedBrc39PrivateImport(chunks(), authenticatedStagePassword, root, selected)
      await first.reservation.store.close()
      native = await root.resumeNative(first.reservation.id, limits, selected.binding, nativeTestExecutable())
      const store = native.store,
        working = new Brc38WorkingAllocation(limits.maximumRowAllocationBytes),
        charge = working.claim(8192),
        fault = new Error('original metadata observer refusal'),
        release = jest.fn((): void => {
          if (release.mock.calls.length === 1) throw fault
          charge.close()
        })
      expect(store.deferExpiredPrivatePhysicalRelease(release)).toBe(false)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, limits.expiresAt - Date.now()) + 25))
      expect(Date.now()).toBeGreaterThanOrEqual(limits.expiresAt)
      expect(store.limits.expiresAt).toBe(limits.expiresAt)
      expect(store.deferExpiredPrivatePhysicalRelease(release)).toBe(true)
      const removal = jest.spyOn(fs, 'rm')
      try {
        await expect(store.discard(fault)).rejects.toBe(fault)
        expect(release).toHaveBeenCalledTimes(1)
        expect(working.used).toBe(8192)
        expect(await fs.readdir(directory)).toEqual(['brc38-admission.sqlite'])
        expect(() => store.assertPrivateNativeDestination(store.knex)).toThrow()
        expect((await root.usage()).imports).toBe(1)
        await expect(retry === 'close' ? store.close() : store.discard(fault)).resolves.toBeUndefined()
        expect(release).toHaveBeenCalledTimes(2)
        expect(working.used).toBe(0)
        expect(removal).toHaveBeenCalledTimes(1)
        await store.close()
        await store.discard(fault)
        expect(release).toHaveBeenCalledTimes(2)
        expect(removal).toHaveBeenCalledTimes(1)
      } finally {
        removal.mockRestore()
      }
      // JS metadata release does not refund persisted catalog reservations.
      expect((await root.usage()).imports).toBe(1)
      expect(await root.collectExpired(1)).toBe(1)
      expect(await root.usage()).toEqual({ imports: 0, physicalBytes: 3145728, logicalBytes: 0 })
    } finally {
      await native?.store.close()
      await root.close()
      await fs.rm(directory, { recursive: true, force: true })
    }
  },
  30000
)

test('complete native journal owns compact key trees and refuses an extra attached clock consumer', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const before = await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)
      expect(before.complete).toBe(true)
      const witnessTables = [
        'transactions',
        'outputs',
        'certificates',
        'tx_labels',
        'output_baskets',
        'output_tags',
        'commissions',
        'sync_states',
        'proven_txs',
        'proven_tx_reqs'
      ]
        .map(table => 'snapshot_identity_' + table)
        .sort()
      const witnesses = await trx('main.sqlite_schema')
        .where({ type: 'table' })
        .whereRaw('substr(name,1,18)=?', ['snapshot_identity_'])
        .orderBy('name')
        .select('name')
      expect(witnesses).toEqual(witnessTables.map(name => ({ name })))
      for (const table of witnessTables) {
        const layout = await trx.raw('PRAGMA main.table_list(??)', [table])
        expect(layout).toHaveLength(1)
        expect(layout[0].wr).toBe(1)
        await expect(trx.raw('SELECT _rowid_ FROM main.?? LIMIT 1', [table])).rejects.toThrow('no such column')
      }
      await trx.raw('SAVEPOINT independent_witness_handler')
      try {
        await trx.raw(
          'CREATE TRIGGER foreign_witness_handler AFTER INSERT ON snapshot_identity_transactions BEGIN SELECT 1; END'
        )
        await expect(validateInstalled(trx, await readPlan(trx))).rejects.toThrow('witness inventory')
      } finally {
        await trx.raw('ROLLBACK TO independent_witness_handler')
        await trx.raw('RELEASE independent_witness_handler')
      }
      await validateInstalled(trx, await readPlan(trx))
      expect(await trx.raw('SELECT brc38_cell_change_protocol() AS protocol')).toEqual([
        { protocol: 'brc38-cell-change/v1' }
      ])
      for (let tableId = 0; tableId < 13; tableId++) {
        const row = await trx('main.sqlite_schema')
          .where({ type: 'trigger', name: `snapshot_journal_physical_${tableId}_UPDATE` })
          .first('sql')
        expect(row.sql.includes('WHEN brc38_cells_changed(')).toBe(true)
      }
      expect(
        (
          await trx('main.sqlite_schema')
            .where({ type: 'trigger', name: 'snapshot_identity_after_transactions_UPDATE' })
            .first('sql')
        ).sql.includes('WHEN brc38_cells_changed(')
      ).toBe(true)
      for (const table of ['snapshot_journal_physical', 'snapshot_journal_scope']) {
        expect(
          (await trx.raw('PRAGMA table_list(??)', [table])).find((row: { name: string }) => row.name === table).wr
        ).toBe(1)
        expect(
          await trx('main.sqlite_schema').where({ type: 'index', tbl_name: table }).whereNull('sql').select('name')
        ).toEqual([])
        await expect(trx.raw('SELECT _rowid_ FROM ?? LIMIT 1', [table])).rejects.toThrow('no such column')
        const query = await trx.raw(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} INDEXED BY sqlite_autoindex_${table}_1 WHERE tableId=?`,
          [0]
        )
        expect(query[0].detail.startsWith(`SEARCH ${table} USING PRIMARY KEY`)).toBe(true)
      }
      expect(
        await trx('main.sqlite_schema').where({ name: 'snapshot_journal_source_rows' }).first('type', 'rootpage')
      ).toEqual({ type: 'view', rootpage: 0 })
      await trx.raw('SAVEPOINT independent_source_projection_handler')
      try {
        await trx.raw(
          'CREATE TRIGGER foreign_journal_projection INSTEAD OF INSERT ON snapshot_journal_source_rows BEGIN SELECT 1; END'
        )
        await expect(readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).rejects.toThrow(
          'Invalid or unowned'
        )
      } finally {
        await trx.raw('ROLLBACK TO independent_source_projection_handler')
        await trx.raw('RELEASE independent_source_projection_handler')
      }
      expect(await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).toEqual(before)
      for (const helper of ['advance', 'guard', 'scope', 'physical', 'member', 'source', 'pointer'])
        expect(await trx('snapshot_journal_' + helper + '_event')).toEqual([])
      for (const name of [
        'snapshot_journal_guard_apply',
        'snapshot_journal_scope_apply',
        'snapshot_journal_physical_apply',
        'snapshot_journal_member_apply',
        'snapshot_journal_source_apply',
        'snapshot_journal_pointer_apply'
      ]) {
        const original = await trx('main.sqlite_schema').where({ type: 'trigger', name }).first('sql')
        expect(typeof original.sql).toBe('string')
        await trx.raw('SAVEPOINT independent_shared_journal_damage')
        try {
          await trx.raw('DROP TRIGGER ??', [name])
          await expect(readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).rejects.toThrow(
            'Invalid or unowned'
          )
        } finally {
          await trx.raw('ROLLBACK TO independent_shared_journal_damage')
          await trx.raw('RELEASE independent_shared_journal_damage')
        }
        expect(await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).toEqual(before)
      }
      await trx.raw('SAVEPOINT independent_journal_attached_handler')
      try {
        await trx.raw(
          'CREATE TRIGGER foreign_journal_consumer INSTEAD OF INSERT ON snapshot_journal_advance_event BEGIN SELECT 1; END'
        )
        await expect(readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).rejects.toThrow(
          'Invalid or unowned'
        )
      } finally {
        await trx.raw('ROLLBACK TO independent_journal_attached_handler')
        await trx.raw('RELEASE independent_journal_attached_handler')
      }
      expect(await readSnapshotJournalSqliteGeneration(trx, previewReceiptPolicy)).toEqual(before)
    })
    fixture.check()
  }, 'after-journal')
}, 30000)

test('fresh native import queries reuse exact source indexes and refuse partial or altered layouts', async () => {
  const reused = [
    ['provenTxs', 'proven_txs', 'proven_txs_txid_unique', ['txid']],
    ['provenTxReqs', 'proven_tx_reqs', 'proven_tx_reqs_txid_unique', ['txid']],
    ['transactions', 'transactions', 'idx_transactions_user_txid', ['userId', 'txid']],
    ['transactionReclaim', 'transactions', 'idx_transactions_nosend_reclaim', ['userId', 'noSendExpiryReclaimTxid']],
    ['txLabelMaps', 'tx_labels_map', 'tx_labels_map_txlabelid_transactionid_unique', ['txLabelId', 'transactionId']],
    ['outputTagMaps', 'output_tags_map', 'output_tags_map_outputtagid_outputid_unique', ['outputTagId', 'outputId']],
    ['outputBaskets', 'output_baskets', 'output_baskets_name_userid_unique', ['userId', 'name']],
    ['outputTags', 'output_tags', 'output_tags_tag_userid_unique', ['userId', 'tag']],
    ['txLabels', 'tx_labels', 'tx_labels_label_userid_unique', ['userId', 'label']],
    ['outputs', 'outputs', 'outputs_transactionid_vout_userid_unique', ['userId', 'transactionId', 'vout']],
    ['transactionReference', 'transactions', 'transactions_reference_unique', ['userId', 'reference']],
    [
      'certificateFields',
      'certificate_fields',
      'certificate_fields_fieldname_certificateid_unique',
      ['userId', 'certificateId', 'fieldName']
    ],
    ['commissions', 'commissions', 'commissions_transactionid_unique', ['userId', 'transactionId']]
  ] as const
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      await verifyBrc38ImportTargetIndexes(trx)
      expect(await brc38ImportTargetIndexStatements(trx)).toHaveLength(4)
      const named = await trx('main.sqlite_schema')
        .whereRaw('substr(name,1,20)=?', ['brc38_import_target_'])
        .whereNotIn('name', [
          'brc38_import_target_cleanup_transactions',
          'brc38_import_target_cleanup_spentBy',
          'brc38_import_target_cleanup_baskets',
          'brc38_import_target_cleanup_certificates'
        ])
        .select('name')
      expect(named).toHaveLength(4)
      for (const [key, table, name, columns] of reused) {
        expect(brc38ImportTargetIndexName(key, trx)).toBe(name)
        expect(named.some(row => row.name === `brc38_import_target_${key}`)).toBe(false)
        const query = await trx.raw(
          `EXPLAIN QUERY PLAN SELECT _rowid_ FROM ${table} INDEXED BY ${name} WHERE ${columns.map(column => `${column}=?`).join(' AND ')}`,
          columns.map(() => 'probe')
        )
        expect(query).toHaveLength(1)
        expect(query[0].detail.startsWith(`SEARCH ${table} USING `)).toBe(true)
        expect(query[0].detail).toContain(`INDEX ${name} (`)
      }
      for (const replacement of [
        null,
        'CREATE INDEX `idx_transactions_user_txid` on `transactions` (`txid`, `userId`)',
        'CREATE INDEX `idx_transactions_user_txid` on `transactions` (`userId` COLLATE NOCASE, `txid`)',
        'CREATE INDEX `idx_transactions_user_txid` on `transactions` (`userId`, `txid`) WHERE txid IS NOT NULL'
      ]) {
        await trx.raw('SAVEPOINT independent_source_index_damage')
        try {
          await trx.raw('DROP INDEX idx_transactions_user_txid')
          if (replacement !== null) await trx.raw(replacement)
          await expect(verifyBrc38ImportTargetIndexes(trx)).rejects.toThrow('owned source')
        } finally {
          await trx.raw('ROLLBACK TO independent_source_index_damage')
          await trx.raw('RELEASE independent_source_index_damage')
        }
        await verifyBrc38ImportTargetIndexes(trx)
      }
      await trx.raw('SAVEPOINT independent_named_index_layout')
      try {
        const ddl = reused.map(
          ([key, table, , columns]) => `CREATE INDEX brc38_import_target_${key} ON ${table} (${columns.join(', ')})`
        )
        await trx.raw(ddl[0])
        await expect(verifyBrc38ImportTargetIndexes(trx)).rejects.toThrow('owned source')
        for (const sql of ddl.slice(6)) await trx.raw(sql)
        await trx.raw('DROP INDEX brc38_import_target_provenTxs')
        await verifyBrc38ImportTargetIndexes(trx)
        expect(await brc38ImportTargetIndexStatements(trx)).toHaveLength(11)
        await trx.raw(ddl[0])
        // The exact previous eleven-tree generation keeps every old tree.
        for (const sql of ddl.slice(1, 6)) await trx.raw(sql)
        await verifyBrc38ImportTargetIndexes(trx)
        expect(await brc38ImportTargetIndexStatements(trx)).toHaveLength(17)
        // A complete historical target-index inventory alone cannot bless a
        // changed enclosing source binding. Its migration must rebind it.
        await expect(validateInstalled(trx, await readPlan(trx))).rejects.toThrow()
      } finally {
        await trx.raw('ROLLBACK TO independent_named_index_layout')
        await trx.raw('RELEASE independent_named_index_layout')
      }
      await verifyBrc38ImportTargetIndexes(trx)
      await validateInstalled(trx, await readPlan(trx))
    })
    fixture.check()
  })
}, 30000)

test('fresh native membership views preserve required row trees and refuse an extra attached handler', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const plan = await readPlan(trx),
        helpers = plan.triggers.filter(sql => sql.startsWith('CREATE VIEW "snapshot_identity_events_'))
      expect(helpers).toHaveLength(13)
      await validateInstalled(trx, plan)
      for (const table of brc38NativeLocalBaselineTables)
        expect(
          (await trx.raw('PRAGMA table_list(??)', [table])).find((row: { name: string }) => row.name === table).wr
        ).toBe(0)
      await trx.raw('SAVEPOINT independent_shared_observer_inventory')
      try {
        await trx.raw(
          'CREATE TRIGGER foreign_shared_observer INSTEAD OF INSERT ON snapshot_identity_events_transactions BEGIN SELECT 1; END'
        )
        await expect(validateInstalled(trx, plan)).rejects.toThrow('Rebuild shared observer inventory mismatch')
      } finally {
        await trx.raw('ROLLBACK TO independent_shared_observer_inventory')
        await trx.raw('RELEASE independent_shared_observer_inventory')
      }
      await validateInstalled(trx, plan)
    })
    fixture.check()
  })
}, 30000)

test('native schema reconstruction observes every complete operational definition in one retained view', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withRead(async trx => {
      const rows = await readBoundedSnapshotJournalSqliteSchema(trx, brc38NativeLocalBaselineTables)
      for (const table of brc38NativeLocalBaselineTables)
        expect(rows.filter(row => row.type === 'table' && row.name === table)).toHaveLength(1)
      const order = rows.map(row => `${row.type}\0${row.name}`)
      expect(order).toEqual([...order].sort())
      for (const row of rows) {
        const selected = trx('sqlite_master').where({ type: row.type, name: row.name, tbl_name: row.tbl_name })
        if (row.sql === null) selected.whereNull('sql')
        else selected.whereRaw('CAST(sql AS BLOB)=CAST(? AS BLOB)', [row.sql])
        expect((await selected.count({ count: '*' }).first())?.count).toBe(1)
      }
    })
    fixture.check()
  })
}, 30000)

test('native local layout accepts only the original unused prepared proof seed', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await verifyBrc38NativeLocalPackedProofSeedRefusal(fixture)
  })
}, 30000)

test('native packed metadata owns its primary trees and retains every marker boundary', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      for (const table of [
        'brc38_native_binary_versions',
        'brc38_native_binary_fields',
        'brc38_native_binary_garbage',
        'brc38_native_text_versions',
        'brc38_native_text_fields',
        'brc38_native_text_garbage',
        'brc38_native_prepared_fields'
      ]) {
        const actual = await trx.raw('PRAGMA table_list(??)', [table])
        expect(actual.find((row: { name: string }) => row.name === table).wr).toBe(1)
        expect(
          (await trx.raw('PRAGMA index_list(??)', [table])).filter((row: { origin: string }) => row.origin === 'pk')
        ).toHaveLength(1)
        expect(
          await trx('sqlite_schema').where({ tbl_name: table, type: 'index' }).whereNull('sql').select('name')
        ).toEqual([])
        await expect(trx.raw('SELECT _rowid_ FROM ?? LIMIT 1', [table])).rejects.toThrow()
      }
      for (const table of ['brc38_native_binary_chunks', 'brc38_native_text_chunks']) {
        expect(
          (await trx.raw('PRAGMA table_list(??)', [table])).find((row: { name: string }) => row.name === table).wr
        ).toBe(0)
        expect(await trx.raw('SELECT _rowid_ FROM ?? LIMIT 1', [table])).toEqual([])
      }
      await installBrc38NativeLocalPackedLayout(trx)
      expect(await hasBrc38NativePackedSchema(trx)).toBe(true)
      expect(await hasBrc38NativePackedTextSchema(trx)).toBe(true)
      expect(await hasBrc38NativePreparedFieldsSchema(trx)).toBe(true)
      expect((await trx.raw('PRAGMA page_size'))[0].page_size).toBe(4096)
      expect((await trx.raw('PRAGMA max_page_count'))[0].max_page_count).toBe(1360)
      // An exact old anchor selects only the old complete family; it cannot
      // authorize the other compact objects. Restore it within the same writer.
      await trx.raw('SAVEPOINT independent_mixed_packed_shape')
      try {
        const name = 'brc38_native_binary_versions',
          legacy = brc38NativePackedBinaryBaseDefinitions.find(sql => sql.startsWith(`CREATE TABLE ${name}(`))!
        await trx.raw('DROP TABLE ??', [name])
        await trx.raw(legacy)
        expect(await brc38NativePackedBinarySourceDefinitions(trx)).toBe(brc38NativePackedBinaryBaseDefinitions)
        await expect(hasBrc38NativePackedSchema(trx)).rejects.toThrow('Packed native source-owned schema differs')
      } finally {
        await trx.raw('ROLLBACK TO independent_mixed_packed_shape')
        await trx.raw('RELEASE independent_mixed_packed_shape')
      }
      // Independent actual row: each binary and text predicate must still
      // reject nonempty postimages, even when another field is the empty marker.
      const when = new Date('2026-10-08T00:00:00.000Z'),
        userId = await fixture.storage.insertUser(
          {
            userId: 0,
            created_at: when,
            updated_at: when,
            identityKey: 'independent compact marker user',
            activeStorage: 'independent private candidate'
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
            reference: 'aW5kZXBlbmRlbnQ=',
            isOutgoing: false,
            satoshis: 0,
            description: ''
          },
          trx
        )
      for (const field of ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'])
        await expect(
          trx('transactions')
            .where({ transactionId })
            .update({ [field]: Buffer.from([1]) })
        ).rejects.toThrow('Packed native payload requires its bounded field writer')
      for (const field of ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix'])
        await expect(
          trx('transactions')
            .where({ transactionId })
            .update({ [field]: 'nonempty marker' })
        ).rejects.toThrow('Packed native text requires its bounded field writer')
    })
    await fixture.withRead(async trx => {
      expect(await hasBrc38NativePackedSchema(trx)).toBe(true)
      expect(await hasBrc38NativePackedTextSchema(trx)).toBe(true)
      expect(await hasBrc38NativePreparedFieldsSchema(trx)).toBe(true)
    })
  })
}, 30000)

test('native v3 shared observer rejects manufactured events and retains source rollback', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      await installBrc38NativeLocalBaselineGeneration(trx, {
        maximumRows: 1024,
        ceiling: snapshotJournalRevision('100000')
      })
      expect((await trx('brc38_local_baseline_clock').where('slot', 1).first('protocol')).protocol).toBe(
        'brc38-local-baseline-journal/v3'
      )
      const events = await trx('brc38_local_baseline_event').select('*')
      expect(events).toEqual([])
      await trx('monitor_events').insert({
        id: -5,
        created_at: 1791331200000,
        updated_at: 1791331200000,
        event: 'independent shared observer event',
        details: null
      })
      expect(
        await trx('brc38_local_baseline_rows')
          .where({ tableId: 15, rowId: -5 })
          .first('present', trx.raw('CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation'))
      ).toEqual({ present: 1, revision: '1', generation: '1' })
    })
    const before = await fixture.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))
    await expect(
      fixture.withWriter(
        async trx =>
          await trx.raw(
            'INSERT INTO brc38_local_baseline_event(tableId,oldRowId,newRowId,present) VALUES(15,NULL,-6,1)'
          )
      )
    ).rejects.toThrow()
    expect(await fixture.withRead(async trx => await readBrc38NativeLocalBaselineGeneration(trx))).toEqual(before)
    const failure = new Error('Independent source rollback must include shared observer effects')
    await expect(
      fixture.withWriter(async trx => {
        await trx('monitor_events').where('id', -5).update({ id: -7 })
        throw failure
      })
    ).rejects.toBe(failure)
    await fixture.withRead(async trx => {
      expect(await readBrc38NativeLocalBaselineGeneration(trx)).toEqual(before)
      expect(
        await trx('brc38_local_baseline_rows')
          .where({ tableId: 15, rowId: -5 })
          .first('present', trx.raw('CAST(revision AS TEXT) AS revision,CAST(generation AS TEXT) AS generation'))
      ).toEqual({ present: 1, revision: '1', generation: '1' })
      expect(await trx('brc38_local_baseline_rows').where({ tableId: 15, rowId: -7 }).first()).toBeUndefined()
      expect(await trx('brc38_local_baseline_event').select('*')).toEqual([])
    })
  })
}, 30000)

test('native derived indexes share their primary B-tree without changing operational rowids', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const plan = await readPlan(trx)
      const derived = [
        'snapshot_profile_keys_v2',
        'snapshot_relation_keys_v2',
        'snapshot_certificate_field_keys_v2',
        'snapshot_global_edges_v2',
        'snapshot_global_keys_v2',
        'snapshot_global_guards_v2',
        'snapshot_index_rebuild_v2',
        'snapshot_index_generation_v2',
        'snapshot_identity_transactions',
        'snapshot_identity_outputs',
        'snapshot_identity_certificates',
        'snapshot_identity_tx_labels',
        'snapshot_identity_output_baskets',
        'snapshot_identity_output_tags',
        'snapshot_identity_commissions',
        'snapshot_identity_sync_states',
        'snapshot_identity_proven_txs',
        'snapshot_identity_proven_tx_reqs'
      ]
      const tables: Array<{ name: string; wr: number }> = await trx.raw('PRAGMA table_list')
      for (const table of derived) {
        expect(tables.find(row => row.name === table)?.wr).toBe(1)
        const primary: Array<{ origin: string; name: string }> = await trx.raw('PRAGMA index_list(??)', [table])
        expect(primary.filter(row => row.origin === 'pk')).toHaveLength(1)
        // WITHOUT ROWID owns the primary tree itself, rather than allocating a
        // second sqlite_schema root page for a duplicate primary-key index.
        expect(
          await trx('sqlite_schema')
            .where({ name: `sqlite_autoindex_${table}_1` })
            .count({ count: '*' })
            .first()
        ).toEqual({ count: 0 })
        await expect(trx(table).select(trx.raw('_rowid_')).limit(1)).rejects.toThrow('no such column')
      }
      for (const table of brc38NativeLocalBaselineTables) {
        expect(tables.find(row => row.name === table)?.wr).toBe(0)
        await trx(table).select(trx.raw('_rowid_')).limit(1)
      }
      expect(await trx.raw('PRAGMA page_size')).toEqual([{ page_size: 4096 }])
      expect(await trx.raw('PRAGMA max_page_count')).toEqual([{ max_page_count: 1360 }])
      await validateInstalled(trx, plan)
      await trx.raw('SAVEPOINT independent_legacy_derived_shape')
      try {
        const recorded = await trx(metadata).where('id', 0).first()
        const definition = plan.ddl.find(sql => sql.startsWith('CREATE TABLE "snapshot_index_generation_v2" '))!
        await trx.raw('DROP TABLE snapshot_index_generation_v2')
        await trx.raw(definition.replace(/ WITHOUT ROWID$/, ''))
        await trx(metadata).insert(recorded)
        const legacy = await readPlan(trx)
        expect(
          legacy.ddl.filter(sql => sql.startsWith('CREATE TABLE ')).every(sql => !sql.endsWith(' WITHOUT ROWID'))
        ).toBe(true)
        // An existing legacy marker selects the historical definitions, but
        // cannot authorize the other seventeen compact tables as that layout.
        await expect(validateInstalled(trx, legacy)).rejects.toThrow('Rebuild schema definition mismatch: ')
      } finally {
        await trx.raw('ROLLBACK TO independent_legacy_derived_shape')
        await trx.raw('RELEASE independent_legacy_derived_shape')
      }
      await validateInstalled(trx, await readPlan(trx))
    })
  })
}, 30000)

test('native compact source binding retains the complete inventory and refuses changed bindings', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const plan = await readPlan(trx)
      const sourceTables = [
        'transactions',
        'outputs',
        'certificates',
        'tx_labels',
        'output_baskets',
        'output_tags',
        'commissions',
        'sync_states',
        'proven_txs',
        'proven_tx_reqs',
        'tx_labels_map',
        'output_tags_map',
        'certificate_fields'
      ]
      const actual = await trx('sqlite_schema')
        .whereIn('tbl_name', sourceTables)
        .whereIn('type', ['table', 'index'])
        .select('type', 'name', 'tbl_name', 'sql')
        .orderBy(['type', 'name'])
        .limit(257)
      expect(JSON.parse(plan.source)).toEqual(actual)
      const expected =
        'brc38-native-sqlite-source/v1:' + createHash('sha256').update(JSON.stringify(actual), 'utf8').digest('hex')
      const original = await trx(metadata).where('id', 0).first('source')
      expect(original.source).toBe(expected)
      expect(Buffer.byteLength(original.source)).toBe(94)
      expect(Buffer.byteLength(plan.source)).toBeGreaterThan(4096)
      await trx(metadata)
        .where('id', 0)
        .update({ source: expected + '0' })
      await expect(validateInstalled(trx, plan)).rejects.toThrow('Rebuild source binding mismatch')
      // A legacy full record upgrades only through the existing writer-owned
      // protocol after its entire current source and observers are verified.
      await trx(metadata).where('id', 0).update({ source: plan.source })
      await validateInstalled(trx, plan)
      await addSnapshotSqliteSourceIndexes(trx, [], async () => {})
      expect((await trx(metadata).where('id', 0).first('source')).source).toBe(expected)
      await validateInstalled(trx, plan)
    })
  })
}, 30000)

// Authored UNRUN: each case opens a separate actual authenticated native owner.
// The executable must first be built and qualified for the selected host.
test('fresh native local layout installs exact guards and rolls back damaged definitions', async () => {
  await withBrc38NativePrivateContractFixture(verifyBrc38NativeLocalPackedLayout)
}, 30000)

test('occupied native transfer cannot install an empty local layout', async () => {
  await withBrc38NativePrivateContractFixture(verifyBrc38NativeLocalPackedOccupiedRefusal)
}, 30000)

test('actual native prepared lifetimes retain charges until the last owner drains', async () => {
  await withBrc38NativePrivateContractFixture(
    async fixture => await verifyNativePreparedFieldLifetimes(fixture.store, fixture.expiresAt)
  )
}, 30000)

test('nonnull native binary markers require actual complete content pointers', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const when = new Date('2026-10-08T00:00:00.000Z')
    const rowId = await fixture.withWriter(async trx => {
      const userId = await fixture.storage.insertUser(
        {
          userId: 0,
          created_at: when,
          updated_at: when,
          identityKey: 'independent packed descriptor user',
          activeStorage: 'independent private candidate'
        },
        trx
      )
      const transactionId = await fixture.storage.insertTransaction(
        {
          transactionId: 0,
          userId,
          created_at: when,
          updated_at: when,
          status: 'nosend',
          reference: 'aW5kZXBlbmRlbnQ=',
          isOutgoing: false,
          satoshis: 0,
          description: 'independent pointer-free transaction'
        },
        trx
      )
      return await fixture.storage.insertOutput(
        {
          outputId: 0,
          userId,
          transactionId,
          created_at: when,
          updated_at: when,
          spendable: false,
          change: false,
          vout: 0,
          satoshis: 0,
          providedBy: 'you',
          purpose: 'independent descriptor',
          type: 'custom',
          outputDescription: 'independent pointer-free output'
        },
        trx
      )
    })
    await verifyNativePackedMissingPointerRefusal(fixture.store, rowId)
  })
}, 30000)

async function seedMonitor(fixture: Brc38NativePrivateContractFixture): Promise<void> {
  await fixture.withWriter(async trx => {
    await trx('monitor_events').insert({
      id: -7,
      created_at: 1791417600000,
      updated_at: 1791417600000,
      event: 'independent local epoch fixture',
      details: null
    })
  })
}

test('native local revision exhaustion preserves the ordinary foreground write', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await seedMonitor(fixture)
    await verifyBrc38NativeLocalBaselineRevisionExhaustion(fixture, -7)
  })
}, 30000)

test('native local capacity exhaustion preserves the newly written physical row', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await seedMonitor(fixture)
    await verifyBrc38NativeLocalBaselineCapacityExhaustion(fixture, -7, -8)
  })
}, 30000)

test('exact signed64 native keys persist while refusing unsafe source transport', async () => {
  await withBrc38NativePrivateContractFixture(verifyBrc38NativeLocalBaselineUnsafeKeyRefusal)
}, 30000)

test('actual all47 local bootstrap and mutation deltas match independent physical keys', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await seedMonitor(fixture)
    // These are the ordinary fresh migration seeds, independently specified
    // before asking the local journal to inventory them.
    const expected = Object.fromEntries(
      brc38NativeLocalBaselineTables.map(table => [
        table,
        table === 'settings' || table === 'prepared_beef_metadata'
          ? [1]
          : table === 'sync_transfers'
            ? [0, 1, 2, 3, 4, 5, 6, 7, 8]
            : table === 'monitor_events'
              ? [-7]
              : []
      ])
    ) as unknown as Record<Brc38NativeLocalBaselineTable, readonly number[]>
    await verifyBrc38NativeLocalBaselineGeneration(fixture, expected)
  }, 'after-journal')
}, 30000)

test('actual exhausted local epoch retires in pages and bootstraps a new complete epoch', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await seedMonitor(fixture)
    await verifyBrc38NativeLocalEpochRecovery(fixture, -7)
  }, 'after-journal')
}, 90000)

test('actual unsafe physical key blocks epoch activation until its ordinary removal', async () => {
  await withBrc38NativePrivateContractFixture(verifyBrc38NativeLocalEpochUnsafeActivationRefusal, 'after-journal')
}, 30000)

test('private row allocation rolls back and refuses reuse after an intervening writer', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const when = new Date('2026-10-08T00:00:00.000Z'),
      userId = await fixture.withWriter(
        async trx =>
          await fixture.storage.insertUser(
            {
              userId: 0,
              created_at: when,
              updated_at: when,
              identityKey: 'independent allocation user',
              activeStorage: 'synthetic target'
            },
            trx
          )
      )
    await verifyPrivatePageIds({ ...fixture, userId })
  })
}, 30000)

test('native local durable transfer retains replay results and exact multipart bytes', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(installBrc38NativeLocalPackedLayout)
    const capabilities = validateSyncTransferCapabilities({ version: 1, partBytes: 1024, maxBytes: 1048576 }),
      bytes = Uint8Array.from({ length: capabilities.partBytes + 17 }, (_, index) => index % 251)
    try {
      await verifyBrc38NativeLocalPackedTransfer(
        new KnexSyncTransferStore(fixture.store.knex, capabilities),
        'independent transfer identity',
        bytes,
        fixture.check
      )
    } finally {
      bytes.fill(0)
    }
  })
}, 30000)

test('derived native TEXT versions preserve independent bytes and release only their original holds', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    const working = new Brc38WorkingAllocation(8388608)
    await verifyPrivateDerivedTextVersions(
      fixture.store,
      { expiresAt: fixture.expiresAt, workingAllocation: working },
      () => ({ maximum: 16777216, remaining: 16777216 })
    )
    expect(working.used).toBe(0)
  })
}, 90000)

test('actual private candidate journal preserves exact integer progress and point reservations', async () => {
  await withBrc38NativePrivateContractFixture(verifyBrc38PrivateLocalCandidateJournal)
}, 30000)

test('actual private candidate journal retains two-pass cursors across a higher source water', async () => {
  await withBrc38NativePrivateContractFixture(verifyBrc38PrivateLocalCandidateTwoPassJournal)
}, 30000)

test('actual private candidate clear cannot skip physical points or renew bounded rebuilds', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    // The clear contract requires every application table to be empty. Fresh
    // migration seed rows are retained solely for fixture restoration; they
    // never supply the clear cursor's independent expected values.
    const seeds = await fixture.withRead(async trx => ({
      settings: await trx('settings').select('*'),
      prepared_beef_metadata: await trx('prepared_beef_metadata').select('*'),
      sync_transfers: await trx('sync_transfers').select('*')
    }))
    await fixture.withWriter(async trx => {
      for (const table of ['sync_transfers', 'prepared_beef_metadata', 'settings']) await trx(table).delete()
      for (const table of brc38NativeLocalBaselineTables)
        expect(await trx(table).first(trx.raw('1 AS present'))).toBeUndefined()
    })
    let failed = false,
      failure: unknown
    try {
      await verifyBrc38PrivateLocalCandidateClearJournal(fixture)
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await fixture.withWriter(async trx => {
        for (const [table, rows] of Object.entries(seeds)) if (rows.length !== 0) await trx(table).insert(rows)
      })
    } catch (cause) {
      throw new AggregateError(
        failed ? [failure, cause] : [cause],
        'Candidate clear contract retains original migration seed restoration'
      )
    }
    if (failed) throw failure
  })
}, 30000)

test('fresh native targets retire exact redundant trees and refuse occupied reinstallation', async () => {
  const stopped = new Error('Owned compact target contract ends before full journal')
  await expect(
    withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async trx => {
        const contracts = [
          ['proven_tx_reqs', 'proven_tx_reqs_txid_index', 'proven_tx_reqs_txid_unique', 'txid'],
          ['commissions', 'commissions_transactionid_index', 'commissions_transactionid_unique', 'transactionId'],
          ['sync_states', 'sync_states_refnum_index', 'sync_states_refnum_unique', 'refNum'],
          [
            'action_batch_outputs',
            'action_batch_outputs_actionbatchid_index',
            'sqlite_autoindex_action_batch_outputs_1',
            'actionBatchId'
          ],
          [
            'action_batch_blobs',
            'action_batch_blobs_actionbatchid_index',
            'action_batch_blobs_actionbatchid_digest_unique',
            'actionBatchId'
          ],
          ['output_tags_map', 'output_tags_map_outputid_index', 'idx_output_tags_map_output_deleted_tag', 'outputId'],
          ['tx_labels_map', 'tx_labels_map_transactionid_index', 'idx_tx_labels_map_tx_deleted', 'transactionId']
        ] as const
        for (const [table, removed, kept, field] of contracts) {
          expect(await trx('main.sqlite_schema').where({ name: removed }).count({ count: '*' }).first()).toEqual({
            count: 0
          })
          expect((await trx.raw('PRAGMA main.table_list(??)', [table]))[0].wr).toBe(0)
          expect(await trx.raw('SELECT _rowid_ FROM main.?? LIMIT 1', [table])).toEqual([])
          const plan = await trx.raw('EXPLAIN QUERY PLAN SELECT _rowid_ FROM ?? INDEXED BY ?? WHERE ??=? LIMIT 8', [
            table,
            kept,
            field,
            'probe'
          ])
          expect(plan).toHaveLength(1)
          expect(plan[0].detail.startsWith(`SEARCH ${table} USING `)).toBe(true)
          expect(plan[0].detail).toContain(`INDEX ${kept} (`)
        }
        const before = await trx('main.sqlite_schema').first(
          trx.raw('count(*) AS objects,sum(rootpage>0) AS roots,sum(length(CAST(sql AS BLOB))) AS sqlBytes')
        )
        await expect(compactBrc38NativeTargetIndexes(trx)).rejects.toThrow('exact fresh private source')
        expect(
          await trx('main.sqlite_schema').first(
            trx.raw('count(*) AS objects,sum(rootpage>0) AS roots,sum(length(CAST(sql AS BLOB))) AS sqlBytes')
          )
        ).toEqual(before)
        expect((await trx.raw('PRAGMA max_page_count'))[0].max_page_count).toBe(1360)
      })
      throw stopped
    })
  ).rejects.toBe(stopped)
}, 30000)

test('literal packed markers preserve SQLite types, collations and occupied complete guard families', async () => {
  const stopped = new Error('Owned marker contract ends before full journal')
  await expect(
    withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async trx => {
        const values = [
          'NULL',
          '0',
          '0.0',
          '9223372036854775807',
          '-9223372036854775808',
          "''",
          "' '",
          "'a'",
          "'é'",
          "CAST(X'00' AS TEXT)",
          "CAST(X'610062' AS TEXT)",
          "X''",
          "X'00'"
        ]
        for (const collation of ['BINARY', 'NOCASE', 'RTRIM'])
          for (const value of values) {
            fixture.check()
            const rows = await trx.raw(`SELECT
            (typeof(v)='text' AND length(CAST(v AS BLOB))=0) AS oldText,
            (v COLLATE BINARY IS '') AS newText,
            (v IS NOT NULL AND (typeof(v)!='text' OR length(CAST(v AS BLOB))!=0)) AS oldTextGuard,
            (v IS NOT NULL AND (v COLLATE BINARY IS NOT '')) AS newTextGuard,
            (typeof(v)='blob' AND length(v)=0) AS oldBinary,
            (v IS X'') AS newBinary,
            (v IS NOT NULL AND (typeof(v)!='blob' OR length(v)!=0)) AS oldBinaryGuard,
            (v IS NOT NULL AND (v IS NOT X'')) AS newBinaryGuard
            FROM (SELECT ${value} COLLATE ${collation} AS v)`)
            expect(rows).toHaveLength(1)
            for (const [old, current] of [
              ['oldText', 'newText'],
              ['oldTextGuard', 'newTextGuard'],
              ['oldBinary', 'newBinary'],
              ['oldBinaryGuard', 'newBinaryGuard']
            ])
              expect(rows[0][current]).toBe(rows[0][old])
          }
        expect(await hasBrc38NativePackedSchema(trx)).toBe(true)
        expect(await hasBrc38NativePackedTextSchema(trx)).toBe(true)
        const before = await trx('main.sqlite_schema').first(
          trx.raw('count(*) AS objects,sum(rootpage>0) AS roots,sum(length(CAST(sql AS BLOB))) AS sqlBytes')
        )
        await trx.raw('SAVEPOINT __marker_historical_family')
        try {
          for (const [kind, source, read] of [
            ['binary', brc38NativePackedBinaryBaseDefinitions, brc38NativePackedBinarySourceDefinitions],
            ['text', brc38NativePackedTextBaseDefinitions, brc38NativePackedTextSourceDefinitions]
          ] as const) {
            const current = await read(trx),
              probe = `CREATE TRIGGER brc38_native_${kind}_fields_row_0 `
            expect(current.find(sql => sql.startsWith(probe))).toContain(
              kind === 'binary' ? " IS X''" : " COLLATE BINARY IS ''"
            )
            // Reconstruct the entire occupied historical compact family, with
            // its original preparation guard. No trigger subset is adopted.
            for (const original of brc38NativeCompactPackedDefinitions(kind, source)) {
              const match = /^CREATE TRIGGER ([A-Za-z0-9_]+) /.exec(original)
              if (match === null) continue
              const sql =
                match[1] === `brc38_native_${kind}_versions_update_guard`
                  ? brc38PreparedFieldVersionGuard(kind, original)
                  : original
              const actual = await trx('main.sqlite_schema').where({ type: 'trigger', name: match[1] }).first('sql')
              if (actual.sql === sql) continue
              await trx.raw('DROP TRIGGER ??', [match[1]])
              await trx.raw(sql)
            }
            expect(await read(trx)).toEqual(brc38NativeCompactPackedDefinitions(kind, source))
          }
          expect(await hasBrc38NativePackedSchema(trx)).toBe(true)
          expect(await hasBrc38NativePackedTextSchema(trx)).toBe(true)
          // The selector's exact first guard cannot bless a changed second guard.
          await trx.raw('DROP TRIGGER brc38_native_binary_fields_row_1')
          await trx.raw(
            'CREATE TRIGGER brc38_native_binary_fields_row_1 BEFORE INSERT ON brc38_native_binary_fields BEGIN SELECT 1; END'
          )
          await expect(hasBrc38NativePackedSchema(trx)).rejects.toThrow('source-owned schema differs')
        } finally {
          await trx.raw('ROLLBACK TO __marker_historical_family')
          await trx.raw('RELEASE __marker_historical_family')
        }
        expect(await hasBrc38NativePackedSchema(trx)).toBe(true)
        expect(await hasBrc38NativePackedTextSchema(trx)).toBe(true)
        expect(
          await trx('main.sqlite_schema').first(
            trx.raw('count(*) AS objects,sum(rootpage>0) AS roots,sum(length(CAST(sql AS BLOB))) AS sqlBytes')
          )
        ).toEqual(before)
        expect((await trx.raw('PRAGMA max_page_count'))[0].max_page_count).toBe(1360)
      })
      throw stopped
    })
  ).rejects.toBe(stopped)
}, 30000)

test('native reply fencing preserves original statement failure through migration cleanup', async () => {
  let statementFailure: unknown, migrationFailure: unknown
  try {
    await withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async trx => {
        await trx.raw(
          "CREATE TEMP TRIGGER independent_native_fence_failure BEFORE UPDATE ON main.settings BEGIN SELECT RAISE(ROLLBACK,'independent initial native failure'); END"
        )
        try {
          await trx.raw('UPDATE settings SET storageName=storageName')
        } catch (cause) {
          statementFailure = cause
          throw cause
        }
        throw new Error('Independent native rollback trigger must reject the statement')
      })
    })
  } catch (cause) {
    migrationFailure = cause
  }
  expect(statementFailure).toBeInstanceOf(AggregateError)
  if (!(statementFailure instanceof AggregateError)) throw new Error('Original native statement failure missing')
  const origin = statementFailure.cause
  expect(origin).toEqual({
    code: 'SQLITE_CONSTRAINT_TRIGGER',
    nativeCode: 1811,
    message: 'independent initial native failure',
    nativeAutocommit: true,
    rollbackCode: 1,
    releaseCode: 0
  })
  expect(Object.isFrozen(origin)).toBe(true)
  expect(statementFailure.errors).toHaveLength(2)
  expect(statementFailure.errors[0].cause).toBe(origin)
  expect(statementFailure.errors[0].nativeCode).toBe(1811)
  expect(migrationFailure).toBeInstanceOf(AggregateError)
  if (!(migrationFailure instanceof AggregateError)) throw new Error('Actual migration cleanup failure missing')
  expect(migrationFailure.message).toBe('Private native migration retains foreign-key restoration failure')
  expect(migrationFailure.errors).toHaveLength(2)
  for (const failure of migrationFailure.errors) {
    expect(failure).toBeInstanceOf(Error)
    expect(failure.code).toBe('SQLITE_ABORT')
    expect(failure.nativeCode).toBe(4)
    expect(failure.nativeConnectionFenced).toBe(true)
    expect(failure.nativeAutocommit).toBe(true)
    expect(failure.cause).toBe(origin)
    expect(Object.keys(failure)).not.toContain('cause')
  }
}, 30000)

test('native raw field metadata preserves integer coordinates and complete UTF8 cells', async () => {
  const fixture = await previewPrivateFixture(undefined, undefined, 65536, 16777216, 16777216)
  try {
    const { root, value, selected } = fixture
    await value.reservation.store.close()
    const reservation = await root.resumeNative(
      value.reservation.id,
      selected.limits,
      selected.binding,
      nativeTestExecutable()
    )
    fixture.held.push(reservation)
    const store = reservation.store,
      text = 'independent raw \u0000雪😀',
      expected = Buffer.from(text, 'utf8'),
      local = { table: 'monitor_events', field: 'details', rowId: 400 } as const,
      ordinary = { table: 'transactions', field: 'description', rowId: 9 } as const,
      working = new Brc38WorkingAllocation(65536)
    // Only lower transport is admitted here. These independent raw cells are
    // not a composed profile, primary provider or complete wallet schema.
    await store.withAuthenticatedPrivateDestination(async () => {
      await store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeWriteTransaction(trx)
            await trx.raw('CREATE TABLE monitor_events(id INTEGER PRIMARY KEY,details TEXT)')
            await trx.raw('CREATE TABLE transactions(transactionId INTEGER PRIMARY KEY,description TEXT)')
            await trx('monitor_events').insert([
              { id: 400, details: text },
              { id: 401, details: null }
            ])
            await trx('transactions').insert([
              { transactionId: 9, description: text },
              { transactionId: 10, description: null }
            ])
          })
      )
      await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeReadTransaction(trx)
            expect(await trx.raw('PRAGMA query_only')).toEqual([{ query_only: 1 }])
            // BEGIN alone does not establish a retained main-database view.
            // Prove the independent original rows before reading their extents.
            expect(await trx('monitor_events').select('id').orderBy('id')).toEqual([{ id: 400 }, { id: 401 }])
            expect(await readBrc38NativeLocalFieldBytes(trx, local)).toBe(expected.length)
            expect(await readBrc38NativeLocalFieldBytes(trx, { ...local, rowId: 401 })).toBeNull()
            expect(await readBrc38NativeTextBytes(trx, ordinary)).toBe(expected.length)
            expect(await readBrc38NativeTextBytes(trx, { ...ordinary, rowId: 10 })).toBeNull()
            let escaped: Uint8Array | undefined
            await withBrc38NativeLocalFieldExtent(
              trx,
              { ...local, offset: 0, length: expected.length, totalBytes: expected.length },
              working,
              async bytes => {
                escaped = bytes
                expect(Buffer.from(bytes)).toEqual(expected)
                expect(working.used).toBe(4096 + 32 * expected.length)
              }
            )
            expect(working.used).toBe(0)
            expect(escaped?.every(byte => byte === 0)).toBe(true)
            const bytes = await readBrc38NativeTextExtent(trx, {
              ...ordinary,
              offset: 0,
              length: expected.length,
              totalBytes: expected.length
            })
            try {
              expect(Buffer.from(bytes)).toEqual(expected)
            } finally {
              bytes.fill(0)
            }
            // Number bindings really are REAL in this driver. The native ABI
            // must continue rejecting them; only validated coordinates bind INTEGER.
            await expect(
              trx.raw('SELECT brc38_local_field_extent_bytes(?,?,?) AS bytes', [13, 0, 400])
            ).rejects.toMatchObject({ code: 'SQLITE_MISUSE' })
            await expect(readBrc38NativeLocalFieldBytes(trx, { ...local, rowId: 400.5 })).rejects.toThrow(TypeError)
            const raw = jest.fn(),
              copied = { raw } as unknown as Parameters<typeof readBrc38NativeLocalFieldBytes>[0]
            await expect(readBrc38NativeLocalFieldBytes(copied, local)).rejects.toThrow('actual retained native')
            await expect(readBrc38NativeTextBytes(copied, ordinary)).rejects.toThrow('actual retained native')
            expect(raw).not.toHaveBeenCalled()
            const controller = new AbortController(),
              reason = new Error('Independent raw-field cancellation')
            controller.abort(reason)
            await expect(readBrc38NativeLocalFieldBytes(trx, local, controller.signal)).rejects.toBe(reason)
            await expect(readBrc38NativeTextBytes(trx, ordinary, controller.signal)).rejects.toBe(reason)
            store.assertPrivateNativeReadTransaction(trx)
          })
      )
    })
    expect(working.used).toBe(0)
  } finally {
    await fixture.close()
  }
})
