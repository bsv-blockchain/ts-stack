import { fixture, value } from '../../../test/utils/snapshotSqliteFixtures'
import { migrateGeneration, refuseGenerationDowngrade } from '../schema/snapshotSqliteIndexMigration'
import { migration, readGenerationIndexState } from '../schema/snapshotSqliteIndexState'
import { names } from '../schema/snapshotSqliteIndexGeneration'
import { retiredTables } from '../schema/snapshotSqliteLegacyOwnership'

test('registered-style migration yields between bounded pages and never auto-publishes its journal', async () => {
  const k = await fixture('BINARY', false, false)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    for (let start = 0; start < 600; start += 100)
      await k('transactions').insert(
        Array.from({ length: 100 }, (_, i) => value('transactions', start + i + 1, start + i + 1, 1))
      )
    const source = await k('transactions').orderBy('transactionId')
    let turns = 0,
      active = true
    const foreground = () => {
      turns++
      if (active) timer = setTimeout(foreground, 0)
    }
    timer = setTimeout(foreground, 0)
    try {
      await migrateGeneration(k)
    } finally {
      active = false
      if (timer) clearTimeout(timer)
    }
    expect(turns).toBeGreaterThan(2)
    expect(await k('transactions').orderBy('transactionId')).toEqual(source)
    expect(await k(names.profile)).toHaveLength(600)
    for (const table of retiredTables) expect(await k.schema.hasTable(table)).toBe(false)
    expect(await readGenerationIndexState(k)).toBe(false)
    await k('knex_migrations').insert({ name: migration, batch: 99, migration_time: new Date() })
    expect(await readGenerationIndexState(k)).toBe('v2')
    await migrateGeneration(k)
    await expect(refuseGenerationDowngrade(k)).rejects.toThrow('downgrade is unsupported')
    expect(await k('transactions').orderBy('transactionId')).toEqual(source)
  } finally {
    if (timer) clearTimeout(timer)
    await k.destroy()
  }
})

test('an outer SQLite transaction refuses before any schema edit', async () => {
  const k = await fixture('BINARY', false, false)
  try {
    const before = await k('sqlite_master').orderBy('name')
    await k.transaction(async trx => {
      await expect(migrateGeneration(trx)).rejects.toThrow('independent bounded transactions')
    })
    expect(await k('sqlite_master').orderBy('name')).toEqual(before)
  } finally {
    await k.destroy()
  }
})
