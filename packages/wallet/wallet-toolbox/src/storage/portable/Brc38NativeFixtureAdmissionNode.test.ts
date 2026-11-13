import { snapshotJournalQuotaLayout } from '../snapshot/journal/SnapshotJournalNativeQuotaLayout'
import {
  snapshotJournalOrdinarySqliteQuotaTriggers,
  snapshotJournalSharedQuotaTriggers
} from '../snapshot/journal/SnapshotJournalSharedQuota'
import { nativeQuotaDispatchDdl } from '../snapshot/journal/SnapshotJournalNativeQuotaSql'
import { previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { withBrc38NativePrivateContractFixture } from './Brc38NativePrivateContractFixture'
import {
  installBrc38NativeLocalPackedLayout,
  hasBrc38NativeLocalPackedLayout
} from './Brc38NativeLocalPackedLayoutNode'
import {
  installBrc38NativeLocalBaselineGeneration,
  readBrc38NativeLocalBaselineGeneration,
  hasBrc38NativeLocalBaselineGenerationSchema
} from './Brc38NativeLocalBaselineGenerationNode'
import {
  installSnapshotJournalSqliteGeneration,
  readSnapshotJournalSqliteGeneration
} from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { snapshotJournalRevision, MAX_SNAPSHOT_JOURNAL_REVISION } from '../snapshot/journal/SnapshotJournalRevision'
import * as sqliteGeneration from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import type { Knex } from 'knex'
import { KnexMigrations } from '../schema/KnexMigrations'
import { PRIMARY_HANDOFF_MIGRATION } from '../schema/primaryHandoffMigration'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'

/** Independent complete catalogue observation in one genuine retained view.
 * Metadata pages and exact BLOB windows keep the native response bounded;
 * the production reader's per-source object bound is not a database bound. */
async function catalogue(k: Knex.Transaction): Promise<unknown> {
  const result: Array<{
    position: number
    type: string
    name: string
    tbl_name: string
    rootpage: number
    sql: string | null
  }> = []
  let position = 0
  while (true) {
    const rows: Array<{
      position: number
      type: string
      name: string
      tbl_name: string
      rootpage: number
      sqlBytes: number | null
    }> = await k('main.sqlite_schema')
      .where('rowid', '>', position)
      .orderBy('rowid')
      .select(
        k.raw('rowid AS position'),
        'type',
        'name',
        'tbl_name',
        'rootpage',
        k.raw('length(CAST(sql AS BLOB)) AS sqlBytes')
      )
      .limit(8)
    if (rows.length === 0) return result
    for (const row of rows) {
      expect(Number.isSafeInteger(row.position)).toBe(true)
      expect(row.position).toBeGreaterThan(position)
      let sql: string | null = null
      if (row.sqlBytes !== null) {
        expect(Number.isSafeInteger(row.sqlBytes)).toBe(true)
        expect(row.sqlBytes).toBeGreaterThanOrEqual(0)
        expect(row.sqlBytes).toBeLessThanOrEqual(65536)
        const parts: Buffer[] = []
        for (let offset = 0; offset < row.sqlBytes; offset += 4096) {
          const bytes = Math.min(4096, row.sqlBytes - offset),
            part = (
              await k('main.sqlite_schema')
                .where('rowid', row.position)
                .select(k.raw('substr(CAST(sql AS BLOB),?,?) AS part', [offset + 1, bytes]))
                .first()
            ).part
          expect(Buffer.isBuffer(part)).toBe(true)
          expect(part.length).toBe(bytes)
          parts.push(part)
        }
        sql = Buffer.concat(parts, row.sqlBytes).toString('utf8')
      }
      result.push({
        position: row.position,
        type: row.type,
        name: row.name,
        tbl_name: row.tbl_name,
        rootpage: row.rootpage,
        sql
      })
      position = row.position
    }
  }
}
async function installAdditionalLayout(k: Knex.Transaction): Promise<void> {
  await installBrc38NativeLocalPackedLayout(k)
  await installBrc38NativeLocalBaselineGeneration(k, {
    maximumRows: 1024,
    ceiling: snapshotJournalRevision('100000')
  })
}

test('private preview retains its original four-MiB authenticated admission by default', async () => {
  const fixture = await previewPrivateFixture()
  try {
    expect(fixture.selected.limits.maximumPhysicalBytes).toBe(4194304)
    expect(fixture.value.reservation.store.limits.maximumPhysicalBytes).toBe(4194304)
    expect(fixture.selected.limits.maximumRowAllocationBytes).toBe(65536)
  } finally {
    await fixture.close()
  }
}, 30000)

test('explicit preview admission rejects invalid physical allowances before opening a fixture', async () => {
  for (const maximum of [0, 1048575, 16777217, Number.MAX_SAFE_INTEGER, Number.NaN])
    await expect(previewPrivateFixture(undefined, undefined, 65536, maximum)).rejects.toThrow(
      'explicit bounded physical allowance'
    )
})

test('the original four-MiB native allowance refuses the complete layout and retains real rollback state', async () => {
  const stopped = new Error('Independent small-admission exhaustion proof completed')
  let verifiedRollback = false,
    nativeOrigin: unknown,
    migrationFailure: unknown
  const observation: { store?: KnexBrc38StagingStore } = {}
  let expectedFailure: unknown = stopped,
    primaryAttempts = 0,
    primaryRunning = false,
    verifiedActiveWriter = false,
    earlyTransactionalFailure = false
  const state = async (k: Knex.Transaction) => ({
    schema: await catalogue(k),
    baseline: (await hasBrc38NativeLocalBaselineGenerationSchema(k))
      ? await readBrc38NativeLocalBaselineGeneration(k)
      : undefined,
    packed: await hasBrc38NativeLocalPackedLayout(k),
    settings: await k('settings').select('*'),
    pages: await k.raw('PRAGMA page_count'),
    maximum: await k.raw('PRAGMA max_page_count')
  })
  // Observe the real current migration and genuine admitted owner. The full
  // candidate still attempts every current migration under the original limit;
  // newer tables may exhaust that limit before the before-journal callback.
  const admit = KnexBrc38StagingStore.prototype.assertPrivateNativeDestination,
    migration = KnexMigrations.prototype.getMigration
  const admissionObserver = jest
    .spyOn(KnexBrc38StagingStore.prototype, 'assertPrivateNativeDestination')
    .mockImplementation(function (this: KnexBrc38StagingStore, database) {
      admit.call(this, database)
      observation.store = this
    })
  const addition = sqliteGeneration.migrateSnapshotJournalSqliteSourceAddition
  const additionObserver = jest
    .spyOn(sqliteGeneration, 'migrateSnapshotJournalSqliteSourceAddition')
    .mockImplementation(async (database, apply, config) => {
      if (!primaryRunning) return await addition(database, apply, config)
      const store = observation.store
      if (store === undefined) throw new Error('Actual admitted primary migration owner missing')
      expect(database.isTransaction).toBe(true)
      store.assertPrivateNativeWriteTransaction(database as Knex.Transaction)
      try {
        return await addition(database, apply, config)
      } catch (cause) {
        const origin = cause instanceof Error ? (cause.cause ?? cause) : cause
        expect(origin).toMatchObject({
          code: 'SQLITE_FULL',
          nativeCode: 13,
          nativeAutocommit: false,
          nativeConnectionFenced: false
        })
        nativeOrigin = origin
        expect(await database.raw('SELECT 1 AS retained')).toEqual([{ retained: 1 }])
        verifiedActiveWriter = true
        throw cause
      }
    })
  const migrationObserver = jest.spyOn(KnexMigrations.prototype, 'getMigration').mockImplementation(async function (
    this: KnexMigrations,
    name
  ) {
    const actual = await migration.call(this, name)
    if (name !== PRIMARY_HANDOFF_MIGRATION) return actual
    return {
      ...actual,
      up: async database => {
        primaryAttempts++
        const store = observation.store
        if (store === undefined) throw new Error('Actual admitted small-budget owner missing')
        expect(store.limits.maximumPhysicalBytes).toBe(4194304)
        expect(store.limits.maximumRowBytes).toBe(65536)
        expect(store.limits.maximumRowAllocationBytes).toBe(65536)
        const read = async <T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> =>
          await store.withPrivateNativeDatabase(
            true,
            async owner =>
              await owner.transaction(async trx => {
                store.assertPrivateNativeReadTransaction(trx)
                return await work(trx)
              })
          )
        const before = await read(state)
        expect(before.maximum).toEqual([{ max_page_count: 336 }])
        primaryRunning = true
        try {
          await actual.up(database)
        } catch (cause) {
          const origin = cause instanceof Error ? (cause.cause ?? cause) : cause
          expect(origin).toMatchObject({ code: 'SQLITE_FULL', nativeCode: 13 })
          nativeOrigin = origin
          // A fresh actual read-only slot verifies the entire committed
          // preimage after the failed migration transaction has rolled back.
          await read(async trx => {
            expect(await catalogue(trx)).toEqual(before.schema)
            expect((await state(trx)).baseline).toEqual(before.baseline)
            expect(await trx('settings').select('*')).toEqual(before.settings)
            expect(await trx.raw('PRAGMA page_count')).toEqual(before.pages)
            expect(await trx.raw('PRAGMA max_page_count')).toEqual(before.maximum)
            expect(await hasBrc38NativeLocalPackedLayout(trx)).toBe(before.packed)
            expect(await trx.schema.hasTable('snapshot_journal_generation')).toBe(false)
            expect(await trx.schema.hasTable('wallet_primary_handoffs')).toBe(false)
            expect(await trx.schema.hasTable('wallet_primary_copy_sources')).toBe(false)
          })
          expectedFailure = cause
          earlyTransactionalFailure = true
          verifiedRollback = true
          throw cause
        } finally {
          primaryRunning = false
        }
      }
    }
  })
  try {
    await withBrc38NativePrivateContractFixture(
      async fixture => {
        expect(fixture.store.limits.maximumPhysicalBytes).toBe(4194304)
        expect(fixture.store.limits.maximumRowBytes).toBe(65536)
        expect(fixture.store.limits.maximumRowAllocationBytes).toBe(65536)
        const before = await fixture.withRead(state)
        expect(before.maximum).toEqual([{ max_page_count: 336 }])
        let failure: unknown
        try {
          await fixture.withWriter(async k => {
            await installAdditionalLayout(k)
            await installSnapshotJournalSqliteGeneration(
              k,
              snapshotJournalRevision(MAX_SNAPSHOT_JOURNAL_REVISION),
              previewReceiptPolicy
            )
          })
        } catch (cause) {
          failure = cause
        }
        const origin = failure instanceof Error ? (failure.cause ?? failure) : failure
        expect(origin).toMatchObject({ code: 'SQLITE_FULL', nativeCode: 13 })
        nativeOrigin = origin instanceof Error ? origin.cause : origin
        await fixture.withRead(async k => {
          expect(await catalogue(k)).toEqual(before.schema)
          expect((await state(k)).baseline).toEqual(before.baseline)
          expect(await k('settings').select('*')).toEqual(before.settings)
          expect(await k.raw('PRAGMA page_count')).toEqual(before.pages)
          expect(await k.raw('PRAGMA max_page_count')).toEqual(before.maximum)
          expect(await hasBrc38NativeLocalPackedLayout(k)).toBe(before.packed)
          expect(await k.schema.hasTable('snapshot_journal_generation')).toBe(false)
        })
        fixture.check()
        verifiedRollback = true
        throw stopped
      },
      'before-journal',
      4194304,
      undefined,
      65536
    )
  } catch (cause) {
    migrationFailure = cause
  } finally {
    additionObserver.mockRestore()
    migrationObserver.mockRestore()
    admissionObserver.mockRestore()
  }
  expect(primaryAttempts).toBe(1)
  expect(verifiedRollback).toBe(true)
  if (earlyTransactionalFailure) {
    // This DDL error leaves SQLite's actual transaction active. Knex rolls
    // it back before the independent fresh read proves the complete preimage.
    expect(nativeOrigin).toMatchObject({
      code: 'SQLITE_FULL',
      nativeCode: 13,
      nativeAutocommit: false,
      nativeConnectionFenced: false
    })
    expect(verifiedActiveWriter).toBe(true)
    expect(migrationFailure).toBe(expectedFailure)
    return
  }
  // Late journal exhaustion automatically rolls back and fences its writer.
  // Retain that distinct cleanup outcome and its concrete original causes.
  expect(migrationFailure).toBeInstanceOf(AggregateError)
  if (!(migrationFailure instanceof AggregateError)) throw new Error('Actual fenced migration cleanup missing')
  expect(migrationFailure.message).toBe('Private native migration retains foreign-key restoration failure')
  expect(migrationFailure.errors).toHaveLength(2)
  expect(nativeOrigin).toMatchObject({ code: 'SQLITE_FULL', nativeCode: 13, nativeAutocommit: true })
  expect(migrationFailure.cause).toBe(expectedFailure)
  expect(migrationFailure.errors[0]).toBe(expectedFailure)
  for (const failure of migrationFailure.errors.slice(1)) {
    expect(failure).toMatchObject({
      code: 'SQLITE_ABORT',
      nativeCode: 4,
      nativeConnectionFenced: true,
      nativeAutocommit: true
    })
    expect(failure.cause).toBe(nativeOrigin)
  }
}, 30000)

test('explicit full-feature native admission seals the complete actual packed baseline and journal', async () => {
  let completed = false
  await withBrc38NativePrivateContractFixture(
    async fixture => {
      expect(fixture.store.limits.maximumPhysicalBytes).toBe(16777216)
      await fixture.withWriter(async k => await installAdditionalLayout(k))
    },
    'before-journal',
    16777216,
    async fixture => {
      await fixture.withRead(async k => {
        const generation = await readSnapshotJournalSqliteGeneration(k, previewReceiptPolicy),
          baseline = await readBrc38NativeLocalBaselineGeneration(k),
          pages = (await k.raw('PRAGMA page_count'))[0].page_count
        expect(
          await k.raw(
            'SELECT brc38_runtime_limit(0) AS address,brc38_runtime_limit(1) AS heap,brc38_runtime_limit(2) AS descriptors'
          )
        ).toEqual([{ address: 134217728, heap: 51380224, descriptors: 32 }])
        expect(generation.complete).toBe(true)
        expect(generation.enabled).toBe(true)
        expect(baseline.enabled).toBe(true)
        expect(await hasBrc38NativeLocalPackedLayout(k)).toBe(true)
        expect(await k.raw('PRAGMA max_page_count')).toEqual([{ max_page_count: 1360 }])
        expect(pages).toBeGreaterThan(336)
        expect(pages).toBeLessThanOrEqual(1360)
        expect(fixture.store.limits.maximumPhysicalBytes).toBe(16777216)
        expect(fixture.store.limits.maximumRowBytes).toBe(65536)
        expect(fixture.store.limits.maximumRowAllocationBytes).toBe(16777216)
      })
      fixture.check()
      completed = true
    }
  )
  expect(completed).toBe(true)
}, 30000)

test('explicit full working admission retains the original serialized row limit and rejects invalid allocation before opening', async () => {
  const fixture = await previewPrivateFixture(undefined, undefined, 65536, 16777216, 16777216)
  try {
    expect(fixture.selected.limits.maximumRowBytes).toBe(65536)
    expect(fixture.selected.limits.maximumRowAllocationBytes).toBe(16777216)
    expect(fixture.value.reservation.store.limits.maximumRowBytes).toBe(65536)
    expect(fixture.value.reservation.store.limits.maximumRowAllocationBytes).toBe(16777216)
  } finally {
    await fixture.close()
  }
  for (const maximum of [0, -1, 16777217, Number.MAX_SAFE_INTEGER, Number.NaN])
    await expect(previewPrivateFixture(undefined, undefined, 65536, 16777216, maximum)).rejects.toThrow(
      'explicit bounded allocation allowance'
    )
}, 30000)

test('genuine native owner retains exact ordinary SQLite quota source and refuses mixed or altered historical definitions', async () => {
  await withBrc38NativePrivateContractFixture(async fixture => {
    await fixture.withWriter(async k => {
      const rows: Array<{ sql: string }> = await k('sqlite_schema')
        .where({ type: 'table' })
        .where('name', 'like', 'snapshot_reconciliation_%')
        .select('sql')
      const ddl = rows.map(row => row.sql)
      const compact = await snapshotJournalQuotaLayout(k, ddl)
      for (const trigger of compact.triggers) await k.raw('DROP TRIGGER ??', [trigger.name])
      for (const sql of [...compact.dispatch].reverse()) {
        const definition = /^CREATE (TRIGGER|VIEW) (\w+)/.exec(sql)
        if (definition === null) throw new Error('Actual compact quota definition missing')
        await k.raw('DROP ' + definition[1] + ' ??', [definition[2]])
      }
      const ordinary = snapshotJournalOrdinarySqliteQuotaTriggers(ddl)
      for (const trigger of ordinary) await k.raw(trigger.sql)
      expect(await snapshotJournalQuotaLayout(k, ddl)).toEqual({ ddl, triggers: ordinary, dispatch: [] })
      const native = snapshotJournalSharedQuotaTriggers(k, ddl)
      await k.raw('DROP TRIGGER ??', [ordinary[0].name])
      await k.raw(native[0].sql)
      await expect(snapshotJournalQuotaLayout(k, ddl)).rejects.toThrow('Mixed native quota definitions')
      await k.raw('DROP TRIGGER ??', [native[0].name])
      await k.raw(ordinary[0].sql.replace('4096+', '4097+'))
      await expect(snapshotJournalQuotaLayout(k, ddl)).rejects.toThrow('Shared journal quota differs')
      await k.raw('DROP TRIGGER ??', [ordinary[0].name])
      await k.raw(ordinary[0].sql)
      for (const sql of nativeQuotaDispatchDdl) await k.raw(sql)
      await expect(snapshotJournalQuotaLayout(k, ddl)).rejects.toThrow('Mixed native quota definitions')
      for (const sql of [...nativeQuotaDispatchDdl].reverse()) {
        const definition = /^CREATE (TRIGGER|VIEW) (\w+)/.exec(sql)
        if (definition === null) throw new Error('Actual compact quota definition missing')
        await k.raw('DROP ' + definition[1] + ' ??', [definition[2]])
      }
      for (const trigger of ordinary) await k.raw('DROP TRIGGER ??', [trigger.name])
      for (const trigger of native) await k.raw(trigger.sql)
      expect(await snapshotJournalQuotaLayout(k, ddl)).toEqual({ ddl, triggers: native, dispatch: [] })
    })
  }, 'after-journal')
}, 30000)
