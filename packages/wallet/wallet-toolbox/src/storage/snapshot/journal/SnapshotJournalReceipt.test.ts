import { knex, type Knex } from 'knex'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL } from './SnapshotJournalSqliteClock'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import * as ArchiveClock from '../archive/SnapshotArchiveSql'
import {
  advanceSnapshotJournalFloor,
  snapshotJournalReceiptPolicy,
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

test('policy rejects non-record inputs with the stable receipt error identity', () => {
  const fields = { receiptLimit: 1, receiptLifetimeMs: 1 }
  const malformed: unknown[] = [null, undefined, 1, 'policy', Object.assign([], fields), Object.assign(() => 0, fields)]
  for (const value of malformed) {
    const call = () => snapshotJournalReceiptPolicy(value as typeof fields)
    expect(call).toThrow(WERR_INVALID_OPERATION)
    expect(call).toThrow('Invalid, unavailable or expired snapshot journal receipt')
  }
  expect(snapshotJournalReceiptPolicy(fields)).toEqual(fields)
  expect(snapshotJournalReceiptPolicy(fields)).not.toBe(fields)
  expect(snapshotJournalReceiptPolicy({ receiptLimit: 128, receiptLifetimeMs: 2592000000 })).toEqual({
    receiptLimit: 128,
    receiptLifetimeMs: 2592000000
  })
})

test('binding refuses non-record values and textual lookalikes before hashing', () => {
  for (const value of [null, undefined, 1, 'binding', Object.assign(() => 0, binding)])
    expect(() => snapshotJournalReceiptBinding(value as unknown as SnapshotJournalReceiptBinding)).toThrow(
      WERR_INVALID_OPERATION
    )
  for (const field of ['backend', 'source', 'schema', 'epoch', 'identityKey', 'storageIdentity'] as const) {
    const text = binding[field]
    expect(() => snapshotJournalReceiptBinding({ ...binding, [field]: { toString: () => text } })).toThrow(
      WERR_INVALID_OPERATION
    )
  }
  for (const field of ['epoch', 'identityKey'] as const)
    for (const text of ['x' + binding[field], binding[field] + 'x'])
      expect(() => snapshotJournalReceiptBinding({ ...binding, [field]: text })).toThrow(WERR_INVALID_OPERATION)
})

test('all supported chains and exact UTF-8 storage identity boundaries bind distinctly', () => {
  const chains = ['main', 'test', 'stn', 'ttn', 'tstn', 'mock']
  expect(new Set(chains.map(chain => snapshotJournalReceiptBinding({ ...binding, chain }))).size).toBe(chains.length)
  const identities = ['x', 'x'.repeat(256), 'é'.repeat(128), '😀'.repeat(64)]
  const hashes = identities.map(storageIdentity => snapshotJournalReceiptBinding({ ...binding, storageIdentity }))
  expect(new Set(hashes).size).toBe(identities.length)
  for (const hash of hashes) expect(hash).toMatch(/^[0-9a-f]{64}$/)
})

test('exact floor and lifetime boundaries remain readable until the database expiry instant', async () => {
  let time = 1000000
  const clock = jest.spyOn(ArchiveClock, 'snapshotArchiveDatabaseNow').mockImplementation(async () => time)
  try {
    const input = { ...request(1), highWater: snapshotJournalRevision('7'), expiresAt: time + 1000 }
    await k('snapshot_journal_retention').update({ floor: '7', receiptLifetimeMs: 1000 })
    const expected = { ...input, binding: snapshotJournalReceiptBinding(binding), floor: '7' }
    expect(await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))).toEqual(expected)
    expect(await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))).toEqual(expected)
    expect(await k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).toEqual(expected)
    for (const changed of [
      { ...input, highWater: snapshotJournalRevision('8') },
      { ...input, expiresAt: input.expiresAt + 1 }
    ])
      await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, changed))).rejects.toThrow(
        WERR_INVALID_OPERATION
      )
    time = input.expiresAt - 1
    expect(await k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).toEqual(expected)
    expect(await k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(0)
    time = input.expiresAt
    await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
    await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
    expect(await k.transaction(t => collectSnapshotJournalReceipts(t))).toBe(1)
    expect(await k('snapshot_journal_receipts')).toEqual([])
  } finally {
    clock.mockRestore()
  }
})

test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'invalid database time %s refuses allocation, lookup and collection without changing rows',
  async time => {
    const input = request(1)
    await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
    const before = await k('snapshot_journal_receipts')
    const clock = jest.spyOn(ArchiveClock, 'snapshotArchiveDatabaseNow').mockResolvedValue(time)
    try {
      await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, request(2)))).rejects.toThrow(
        WERR_INVALID_OPERATION
      )
      await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow(
        WERR_INVALID_OPERATION
      )
      await expect(k.transaction(t => collectSnapshotJournalReceipts(t))).rejects.toThrow(WERR_INVALID_OPERATION)
      expect(await k('snapshot_journal_receipts')).toEqual(before)
    } finally {
      clock.mockRestore()
    }
  }
)

test('malformed singleton retention metadata refuses every operation without partial writes', async () => {
  const input = request(1)
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  const retained = await k('snapshot_journal_retention').first()
  const before = await k('snapshot_journal_receipts')
  await k.raw('PRAGMA ignore_check_constraints=ON')
  const malformed = [
    [],
    [{ ...retained, id: 2 }],
    [retained, { ...retained, id: 2 }],
    [{ ...retained, receiptLimit: 0 }],
    [{ ...retained, receiptLimit: 129 }],
    [{ ...retained, receiptLifetimeMs: 0 }],
    [{ ...retained, receiptLifetimeMs: 2592000001 }]
  ]
  for (const rows of malformed) {
    await k('snapshot_journal_retention').delete()
    if (rows.length) await k('snapshot_journal_retention').insert(rows)
    await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, request(2)))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
    await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
    await expect(k.transaction(t => collectSnapshotJournalReceipts(t))).rejects.toThrow(WERR_INVALID_OPERATION)
    expect(await k('snapshot_journal_receipts')).toEqual(before)
  }
})

test('malformed stored receipt revisions and collector identities refuse without deleting data', async () => {
  const input = request(1)
  await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))
  const stored = await k('snapshot_journal_receipts').first()
  for (const highWater of ['0', '-1', '9223372036854775808']) {
    await k('snapshot_journal_receipts').update({ highWater })
    await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
    await expect(k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))).rejects.toThrow()
  }
  await k('snapshot_journal_receipts').update({ ...stored, requestId: 'not-a-digest', expiresAt: 1 })
  await expect(k.transaction(t => collectSnapshotJournalReceipts(t))).rejects.toThrow(WERR_INVALID_OPERATION)
  expect(await k('snapshot_journal_receipts')).toHaveLength(1)
})

test('SQLite alias is supported while unrecognized database drivers refuse explicitly', async () => {
  k.client.config.client = 'sqlite3'
  const input = request(1)
  expect(await k.transaction(t => recordSnapshotJournalReceipt(t, binding, input))).toMatchObject(input)
  for (const client of ['pg', 'mysql-compatible', '', undefined]) {
    k.client.config.client = client
    expect(() => snapshotJournalReceiptDdl(k)).toThrow(WERR_INVALID_OPERATION)
    await expect(k.transaction(t => readSnapshotJournalReceipt(t, binding, input))).rejects.toThrow(
      WERR_INVALID_OPERATION
    )
  }
})

test('request expiry must be an exact primitive number before database work', async () => {
  const input = request(1)
  for (const expiresAt of [String(input.expiresAt), { valueOf: () => input.expiresAt }, null, undefined, Number.NaN])
    await expect(
      k.transaction(t => recordSnapshotJournalReceipt(t, binding, { ...input, expiresAt } as typeof input))
    ).rejects.toThrow(WERR_INVALID_OPERATION)
  expect(await k('snapshot_journal_receipts')).toEqual([])
})

describe('atomic continuity floor', () => {
  let directory: string
  beforeEach(async () => {
    await k.destroy()
    directory = await mkdtemp(join(tmpdir(), 'ts569-retention-'))
    k = knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await k.raw('PRAGMA journal_mode=WAL')
    await k.raw('PRAGMA busy_timeout=0')
    for (const sql of snapshotJournalReceiptDdl(k)) await k.raw(sql)
    await k.raw(SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL)
    await k('snapshot_journal_clock').insert({ id: 1, revision: '100', ceiling: '1000', enabled: 1, reason: null })
    await k('snapshot_journal_retention').insert({ id: 1, floor: '0', receiptLimit: 128, receiptLifetimeMs: 600000 })
    jest.spyOn(ArchiveClock, 'snapshotArchiveDatabaseNow').mockResolvedValue(2000)
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await k.destroy()
    await rm(directory, { recursive: true, force: true })
  })
  const revision = (n: number) => snapshotJournalRevision(String(n))
  async function stored(n: number, highWater: number, expiresAt = 3000) {
    await k('snapshot_journal_receipts').insert({
      requestId: n.toString(16).padStart(64, '0'),
      binding: 'a'.repeat(64),
      highWater: String(highWater),
      floor: '0',
      expiresAt
    })
  }
  test('the lowest live receipt pins continuity, including receipts for other profiles', async () => {
    await stored(1, 90)
    await stored(2, 70)
    await stored(3, 10, 2000)
    const receipts = await k('snapshot_journal_receipts').orderBy('requestId')
    await expect(k.transaction(t => advanceSnapshotJournalFloor(t, revision(71)))).rejects.toThrow()
    expect((await k('snapshot_journal_clock').first()).revision).toBe(100)
    expect((await k('snapshot_journal_retention').first()).floor).toBe('0')
    expect(await k('snapshot_journal_receipts').orderBy('requestId')).toEqual(receipts)
    expect(await k.transaction(t => advanceSnapshotJournalFloor(t, revision(70)))).toEqual({
      floor: '70',
      highWater: '101',
      liveReceipts: 2,
      examined: 3
    })
    expect(await k.transaction(t => advanceSnapshotJournalFloor(t, revision(70)))).toEqual({
      floor: '70',
      highWater: '102',
      liveReceipts: 2,
      examined: 3
    })
    expect(await k('snapshot_journal_receipts').orderBy('requestId')).toEqual(receipts)
  })
  test('rejects backwards and future floors and requires a writer transaction', async () => {
    await k('snapshot_journal_retention').update({ floor: '40' })
    await expect(advanceSnapshotJournalFloor(k, revision(40))).rejects.toThrow()
    for (const floor of [39, 102])
      await expect(k.transaction(t => advanceSnapshotJournalFloor(t, revision(floor)))).rejects.toThrow()
    expect((await k('snapshot_journal_retention').first()).floor).toBe('40')
    expect((await k('snapshot_journal_clock').first()).revision).toBe(100)
  })
  test('an exhausted generation commits invalidation without advancing continuity', async () => {
    await k('snapshot_journal_clock').update({ revision: 1000 })
    expect(await k.transaction(t => advanceSnapshotJournalFloor(t, revision(50)))).toBeUndefined()
    expect((await k('snapshot_journal_clock').first()).enabled).toBe(0)
    expect((await k('snapshot_journal_retention').first()).floor).toBe('0')
  })
  test('floor publication rolls back atomically and survives a lost committed acknowledgement', async () => {
    await expect(
      k.transaction(async t => {
        await advanceSnapshotJournalFloor(t, revision(50))
        throw Error('before commit')
      })
    ).rejects.toThrow('before commit')
    expect((await k('snapshot_journal_retention').first()).floor).toBe('0')
    await expect(
      (async () => {
        await k.transaction(t => advanceSnapshotJournalFloor(t, revision(50)))
        throw Error('lost acknowledgement')
      })()
    ).rejects.toThrow('lost acknowledgement')
    expect((await k('snapshot_journal_retention').first()).floor).toBe('50')
  })
  test('bounded capacity scans refuse overfull storage, including expired rows', async () => {
    await k('snapshot_journal_retention').update({ receiptLimit: 1 })
    await stored(1, 10, 1000)
    await stored(2, 10, 1000)
    const queries: string[] = []
    k.on('query', query => queries.push(query.sql))
    await expect(k.transaction(t => advanceSnapshotJournalFloor(t, revision(50)))).rejects.toThrow()
    expect(queries.filter(sql => sql.includes('from `snapshot_journal_receipts`'))).toEqual([
      expect.stringMatching(/order by `requestId` asc limit \?$/)
    ])
    expect((await k('snapshot_journal_retention').first()).floor).toBe('0')
  })
  test('corrupt expired receipts also prevent floor publication', async () => {
    await stored(1, 10, 1000)
    await k('snapshot_journal_receipts').update({ binding: 'z'.repeat(64) })
    await expect(k.transaction(t => advanceSnapshotJournalFloor(t, revision(50)))).rejects.toThrow()
    expect((await k('snapshot_journal_retention').first()).floor).toBe('0')
  })
  test('an independently held writer makes floor admission fail without waiting', async () => {
    const peer = knex({
      client: 'better-sqlite3',
      connection: k.client.config.connection,
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    await peer.raw('PRAGMA busy_timeout=0')
    const held = await peer.transaction()
    try {
      await held('snapshot_journal_clock').where('id', 1).update({ revision: 100 })
      const start = performance.now()
      await expect(k.transaction(t => advanceSnapshotJournalFloor(t, revision(50)))).rejects.toMatchObject({
        code: 'SQLITE_BUSY'
      })
      expect(performance.now() - start).toBeLessThan(1000)
    } finally {
      await held.rollback()
      await peer.destroy()
    }
  })

  test('300 seeded independent ledgers preserve every live prefix and monotonic floor', async () => {
    let seed = 3242026
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % max
    }
    for (let n = 0; n < 300; n++) {
      const prior = random(101),
        requested = random(151)
      const proofs = Array.from({ length: random(4) }, (_, index) => ({
        requestId: (index + 1).toString(16).padStart(64, '0'),
        binding: 'a'.repeat(64),
        highWater: String(random(121) + 1),
        floor: '0',
        expiresAt: random(2) ? 2000 : 3000
      }))
      await k('snapshot_journal_receipts').delete()
      await k('snapshot_journal_clock').update({ revision: 100, enabled: 1, reason: null })
      await k('snapshot_journal_retention').update({ floor: String(prior) })
      if (proofs.length) await k('snapshot_journal_receipts').insert(proofs)
      const live = proofs.filter(proof => proof.expiresAt > 2000)
      const allowed =
        requested >= prior &&
        requested <= 101 &&
        live.every(
          proof =>
            Number(proof.highWater) >= prior && Number(proof.highWater) <= 101 && requested <= Number(proof.highWater)
        )
      const advancing = k.transaction(t => advanceSnapshotJournalFloor(t, revision(requested)))
      if (allowed) {
        expect(await advancing).toEqual({
          floor: String(requested),
          highWater: '101',
          liveReceipts: live.length,
          examined: proofs.length
        })
      } else {
        await expect(advancing).rejects.toThrow()
      }
      expect((await k('snapshot_journal_retention').first()).floor).toBe(String(allowed ? requested : prior))
      expect((await k('snapshot_journal_clock').first()).revision).toBe(allowed ? 101 : 100)
      expect(await k('snapshot_journal_receipts').orderBy('requestId')).toEqual(proofs)
    }
  })
})
