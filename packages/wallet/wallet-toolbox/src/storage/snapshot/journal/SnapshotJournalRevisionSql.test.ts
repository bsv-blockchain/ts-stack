import { knex, type Knex } from 'knex'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalRevisionText, snapshotJournalRevisionOperand } from './SnapshotJournalRevisionSql'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

test('the SQL helpers preserve exact SQLite range and generation values', async () => {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await k.raw('CREATE TABLE revisions(revision INTEGER PRIMARY KEY,generation INTEGER NOT NULL)')
    const values = ['9', '10', '9007199254740992', '9007199254740993', '9223372036854775807']
    for (const revision of values) await k('revisions').insert({ revision, generation: revision })
    const query = k('revisions')
      .select({
        revisionText: snapshotJournalRevisionText(k, 'revisions.revision'),
        generationText: snapshotJournalRevisionText(k, 'revisions.generation')
      })
      .where('revision', '>', snapshotJournalRevisionOperand(k, snapshotJournalRevision('9007199254740992')))
      .orderBy('revision')
      .limit(2)
    expect(await query).toEqual(values.slice(3).map(value => ({ revisionText: value, generationText: value })))
    const sql = query.toSQL(),
      plan: Array<{ detail: string }> = await k.raw('EXPLAIN QUERY PLAN ' + sql.sql, sql.bindings)
    expect(plan.some(row => row.detail.includes('SEARCH revisions USING INTEGER PRIMARY KEY'))).toBe(true)
    expect(plan.some(row => row.detail.includes('TEMP B-TREE'))).toBe(false)
    expect(() => snapshotJournalRevisionOperand(k, '9223372036854775808' as SnapshotJournalRevision)).toThrow(
      WERR_INVALID_OPERATION
    )
    expect(() => snapshotJournalRevisionOperand(k, '1 OR 1=1' as SnapshotJournalRevision)).toThrow(
      WERR_INVALID_OPERATION
    )
  } finally {
    await k.destroy()
  }
})

test('MySQL operands and selected text use integer-preserving types and parameter bindings', async () => {
  const k = knex({ client: 'mysql2' })
  try {
    const query = k('revisions')
      .select({ exactRevision: snapshotJournalRevisionText(k, 'revision') })
      .where('revision', '>', snapshotJournalRevisionOperand(k, snapshotJournalRevision('9007199254740992')))
      .orderBy('revision')
      .limit(2)
      .toSQL()
    expect(query.sql).toContain('CAST(`revision` AS CHAR)')
    expect(query.sql).toContain('CAST(? AS SIGNED)')
    expect(query.bindings).toEqual(['9007199254740992', 2])
  } finally {
    await k.destroy()
  }
})

test.each(['pg', 'mssql', 'mysql-custom', undefined])('unknown driver %p refuses before issuing SQL', client => {
  const k = { client: { config: { client } } } as unknown as Knex
  expect(() => snapshotJournalRevisionText(k, 'revision')).toThrow('Unsupported snapshot journal SQL driver')
  expect(() => snapshotJournalRevisionOperand(k, snapshotJournalRevision('0'))).toThrow(
    'Unsupported snapshot journal SQL driver'
  )
})
