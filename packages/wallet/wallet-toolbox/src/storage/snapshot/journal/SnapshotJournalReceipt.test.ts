import { knex, type Knex } from 'knex'
import { createHash } from 'node:crypto'
import {
  snapshotJournalReceiptBinding,
  snapshotJournalReceiptDdl,
  recordSnapshotJournalReceipt,
  readSnapshotJournalReceipt,
  collectSnapshotJournalReceipts,
  type SnapshotJournalReceiptBinding
} from './SnapshotJournalReceipt'
import { snapshotJournalRevision } from './SnapshotJournalRevision'

const binding: SnapshotJournalReceiptBinding = {
  backend: '11'.repeat(32),
  epoch: '12345678-1234-4234-9234-123456789012',
  source: '22'.repeat(32),
  schema: '33'.repeat(32),
  storageIdentity: 'synthetic-storage',
  identityKey: '02' + '44'.repeat(32),
  userId: 1,
  chain: 'test'
}
const request = (n: number) => ({
  requestId: n.toString(16).padStart(64, '0'),
  highWater: snapshotJournalRevision('9007199254740993'),
  expiresAt: Date.now() + 60000
})
let k: Knex
beforeEach(async () => {
  k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  await k.raw('PRAGMA busy_timeout=0')
  for (const sql of snapshotJournalReceiptDdl(k)) await k.raw(sql)
  await k('snapshot_journal_retention').insert({ id: 1, floor: '0', receiptLimit: 128, receiptLifetimeMs: 2592000000 })
})
afterEach(async () => {
  await k.destroy()
})

test('binding has a stable independent digest and distinguishes every bound field', () => {
  const expected = createHash('sha256')
    .update(
      'snapshot-journal-receipt-binding-v1\n' +
        JSON.stringify([
          binding.backend,
          binding.epoch,
          binding.source,
          binding.schema,
          binding.storageIdentity,
          binding.identityKey,
          binding.userId,
          binding.chain
        ])
    )
    .digest('hex')
  expect(snapshotJournalReceiptBinding(binding)).toBe(expected)
  const changes: Partial<SnapshotJournalReceiptBinding>[] = [
    { backend: '55'.repeat(32) },
    { epoch: '12345678-1234-4234-9234-123456789013' },
    { source: '55'.repeat(32) },
    { schema: '55'.repeat(32) },
    { storageIdentity: 'synthetic-other' },
    { identityKey: '03' + '44'.repeat(32) },
    { userId: 2 },
    { chain: 'main' }
  ]
  for (const change of changes) expect(snapshotJournalReceiptBinding({ ...binding, ...change })).not.toBe(expected)
})

test.each([
  { backend: 'z'.repeat(64) },
  { epoch: '12345678-1234-1234-9234-123456789012' },
  { source: '11'.repeat(33) },
  { schema: '' },
  { identityKey: '04' + '44'.repeat(32) },
  { userId: 0 },
  { userId: 1.5 },
  { userId: Number.MAX_SAFE_INTEGER + 1 },
  { chain: 'unknown' },
  { storageIdentity: '' },
  { storageIdentity: 'x'.repeat(257) },
  { storageIdentity: '\ud800' },
  { storageIdentity: 'é'.repeat(129) }
])('rejects invalid binding %o before creating a receipt', async change => {
  await expect(
    k.transaction(t => recordSnapshotJournalReceipt(t, { ...binding, ...change }, request(1)))
  ).rejects.toThrow()
  expect(await k('snapshot_journal_receipts')).toHaveLength(0)
})

test('exact retry preserves immutable receipt/floor and binding changes refuse', async () => {
  const input = request(1)
  const first = await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  expect(first).toEqual({ ...input, binding: snapshotJournalReceiptBinding(binding), floor: '0' })
  await k('snapshot_journal_retention').update({ floor: '5' })
  const retry = await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  expect(retry).toEqual(first)
  expect(await k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).toEqual(first)
  for (const other of [
    { ...input, highWater: snapshotJournalRevision('9007199254740994') },
    { ...input, expiresAt: input.expiresAt + 1 }
  ])
    await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, other))).rejects.toThrow()
  await expect(k.transaction(t => recordSnapshotJournalReceipt(t, { ...binding, userId: 2 }, input))).rejects.toThrow()
  await expect(
    k.transaction(t => readSnapshotJournalReceipt(t, { ...binding, backend: '55'.repeat(32) }, input))
  ).rejects.toThrow()
  expect(await k('snapshot_journal_receipts')).toHaveLength(1)
})

test('receipt and floor changes roll back together; committed receipt survives lost acknowledgement', async () => {
  const input = request(1)
  await expect(
    k.transaction(async t => {
      await t('snapshot_journal_retention').update({ floor: '7' })
      await recordSnapshotJournalReceipt(t, binding, input)
      throw new Error('before commit')
    })
  ).rejects.toThrow('before commit')
  expect(await k('snapshot_journal_receipts')).toHaveLength(0)
  expect((await k('snapshot_journal_retention').first()).floor).toBe('0')
  await expect(
    (async () => {
      await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
      throw new Error('after commit')
    })()
  ).rejects.toThrow('after commit')
  expect(await k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).toMatchObject(input)
})

test('a missing restored receipt refuses even after journal revision moves beyond the checkpoint', async () => {
  const input = request(1)
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  const exact = await k('snapshot_journal_receipts').first()
  await k('snapshot_journal_receipts').delete()
  await k.transaction(t =>
    recordSnapshotJournalReceipt(t, binding, { ...request(2), highWater: snapshotJournalRevision('9007199254740994') })
  )
  await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
  await k('snapshot_journal_receipts').insert(exact)
  expect(await k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).toMatchObject(input)
  await k('snapshot_journal_retention').update({ floor: '9007199254740994' })
  await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
})

test('capacity includes expired records until bounded collection commits, and exact expired requests cannot reopen', async () => {
  await k('snapshot_journal_retention').update({ receiptLimit: 2 })
  const a = request(1),
    b = request(2),
    c = request(3)
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, a))
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, b))
  await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))).rejects.toThrow()
  await k('snapshot_journal_receipts').where('requestId', a.requestId).update({ expiresAt: 1 })
  await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))).rejects.toThrow()
  await expect(
    k.transaction(async t => {
      expect(await collectSnapshotJournalReceipts(t)).toBe(1)
      throw new Error('collector rollback')
    })
  ).rejects.toThrow('collector rollback')
  expect(await k('snapshot_journal_receipts')).toHaveLength(2)
  expect(await k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(1)
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, c))
  await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, { ...a, expiresAt: 1 }))).rejects.toThrow()
  expect(await k.transaction(t => readSnapshotJournalReceipt(t, binding, b))).toMatchObject(b)
})

test('collector uses at most64 indexed candidates and releases no unexpired receipt', async () => {
  const common = { binding: snapshotJournalReceiptBinding(binding), highWater: '9', floor: '0', expiresAt: 1 }
  for (let i = 1; i <= 128; i += 32)
    await k('snapshot_journal_receipts').insert(
      Array.from({ length: 32 }, (_, offset) => ({ ...common, requestId: (i + offset).toString(16).padStart(64, '0') }))
    )
  await k('snapshot_journal_receipts')
    .where('requestId', request(128).requestId)
    .update({ expiresAt: Date.now() + 60000 })
  const query = k('snapshot_journal_receipts')
    .where('expiresAt', '<=', Date.now())
    .select('requestId')
    .orderBy(['expiresAt', 'requestId'])
    .limit(64)
    .toSQL()
  const plan: Array<{ detail: string }> = await k.raw(
    'EXPLAIN QUERY PLAN ' + query.sql,
    query.bindings as Knex.RawBinding[]
  )
  expect(plan.map(x => x.detail).join(' ')).toContain(
    'SEARCH snapshot_journal_receipts USING COVERING INDEX snapshot_journal_receipts_expiry'
  )
  expect(await k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(64)
  expect(await k('snapshot_journal_receipts')).toHaveLength(64)
  expect(await k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(63)
  expect(await k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(0)
  expect(await k('snapshot_journal_receipts')).toHaveLength(1)
})

test('mutating calls require explicit transactions and a nonwaiting SQLite connection', async () => {
  await expect(recordSnapshotJournalReceipt(k, binding, request(1))).rejects.toThrow()
  await expect(readSnapshotJournalReceipt(k, binding, request(1))).rejects.toThrow()
  await expect(collectSnapshotJournalReceipts(k)).rejects.toThrow()
  await k.raw('PRAGMA busy_timeout=1')
  await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, request(1)))).rejects.toThrow()
  await expect(k.transaction(t => collectSnapshotJournalReceipts(t))).rejects.toThrow()
})

test('malformed persisted receipts and retention metadata refuse', async () => {
  const input = request(1)
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  for (const change of [{ binding: 'x' }, { highWater: '01' }, { floor: '9007199254740994' }, { expiresAt: 1 }]) {
    await k.transaction(async t => {
      await t('snapshot_journal_receipts').update(change)
      await expect(readSnapshotJournalReceipt(t, binding, input)).rejects.toThrow()
      await t.rollback()
    })
  }
  await k('snapshot_journal_retention').update({ floor: '01' })
  await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
})

test('expired, overlong and malformed requests allocate no receipt', async () => {
  const input = request(1)
  for (const change of [
    { requestId: 'x' },
    { requestId: 'a'.repeat(65) },
    { highWater: '0' },
    { highWater: '01' },
    { expiresAt: 1 },
    { expiresAt: Date.now() + 2592000000 + 60000 },
    { expiresAt: '9007199254740993' }
  ])
    await expect(
      k.transaction(t => recordSnapshotJournalReceipt(t, binding, { ...input, ...change } as typeof input))
    ).rejects.toThrow()
  expect(await k('snapshot_journal_receipts')).toHaveLength(0)
})

test('a receipt whose captured floor exceeds the current floor refuses inconsistent state', async () => {
  const input = request(1)
  await k('snapshot_journal_retention').update({ floor: '10' })
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  await k('snapshot_journal_retention').update({ floor: '9' })
  await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
  await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
})
