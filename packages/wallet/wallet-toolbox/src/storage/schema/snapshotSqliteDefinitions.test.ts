import { fixture as sqliteFixture } from '../../../test/utils/snapshotSqliteFixtures'
import type { Knex } from 'knex'
import { metadata, readPlan, validateInstalled, installGeneration, type Plan } from './snapshotSqliteIndexGeneration'
import { runInSeries } from '../../utility/runInSeries'

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
    const pages = queries.filter(query => query.sql.startsWith('select `type`, `name`, `sql` from `sqlite_master`'))
    expect(expected.length).toBeGreaterThan(16)
    expect(pages).toHaveLength(Math.ceil(expected.length / 16))
    expect(pages.every(query => query.bindings.length > 0 && query.bindings.length <= 32)).toBe(true)
    expect(pages.flatMap(query => query.bindings)).toEqual(expected.flat())
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
