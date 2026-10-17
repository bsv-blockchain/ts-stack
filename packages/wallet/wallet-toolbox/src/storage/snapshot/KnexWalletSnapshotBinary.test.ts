import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import type { SnapshotArchiveSource } from './archive/KnexSnapshotArchiveSource'

jest.setTimeout(30000)
const identity = '02' + '11'.repeat(32),
  foreign = '03' + '22'.repeat(32)
let directory: string, storage: StorageKnex, writer: StorageKnex, source: SnapshotArchiveSource | undefined
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wallet-binary-extent-'))
  const open = () =>
    new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 0, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
  storage = open()
  writer = open()
  await storage.knex.raw('PRAGMA journal_mode=WAL')
  await storage.migrate('Binary extent fixture', 'binary-source')
  await storage.makeAvailable()
  await writer.makeAvailable()
  const { user } = await storage.findOrInsertUser(identity),
    { user: other } = await storage.findOrInsertUser(foreign)
  const timestamps = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-01-01') }
  for (const [id, userId] of [
    [1, user.userId],
    [2, other.userId]
  ])
    await storage.knex('transactions').insert({
      ...timestamps,
      transactionId: id,
      userId,
      reference: `binary-${id}`,
      status: 'completed',
      isOutgoing: 1,
      satoshis: 0,
      description: 'Binary extent fixture',
      rawTx: Buffer.alloc(1048576, id)
    })
  source = await storage.openSnapshotArchiveSource(identity)
  expect(source).toBeDefined()
})
afterEach(async () => {
  const drained = await Promise.allSettled([source?.close(), storage?.destroy(), writer?.destroy()])
  const errors = drained.filter(value => value.status === 'rejected')
  if (errors.length)
    throw new AggregateError(
      errors.map(value => value.reason),
      'Binary fixture ownership did not drain'
    )
  await rm(directory, { recursive: true, force: true })
})

async function expectedReadFailure(read: Promise<unknown>, message: string): Promise<void> {
  let failure: unknown
  try {
    await read
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(Error)
  expect((failure as Error).message).toContain(message)
  // A physical read failure stops this retained view. Observe its exact closed
  // lifetime before opening another; an independent cleanup failure must fail.
  await expect(source!.close()).rejects.toBe(failure)
  await expect(source!.closed).rejects.toBe(failure)
  source = undefined
}

test('ordinary full-row admission refuses a large blob without loading it', async () => {
  await expectedReadFailure(source!.readPage('transactions', undefined, { maxBytes: 4096 }), 'large-value streaming')
})

test('metadata omits a large native blob while bounded extents remain in the same view across a foreground write', async () => {
  const binary = source!.binaryReader!
  const page = await binary.readMetadataPage('transactions', undefined, { maxRows: 1, maxBytes: 4096 })
  expect(page.rows).toHaveLength(1)
  expect(page.rows[0].fields.transactionId).toBe(1)
  expect(Object.hasOwn(page.rows[0].fields, 'rawTx')).toBe(false)
  expect(page.rows[0].binaries.rawTx).toBe(1048576)
  await writer
    .knex('transactions')
    .where('transactionId', 1)
    .update({ rawTx: Buffer.alloc(1048576, 9) })
  const extent = await binary.readBinaryCell('transactions', page.rows[0].cursor, 'rawTx', 65536, 4096, 1048576)
  expect(extent).toEqual(new Uint8Array(4096).fill(1))
  expect(
    (
      await writer
        .knex('transactions')
        .where('transactionId', 1)
        .select(writer.knex.raw('substr(rawTx,1,1) AS byte'))
        .first()
    ).byte
  ).toEqual(Buffer.from([9]))
})

test('extent metadata cannot authorize another view, column, size or a closed lifetime', async () => {
  const binary = source!.binaryReader!,
    page = await binary.readMetadataPage('transactions')
  const cursor = page.rows[0].cursor
  await expect(
    binary.readBinaryCell('transactions', { ...cursor, snapshotId: 'different' }, 'rawTx', 0, 1, 1048576)
  ).rejects.toThrow('snapshot')
  await expect(binary.readBinaryCell('transactions', cursor, 'lockingScript', 0, 1, 1048576)).rejects.toThrow('extent')
  await expect(binary.readBinaryCell('transactions', cursor, 'rawTx', 0, 65537, 1048576)).rejects.toThrow('extent')
  await source!.close()
  await expect(binary.readBinaryCell('transactions', cursor, 'rawTx', 0, 1, 1048576)).rejects.toThrow()
})

test.each(['foreign profile', 'incorrect length'])(
  'actual cell checks refuse %s and drain the retained view',
  async kind => {
    const binary = source!.binaryReader!,
      page = await binary.readMetadataPage('transactions')
    const cursor = page.rows[0].cursor
    await expectedReadFailure(
      binary.readBinaryCell(
        'transactions',
        kind === 'foreign profile' ? { ...cursor, after: [2] } : cursor,
        'rawTx',
        0,
        1,
        kind === 'incorrect length' ? 1048575 : 1048576
      ),
      'actual cell'
    )
  }
)
