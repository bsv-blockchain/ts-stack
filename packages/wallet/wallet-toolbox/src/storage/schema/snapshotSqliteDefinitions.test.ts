import { fixture as sqliteFixture } from '../../../test/utils/snapshotSqliteFixtures'
import type { Knex } from 'knex'
import { metadata, readPlan, validateInstalled, installGeneration, type Plan } from './snapshotSqliteIndexGeneration'
import { runInSeries } from '../../utility/runInSeries'
import { validateLegacy, legacySchema, retiredTables } from './snapshotSqliteLegacyOwnership'
import { copyGenerationPage } from './snapshotSqliteIndexBootstrap'
import { retireGenerationPage } from './snapshotSqliteIndexRetirement'

test('retirement retains exactly the surviving legacy definitions across each committed page', async () => {
  const k = await sqliteFixture('BINARY', false, false)
  try {
    const plan = await installGeneration(k)
    let copied = false
    for (let page = 0; page < 64 && !copied; page++) copied = (await copyGenerationPage(k, plan)).complete
    expect(copied).toBe(true)
    const original = await k(metadata).where('id', 0).first()
    const inventory = JSON.parse(original.legacy)
    expect(inventory.length).toBeGreaterThan(retiredTables.length)
    await k(metadata)
      .where('id', 0)
      .update({ legacy: JSON.stringify(inventory.slice(1)) })
    await expect(retireGenerationPage(k, plan)).rejects.toThrow('Legacy retirement schema changed')
    expect(await k.schema.hasTable(retiredTables[0])).toBe(true)
    expect((await k(metadata).where('id', 0).first()).retireTable).toBe(0)
    await k(metadata).where('id', 0).update(original)
    let complete = false
    for (let page = 0; page < 64 && !complete; page++) {
      const before = await k(metadata).where('id', 0).first()
      const result = await retireGenerationPage(k, await readPlan(k))
      const after = await k(metadata).where('id', 0).first()
      expect(after.source).toBe(plan.source)
      if (result.removed === 0) {
        expect(JSON.parse(after.legacy)).toEqual(await legacySchema(k))
        expect(Buffer.byteLength(after.legacy)).toBeLessThanOrEqual(Buffer.byteLength(before.legacy))
        if (result.table !== undefined) expect(await k.schema.hasTable(result.table)).toBe(false)
      }
      complete = result.complete
    }
    expect(complete).toBe(true)
    expect((await k(metadata).where('id', 0).first()).legacy).toBe('[]')
    // An existing finished generation with its historical full receipt is
    // forward-compatible: verify physical absence before releasing that data.
    await k(metadata).where('id', 0).update({ legacy: original.legacy })
    await expect(retireGenerationPage(k, await readPlan(k))).resolves.toEqual({
      complete: true,
      removed: 0,
      table: undefined
    })
    const finished = await k(metadata).where('id', 0).first()
    expect(finished.legacy).toBe('[]')
    await retireGenerationPage(k, await readPlan(k))
    expect(await k(metadata).where('id', 0).first()).toEqual(finished)
  } finally {
    await k.destroy()
  }
}, 30000)

test('legacy ownership reads every complete trigger and view in bounded catalog replies', async () => {
  const k = await sqliteFixture('BINARY', false, false)
  try {
    for (let index = 0; index < 24; index++)
      await k.raw(`CREATE VIEW "independent_view_${String(index).padStart(2, '0')}" AS SELECT 1 AS value`)
    await k.transaction(async trx => {
      const expected: Array<{ type: string; name: string }> = await trx('sqlite_master')
        .whereIn('type', ['trigger', 'view'])
        .select('type', 'name')
        .orderBy(['type', 'name'])
      const queries: string[] = []
      const observe = (query: { sql: string }): void => {
        if (query.sql.startsWith('select `type`, `name`, `tbl_name`, `sql` from `sqlite_master`'))
          queries.push(query.sql)
      }
      trx.on('query', observe)
      try {
        await validateLegacy(trx)
      } finally {
        trx.removeListener('query', observe)
      }
      expect(queries).toHaveLength(expected.length + 1)
      expect(queries.every(sql => sql.endsWith('order by `type` asc, `name` asc limit ?'))).toBe(true)
      // The last view must still be checked after every earlier trigger/view.
      // Retain its complete definition, including a reference after a long comment.
      await trx.raw(
        `CREATE VIEW "zz_independent_foreign_view" AS SELECT /*${'x'.repeat(4096)}*/ * FROM "${retiredTables[0]}"`
      )
      await expect(validateLegacy(trx)).rejects.toThrow('Unowned object references legacy auxiliary data')
    })
  } finally {
    await k.destroy()
  }
}, 30000)

describe('actual native exact generation-definition reads', () => {
  let fixture: { k: Knex }
  let plan: Plan
  beforeAll(async () => {
    fixture = { k: await sqliteFixture('BINARY', false, false) }
    await installGeneration(fixture.k)
  })
  beforeEach(async () => {
    plan = await readPlan(fixture.k)
  })
  afterAll(async () => {
    await fixture?.k.destroy()
  })
  test('reads every exact type/name in pages of at most sixteen without writes or authority caches', async () => {
    const queries: Array<{ sql: string; bindings: unknown[] }> = []
    const observe = (query: { sql: string; bindings: unknown[] }) => queries.push(query)
    fixture.k.on('query', observe)
    try {
      await validateInstalled(fixture.k, plan)
    } finally {
      fixture.k.removeListener('query', observe)
    }
    const expected = [...plan.ddl, ...plan.triggers].map(sql => {
      const match = /^CREATE (TABLE|INDEX|TRIGGER) ("[^"]+"|\w+)/.exec(sql)!
      return [match[1].toLowerCase(), match[2].replaceAll('"', '')]
    })
    const pages = queries.filter(query =>
      query.sql.startsWith('select `type`, substr(name,1,129) AS name, substr(sql,1,65537) AS sql from `sqlite_master`')
    )
    expect(expected.length).toBeGreaterThan(16)
    expect(pages).toHaveLength(Math.ceil(expected.length / 16))
    const pairs = pages.map(query => {
      const values = query.bindings.slice(0, -1)
      expect(query.bindings.at(-1)).toBe(values.length / 2 + 1)
      expect(query.sql.endsWith(' limit ?')).toBe(true)
      return values
    })
    expect(pairs.every(values => values.length > 0 && values.length <= 32)).toBe(true)
    expect(pairs.flat()).toEqual(expected.flat())
    expect(queries.every(query => /^(select|PRAGMA|EXPLAIN)\b/i.test(query.sql))).toBe(true)
    const later = { ...plan, ddl: [...plan.ddl] }
    later.ddl[0] += '\n'
    await expect(validateInstalled(fixture.k, later)).rejects.toThrow('Rebuild schema definition mismatch: ')
  })
  test.each(['TABLE', 'INDEX', 'TRIGGER'])('still compares the entire %s SQL text', async type => {
    const changed = { ...plan, ddl: [...plan.ddl], triggers: [...plan.triggers] }
    const list = type === 'TRIGGER' ? changed.triggers : changed.ddl
    const index = list.findIndex(sql => sql.startsWith('CREATE ' + type + ' '))
    expect(index).toBeGreaterThanOrEqual(0)
    list[index] += '\n'
    await expect(validateInstalled(fixture.k, changed)).rejects.toThrow('Rebuild schema definition mismatch: ')
  })
  test('pairs the object type with its exact name and rejects a missing definition', async () => {
    const changed = { ...plan, ddl: [...plan.ddl] }
    changed.ddl[0] = changed.ddl[0].replace('CREATE TABLE ', 'CREATE INDEX ')
    await expect(validateInstalled(fixture.k, changed)).rejects.toThrow('Rebuild schema definition mismatch: ')
    changed.ddl[0] = plan.ddl[0].replace('snapshot_profile_keys_v2', 'fixture_missing_definition')
    await expect(validateInstalled(fixture.k, changed)).rejects.toThrow(
      'Rebuild schema definition mismatch: fixture_missing_definition'
    )
  })
  test('preserves the first mismatch before a later malformed definition and reports malformed plans', async () => {
    const changed = { ...plan, ddl: [...plan.ddl] }
    changed.ddl[0] += '\n'
    changed.ddl[1] = 'invalid generated fixture definition'
    await expect(validateInstalled(fixture.k, changed)).rejects.toThrow(
      'Rebuild schema definition mismatch: snapshot_profile_keys_v2'
    )
    changed.ddl[0] = plan.ddl[0]
    await expect(validateInstalled(fixture.k, changed)).rejects.toThrow('Invalid generated schema definition')
  })
  test('retains duplicate expected definitions and refuses a changed source plan', async () => {
    await expect(validateInstalled(fixture.k, { ...plan, ddl: [...plan.ddl, plan.ddl[0]] })).resolves.toBeUndefined()
    await expect(validateInstalled(fixture.k, { ...plan, source: plan.source + ' ' })).rejects.toThrow(
      'Rebuild source schema changed'
    )
  })
  test('checks the actual source-binding metadata after the complete schema read', async () => {
    const original = await fixture.k(metadata).where('id', 0).first()
    await runInSeries([{ complete: 2 }, { retireTable: -1 }, { source: plan.source + ' ' }], async change => {
      try {
        await fixture.k(metadata).where('id', 0).update(change)
        await expect(validateInstalled(fixture.k, plan)).rejects.toThrow('Rebuild source binding mismatch')
      } finally {
        await fixture.k(metadata).where('id', 0).update(original)
      }
    })
    await expect(validateInstalled(fixture.k, plan)).resolves.toBeUndefined()
  })
})
