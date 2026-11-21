import { randomUUID } from 'node:crypto'
import { prepareBrc38ImportHistory } from './Brc38ImportHistory'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { importPageFixture } from './Brc38ImportPageFixture'
import { prepareBrc38ImportPage, type Brc38PreparedImportData } from './Brc38ImportPage'
import { runInSeries } from '../../utility/runInSeries'
import type { JsonValue } from './Brc38PortableRows'
import { loadBrc38ImportIdMap } from './Brc38ImportIdMap'
import { commitBrc38ImportJournalStep } from './Brc38ImportJournal'

describe('bounded native import history projection', () => {
  let target: Awaited<ReturnType<typeof importJournalFixture>>
  beforeEach(async () => {
    target = await importJournalFixture()
    await target.prepare()
    await target.k.transaction(
      async trx =>
        await commitBrc38ImportJournalStep(
          trx,
          target.admission,
          target.step(0, 4),
          await target.destinationSha256(trx),
          async () => {
            const incoming = [14, 0, -7, 1e300],
              local = [0, -7, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
              loaded = await loadBrc38ImportIdMap(
                trx,
                target.admission.scope,
                incoming.map(incomingId => ({ entity: 'transaction', incomingId, required: false }))
              )
            await trx('native_import_rows').insert(
              local.map(rowId => ({ rowId, userId: 7, value: 'signed native target' }))
            )
            for (let index = 0; index < incoming.length; index++)
              loaded.map.transaction.idMap[incoming[index]] = local[index]
            await loaded.persist()
            return await target.destinationSha256(trx)
          }
        )
    )
  })
  afterEach(async () => await target?.close())
  async function data(table: 'syncStates' | 'provenTxReqs', json: JsonValue) {
    const source = importPageFixture()
    if (table === 'syncStates') source.data.tables.syncStates[0].syncMap = json
    else source.data.tables.provenTxReqs[0].notify = json
    // The fixture reader holds this exact source. Locate by indexed counts, not
    // assumptions about a table's archive position.
    const all = [
      'provenTxs',
      'outputBaskets',
      'outputTags',
      'txLabels',
      'transactions',
      'outputs',
      'txLabelMaps',
      'outputTagMaps',
      'certificates',
      'certificateFields',
      'commissions',
      'provenTxReqs',
      'syncStates'
    ] as const
    let from = 1
    for (const name of all) {
      if (name === table) break
      from += source.data.tables[name].length
    }
    return await (
      await prepareBrc38ImportPage(source.reader, source.metadata, source.admission, from)
    ).consume(async prepared => prepared)
  }
  async function prepare(value: Brc38PreparedImportData, maximum = 65536, signal?: AbortSignal) {
    return await target.k.transaction(
      async trx => await prepareBrc38ImportHistory(trx, target.admission.scope, value, maximum, signal)
    )
  }
  test('notifications preserve original history, keep signed/zero/exponent source identity, deduplicate targets and omit unknown IDs', async () => {
    const original = { transactionIds: [14, 14, 0, -7, 1e300, 999, 1.5], flag: false, attempts: 0 },
      source = await data('provenTxReqs', original),
      before = JSON.stringify(source),
      [projection] = await prepare(source)
    expect(projection.originalJson).toBe(JSON.stringify(original))
    expect(JSON.parse(projection.mappedJson)).toEqual({
      transactionIds: [-Number.MAX_SAFE_INTEGER, -7, 0, Number.MAX_SAFE_INTEGER],
      flag: false,
      attempts: 0
    })
    expect(projection).toMatchObject({ field: 'notify', unmappedIds: 1, activated: false })
    expect(JSON.stringify(source)).toBe(before)
    expect(Object.isFrozen(projection)).toBe(true)
    expect(await target.k('brc38_import_ids')).toHaveLength(4)
  })
  test('sync checkpoints retain original counts/dates and canonical remote aliases; unmapped IDs never become native IDs', async () => {
    const original = {
        transaction: {
          entityName: 'original-transactions',
          count: -9,
          maxUpdated_at: '2025-04-05T06:07:08.000Z',
          idMap: { '01': 999, '1': 14, '2': 0, '3': -7, '4': 1e300, '5': 999 }
        }
      },
      source = await data('syncStates', original),
      [projection] = await prepare(source),
      mapped = JSON.parse(projection.mappedJson)
    // Existing decoder/normalization enumerates integer property 1 first, then
    // alias01 overwrites it. Both unknown source entries remain provenance only.
    expect(mapped.transaction).toEqual({
      entityName: 'original-transactions',
      count: -9,
      maxUpdated_at: '2025-04-05T06:07:08.000Z',
      idMap: { '2': -7, '3': -Number.MAX_SAFE_INTEGER, '4': Number.MAX_SAFE_INTEGER }
    })
    expect(projection.originalJson).toBe(JSON.stringify(original))
    expect(projection).toMatchObject({ unmappedIds: 2, activated: false })
    expect(Object.keys(mapped)).toHaveLength(12)
    expect(mapped.output).toEqual({ entityName: 'output', count: 0, idMap: {} })
  })
  test('one history row exceeds4096 references using only sequential128-entry scoped native queries', async () => {
    const idMap: Record<number, number> = {}
    for (let index = 0; index < 5001; index++) idMap[index] = index === 0 ? 14 : 900000 + index
    // This bounded synthetic row is detached data; no historical crash fixture
    // is selected. Full end-to-end big-archive qualification remains separate.
    const source = await data('syncStates', {}),
      json = JSON.stringify({ transaction: { idMap } })
    if (source.kind !== 'table' || source.table !== 'syncStates') throw new Error('History fixture missing')
    const prepared: Brc38PreparedImportData = {
        ...source,
        rows: [{ ...source.rows[0], syncMap: json }]
      },
      queries: Array<{ sql: string; bindings?: readonly unknown[] }> = []
    target.k.on('query', value => queries.push(value))
    const [projection] = await prepare(prepared, 1048576),
      reads = queries.filter(value => value.sql.startsWith('select') && value.sql.includes('brc38_import_ids'))
    expect(reads).toHaveLength(40)
    const batchSizes = reads.map(value => {
      const list = /`incomingId` in \(([^)]*)\)/.exec(value.sql)?.[1]
      if (list === undefined) throw new Error('Bounded native reference selector missing')
      return list.split(',').length
    })
    expect(batchSizes.every(value => value <= 128)).toBe(true)
    expect(batchSizes.reduce((sum, value) => sum + value, 0)).toBe(5001)
    expect(
      reads.every(
        value =>
          value.sql.includes('`importId`') && value.sql.includes('`archiveSha256`') && value.sql.includes('`userId`')
      )
    ).toBe(true)
    expect(JSON.parse(projection.mappedJson).transaction.idMap).toEqual({ '0': 0 })
    expect(projection.unmappedIds).toBe(5000)
    expect(projection.originalJson).toBe(json)
    expect(queries.filter(value => /^(insert|update|delete)/.test(value.sql))).toEqual([])
  })
  test('every scope dimension refuses using another import/profile mapping and never writes', async () => {
    const source = await data('provenTxReqs', { transactionIds: [14] }),
      scopes = [
        { ...target.admission.scope, importId: randomUUID() },
        { ...target.admission.scope, userId: -7 },
        { ...target.admission.scope, archiveSha256: 'c'.repeat(64) },
        { ...target.admission.scope, bindingSha256: 'd'.repeat(64) }
      ]
    await runInSeries(scopes, async scope => {
      const [projection] = await target.k.transaction(
        async trx => await prepareBrc38ImportHistory(trx, scope, source, 65536)
      )
      expect(JSON.parse(projection.mappedJson).transactionIds).toEqual([])
      expect(projection.unmappedIds).toBe(1)
    })
    expect(await target.k('brc38_import_ids')).toHaveLength(4)
  })
  test('invalid budgets, cancellation and normalized metadata amplification refuse before publication', async () => {
    const source = await data('syncStates', {}),
      abort = new AbortController(),
      reason = new Error('history cancel')
    await expect(prepare(source, 0)).rejects.toThrow('budget')
    await expect(prepare(source, 128)).rejects.toThrow('budget')
    abort.abort(reason)
    await expect(prepare(source, 65536, abort.signal)).rejects.toBe(reason)
    expect(await target.k('brc38_import_ids')).toHaveLength(4)
  })
})
