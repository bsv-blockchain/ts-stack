import { withBrc38NativePrivateContractFixture } from '../../portable/Brc38NativePrivateContractFixture'
import {
  installBrc38NativeLocalBaselineGeneration,
  brc38NativeLocalBaselineSourceDefinitions
} from '../../portable/Brc38NativeLocalBaselineGenerationNode'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import { readBoundedSnapshotJournalSqliteSchema } from './SnapshotJournalSqliteGeneration'
import type { Knex } from 'knex'

function blobBytes(value: unknown): number {
  if (Buffer.isBuffer(value)) return value.length
  if (Array.isArray(value)) return value.reduce((sum, part) => sum + blobBytes(part), 0)
  if (value !== null && typeof value === 'object')
    return Object.values(value).reduce<number>((sum, part) => sum + blobBytes(part), 0)
  return 0
}
async function oracle(
  k: Knex.Transaction
): Promise<Array<{ type: string; name: string; tbl_name: string; sql: string | null }>> {
  const positions = await k('main.sqlite_schema')
    .whereIn('tbl_name', ['users', 'settings', 'tx_labels'])
    .select(k.raw('CAST(rowid AS TEXT) AS position'))
    .orderBy(['type', 'name'])
    .limit(513)
  if (positions.length > 512) throw new Error('Independent fixture inventory exceeds512objects')
  const result: Array<{ type: string; name: string; tbl_name: string; sql: string | null }> = []
  for (const row of positions) {
    const value = await k('main.sqlite_schema')
      .where('rowid', row.position)
      .first(
        'type',
        'name',
        'tbl_name',
        k.raw('length(CAST(sql AS BLOB)) AS bytes'),
        k.raw('CASE WHEN length(CAST(sql AS BLOB))<=8192 THEN sql END AS sql')
      )
    let sql: string | null = value.sql
    if (value.bytes !== null && value.bytes > 8192) {
      const parts: Buffer[] = []
      for (let offset = 0; offset < value.bytes; offset += 512) {
        const part = await k('main.sqlite_schema')
          .where('rowid', row.position)
          .first(k.raw('substr(CAST(sql AS BLOB),?,512) AS part', [offset + 1]))
        expect(Buffer.isBuffer(part.part)).toBe(true)
        parts.push(part.part)
      }
      sql = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts))
    }
    result.push({ type: value.type, name: value.name, tbl_name: value.tbl_name, sql })
  }
  return result
}
async function measured(k: Knex.Transaction): Promise<Awaited<ReturnType<typeof oracle>>> {
  const queries: string[] = [],
    responses: number[] = []
  const query = (value: { sql: string }): void => {
    queries.push(value.sql)
  }
  const response = (value: unknown): void => {
    responses.push(blobBytes(value))
  }
  k.on('query', query).on('query-response', response)
  let result: Awaited<ReturnType<typeof oracle>> | undefined
  try {
    result = await readBoundedSnapshotJournalSqliteSchema(k, ['users', 'settings', 'tx_labels'])
  } finally {
    k.removeListener('query', query).removeListener('query-response', response)
  }
  if (result === undefined) throw new Error('Independent measured schema response missing')
  expect(result.length).toBeGreaterThan(8)
  expect(queries.length).toBeLessThan(result.length + 1)
  expect(Math.max(...responses)).toBeLessThanOrEqual(16384)
  expect(responses.length).toBe(queries.length)
  return result
}

test('actual native schema batches retain complete exact ordering and fresh rollback data', async () => {
  const stop = new Error('independent native schema batch fixture stop')
  let stopped = false
  try {
    await withBrc38NativePrivateContractFixture(async fixture => {
      await fixture.withWriter(async k => {
        await installBrc38NativeLocalBaselineGeneration(k, {
          maximumRows: 1024,
          ceiling: snapshotJournalRevision('100000')
        })
        const expected = await oracle(k)
        expect(await measured(k)).toEqual(expected)
        // Fresh installations and retained compact-name generations use the
        // same settings UPDATE observer body. Select its actual physical name
        // from the independent inventory, then require its source definition.
        const observers = expected.filter(
          row =>
            row.type === 'trigger' &&
            row.tbl_name === 'settings' &&
            /^brc38_local_baseline_(settings|s1)_update$/.test(row.name)
        )
        expect(observers).toHaveLength(1)
        const observer = observers[0]
        const original = (await brc38NativeLocalBaselineSourceDefinitions(k)).find(sql =>
          sql.startsWith('CREATE TRIGGER ' + observer.name + ' AFTER UPDATE ON settings ')
        )!
        expect(typeof original).toBe('string')
        for (const bytes of [16384, 16385]) {
          await k.raw('SAVEPOINT actual_native_schema_bytes')
          try {
            const row = observer
            expect(row).toBeDefined()
            const prefix = original.slice(0, original.indexOf('BEGIN ') + 6) + "SELECT '🙂﻿",
              suffix = "'; " + original.slice(original.indexOf('BEGIN ') + 6)
            const padding = bytes - Buffer.byteLength('trigger' + row.name + row.tbl_name + prefix + suffix)
            expect(padding).toBeGreaterThan(0)
            await k.raw('DROP TRIGGER ' + observer.name)
            await k.raw(prefix + 'x'.repeat(padding) + suffix)
            const changed = await oracle(k)
            expect(changed).not.toEqual(expected)
            const changedRow = changed.find(value => value.name === row.name)!
            expect(
              Object.values(changedRow).reduce<number>((sum, value) => sum + Buffer.byteLength(value ?? ''), 0)
            ).toBe(bytes)
            expect(await measured(k)).toEqual(changed)
          } finally {
            await k.raw('ROLLBACK TO actual_native_schema_bytes')
            await k.raw('RELEASE actual_native_schema_bytes')
          }
          expect(await measured(k)).toEqual(expected)
          expect(await oracle(k)).toEqual(expected)
        }
        fixture.check()
      })
      throw stop
    })
  } catch (cause) {
    if (cause !== stop) throw cause
    stopped = true
  }
  expect(stopped).toBe(true)
}, 120000)
