import { readGenerationIndexState, migration } from '../schema/snapshotSqliteIndexState'
import { dropGenerationForDataDeletion } from '../schema/snapshotSqliteIndexMigration'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { fixture, exact, value, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'
import { installGeneration, names, metadata, progress, oldProgress } from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../schema/snapshotSqliteIndexBootstrap'
import { legacyNames } from '../schema/snapshotSqliteMembership'

function generation(k: Knex): Knex {
  const mapping = new Map(Object.entries(legacyNames).map(([key, value]) => [value, names[key as keyof typeof names]]))
  return new Proxy(k, {
    apply(target, self, args: unknown[]) {
      if (typeof args[0] === 'string' && mapping.has(args[0])) args[0] = mapping.get(args[0])
      return Reflect.apply(target, self, args)
    }
  })
}
async function finish(k: Knex, plan: Awaited<ReturnType<typeof installGeneration>>) {
  for (let page = 0; page < 100; page++) if ((await copyGenerationPage(k, plan)).complete) return
  throw new Error('Rebuild did not finish')
}

test.each(['BINARY', 'NOCASE', 'RTRIM'])(
  'fresh %s generation repairs stale indexes while low-key writes continue',
  async collation => {
    const k = await fixture(collation, false, false)
    try {
      for (const table of tables) for (const id of [1, 2]) await k(table).insert(value(table, id, id, id))
      await replace(k, 'transactions', value('transactions', 1, 2, 3))
      await expect(exact(k)).rejects.toThrow()
      const source = await k('transactions')
      const plan = await installGeneration(k)
      expect(await k('transactions')).toEqual(source)
      for (const table of oldProgress) expect((await k(table)).every(row => row.complete === 0)).toBe(true)
      let pages = 0
      for (; pages < 100; pages++) {
        const result = await copyGenerationPage(k, plan)
        if (result.complete) break
        await replace(k, 'transactions', value('transactions', 1, 2, (pages % 2) + 1))
        await replace(k, 'certificates', value('certificates', 1, 1, (pages % 2) + 1))
        await replace(k, 'proven_tx_reqs', value('proven_tx_reqs', 1, 2, (pages % 2) + 1))
      }
      expect(pages).toBe(12)
      await exact(generation(k))
      expect(await k(metadata).first('complete')).toEqual({ complete: 1 })
      expect(await installGeneration(k)).toEqual(plan)
      await finish(k, plan)
      await exact(generation(k))
    } finally {
      await k.destroy()
    }
  }
)

test('page rollback keeps its cursor and memberships together; resumed copies are bounded', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    for (let start = 0; start < 600; start += 100)
      await k('transactions').insert(
        Array.from({ length: 100 }, (_, i) => value('transactions', start + i + 1, start + i + 1, 1))
      )
    const plan = await installGeneration(k)
    const failure = new Error('synthetic checkpoint write failure')
    const inject = (query: { sql: string }) => {
      if (query.sql.startsWith('update `' + progress + '`')) throw failure
    }
    k.on('query', inject)
    try {
      await expect(copyGenerationPage(k, plan)).rejects.toBe(failure)
    } finally {
      k.off('query', inject)
    }
    expect(await k(names.profile)).toEqual([])
    expect(await k(progress).where('stream', 0).first()).toMatchObject({ afterId: 0, complete: 0 })
    const first = await copyGenerationPage(k, plan)
    expect(first.copiedThrough).toMatchObject({ afterId: 256, complete: 0 })
    expect(await k(names.profile)).toHaveLength(256)
    await replace(k, 'transactions', value('transactions', 1, 2, 2))
    const resumed = await installGeneration(k)
    expect((await copyGenerationPage(k, resumed)).copiedThrough).toMatchObject({
      afterId: 512,
      complete: 0
    })
    expect((await copyGenerationPage(k, resumed)).copiedThrough).toMatchObject({
      afterId: 600,
      complete: 1
    })
    await finish(k, resumed)
    await exact(generation(k))
  } finally {
    await k.destroy()
  }
})

test.each(['tx_labels_map', 'output_tags_map', 'certificate_fields'])(
  'unsupported additional unique constraint on %s refuses atomically',
  async table => {
    const k = await fixture('BINARY', false, false)
    try {
      const column = table === 'tx_labels_map' ? 'transactionId' : table === 'output_tags_map' ? 'outputId' : 'userId'
      await k.raw('CREATE UNIQUE INDEX unexpected_identity ON ??(??)', [table, column])
      const before = await k('sqlite_master').orderBy('name')
      await expect(installGeneration(k)).rejects.toThrow('Unsupported composite identity constraints')
      expect(await k('sqlite_master').orderBy('name')).toEqual(before)
    } finally {
      await k.destroy()
    }
  }
)

test('changed source schema and missing owned triggers refuse resume without adopting the mismatch', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    const plan = await installGeneration(k)
    await k.raw('CREATE INDEX unexpected_source_index ON tx_labels(userId)')
    await expect(installGeneration(k)).rejects.toThrow('Rebuild source binding mismatch')
    await k.raw('DROP INDEX unexpected_source_index')
    await k.raw('DROP TRIGGER snapshot_identity_before_transactions_INSERT')
    await expect(installGeneration(k)).rejects.toThrow('Rebuild schema definition mismatch')
    expect(await k(metadata).first('complete')).toEqual({ complete: 0 })
    expect(plan.source).not.toBe('')
  } finally {
    await k.destroy()
  }
})

test.each([
  'missing progress',
  'extra progress',
  'negative cursor',
  'wrong text cursor',
  'partial composite cursor',
  'invalid completion',
  'wrong source binding',
  'negative retirement',
  'fractional retirement',
  'excess retirement',
  'published pending',
  'completed with pending streams',
  'missing lock',
  'changed lock'
])('malformed generation state refuses adoption: %s', async kind => {
  const k = await fixture('BINARY', false, false)
  try {
    await k('transactions').insert(value('transactions', 1, 1, 1))
    await installGeneration(k)
    if (kind === 'missing progress') await k(progress).where('stream', 0).delete()
    if (kind === 'extra progress')
      await k(progress).insert({ stream: 12, afterId: 0, afterSecond: 0, afterText: '', complete: 0 })
    if (kind === 'negative cursor') await k(progress).where('stream', 0).update({ afterId: -1 })
    if (kind === 'wrong text cursor') await k(progress).where('stream', 0).update({ afterText: 'unexpected' })
    if (kind === 'partial composite cursor') await k(progress).where('stream', 8).update({ afterId: 1 })
    if (kind === 'invalid completion') await k(progress).where('stream', 0).update({ complete: 2 })
    if (kind === 'wrong source binding') await k(metadata).update({ source: 'changed' })
    if (kind === 'negative retirement') await k(metadata).update({ retireTable: -1 })
    if (kind === 'fractional retirement') await k(metadata).update({ retireTable: 0.5 })
    if (kind === 'excess retirement') await k(metadata).update({ retireTable: 7 })
    if (kind === 'published pending')
      await k('knex_migrations').insert({ name: migration, batch: 99, migration_time: new Date() })
    if (kind === 'completed with pending streams') await k(metadata).update({ complete: 1 })
    if (kind === 'missing lock') await k.schema.dropTable('snapshot_index_install_lock_v2')
    if (kind === 'changed lock') await k.raw('ALTER TABLE snapshot_index_install_lock_v2 ADD COLUMN extra INTEGER')
    const before = await k('transactions')
    await expect(readGenerationIndexState(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
    if (kind === 'missing lock' || kind === 'changed lock') {
      await expect(dropGenerationForDataDeletion(k)).rejects.toBeInstanceOf(WERR_INVALID_OPERATION)
      expect(await k.schema.hasTable(names.profile)).toBe(true)
    }
    expect(await k('transactions')).toEqual(before)
  } finally {
    await k.destroy()
  }
})
