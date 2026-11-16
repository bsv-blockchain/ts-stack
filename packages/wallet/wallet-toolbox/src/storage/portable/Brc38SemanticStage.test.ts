import { Brc38SemanticStage, brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { parseBRC38Json, type BRC38WalletData } from './index'
import {
  semanticStageFixture,
  memoryStageStore,
  importToMemoryStage,
  options,
  source
} from './Brc38SemanticStageFixture'

test('complete thirteen-table semantics preserve exact original provenance and one-row reads', async () => {
  const data = semanticStageFixture(),
    before = JSON.stringify(data)
  const result = await importToMemoryStage(data)
  expect(result.sealed).toBe(1)
  expect(result.discarded).toBe(0)
  expect(result.rows.size).toBe(13)
  expect(result.maximumReturnedRows).toBe(1)
  expect(result.header?.user.activeStorage).toBe('original-source')
  expect(result.header?.sourceStorage).toEqual(data.sourceStorage)
  for (const table of brc38StageTables)
    expect(result.rows.get(JSON.stringify([table, 0]))).toEqual(parseBRC38Json(before).tables[table][0])
  expect(JSON.stringify(data)).toBe(before)
})
test('arbitrary table order keeps references provisional until all tables are complete', async () => {
  const data = semanticStageFixture()
  data.tables = Object.fromEntries(Object.entries(data.tables).reverse()) as BRC38WalletData['tables']
  const result = await importToMemoryStage(data)
  expect(result.sealed).toBe(1)
  expect(result.rows.size).toBe(13)
})
test.each([false, true, 0, 1])('historical request flag %p retains its exact archive spelling', async value => {
  const data = semanticStageFixture()
  data.tables.provenTxReqs[0].wasBroadcast = value
  const result = await importToMemoryStage(data)
  expect(result.sealed).toBe(1)
  expect(result.rows.get(JSON.stringify(['provenTxReqs', 0]))?.wasBroadcast).toBe(value)
})
test.each([-1, 2, null, '1', {}, []])('invalid historical request flag %p refuses and discards', async value => {
  const data = semanticStageFixture(),
    state = memoryStageStore()
  data.tables.provenTxReqs[0].wasBroadcast = value
  await expect(
    readBrc38JsonStream(source(data), new Brc38SemanticStage(state.store, options), {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 65536
    })
  ).rejects.toThrow(value === null ? 'Invalid bounded BRC-38 JSON stream' : 'wasBroadcast must be a boolean or 0/1')
  expect(state.sealed).toBe(0)
  expect(state.discarded).toBe(1)
  expect(state.rows.size).toBe(0)
})
test.each(brc38StageTables)('duplicate primary/composite key refuses %s and discards private data', async table => {
  const data = semanticStageFixture(),
    state = memoryStageStore()
  data.tables[table].push({ ...data.tables[table][0] })
  await expect(
    readBrc38JsonStream(source(data), new Brc38SemanticStage(state.store, options), {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 65536
    })
  ).rejects.toThrow('Duplicate')
  expect(state.sealed).toBe(0)
  expect(state.rows.size).toBe(0)
  expect(state.discarded).toBe(1)
})
const badReferences: Array<[Brc38StageTable, string]> = [
  ['transactions', 'provenTxId'],
  ['provenTxReqs', 'provenTxId'],
  ['commissions', 'transactionId'],
  ['outputs', 'transactionId'],
  ['outputs', 'basketId'],
  ['outputs', 'spentBy'],
  ['txLabelMaps', 'transactionId'],
  ['txLabelMaps', 'txLabelId'],
  ['outputTagMaps', 'outputId'],
  ['outputTagMaps', 'outputTagId'],
  ['certificateFields', 'certificateId']
]
test.each(badReferences)('dangling %s.%s refuses sealing', async (table, field) => {
  const data = semanticStageFixture()
  data.tables[table][0][field] = 999
  await expect(importToMemoryStage(data)).rejects.toThrow('does not reference an exported row')
})
test.each([
  'outputBaskets',
  'transactions',
  'commissions',
  'outputs',
  'outputTags',
  'txLabels',
  'certificates',
  'certificateFields',
  'syncStates'
] as Brc38StageTable[])('cross-profile %s refuses sealing', async table => {
  const data = semanticStageFixture()
  data.tables[table][0].userId = 8
  await expect(importToMemoryStage(data)).rejects.toThrow('does not match user.userId')
})
test.each(brc38StageTables)('missing standard timestamp refuses %s', async table => {
  const data = semanticStageFixture()
  delete data.tables[table][0].created_at
  await expect(importToMemoryStage(data)).rejects.toThrow('UTC ISO timestamp')
})
test.each([
  ['identity', { expectedIdentityKey: 'another-identity' }],
  ['network', { expectedChain: 'main' as const }],
  ['source', { expectedSourceStorageIdentityKey: 'another-source' }]
])('explicit %s mismatch refuses before sealing', async (_label, override) => {
  await expect(importToMemoryStage(semanticStageFixture(), { ...options, ...override })).rejects.toThrow(
    'does not match'
  )
})
test('extraneous proof and unmatched request are refused while optional proof references remain optional', async () => {
  const data = semanticStageFixture()
  data.tables.provenTxs.push({
    ...data.tables.provenTxs[0],
    provenTxId: 22,
    txid: 'd'.repeat(64)
  })
  await expect(importToMemoryStage(data)).rejects.toThrow('provenTx.provenTxId')
  const req = semanticStageFixture()
  req.tables.provenTxReqs[0].txid = 'd'.repeat(64)
  await expect(importToMemoryStage(req)).rejects.toThrow('provenTxReq.txid')
  const optional = semanticStageFixture()
  delete optional.tables.transactions[0].provenTxId
  expect((await importToMemoryStage(optional)).sealed).toBe(1)
})
test('historical tombstones, policy values, unfamiliar statuses and stale notification history stay unchanged', async () => {
  const data = semanticStageFixture()
  data.tables.outputBaskets[0].numberOfDesiredUTXOs = 4
  data.tables.syncStates[0].status = 'historical-status'
  data.tables.provenTxReqs[0].notify = {
    transactionIds: [14, 999],
    extra: [true, ['legacy']]
  }
  const result = await importToMemoryStage(data)
  expect(result.rows.get(JSON.stringify(['outputBaskets', 0]))).toEqual(data.tables.outputBaskets[0])
  expect(result.rows.get(JSON.stringify(['syncStates', 0]))).toEqual(data.tables.syncStates[0])
  expect(result.rows.get(JSON.stringify(['provenTxReqs', 0]))).toEqual(data.tables.provenTxReqs[0])
})
test('row quota is charged before another append', async () => {
  const state = memoryStageStore(),
    append = jest.spyOn(state.store, 'append')
  await expect(
    readBrc38JsonStream(
      source(semanticStageFixture()),
      new Brc38SemanticStage(state.store, { ...options, maximumRows: 1 }),
      { maximumArchiveBytes: 1048576, maximumRowAllocationBytes: 65536 }
    )
  ).rejects.toThrow('row policy')
  expect(append).toHaveBeenCalledTimes(1)
  expect(state.discarded).toBe(1)
  expect(state.rows.size).toBe(0)
})
test('missing private row/count corruption refuses the final seal', async () => {
  const state = memoryStageStore()
  state.store.row = async () => undefined
  await expect(
    readBrc38JsonStream(source(semanticStageFixture()), new Brc38SemanticStage(state.store, options), {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 65536
    })
  ).rejects.toThrow('missing')
  expect(state.sealed).toBe(0)
  const corrupt = memoryStageStore()
  corrupt.store.count = async () => 0
  await expect(
    readBrc38JsonStream(source(semanticStageFixture()), new Brc38SemanticStage(corrupt.store, options), {
      maximumArchiveBytes: 1048576,
      maximumRowAllocationBytes: 65536
    })
  ).rejects.toThrow('count')
  expect(corrupt.sealed).toBe(0)
})
test('owned append must settle before disposal and concurrent staging refuses', async () => {
  const state = memoryStageStore()
  let release = () => {}
  const pending = new Promise<void>(done => {
    release = done
  })
  state.store.append = async () => pending
  const stage = new Brc38SemanticStage(state.store, options),
    row = semanticStageFixture().tables.outputs[0]
  const first = stage.provisionalRow('outputs', 0, row)
  await expect(stage.provisionalRow('outputs', 0, row)).rejects.toThrow('unavailable')
  await expect(stage.discard(new Error('cancel'))).rejects.toThrow('Wait for owned')
  expect(state.discarded).toBe(0)
  release()
  await first
  await stage.discard(new Error('cancel'))
  expect(state.discarded).toBe(1)
  await stage.discard(new Error('again'))
  expect(state.discarded).toBe(1)
})
test('selected options are detached from later host mutation', async () => {
  const selected = { ...options },
    state = memoryStageStore(),
    stage = new Brc38SemanticStage(state.store, selected)
  selected.expectedIdentityKey = 'changed'
  selected.maximumRows = 1
  await readBrc38JsonStream(source(semanticStageFixture()), stage, {
    maximumArchiveBytes: 1048576,
    maximumRowAllocationBytes: 65536
  })
  expect(state.sealed).toBe(1)
})
test('legacy optional note time and prototype-looking history keys preserve exact values', async () => {
  const data = semanticStageFixture()
  data.tables.provenTxReqs[0].history = {
    notes: [{ what: 'sent', retained: false, zero: 0, text: '', ['__proto__']: 'own property' }]
  }
  const result = await importToMemoryStage(data)
  expect(result.rows.get(JSON.stringify(['provenTxReqs', 0]))).toEqual(data.tables.provenTxReqs[0])
})
test.each([
  { notes: 'invalid' },
  { notes: ['invalid'] },
  { notes: [{ when: 'not-a-time', what: 'sent' }] },
  { notes: [{ what: false }] }
])('malformed structured history refuses: %j', async history => {
  const data = semanticStageFixture()
  data.tables.provenTxReqs[0].history = history
  await expect(importToMemoryStage(data)).rejects.toThrow('BRC-38')
})
test.each([{ transactionIds: false }, { transactionIds: ['14'] }])(
  'malformed notification history refuses: %j',
  async notify => {
    const data = semanticStageFixture()
    data.tables.provenTxReqs[0].notify = notify
    await expect(importToMemoryStage(data)).rejects.toThrow('BRC-38')
  }
)
test('cancellation after owned append settles discards the row without a seal', async () => {
  const state = memoryStageStore(),
    controller = new AbortController(),
    append = state.store.append,
    cause = new Error('cancel after append')
  state.store.append = async record => {
    await append(record)
    controller.abort(cause)
  }
  await expect(
    readBrc38JsonStream(
      source(semanticStageFixture()),
      new Brc38SemanticStage(state.store, { ...options, signal: controller.signal }),
      { maximumArchiveBytes: 1048576, maximumRowAllocationBytes: 65536 }
    )
  ).rejects.toBe(cause)
  expect(state.rows.size).toBe(0)
  expect(state.discarded).toBe(1)
  expect(state.sealed).toBe(0)
})
test('failed physical disposal retains ownership and can be retried', async () => {
  const state = memoryStageStore(),
    stage = new Brc38SemanticStage(state.store, options),
    original = state.store.discard,
    cause = new Error('host disposal failed')
  state.store.discard = jest.fn().mockRejectedValueOnce(cause).mockImplementation(original)
  await expect(stage.discard(new Error('cancel'))).rejects.toBe(cause)
  await stage.discard(new Error('cancel'))
  expect(state.discarded).toBe(1)
  await expect(stage.provisionalRow('outputs', 0, semanticStageFixture().tables.outputs[0])).rejects.toThrow(
    'unavailable'
  )
})
