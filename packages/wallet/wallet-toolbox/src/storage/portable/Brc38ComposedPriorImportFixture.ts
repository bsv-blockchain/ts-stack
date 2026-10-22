import { expect } from '@jest/globals'
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { WalletStorageManager } from '../WalletStorageManager'
import { withComposedFixtureRead } from './Brc38ComposedSemanticFixture'

// Independent original table coordinates. Neither a production inventory nor
// the production metadata encoder supplies this fixture's expected bytes.
const originals = [
  'brc38_import_journal',
  'brc38_import_ids',
  'brc38_import_original_budget',
  'brc38_import_original',
  'brc38_import_streamed_original_budget',
  'brc38_import_streamed_original',
  'brc38_import_structured_original_budget',
  'brc38_import_structured_original',
  'private_binary_fields',
  'private_binary_chunks',
  'private_text_fields',
  'private_text_chunks',
  'private_structured_fields',
  'private_structured_chunks',
  'private_canonical_structured_fields',
  'private_canonical_structured_chunks',
  'private_projected_structured_fields',
  'private_projected_structured_chunks'
] as const
type Cell = null | bigint | number | string | Uint8Array
type MetadataCell = readonly ['null'] | readonly ['integer' | 'real' | 'text' | 'blob', string]
type Metadata = ReadonlyArray<readonly [string, MetadataCell]>
interface Original {
  readonly tableId: number
  readonly sourceRowId: number
  readonly metadata: Metadata
  readonly fieldKind: 'none' | 'blob' | 'text'
  readonly payload: Buffer
}
interface Retained extends Original {
  readonly sourceLineageSha256: string
}
export interface ComposedPriorImportFixture {
  readonly originals: readonly Original[]
  readonly retained: readonly Retained[]
}
const maximumRows = 512
const maximumBytes = 4194304
const maximumCellBytes = 1048576
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const key = (row: Retained): string => JSON.stringify([row.sourceLineageSha256, row.tableId, row.sourceRowId])

/** Small, bounded fixture only: preserve every SQLite type and full payload,
 * including inert prior receipts, IDs and source operational values. */
function metadata(row: Readonly<Record<string, Cell>>): Metadata {
  return Object.keys(row)
    .sort((a, b) => Number(a > b) - Number(a < b))
    .map(name => {
      const value = row[name]
      const cell: MetadataCell =
        value === null
          ? ['null']
          : typeof value === 'bigint'
            ? ['integer', value.toString()]
            : typeof value === 'number'
              ? ['real', Object.is(value, -0) ? '-0' : value.toString()]
              : typeof value === 'string'
                ? ['text', value]
                : ['blob', Buffer.from(value).toString('base64')]
      return [name, cell] as const
    })
}

async function present(read: Knex.Transaction, table: string): Promise<boolean> {
  const rows = await read('sqlite_schema').where({ name: table, type: 'table' }).select('name').limit(2)
  expect(rows.length).toBeLessThanOrEqual(1)
  return rows.length === 1
}

async function captureOriginals(read: Knex.Transaction): Promise<Original[]> {
  const result: Original[] = []
  let charged = 0
  for (const [tableId, table] of originals.entries()) {
    if (!(await present(read, table))) continue
    const columns = (await read.raw('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 129', [table])) as Array<{
      name: string
    }>
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.length).toBeLessThanOrEqual(128)
    const names = columns.map(column => column.name)
    expect(names.every(name => /^[A-Za-z][A-Za-z0-9_]*$/.test(name))).toBe(true)
    const payloadField = [3, 5, 7].includes(tableId)
      ? 'originalJson'
      : [9, 11, 13, 15, 17].includes(tableId)
        ? 'payload'
        : undefined
    if (payloadField !== undefined) expect(names).toContain(payloadField)
    const sizes = (await read(table)
      .select(
        read.raw('rowid AS physical'),
        read.raw(names.map(() => 'coalesce(length(CAST(?? AS BLOB)),0)').join('+') + ' AS bytes', names)
      )
      .orderBy('rowid')
      .limit(maximumRows + 1)) as Array<{ physical: number; bytes: number }>
    expect(result.length + sizes.length).toBeLessThanOrEqual(maximumRows)
    for (const size of sizes) {
      expect(Number.isSafeInteger(size.physical)).toBe(true)
      expect(Number.isSafeInteger(size.bytes)).toBe(true)
      expect(size.bytes).toBeGreaterThanOrEqual(0)
      expect(size.bytes).toBeLessThanOrEqual(maximumCellBytes)
      charged += size.bytes + 512
      expect(charged).toBeLessThanOrEqual(maximumBytes)
      const rows = (await read(table)
        .whereRaw('rowid=?', [size.physical])
        .select(names)
        .limit(2)
        .options({ safeIntegers: true })) as Array<Record<string, Cell>>
      expect(rows).toHaveLength(1)
      const row = rows[0]
      for (const value of Object.values(row)) {
        expect(
          value === null ||
            typeof value === 'bigint' ||
            typeof value === 'string' ||
            value instanceof Uint8Array ||
            (typeof value === 'number' && Number.isFinite(value))
        ).toBe(true)
      }
      const value = payloadField === undefined ? undefined : row[payloadField]
      if (payloadField !== undefined) delete row[payloadField]
      const payload =
        value === undefined
          ? Buffer.alloc(0)
          : typeof value === 'string'
            ? Buffer.from(value)
            : Buffer.from(value as Uint8Array)
      result.push({
        tableId,
        sourceRowId: size.physical,
        metadata: metadata(row),
        fieldKind: value === undefined ? 'none' : typeof value === 'string' ? 'text' : 'blob',
        payload
      })
    }
  }
  return result
}

async function captureRetained(read: Knex.Transaction): Promise<{ lineage?: string; rows: Retained[] }> {
  const tables = ['brc38_local_prior_import_budget', 'brc38_local_prior_import_rows', 'brc38_local_prior_import_chunks']
  const exists: boolean[] = []
  for (const table of tables) exists.push(await present(read, table))
  expect(exists.every(Boolean) || exists.every(value => !value)).toBe(true)
  if (!exists[0]) return { rows: [] }
  const budgets = await read(tables[0]).select('*').limit(2)
  expect(budgets).toHaveLength(1)
  const budget = budgets[0]
  expect(budget.copyTable).toBe(19)
  expect(budget.afterRowId).toBeNull()
  expect(budget.sourceLineageSha256).toMatch(/^[0-9a-f]{64}$/)
  const sizes = (await read(tables[1])
    .select('bytes', read.raw('length(CAST(metadataJson AS BLOB)) AS metadataBytes'))
    .limit(maximumRows + 1)) as Array<{ bytes: number; metadataBytes: number }>
  expect(sizes.length).toBeLessThanOrEqual(maximumRows)
  let charged = 0
  for (const size of sizes) {
    expect(Number.isSafeInteger(size.bytes)).toBe(true)
    expect(Number.isSafeInteger(size.metadataBytes)).toBe(true)
    expect(size.bytes).toBeGreaterThanOrEqual(0)
    expect(size.bytes).toBeLessThanOrEqual(maximumCellBytes)
    expect(size.metadataBytes).toBeGreaterThan(0)
    expect(size.metadataBytes).toBeLessThanOrEqual(maximumCellBytes)
    charged += size.bytes + size.metadataBytes + 512
    expect(charged).toBeLessThanOrEqual(maximumBytes)
  }
  const rows = (await read(tables[1])
    .select('*')
    .orderBy('sourceLineageSha256')
    .orderBy('tableId')
    .orderBy('sourceRowId')
    .limit(maximumRows + 1)) as Array<{
    sourceLineageSha256: string
    tableId: number
    sourceRowId: number
    metadataJson: string
    metadataSha256: string
    fieldKind: Original['fieldKind']
    bytes: number
    sha256: string | null
    accepted: number
    chunks: number
    state: string
  }>
  expect(rows).toHaveLength(sizes.length)
  expect(budget.records).toBe(rows.length)
  let logicalBytes = 0,
    chunkCount = 0
  const result: Retained[] = []
  for (const row of rows) {
    expect(row.sourceLineageSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isSafeInteger(row.tableId)).toBe(true)
    expect(row.tableId).toBeGreaterThanOrEqual(0)
    expect(row.tableId).toBeLessThan(18)
    expect(Number.isSafeInteger(row.sourceRowId)).toBe(true)
    expect(row.state).toBe('SEALED')
    expect(row.accepted).toBe(row.bytes)
    expect(hash(row.metadataJson)).toBe(row.metadataSha256)
    const coordinate = {
      sourceLineageSha256: row.sourceLineageSha256,
      tableId: row.tableId,
      sourceRowId: row.sourceRowId
    }
    const chunks = (await read(tables[2])
      .where(coordinate)
      .select('offset', 'bytes', 'payload', 'sha256')
      .orderBy('offset')
      .limit(1025)) as Array<{ offset: number; bytes: number; payload: Uint8Array; sha256: string }>
    expect(chunks.length).toBeLessThanOrEqual(1024)
    expect(chunks).toHaveLength(row.chunks)
    let offset = 0
    const parts: Buffer[] = []
    for (const chunk of chunks) {
      expect(chunk.offset).toBe(offset)
      expect(chunk.payload).toBeInstanceOf(Uint8Array)
      expect(chunk.bytes).toBe(chunk.payload.byteLength)
      expect(chunk.bytes).toBeGreaterThan(0)
      expect(chunk.bytes).toBeLessThanOrEqual(16384)
      expect(hash(chunk.payload)).toBe(chunk.sha256)
      offset += chunk.bytes
      expect(offset).toBeLessThanOrEqual(row.bytes)
      parts.push(Buffer.from(chunk.payload))
    }
    const payload = Buffer.concat(parts)
    expect(payload.length).toBe(row.bytes)
    expect(row.fieldKind === 'none' ? row.sha256 : hash(payload)).toBe(row.fieldKind === 'none' ? null : row.sha256)
    if (row.fieldKind === 'none') expect(payload).toHaveLength(0)
    logicalBytes += 512 + Buffer.byteLength(row.metadataJson) + payload.length + 512 * chunks.length
    chunkCount += chunks.length
    result.push({
      ...coordinate,
      metadata: JSON.parse(row.metadataJson) as Metadata,
      fieldKind: row.fieldKind,
      payload
    })
  }
  expect(budget.logicalBytes).toBe(logicalBytes)
  const total = (await read(tables[2]).count({ count: '*' }).first()) as { count: number }
  expect(total.count).toBe(chunkCount)
  expect(new Set(result.map(key)).size).toBe(result.length)
  return { lineage: budget.sourceLineageSha256 as string, rows: result }
}

/** Capture before mutation. Previously inherited DATA is captured separately
 * so another import cannot silently discard or rewrite the older cohorts. */
export async function captureComposedPriorImports(manager: WalletStorageManager): Promise<ComposedPriorImportFixture> {
  return await withComposedFixtureRead(manager, async read => {
    const originals = await captureOriginals(read),
      retained = await captureRetained(read)
    expect(originals.length).toBeGreaterThan(0)
    return { originals, retained: retained.rows }
  })
}

export async function assertComposedPriorImports(
  manager: WalletStorageManager,
  before: ComposedPriorImportFixture
): Promise<void> {
  await withComposedFixtureRead(manager, async read => {
    const actual = await captureRetained(read)
    expect(actual.lineage).toBeDefined()
    const expected = new Map(before.retained.map(row => [key(row), row]))
    for (const original of before.originals) {
      const row = { ...original, sourceLineageSha256: actual.lineage! },
        identity = key(row)
      if (expected.has(identity)) expect(expected.get(identity)).toEqual(row)
      expected.set(identity, row)
    }
    expect(actual.rows).toHaveLength(expected.size)
    expect(new Map(actual.rows.map(row => [key(row), row]))).toEqual(expected)
  })
}
