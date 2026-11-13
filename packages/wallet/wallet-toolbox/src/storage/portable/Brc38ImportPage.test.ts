import { prepareBrc38ImportPage, brc38ImportTableOrder } from './Brc38ImportPage'
import { importPageFixture, pageClone } from './Brc38ImportPageFixture'
import { brc38StageTables } from './Brc38SemanticStage'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import type { Brc38AuthenticatedImportReader } from './KnexBrc38StagingStore'
import { runInSeries } from '../../utility/runInSeries'
describe('bounded authoritative private import page producer', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })
  test('header is explicit, source primary/history preserved in prepared data, and payload is one-use', async () => {
    const f = importPageFixture(),
      page = await prepareBrc38ImportPage(f.reader, f.metadata, f.admission, 0)
    expect(page.step).toMatchObject({ fromRow: 0, rows: 1, mappedIds: 0 })
    expect(page.references).toEqual([])
    await page.consume(async data => {
      if (data.kind !== 'header') throw new Error('Header missing')
      expect(data.user.userId).toBe(f.data.user.userId)
      expect(data.user.activeStorage).toBe(f.data.user.activeStorage)
      expect(data.user.created_at).toBeInstanceOf(Date)
      expect(data.user.created_at.toISOString()).toBe(f.data.user.created_at)
      expect(data.original).toEqual(f.header)
      expect(Object.isFrozen(data.user)).toBe(true)
    })
    expect(() => page.consume(jest.fn())).toThrow('already consumed')
    expect(f.scalarReads).toBe(13)
    expect(f.calls).toEqual([])
  })
  test('thirteen-table dependency order matches the existing restore insertion contract', async () => {
    expect(brc38ImportTableOrder).toEqual([
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
    ])
    const f = importPageFixture()
    let cursor = 1
    await runInSeries(brc38ImportTableOrder, async table => {
      const page = await prepareBrc38ImportPage(f.reader, f.metadata, f.admission, cursor)
      expect(page.step).toMatchObject({ fromRow: cursor, rows: f.data.tables[table].length })
      await page.consume(async data => {
        if (data.kind !== 'table') throw new Error('Table missing')
        expect(data.table).toBe(table)
        expect(data.fromIndex).toBe(0)
        expect(data.rows).toHaveLength(f.data.tables[table].length)
      })
      cursor += page.step.rows
    })
    expect(cursor).toBe(f.admission.totalRows)
    expect(f.maximumPending).toBe(1)
    expect(f.calls).toHaveLength(13)
  })
  test('a row budget returns a proper prefix and exact next indexed coordinate without advancing skipped rows', async () => {
    const data = semanticStageFixture()
    data.tables.outputBaskets.push(
      { ...data.tables.outputBaskets[0], basketId: -2, name: 'second' },
      { ...data.tables.outputBaskets[0], basketId: 1e21, name: 'third' }
    )
    const f = importPageFixture(data),
      admission = { ...f.admission, maximumStepRows: 2 },
      first = await prepareBrc38ImportPage(f.reader, f.metadata, admission, 2)
    expect(first.step).toMatchObject({ fromRow: 2, rows: 2, mappedIds: 2 })
    expect(f.calls).toEqual([
      { table: 'outputBaskets', index: 0 },
      { table: 'outputBaskets', index: 1 }
    ])
    const next = await prepareBrc38ImportPage(f.reader, f.metadata, admission, 4)
    expect(next.step.rows).toBe(1)
    expect(next.references[0].incomingId).toBe(1e21)
  })
  test('a small serialized page budget keeps the original larger row allocation budget', async () => {
    const data = semanticStageFixture()
    data.tables.outputBaskets.push({
      ...data.tables.outputBaskets[0],
      basketId: -2,
      name: 'second'
    })
    const f = importPageFixture(data),
      admission = { ...f.admission, maximumStepBytes: 300 },
      page = await prepareBrc38ImportPage(f.reader, f.metadata, admission, 2)
    expect(page.step.rows).toBe(1)
    expect(page.step.bytes).toBeLessThanOrEqual(300)
    expect(f.calls).toHaveLength(2)
  })
  test('required foreign IDs are deduplicated while self-ID references remain non-required', async () => {
    const data = semanticStageFixture()
    data.tables.outputs[0].spentBy = data.tables.outputs[0].transactionId
    const f = importPageFixture(data),
      start = 1 + brc38ImportTableOrder.slice(0, 5).reduce((sum, table) => sum + data.tables[table].length, 0),
      page = await prepareBrc38ImportPage(f.reader, f.metadata, f.admission, start)
    expect(page.references).toEqual(
      expect.arrayContaining([
        { entity: 'output', incomingId: data.tables.outputs[0].outputId, required: false },
        { entity: 'transaction', incomingId: data.tables.outputs[0].transactionId, required: true },
        { entity: 'outputBasket', incomingId: data.tables.outputs[0].basketId, required: true }
      ])
    )
    expect(page.references).toHaveLength(3)
  })
  test('base64, timestamps, JSON history and unknown legacy extension fields keep their decoded meaning', async () => {
    const data = semanticStageFixture()
    data.tables.provenTxReqs[0].extension = { value: 'original' }
    const f = importPageFixture(data),
      start = 1 + brc38ImportTableOrder.slice(0, 11).reduce((sum, table) => sum + data.tables[table].length, 0),
      page = await prepareBrc38ImportPage(f.reader, f.metadata, f.admission, start)
    await page.consume(async value => {
      if (value.kind !== 'table' || value.table !== 'provenTxReqs') throw new Error('Request missing')
      const row = value.rows[0]
      expect(row.rawTx).toEqual([1, 2])
      expect(row.created_at.toISOString()).toBe(data.tables.provenTxReqs[0].created_at)
      expect(JSON.parse(row.history)).toEqual(data.tables.provenTxReqs[0].history)
      expect(JSON.parse(row.notify)).toEqual(data.tables.provenTxReqs[0].notify)
      expect(row).toHaveProperty('extension', { value: 'original' })
    })
  })
  test('digest is stable under insertion-order changes and changes with bounded source content', async () => {
    const f = importPageFixture(),
      first = await prepareBrc38ImportPage(f.reader, f.metadata, f.admission, 2)
    f.data.tables.outputBaskets[0] = Object.fromEntries(Object.entries(f.data.tables.outputBaskets[0]).reverse())
    const same = await prepareBrc38ImportPage(
      f.reader,
      f.metadata,
      {
        ...f.admission,
        scope: {
          userId: 7,
          archiveSha256: f.admission.scope.archiveSha256,
          bindingSha256: f.admission.scope.bindingSha256,
          importId: f.admission.scope.importId
        }
      },
      2
    )
    expect(same.step).toEqual(first.step)
    f.data.tables.outputBaskets[0].name = 'changed'
    const changed = await prepareBrc38ImportPage(f.reader, f.metadata, f.admission, 2)
    expect(changed.step.pageSha256).not.toBe(first.step.pageSha256)
  })
  test.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])('invalid cursor %s refuses before source reads', async cursor => {
    const f = importPageFixture()
    await expect(prepareBrc38ImportPage(f.reader, f.metadata, f.admission, cursor)).rejects.toThrow('stale')
    expect(f.scalarReads).toBe(0)
  })
  test.each([0, 2])('a changed authoritative scalar count by %s refuses before payload loading', async delta => {
    const f = importPageFixture(),
      reader: Brc38AuthenticatedImportReader = {
        ...f.reader,
        count: async table => (table === brc38StageTables[0] ? delta : await f.reader.count(table))
      }
    await expect(prepareBrc38ImportPage(reader, f.metadata, f.admission, 1)).rejects.toThrow('stale')
    expect(f.calls).toEqual([])
  })
  test('missing indexed row cannot skip its cursor', async () => {
    const f = importPageFixture(),
      reader = { ...f.reader, row: async () => undefined }
    await expect(prepareBrc38ImportPage(reader, f.metadata, f.admission, 1)).rejects.toThrow('stale')
  })
  test('header table arrays must be empty after actual semantic staging', async () => {
    const f = importPageFixture(),
      reader = { ...f.reader, header: async () => pageClone(f.data) }
    await expect(prepareBrc38ImportPage(reader, f.metadata, f.admission, 0)).rejects.toThrow('stale')
  })
  test.each([0, 1])('insufficient byte budget refuses header/first-row %s without truncation', async cursor => {
    const f = importPageFixture()
    await expect(
      prepareBrc38ImportPage(f.reader, f.metadata, { ...f.admission, maximumStepBytes: 1 }, cursor)
    ).rejects.toThrow('budget')
  })
  test('cancellation during scalar reads completes only the owned current read and never begins payload loading', async () => {
    const f = importPageFixture(),
      abort = new AbortController(),
      reason = new Error('Synthetic cancellation'),
      reader = {
        ...f.reader,
        count: async (table: (typeof brc38StageTables)[number]) => {
          const value = await f.reader.count(table)
          abort.abort(reason)
          return value
        }
      }
    await expect(prepareBrc38ImportPage(reader, f.metadata, f.admission, 0, abort.signal)).rejects.toBe(reason)
    expect(f.scalarReads).toBe(1)
    expect(f.calls).toEqual([])
  })
  test('original expiry is not renewed by preparation', async () => {
    const f = importPageFixture()
    jest.spyOn(Date, 'now').mockReturnValue(f.admission.expiresAt)
    await expect(prepareBrc38ImportPage(f.reader, f.metadata, f.admission, 0)).rejects.toThrow('stale')
    expect(f.scalarReads).toBe(0)
  })
})
