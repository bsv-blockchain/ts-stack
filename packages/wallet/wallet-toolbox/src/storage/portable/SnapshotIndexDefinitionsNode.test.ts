import { previewDestinationFixture } from './Brc38ImportPreviewFixture'
import { metadata, readPlan, validateInstalled, type Plan } from '../schema/snapshotSqliteIndexGeneration'
import { runInSeries } from '../../utility/runInSeries'

describe('actual native exact generation-definition reads', () => {
  let fixture: Awaited<ReturnType<typeof previewDestinationFixture>>
  let plan: Plan
  beforeAll(async () => {
    fixture = await previewDestinationFixture()
  })
  beforeEach(async () => {
    plan = await readPlan(fixture.k)
  })
  afterAll(async () => {
    await fixture?.close()
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
      query.sql.startsWith('select count(*) as `matches`, count(distinct `name`) as `names` from `sqlite_master`')
    )
    expect(expected.length).toBeGreaterThan(16)
    expect(pages.length).toBeGreaterThanOrEqual(Math.ceil(expected.length / 16))
    expect(pages.length).toBeLessThanOrEqual(expected.length)
    const pairs: unknown[][] = [],
      completeSql: unknown[] = []
    for (const query of pages) {
      const values = query.bindings.slice(0, -1)
      expect(query.bindings.at(-1)).toBe(1)
      expect(query.sql.endsWith(' limit ?')).toBe(true)
      expect(values.length).toBeGreaterThan(0)
      expect(values.length % 3).toBe(0)
      expect(values.length).toBeLessThanOrEqual(48)
      const bindingBytes = values.reduce<number>((sum, value) => sum + Buffer.byteLength(String(value)), 0)
      // One longer original definition still has its individual bounded query.
      expect(bindingBytes <= 32768 || values.length === 3).toBe(true)
      for (let at = 0; at < values.length; at += 3) {
        pairs.push(values.slice(at, at + 2))
        completeSql.push(values[at + 2])
      }
    }
    expect(pairs).toEqual(expected)
    expect(completeSql).toEqual([...plan.ddl, ...plan.triggers])
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
