import { knex } from 'knex'
import { withBrc38NativePrivateContractFixture } from './Brc38NativePrivateContractFixture'
import {
  installBrc38NativeLocalBaselineGeneration,
  hasBrc38NativeLocalBaselineGenerationSchema,
  brc38NativeLocalBaselineSourceDefinitions,
  readBrc38NativeLocalBaselineGeneration
} from './Brc38NativeLocalBaselineGenerationNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import { verifySnapshotJournalDestinationSchema } from '../snapshot/journal/SnapshotJournalDestinationSchema'
import { runInSeries } from '../../utility/runInSeries'

// This actual native fixture stops before sealing or publication. Its original
// small admission, genuine actor and concrete cleanup remain enforced.
test('native baseline bounded comparisons retain complete schema and exact current rollback', async () => {
  const stop = new Error('independent baseline comparison fixture stop')
  await expect(
    withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async trx => {
        await installBrc38NativeLocalBaselineGeneration(trx, {
          maximumRows: 1024,
          ceiling: snapshotJournalRevision('100000')
        })
        const expected = await brc38NativeLocalBaselineSourceDefinitions(trx)
        const batches: Array<{ sql: string; bindings: unknown[] }> = []
        const observe = (query: { sql: string; bindings?: unknown[] }): void => {
          if (query.sql.includes('count(distinct')) batches.push({ sql: query.sql, bindings: query.bindings ?? [] })
        }
        trx.on('query', observe)
        try {
          expect(await hasBrc38NativeLocalBaselineGenerationSchema(trx)).toBe(true)
        } finally {
          trx.removeListener('query', observe)
        }
        expect(batches.length).toBeGreaterThan(0)
        expect(batches.length).toBeLessThanOrEqual(Math.ceil(expected.length / 16))
        for (const query of batches) {
          expect(query.bindings.at(-1)).toBe(1) // Knex first() adds the fixed LIMIT binding.
          const definitions = query.bindings.slice(0, -1)
          expect(definitions.every(value => typeof value === 'string')).toBe(true)
          expect(definitions.length % 3).toBe(0)
          expect(definitions.length / 3).toBeLessThanOrEqual(32)
          const bytes = definitions.reduce<number>((total, value) => total + Buffer.byteLength(String(value)), 0)
          expect(bytes <= 32768 || definitions.length === 3).toBe(true)
          const packetBytes =
            16 +
            Buffer.byteLength(query.sql) +
            query.bindings.reduce<number>(
              (sum, item) => sum + (typeof item === 'string' ? 5 + Buffer.byteLength(item) : 9),
              0
            )
          expect(packetBytes).toBeLessThanOrEqual(65537)
        }
        const generation = await readBrc38NativeLocalBaselineGeneration(trx)
        expect(generation).toMatchObject({
          maximumRows: 1024,
          ceiling: '100000',
          records: 0,
          enabled: true,
          complete: false,
          bootstrapTable: 0,
          afterRowId: null
        })
        const geometry = async (): Promise<unknown[]> => await trx.raw('PRAGMA page_count')
        const originalGeometry = await geometry()
        const objects = async (): Promise<
          Array<{ position: string; type: string; name: string; rootpage: number }>
        > => {
          const result: Array<{ position: string; type: string; name: string; rootpage: number }> = []
          let after: string | undefined
          for (;;) {
            const query = trx('main.sqlite_schema')
              .select(trx.raw('CAST(rowid AS TEXT) AS position'), 'type', 'name', 'rootpage')
              .orderBy('rowid')
              .limit(32)
            if (after !== undefined) query.whereRaw('rowid > CAST(? AS INTEGER)', [after])
            const page = await query
            if (page.length === 0) return result
            result.push(...page)
            if (result.length > 1024) throw new Error('Independent schema inventory exceeds its fixed fixture bound')
            after = page.at(-1).position
          }
        }
        const originalObjects = await objects()
        const observers = expected.filter(sql =>
          /^CREATE TRIGGER [A-Za-z0-9_]+ AFTER UPDATE ON snapshot_reconciliation_window_progress BEGIN /.test(sql)
        )
        expect(observers).toHaveLength(1)
        const observer = observers[0],
          name = /^CREATE TRIGGER ([A-Za-z0-9_]+) /.exec(observer)![1]
        expect(name).toMatch(/^brc38_local_baseline_(?:s46|snapshot_reconciliation_window_progress)_update$/)
        for (const changed of [false, true]) {
          await trx.raw('SAVEPOINT actual_baseline_batch_negative')
          try {
            await trx.raw('DROP TRIGGER ??', [name])
            if (changed) await trx.raw(observer.replace('BEGIN ', 'BEGIN SELECT 1; '))
            await expect(hasBrc38NativeLocalBaselineGenerationSchema(trx)).rejects.toThrow(
              'Local baseline original generation, schema or progress differs'
            )
          } finally {
            await trx.raw('ROLLBACK TO actual_baseline_batch_negative')
            await trx.raw('RELEASE actual_baseline_batch_negative')
          }
          expect(await hasBrc38NativeLocalBaselineGenerationSchema(trx)).toBe(true)
          expect(await readBrc38NativeLocalBaselineGeneration(trx)).toEqual(generation)
          expect(await geometry()).toEqual(originalGeometry)
          expect(await objects()).toEqual(originalObjects)
        }
        fixture.check()
      })
      throw stop
    })
  ).rejects.toBe(stop)
}, 120000)

test('genuine ordinary SQLite cannot claim a native baseline actor from matching data', async () => {
  const k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await k.raw('CREATE TABLE brc38_local_baseline_clock(slot INTEGER PRIMARY KEY, epoch TEXT)')
    await k.transaction(async trx => {
      await expect(hasBrc38NativeLocalBaselineGenerationSchema(trx)).rejects.toThrow(
        'Local baseline journal requires its actual current native transaction'
      )
    })
  } finally {
    await k.destroy()
  }
})

test('native durable receipt mutations retain physical generations and rollback on the existing kernel', async () => {
  const stop = new Error('independent receipt observer fixture stop')
  await expect(
    withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async trx => {
        await trx('users').insert({
          userId: 76,
          identityKey: 'independent-receipt-owner',
          activeStorage: 'independent-receipt-storage',
          created_at: 0,
          updated_at: 0
        })
        await installBrc38NativeLocalBaselineGeneration(trx, {
          maximumRows: 1024,
          ceiling: snapshotJournalRevision('100000')
        })
        const key = { userId: 76, txid: 'f'.repeat(64) }
        const receipt = {
          ...key,
          ownerToken: 'independent-original-owner',
          state: 'pending',
          leaseUntil: 123456,
          needsNewReceipt: 1
        }
        const clock = async () => await trx('brc38_local_baseline_clock').where({ slot: 1 }).first()
        const point = async () => await trx('brc38_local_baseline_rows').where({ tableId: 47, rowId: 1 }).first()
        await trx('internalize_receipts').insert(receipt)
        expect(await trx('internalize_receipts').where(key).select(trx.raw('rowid AS physical')).first()).toEqual({
          physical: 1
        })
        expect(await point()).toMatchObject({ present: 1, revision: 1, generation: 1 })
        expect((await clock()).revision).toBe(1)
        await trx('internalize_receipts')
          .where({ ...key, ownerToken: receipt.ownerToken })
          .update({
            state: 'complete',
            leaseUntil: 0,
            needsNewReceipt: 0
          })
        expect(await point()).toMatchObject({ present: 1, revision: 2, generation: 1 })
        const completed = await trx('internalize_receipts').where(key).first()
        const originalClock = await clock()
        const originalPoint = await point()
        await trx.raw('SAVEPOINT independent_receipt_rollback')
        await trx('internalize_receipts').where(key).update({ ownerToken: 'rolled-back-owner', state: 'retryable' })
        expect((await point()).revision).toBe(3)
        await trx.raw('ROLLBACK TO independent_receipt_rollback')
        await trx.raw('RELEASE independent_receipt_rollback')
        expect(await clock()).toEqual(originalClock)
        expect(await point()).toEqual(originalPoint)
        expect(await trx('internalize_receipts').where(key).first()).toEqual(completed)
        expect(
          await trx('internalize_receipts')
            .where({ ...key, ownerToken: 'other-owner' })
            .update({ state: 'retryable' })
        ).toBe(0)
        expect(await clock()).toEqual(originalClock)
        await trx('internalize_receipts').where(key).delete()
        expect(await point()).toMatchObject({ present: 0, revision: 3, generation: 1 })
        await trx('internalize_receipts').insert(completed)
        expect(await point()).toMatchObject({ present: 1, revision: 4, generation: 4 })
        expect(await trx('internalize_receipts').where(key).first()).toEqual(completed)
        expect((await clock()).revision).toBe(4)
        fixture.check()
      })
      throw stop
    })
  ).rejects.toBe(stop)
}, 120000)

test('actual native journal destination batches exact definitions and restores every rejected layout', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async trx => {
      const packets: Array<{ sql: string; bindings: unknown[] }> = []
      const observe = (query: { sql: string; bindings?: unknown[] }): void => {
        const bindings = query.bindings ?? []
        if (
          query.sql.includes('CAST(sql AS BLOB)') &&
          typeof bindings[0] === 'string' &&
          bindings[0].startsWith('snapshot_reconciliation_')
        )
          packets.push({ sql: query.sql, bindings })
      }
      trx.on('query', observe)
      try {
        await verifySnapshotJournalDestinationSchema(trx)
      } finally {
        trx.off('query', observe)
      }
      expect(packets.length).toBeGreaterThan(0)
      expect(Math.max(...packets.map(packet => (packet.bindings.length - 1) / 3))).toBeGreaterThanOrEqual(16)
      for (const packet of packets) {
        const definitions = packet.bindings.slice(0, -1)
        expect(packet.bindings.at(-1)).toBe(1)
        expect(definitions.every(value => typeof value === 'string')).toBe(true)
        expect(definitions.length % 3).toBe(0)
        expect(definitions.length / 3).toBeLessThanOrEqual(32)
        const bytes = definitions.reduce<number>((total, value) => total + Buffer.byteLength(String(value)), 0)
        expect(bytes <= 32768 || definitions.length === 3).toBe(true)
        expect(
          16 +
            Buffer.byteLength(packet.sql) +
            packet.bindings.reduce<number>(
              (total, value) => total + (typeof value === 'string' ? 5 + Buffer.byteLength(value) : 9),
              0
            )
        ).toBeLessThanOrEqual(65537)
      }
      const geometry = async () => await trx.raw('PRAGMA page_count')
      const originalGeometry = await geometry()
      const catalogCount = async () => await trx('main.sqlite_schema').count({ count: '*' }).first()
      const originalCount = await catalogCount()
      await runInSeries(['missing', 'altered', 'trigger', 'index'] as const, async variant => {
        await trx.raw('SAVEPOINT independent_destination_schema_batch')
        try {
          if (variant === 'missing') await trx.raw('DROP TABLE snapshot_reconciliation_windows')
          else if (variant === 'altered')
            await trx.raw('ALTER TABLE snapshot_reconciliation_windows ADD COLUMN independent_destination_column TEXT')
          else if (variant === 'trigger')
            await trx.raw(
              'CREATE TRIGGER independent_destination_schema_trigger BEFORE UPDATE ON snapshot_reconciliation_windows BEGIN SELECT 1; END'
            )
          else
            await trx.raw(
              'CREATE INDEX independent_destination_schema_index ON snapshot_reconciliation_windows(userId)'
            )
          await expect(verifySnapshotJournalDestinationSchema(trx)).rejects.toThrow()
        } finally {
          await trx.raw('ROLLBACK TO independent_destination_schema_batch')
          await trx.raw('RELEASE independent_destination_schema_batch')
        }
        await verifySnapshotJournalDestinationSchema(trx)
        expect(await geometry()).toEqual(originalGeometry)
        expect(await catalogCount()).toEqual(originalCount)
      })
    })
    fixture.check()
  }, 'after-journal')
}, 120000)
