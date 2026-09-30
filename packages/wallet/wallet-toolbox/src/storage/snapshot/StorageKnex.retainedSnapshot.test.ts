import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { runInSeries } from '../../utility/runInSeries'

const stores: StorageKnex[] = []
const directories: string[] = []
const identity = '02' + '11'.repeat(32)

async function pair(): Promise<[StorageKnex, StorageKnex]> {
  const directory = await mkdtemp(join(tmpdir(), 'retained-wallet-view-'))
  directories.push(directory)
  const open = () => {
    const store = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 },
        acquireConnectionTimeout: 1000
      })
    })
    stores.push(store)
    return store
  }
  const source = open()
  await source.knex.raw('PRAGMA journal_mode = WAL')
  await source.migrate('retained source', 'source-storage')
  await source.makeAvailable()
  const writer = open()
  await writer.makeAvailable()
  return [source, writer]
}

afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(stores.splice(0), store => store.destroy())
  await runInSeries(directories.splice(0), directory => rm(directory, { recursive: true, force: true }))
})

test('retains an already-pinned SQLite view across independent writes, idle periods and repeated keyset reads', async () => {
  const [source, writer] = await pair()
  const { user } = await source.findOrInsertUser(identity)
  const when = new Date('2026-01-01T00:00:00.000Z')
  await runInSeries(
    Array.from({ length: 12 }, (_, index) => index),
    async index => {
      await source.insertTxLabel({
        txLabelId: 0,
        userId: user.userId,
        label: `label ${index}`,
        isDeleted: index === 5,
        created_at: when,
        updated_at: when
      })
    }
  )
  const { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
  await source.findOrInsertTxLabel(other.userId, 'foreign label')
  const expected = await source.findTxLabels({ partial: { userId: user.userId } })
  expect(source.supportsRetainedReadSnapshot()).toBe(true)
  const view = await source.openReadSnapshot()
  // There has been no consumer read yet. Opening must already have pinned the
  // view, rather than choosing an unrelated point in time on the first page.
  await writer.updateTxLabel(expected[0].txLabelId, { label: 'changed after open', updated_at: when })
  await writer.updateTxLabel(expected[7].txLabelId, { isDeleted: true, updated_at: when })
  await writer.findOrInsertTxLabel(user.userId, 'inserted after open')
  const page = (after: number) =>
    view.read(trx =>
      source
        .toDb(trx)<{
          txLabelId: number
          label: string
          isDeleted: boolean | number
        }>('tx_labels')
        .select('txLabelId', 'label', 'isDeleted')
        .where({ userId: user.userId })
        .where('txLabelId', '>', after)
        .orderBy('txLabelId')
        .limit(4)
    )
  const first = await page(0)
  await new Promise(resolve => setImmediate(resolve))
  const second = await page(first[3].txLabelId)
  const third = await page(second[3].txLabelId)
  expect(await page(third[3].txLabelId)).toEqual([])
  expect(await page(0)).toEqual(first)
  const result = [...first, ...second, ...third]
  expect(result.map(row => [row.txLabelId, row.label, Boolean(row.isDeleted)])).toEqual(
    expected.map(row => [row.txLabelId, row.label, row.isDeleted])
  )
  await view.close()
  const next = await source.openReadSnapshot()
  const current = await next.read(trx => source.findTxLabels({ partial: { userId: user.userId }, trx }))
  expect(current).toHaveLength(13)
  expect(current.find(row => row.txLabelId === expected[0].txLabelId)?.label).toBe('changed after open')
  expect(current.find(row => row.txLabelId === expected[7].txLabelId)?.isDeleted).toBe(true)
  await next.close()
})

test('cancellation keeps the provider slot occupied until an in-flight database read drains', async () => {
  const [source] = await pair()
  const { user } = await source.findOrInsertUser(identity)
  const controller = new AbortController()
  const view = await source.openReadSnapshot({ signal: controller.signal })
  let release!: () => void
  const held = new Promise<void>(resolve => {
    release = resolve
  })
  let started!: () => void
  const reading = new Promise<void>(resolve => {
    started = resolve
  })
  const pending = view.read(async trx => {
    const rows = await source.findTxLabels({ partial: { userId: user.userId }, trx })
    started()
    await held
    return rows
  })
  const outcome = pending.catch(error => error)
  try {
    await reading
    controller.abort()
    await expect(source.openReadSnapshot()).rejects.toThrow('already has a retained read snapshot')
    release()
    expect(await outcome).toBeInstanceOf(Error)
    await view.closed
    const fresh = await source.openReadSnapshot()
    await fresh.close()
  } finally {
    release()
    await view.close()
  }
})

test('a failed read rolls back and permits a later retained view and ordinary write', async () => {
  const [source] = await pair()
  const { user } = await source.findOrInsertUser(identity)
  const view = await source.openReadSnapshot()
  const failure = new Error('synthetic snapshot query failure')
  await expect(
    view.read(async trx => {
      await source.findUsers({ partial: { userId: user.userId }, trx })
      throw failure
    })
  ).rejects.toBe(failure)
  await expect(view.closed).rejects.toBe(failure)
  await source.findOrInsertTxLabel(user.userId, 'after rollback')
  const fresh = await source.openReadSnapshot()
  expect(await fresh.read(trx => source.findTxLabels({ partial: { userId: user.userId }, trx }))).toHaveLength(1)
  await fresh.close()
})

test('provider destruction closes its idle retained view before destroying the pool', async () => {
  const [source] = await pair()
  const view = await source.openReadSnapshot()
  await source.destroy()
  stores.splice(stores.indexOf(source), 1)
  await view.closed
  expect(view.isOpen).toBe(false)
  await expect(view.read(async () => 1)).rejects.toThrow('closed')
})

test('IndexedDB retains its scoped snapshot support but explicitly refuses an idle retained transaction', async () => {
  const source = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  expect(source.supportsReadSnapshot()).toBe(true)
  expect(source.supportsRetainedReadSnapshot()).toBe(false)
  await expect(source.openReadSnapshot()).rejects.toThrow('Retained read snapshots are not supported')
})

test('reserves the provider slot before acquisition hooks can re-enter opening', async () => {
  const [source] = await pair()
  const aborted = new AbortController()
  aborted.abort()
  const run = source.readSnapshot.bind(source)
  let nested: Promise<unknown> | undefined
  jest.spyOn(source, 'readSnapshot').mockImplementationOnce(async read => {
    nested = source.openReadSnapshot({ signal: aborted.signal }).catch(error => error)
    return await run(read)
  })
  const view = await source.openReadSnapshot()
  expect(await nested).toEqual(
    expect.objectContaining({ message: expect.stringContaining('already has a retained read snapshot') })
  )
  await view.close()
})

test('provider destruction still destroys the pool if retained-view cleanup reports failure', async () => {
  const [source] = await pair()
  const cleanupFailure = new Error('synthetic cleanup failure')
  const run = source.readSnapshot.bind(source)
  jest.spyOn(source, 'readSnapshot').mockImplementationOnce(async read => {
    await run(read)
    throw cleanupFailure
  })
  const view = await source.openReadSnapshot()
  await expect(source.destroy()).rejects.toBe(cleanupFailure)
  stores.splice(stores.indexOf(source), 1)
  await expect(view.closed).rejects.toBe(cleanupFailure)
  await expect(source.knex.raw('SELECT 1')).rejects.toThrow('Unable to acquire a connection')
})

test('SQL providers with an unsupported database retain the explicit unsupported fallback', async () => {
  const [source] = await pair()
  jest.spyOn(source, 'supportsReadSnapshot').mockReturnValue(false)
  const read = jest.spyOn(source, 'readSnapshot')
  expect(source.supportsRetainedReadSnapshot()).toBe(false)
  await expect(source.openReadSnapshot()).rejects.toThrow('Retained read snapshots are not supported')
  expect(read).not.toHaveBeenCalled()
})

test.each([false, true])(
  'destruction fences retained-view admission before asynchronous cleanup (existing view: %s)',
  async existing => {
    const [source] = await pair()
    if (existing) await source.openReadSnapshot()
    let release!: () => void
    const cleanup = new Promise<void>(resolve => {
      release = resolve
    })
    let entered!: () => void
    const stopping = new Promise<void>(resolve => {
      entered = resolve
    })
    jest.spyOn(source, 'stopPreparedBeefTasks').mockImplementationOnce(async () => {
      entered()
      await cleanup
    })
    const destruction = source.destroy()
    try {
      await stopping
      // Observe/close an incorrectly admitted view so a failed assertion cannot
      // strand the pool. The provider must refuse before any acquisition.
      const read = jest.spyOn(source, 'readSnapshot')
      const result = await source.openReadSnapshot().catch(error => error)
      if (!(result instanceof Error)) await result.close()
      expect(result).toEqual(expect.objectContaining({ message: expect.stringContaining('destruction begins') }))
      expect(read).not.toHaveBeenCalled()
    } finally {
      release()
      await destruction
      stores.splice(stores.indexOf(source), 1)
    }
    await expect(source.openReadSnapshot()).rejects.toThrow('destruction begins')
  }
)
