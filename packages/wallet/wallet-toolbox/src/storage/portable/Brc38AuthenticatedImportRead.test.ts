import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { Brc38SemanticStage } from './Brc38SemanticStage'
import { semanticStageFixture, options } from './Brc38SemanticStageFixture'
import { resumeBinding, resumeLimits } from './Brc38ResumeFixture'
import { previewDestinationFixture, previewPrivateFixture, previewReceiptPolicy } from './Brc38ImportPreviewFixture'
import { previewBrc38PrivateImport } from './Brc38PrivateImportPreviewNode'
import { brc38StageTables } from './Brc38SemanticStage'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import { runInSeries } from '../../utility/runInSeries'
describe('actual authenticated bounded private import reads', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    staged: Awaited<ReturnType<typeof previewPrivateFixture>>
  const store = () => staged.value.reservation.store
  beforeEach(async () => {
    target = await previewDestinationFixture()
    staged = await previewPrivateFixture()
    await previewBrc38PrivateImport(store(), target.storage, 'restore', previewReceiptPolicy)
  })
  afterEach(async () => {
    try {
      await staged?.close()
    } finally {
      await target?.close()
    }
  })
  test('actual sealed header and thirteen indexed counts/rows match the authenticated archive without target writes', async () => {
    let escaped!: Readonly<Brc38AuthenticatedImportReader>
    const queries: Array<{ sql: string; bindings?: readonly unknown[] }> = []
    store().knex.on('query', (query: { sql: string; bindings?: readonly unknown[] }) => {
      queries.push(query)
    })
    await store().withAuthenticatedImportRead(async (json, metadata, reader) => {
      escaped = reader
      expect(JSON.parse(json).archiveSha256).toBe(staged.selected.binding.archiveSha256)
      const header = await reader.header()
      expect(header.user.identityKey).toBe(staged.selected.binding.identityKey)
      let total = 0
      await runInSeries(brc38StageTables, async table => {
        const count = await reader.count(table)
        total += count
        if (count > 0)
          expect(await reader.row(table, 0)).toEqual(
            await store()
              .knex('rows')
              .where({ tableName: table, position: 0 })
              .first('payload')
              .then(row => JSON.parse(row.payload))
          )
        expect(await reader.row(table, count)).toBeUndefined()
      })
      expect(total).toBe(metadata.rows)
    })
    await expect(escaped.header()).rejects.toThrow('unavailable')
    expect(queries.some(query => /\boffset\b/i.test(query.sql))).toBe(false)
    // Data rows use keyed metadata and indexes. COUNT is permitted only for
    // the owner's bounded catalog checks, which verify actual sealing guards.
    const catalogCounts = queries.filter(query => /count\s*\(/i.test(query.sql))
    expect(catalogCounts.length).toBeGreaterThan(0)
    for (const query of catalogCounts) {
      const sql = query.sql.replace(/\s+/g, ' ')
      if (/^select count\(\*\) as `count` /i.test(sql))
        expect(sql).toMatch(
          /^select count\(\*\) as `count` from (?:`main`\.)?`sqlite_(?:schema|master)` where .+ limit \?$/i
        )
      else {
        // Fresh field-family verification aggregates only its bounded catalog,
        // including complete DDL/prefix/seal checks; it never counts data rows.
        expect(sql).toMatch(/^select count\(\*\) AS total, sum\(CASE WHEN /)
        expect(sql.match(/\bfrom\b/gi)).toHaveLength(1)
        expect(sql).toMatch(/ AS sealMatches from `sqlite_schema` where `tbl_name` in \(\?, \?\) limit \?$/)
        expect(
          [...sql.matchAll(/ AS (total|baseMatches|prefixMatches|sealCount|sealMatches)\b/g)].map(match => match[1])
        ).toEqual(['total', 'baseMatches', 'prefixMatches', 'sealCount', 'sealMatches'])
      }
      expect(query.bindings?.at(-1)).toBe(1)
    }
    expect(await target.writer('users')).toEqual([])
  })
  test('unawaited actual native read is drained before preparation releases the kernel owner', async () => {
    let read!: Promise<number>,
      settled = false
    const result = await store().withAuthenticatedImportRead(async (_json, _metadata, reader) => {
      read = reader.count(brc38StageTables[0])
      void read.then(() => {
        settled = true
      })
      await expect(store().close()).rejects.toThrow('Wait for owned')
      await expect(store().readImportPreview()).rejects.toThrow('already owned')
      return 'prepared'
    })
    expect(result).toBe('prepared')
    expect(settled).toBe(true)
    expect(await read).toBeGreaterThanOrEqual(0)
    expect(await store().readImportPreview()).toBeDefined()
  })
  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    'invalid row coordinate %s refuses before payload SQL',
    async index => {
      await expect(
        store().withAuthenticatedImportRead(
          async (_json, _metadata, reader) => await reader.row(brc38StageTables[0], index)
        )
      ).rejects.toThrow('coordinate')
    }
  )
  test('sealed authenticated payload refuses mutation and retains the original readable row', async () => {
    const original = await store().knex('rows').first('tableName', 'position', 'payload'),
      coordinate = { tableName: original.tableName, position: original.position }
    await expect(
      store()
        .knex('rows')
        .where(coordinate)
        .update({ payload: 'x'.repeat(store().limits.maximumRowBytes + 1) })
    ).rejects.toThrow('Authenticated private source is immutable')
    await store().withAuthenticatedImportRead(async (_json, _metadata, reader) => {
      expect(await reader.row(coordinate.tableName, coordinate.position)).toEqual(JSON.parse(original.payload))
    })
    expect(await target.writer('users')).toEqual([])
  })
  test('oversized stored payload is refused at native extent before payload loading', async () => {
    // Corrupt a real provisional row: successful authentication makes the
    // source immutable. Both states use the same physical row-extent reader.
    const parent = await mkdtemp(join(tmpdir(), 'brc38-import-read-extent-'))
    let provisional: KnexBrc38StagingStore | undefined
    try {
      provisional = await KnexBrc38StagingStore.createOwned(parent, resumeLimits(), resumeBinding())
      await new Brc38SemanticStage(provisional, options).provisionalRow(
        'outputBaskets',
        0,
        semanticStageFixture().tables.outputBaskets[0]
      )
      await provisional
        .knex('rows')
        .where({ tableName: 'outputBaskets', position: 0 })
        .update({
          payload: 'x'.repeat(provisional.limits.maximumRowBytes + 1)
        })
      const queries: string[] = []
      provisional.knex.on('query', (query: { sql: string }) => {
        queries.push(query.sql)
      })
      await expect(provisional.row('outputBaskets', 0)).rejects.toThrow('length is inconsistent')
      expect(queries.some(sql => /^select `payload`/i.test(sql))).toBe(false)
    } finally {
      await provisional?.close()
      await rm(parent, { recursive: true, force: true })
    }
  })
})
