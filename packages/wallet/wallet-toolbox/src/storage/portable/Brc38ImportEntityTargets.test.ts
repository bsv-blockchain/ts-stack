import { previewDestinationFixture, previewReceiptPolicy as policy } from './Brc38ImportPreviewFixture'
import { withBrc38KnexImportReadDestination } from './Brc38KnexDestinationFence'
import { importPageFixture } from './Brc38ImportPageFixture'
import { prepareBrc38ImportPage, brc38ImportTableOrder, type Brc38PreparedImportData } from './Brc38ImportPage'
import { createSyncMap } from '../schema/entities/EntityBase'
import { prepareBrc38ImportEntityTargets } from './Brc38ImportEntityTargets'
import { prepareBrc38ImportExistingRows } from './Brc38ImportExistingRows'
import { installBrc38ImportTargetIndexes, verifyBrc38ImportTargetIndexes } from './Brc38ImportTargetIndexes'
import { runInSeries } from '../../utility/runInSeries'
import knex, { type Knex } from 'knex'
import fc from 'fast-check'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(
    MIN_PROPERTY_RUNS,
    Number(process.env.FAST_CHECK_NUM_RUNS ?? process.env.FC_NUM_RUNS ?? MIN_PROPERTY_RUNS)
  ),
  seed: Number(process.env.FAST_CHECK_SEED ?? process.env.FC_SEED ?? 3242026)
})

const selection = {
  identityKey: 'original-identity',
  chain: 'test' as const,
  targetStorageIdentityKey: 'synthetic target',
  mode: 'merge' as const
}
const identities = {
  provenTxs: ['proven_txs', 'provenTxId', 'provenTx', 0],
  outputBaskets: ['output_baskets', 'basketId', 'outputBasket', -7],
  outputTags: ['output_tags', 'outputTagId', 'outputTag', -8],
  txLabels: ['tx_labels', 'txLabelId', 'txLabel', -9],
  transactions: ['transactions', 'transactionId', 'transaction', 0],
  outputs: ['outputs', 'outputId', 'output', -10],
  txLabelMaps: ['tx_labels_map'],
  outputTagMaps: ['output_tags_map'],
  certificates: ['certificates', 'certificateId', 'certificate', -11],
  certificateFields: ['certificate_fields'],
  commissions: ['commissions', 'commissionId', 'commission', -12],
  provenTxReqs: ['proven_tx_reqs', 'provenTxReqId', 'provenTxReq', -13],
  syncStates: ['sync_states', 'syncStateId', undefined, -14]
} as const
function native(row: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined) continue
    if (value instanceof Date) result[key] = value.getTime()
    else if (typeof value === 'boolean') result[key] = value ? 1 : 0
    else if (Array.isArray(value)) result[key] = Buffer.from(value as number[])
    else result[key] = value
  }
  return result
}
describe('actual bounded indexed identities for all thirteen native import entities', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
    readerPool: Knex | undefined,
    pages: Brc38PreparedImportData[],
    map: ReturnType<typeof createSyncMap>
  beforeEach(async () => {
    target = await previewDestinationFixture(installBrc38ImportTargetIndexes)
    await target.storage.insertUser({
      userId: 7,
      identityKey: selection.identityKey,
      activeStorage: '',
      created_at: new Date(),
      updated_at: new Date()
    })
    const source = importPageFixture()
    pages = []
    map = createSyncMap()
    readerPool = undefined
    let cursor = 1
    await runInSeries(brc38ImportTableOrder, async table => {
      const page = await prepareBrc38ImportPage(source.reader, source.metadata, source.admission, cursor)
      pages.push(await page.consume(async data => data))
      cursor += source.data.tables[table].length
    })
    for (const page of pages) {
      if (page.kind !== 'table') throw new Error('Table fixture missing')
      const identity = identities[page.table]
      if (identity.length === 1 || identity[2] === undefined) continue
      const row = page.rows[0] as unknown as Record<string, number>
      map[identity[2]].idMap[row[identity[1]]] = identity[3]
    }
    await target.k.transaction(async trx => {
      await runInSeries(pages, async page => {
        if (page.kind !== 'table') throw new Error('Native table fixture missing')
        const identity = identities[page.table],
          row = native(page.rows[0] as unknown as Record<string, unknown>)
        if (identity[1] !== undefined) row[identity[1]] = identity[3]
        if ('userId' in row) row.userId = 7
        for (const [field, entity] of [
          ['provenTxId', 'provenTx'],
          ['transactionId', 'transaction'],
          ['spentBy', 'transaction'],
          ['basketId', 'outputBasket'],
          ['outputTagId', 'outputTag'],
          ['txLabelId', 'txLabel'],
          ['outputId', 'output'],
          ['certificateId', 'certificate']
        ] as const) {
          if (identity.length > 1 && field === identity[1]) continue
          const id = row[field]
          if (typeof id === 'number') row[field] = map[entity].idMap[id]
        }
        await trx(identity[0]).insert(row)
      })
    })
  })
  afterEach(async () => {
    const results = await Promise.allSettled([readerPool?.destroy(), target?.close()]),
      failed = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failed.length > 0) throw new AggregateError(failed, 'Native target helper retains physical cleanup')
  })
  async function read<T>(callback: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    // Real pinned file/WAL query-only helper component, not import authority.
    // The full owner separately refuses disabled unsupported-key generations.
    readerPool ??= knex({ ...target.k.client.config, pool: { min: 0, max: 1 } })
    await readerPool.raw('PRAGMA query_only = ON')
    return await readerPool.transaction(callback)
  }
  async function prepare(data: Brc38PreparedImportData, maximum = 65536, signal?: AbortSignal) {
    return await read(async trx => await prepareBrc38ImportEntityTargets(trx, 7, data, map, maximum, signal))
  }
  function page(table: 'transactions' | 'outputBaskets' | 'txLabelMaps' | 'provenTxs' | 'outputs') {
    const value = pages.find(row => row.kind === 'table' && row.table === table)
    if (value?.kind !== 'table') throw new Error('Prepared target fixture missing')
    return value
  }
  test('all13 preserve native signed/zero IDs, composite keys, tombstones and original source while selecting only bounded metadata', async () => {
    const before = JSON.stringify(pages),
      queries: Array<{ sql: string; bindings: readonly Knex.RawBinding[] }> = []
    target.k.on('query', value => queries.push(value))
    // Payload size is irrelevant to identity lookup; it must never be loaded.
    await target
      .k('proven_txs')
      .where({ provenTxId: 0 })
      .update({ rawTx: Buffer.alloc(2097152, 7) })
    await read(async trx => {
      trx.on('query', value => queries.push(value))
      await runInSeries(pages, async data => {
        if (data.kind !== 'table') throw new Error('Table data missing')
        const [found] = await prepareBrc38ImportEntityTargets(trx, 7, data, map, 65536),
          identity = identities[data.table]
        expect(found.found).toBe(true)
        if (identity.length === 1) expect(found.localId).toBeUndefined()
        else expect(found.localId).toBe(identity[3])
        expect(Object.isFrozen(found.key)).toBe(true)
      })
      const reads = queries.filter(value => value.sql.includes('INDEXED BY'))
      expect(reads).toHaveLength(13)
      for (const read of reads) {
        expect(read.sql).toMatch(/limit \?/)
        expect(read.bindings.at(-1)).toBe(2)
        expect(read.sql).not.toMatch(/select \*|offset|rawTx|lockingScript|syncMap|notify/)
        const plan: Array<{ detail: string }> = await trx.raw('EXPLAIN QUERY PLAN ' + read.sql, [...read.bindings])
        expect(plan.some(value => /SEARCH .*brc38_import_target_/.test(value.detail))).toBe(true)
        expect(plan.some(value => /SCAN /.test(value.detail))).toBe(false)
      }
    })
    expect(JSON.stringify(pages)).toBe(before)
    expect((await target.k('output_tags_map').first()).isDeleted).toBe(1)
    expect(await target.k('users')).toHaveLength(1)
  })
  test('transaction matching prefers stable txid over local reference and retains reference fallback for pre-broadcast rows', async () => {
    const value = page('transactions')
    if (value.table !== 'transactions') throw new Error('Transaction missing')
    await target.k('transactions').insert({
      ...native(value.rows[0]),
      transactionId: -99,
      provenTxId: 0,
      userId: 7,
      reference: 'other-local',
      txid: 'other-txid'
    })
    const preferred: Brc38PreparedImportData = {
      ...value,
      rows: [{ ...value.rows[0], reference: 'other-local' }]
    }
    expect((await prepare(preferred))[0]).toMatchObject({
      found: true,
      localId: 0,
      index: 'transactions'
    })
    const fallback: Brc38PreparedImportData = {
      ...value,
      rows: [{ ...value.rows[0], txid: 'new-broadcast-txid' }]
    }
    expect((await prepare(fallback))[0]).toMatchObject({
      found: true,
      localId: 0,
      index: 'transactionReference'
    })
  })
  test('scoped mappings cannot authorize cross-profile parents or follow an unrelated incoming numeric ID', async () => {
    const value = page('txLabelMaps')
    await target.storage.insertUser({
      userId: 999,
      identityKey: 'other-profile',
      activeStorage: '',
      created_at: new Date(),
      updated_at: new Date()
    })
    await target.k('tx_labels').where({ txLabelId: -9 }).update({ userId: 999 })
    await expect(prepare(value)).rejects.toThrow('parent ownership')
    await target.k('tx_labels').where({ txLabelId: -9 }).update({ userId: 7 })
    delete map.transaction.idMap[14]
    await expect(prepare(value)).rejects.toThrow('parent ownership')
    // The legacy incoming ID14 exists as an unrelated target. It never serves
    // as a fallback for the absent durable parent map.
    await target.k('transactions').insert({
      ...native(page('transactions').rows[0]),
      transactionId: 14,
      provenTxId: 0,
      userId: 7,
      reference: 'unrelated-id',
      txid: 'unrelated-txid'
    })
    await expect(prepare(value)).rejects.toThrow('parent ownership')
  })
  test('natural-key target must agree with every already-durable own mapping', async () => {
    map.provenTx.idMap[11] = 99
    await expect(prepare(page('provenTxs'))).rejects.toThrow('identity')
    const value = page('outputBaskets')
    if (value.table !== 'outputBaskets') throw new Error('Basket missing')
    await expect(prepare({ ...value, rows: [{ ...value.rows[0], name: 'absent target' }] })).rejects.toThrow('identity')
    delete map.outputBasket.idMap[value.rows[0].basketId]
    expect((await prepare({ ...value, rows: [{ ...value.rows[0], name: 'absent target' }] }))[0].found).toBe(false)
  })
  test('missing indexes and altered migration SQL refuse without fallback scans or writes', async () => {
    await target.k.raw('DROP INDEX brc38_import_target_provenTxs')
    await expect(prepare(page('provenTxs'))).rejects.toThrow('differ')
    await target.k.raw('CREATE INDEX brc38_import_target_provenTxs ON proven_txs (height)')
    await expect(target.k.transaction(async trx => await verifyBrc38ImportTargetIndexes(trx))).rejects.toThrow('differ')
  })
  test('duplicates, budgets, cancellation and non-read-only ownership refuse before publication', async () => {
    const value = page('transactions')
    await target.k('transactions').insert({
      ...native(value.rows[0]),
      transactionId: -99,
      provenTxId: 0,
      userId: 7,
      reference: 'duplicate-txid'
    })
    await expect(prepare(value)).rejects.toThrow('identity')
    await expect(prepare(value, 0)).rejects.toThrow('budget')
    await expect(prepare(value, 1)).rejects.toThrow('budget')
    const abort = new AbortController(),
      reason = new Error('target cancel')
    abort.abort(reason)
    await expect(prepare(value, 65536, abort.signal)).rejects.toBe(reason)
    await expect(
      target.k.transaction(async trx => await prepareBrc38ImportEntityTargets(trx, 7, value, map, 65536))
    ).rejects.toThrow('query-only')
  })
  test('the full destination owner refuses a generation disabled by unsupported entity keys', async () => {
    const apply = jest.fn()
    await expect(withBrc38KnexImportReadDestination(target.storage, selection, policy, apply)).rejects.toThrow(
      'complete enabled owned SQLite generation'
    )
    expect(apply).not.toHaveBeenCalled()
  })
  test('full300 native natural-key identities match an independent oracle across accepted incoming number identities', async () => {
    const value = page('outputBaskets')
    if (value.table !== 'outputBaskets') throw new Error('Basket missing')
    await read(async trx => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(0, -7, 1e300, Number.MAX_SAFE_INTEGER),
          fc.boolean(),
          async (incoming, present) => {
            const data: Brc38PreparedImportData = {
                ...value,
                rows: [
                  {
                    ...value.rows[0],
                    basketId: incoming,
                    name: present ? value.rows[0].name : 'unknown-natural-key'
                  }
                ]
              },
              [found] = await prepareBrc38ImportEntityTargets(trx, 7, data, createSyncMap(), 65536)
            expect(found.found).toBe(present)
            expect(found.localId).toBe(present ? -7 : undefined)
          }
        ),
        {
          numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
          seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
          path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
          interruptAfterTimeLimit: 150000,
          markInterruptAsFailure: true
        }
      )
    })
  }, 180000)
  async function payload(data: Brc38PreparedImportData, maximum = 65536, signal?: AbortSignal) {
    return await read(async trx => {
      const targets = await prepareBrc38ImportEntityTargets(trx, 7, data, map, 65536, signal)
      return await prepareBrc38ImportExistingRows(trx, target.storage, 7, data, targets, maximum, signal)
    })
  }
  test('all13 complete existing native payloads retain dates, bytes, tombstones, native IDs and original source', async () => {
    const before = JSON.stringify(pages)
    await read(async trx => {
      const legacy = {
        provenTxs: async () => await target.storage.findProvenTxs({ partial: {}, trx }),
        outputBaskets: async () => await target.storage.findOutputBaskets({ partial: {}, trx }),
        outputTags: async () => await target.storage.findOutputTags({ partial: {}, trx }),
        txLabels: async () => await target.storage.findTxLabels({ partial: {}, trx }),
        transactions: async () => await target.storage.findTransactions({ partial: {}, trx }),
        outputs: async () => await target.storage.findOutputs({ partial: {}, trx }),
        txLabelMaps: async () => await target.storage.findTxLabelMaps({ partial: {}, trx }),
        outputTagMaps: async () => await target.storage.findOutputTagMaps({ partial: {}, trx }),
        certificates: async () => await target.storage.findCertificates({ partial: {}, trx }),
        certificateFields: async () => await target.storage.findCertificateFields({ partial: {}, trx }),
        commissions: async () => await target.storage.findCommissions({ partial: {}, trx }),
        provenTxReqs: async () => await target.storage.findProvenTxReqs({ partial: {}, trx }),
        syncStates: async () => await target.storage.findSyncStates({ partial: {}, trx })
      }
      await runInSeries(pages, async data => {
        if (data.kind !== 'table') throw new Error('Existing table missing')
        const targets = await prepareBrc38ImportEntityTargets(trx, 7, data, map, 65536),
          [existing] = await prepareBrc38ImportExistingRows(trx, target.storage, 7, data, targets, 65536),
          expected = (await legacy[data.table]())[0]
        expect(existing.table).toBe(data.table)
        expect(existing.row).toEqual(expected)
        expect(existing.row?.created_at).toBeInstanceOf(Date)
        expect(existing.row?.updated_at).toBeInstanceOf(Date)
        expect(Object.isFrozen(existing)).toBe(true)
        expect(Object.isFrozen(existing.row)).toBe(true)
        expect(existing.allocationBytes).toBeGreaterThan(0)
      })
    })
    expect(JSON.stringify(pages)).toBe(before)
    expect((await target.k('output_tags_map').first()).isDeleted).toBe(1)
  })
  test('oversized blobs and embedded-NUL text refuse in SQL before any full native row payload is selected', async () => {
    const queries: string[] = []
    await target
      .k('proven_txs')
      .where({ provenTxId: 0 })
      .update({ rawTx: Buffer.alloc(2097152, 7) })
    await read(async trx => {
      trx.on('query', value => queries.push(value.sql))
      const data = page('provenTxs'),
        targets = await prepareBrc38ImportEntityTargets(trx, 7, data, map, 65536)
      await expect(prepareBrc38ImportExistingRows(trx, target.storage, 7, data, targets, 65536)).rejects.toThrow(
        'allocation budget'
      )
    })
    expect(queries.some(sql => /select `/.test(sql))).toBe(false)
    await target
      .k('transactions')
      .where({ transactionId: 0 })
      .update({ description: 'a\u0000' + 'x'.repeat(2097152) })
    queries.length = 0
    await read(async trx => {
      trx.on('query', value => queries.push(value.sql))
      const data = page('transactions'),
        targets = await prepareBrc38ImportEntityTargets(trx, 7, data, map, 65536)
      await expect(prepareBrc38ImportExistingRows(trx, target.storage, 7, data, targets, 65536)).rejects.toThrow(
        'allocation budget'
      )
    })
    expect(queries.some(sql => /select `/.test(sql))).toBe(false)
    expect(queries.some(sql => sql.includes('length(CAST('))).toBe(true)
  })
  test('the fixed page allocation budget aggregates existing rows and refuses before loading the next payload', async () => {
    const data = page('outputBaskets')
    if (data.table !== 'outputBaskets') throw new Error('Basket missing')
    const [first] = await payload(data),
      second = { ...data.rows[0], basketId: 199, name: 'second existing basket' }
    await target.k('output_baskets').insert({ ...native(second), userId: 7, basketId: 200 })
    const expanded: Brc38PreparedImportData = { ...data, rows: [data.rows[0], second] },
      queries: string[] = []
    await read(async trx => {
      trx.on('query', value => queries.push(value.sql))
      const targets = await prepareBrc38ImportEntityTargets(trx, 7, expanded, map, 65536)
      await expect(
        prepareBrc38ImportExistingRows(trx, target.storage, 7, expanded, targets, first.allocationBytes)
      ).rejects.toThrow('allocation budget')
    })
    expect(queries.filter(sql => /select `/.test(sql))).toHaveLength(1)
    expect(await target.k('output_baskets')).toHaveLength(2)
  })
  test('offloaded output scripts load only the bounded known-valid proof slice while full raw reconstruction remains charged', async () => {
    const data = page('outputs'),
      proof = page('provenTxs')
    if (data.table !== 'outputs' || proof.table !== 'provenTxs') throw new Error('Output/proof missing')
    await target
      .k('proven_txs')
      .where({ provenTxId: 0 })
      .update({ rawTx: Buffer.alloc(2097152, 9) })
    await target
      .k('outputs')
      .where({ outputId: -10 })
      .update({ txid: proof.rows[0].txid, lockingScript: null, scriptOffset: 2, scriptLength: 3 })
    const [existing] = await payload(data)
    expect(existing.table).toBe('outputs')
    if (existing.table !== 'outputs') throw new Error('Output result missing')
    expect(existing.row?.lockingScript).toEqual([9, 9, 9])
    expect(Object.isFrozen(existing.row?.lockingScript)).toBe(true)
    await target.k('transactions').where({ transactionId: 0 }).update({ rawTx: null })
    await expect(payload(page('transactions'))).rejects.toThrow('allocation budget')
    await target.k('outputs').where({ outputId: -10 }).update({ scriptOffset: -1 })
    await expect(payload(data)).rejects.toThrow('txid, offset and length')
  })
  test('the original whole-raw and slice paths preserve their different request-status acceptance', async () => {
    const transaction = page('transactions'),
      output = page('outputs'),
      proof = page('provenTxs')
    if (transaction.table !== 'transactions' || output.table !== 'outputs' || proof.table !== 'provenTxs')
      throw new Error('Raw fixtures missing')
    await target.k('transactions').where({ transactionId: 0 }).update({ rawTx: null, provenTxId: null })
    await target.k('proven_tx_reqs').where({ provenTxReqId: -13 }).update({ provenTxId: null })
    await target.k('proven_txs').where({ provenTxId: 0 }).delete()
    await target
      .k('outputs')
      .where({ outputId: -10 })
      .update({ txid: proof.rows[0].txid, lockingScript: null, scriptOffset: 1, scriptLength: 2 })
    const unproven: Brc38PreparedImportData = {
      ...transaction,
      rows: [{ ...transaction.rows[0], provenTxId: undefined }]
    }
    for (const status of ['unconfirmed', 'unfail'] as const) {
      await target
        .k('proven_tx_reqs')
        .where({ provenTxReqId: -13 })
        .update({ status, rawTx: Buffer.from([9, 8, 7, 6]) })
      const [whole] = await payload(unproven),
        [slice] = await payload(output)
      if (whole.table !== 'transactions' || slice.table !== 'outputs') throw new Error('Dependency result missing')
      expect(whole.row?.rawTx).toEqual(status === 'unconfirmed' ? [9, 8, 7, 6] : undefined)
      expect(slice.row?.lockingScript).toEqual(status === 'unfail' ? [8, 7] : undefined)
    }
  })
  test('identity changes, forged profile keys, cancellation and non-query-only payload owners refuse before publication', async () => {
    const data = page('outputBaskets'),
      abort = new AbortController(),
      reason = new Error('payload cancel')
    await read(async trx => {
      const targets = await prepareBrc38ImportEntityTargets(trx, 7, data, map, 65536),
        first = targets[0]
      for (const forged of [
        { ...first, found: false },
        { ...first, localId: 100 },
        { ...first, key: { ...first.key, userId: 999 } }
      ])
        await expect(prepareBrc38ImportExistingRows(trx, target.storage, 7, data, [forged], 65536)).rejects.toThrow(
          'identity'
        )
      trx.on('query', value => {
        if (value.sql.includes('AS allocationBytes')) abort.abort(reason)
      })
      await expect(
        prepareBrc38ImportExistingRows(trx, target.storage, 7, data, targets, 65536, abort.signal)
      ).rejects.toBe(reason)
    })
    const targets = await prepare(data)
    await expect(
      target.k.transaction(
        async trx => await prepareBrc38ImportExistingRows(trx, target.storage, 7, data, targets, 65536)
      )
    ).rejects.toThrow('query-only')
  })
  test('full300 SQL allocation charges match an independent native-byte oracle including NUL and Unicode', async () => {
    const data = page('outputBaskets')
    if (data.table !== 'outputBaskets') throw new Error('Property basket missing')
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', 'a\u0000b', 'é', '🙂'),
        fc.integer({ min: 0, max: 256 }),
        async (part, repetitions) => {
          const name = part.repeat(repetitions)
          await target.k('output_baskets').where({ basketId: -7 }).update({ name })
          const raw: Record<string, unknown> = await target.k('output_baskets').where({ basketId: -7 }).first(),
            expected = Object.values(raw).reduce<number>(
              (sum, value) => sum + 256 + 16 * (value === null ? 0 : Buffer.byteLength(String(value))),
              0
            ),
            input: Brc38PreparedImportData = { ...data, rows: [{ ...data.rows[0], name }] },
            [existing] = await payload(input)
          expect(existing.allocationBytes).toBe(expected)
          await expect(payload(input, expected - 1)).rejects.toThrow('allocation budget')
        }
      ),
      {
        numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
        seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
        path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? '',
        interruptAfterTimeLimit: 150000,
        markInterruptAsFailure: true
      }
    )
  }, 180000)
})
