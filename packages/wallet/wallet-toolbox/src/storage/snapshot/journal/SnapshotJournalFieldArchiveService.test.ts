import {
  snapshotJournalArchiveFixture,
  journalArchiveIdentity as identityKey
} from '../../../../test/utils/snapshotJournalArchiveFixture'
import { runInSeries } from '../../../utility/runInSeries'
import { KnexSnapshotArchiveService } from '../archive/KnexSnapshotArchiveService'
import { SnapshotArchiveCleanupPendingError } from '../archive/SnapshotArchiveOwner'
import type { SnapshotArchiveRequestReceipt } from '../archive/SnapshotArchiveRequest'
import type { SnapshotJournalFieldArchiveReaderRequest } from './SnapshotJournalArchiveReaderRequest'
import * as Backend from './SnapshotJournalCaptureBackend'

const fixtures: Array<Awaited<ReturnType<typeof snapshotJournalArchiveFixture>>> = [],
  controllers: KnexSnapshotArchiveService[] = [],
  options = { lifetimeMs: 300000, maxBytes: 524288 }
async function fixture(full = false) {
  const f = await snapshotJournalArchiveFixture(full)
  fixtures.push(f)
  const first = new KnexSnapshotArchiveService(f.storage),
    second = new KnexSnapshotArchiveService(f.storage)
  controllers.push(first, second)
  return { ...f, first, second }
}
async function terminal(
  service: KnexSnapshotArchiveService,
  request: SnapshotJournalFieldArchiveReaderRequest
): Promise<SnapshotArchiveRequestReceipt> {
  const deadline = performance.now() + 60000
  let receipt = await service.journalFieldsStatus(identityKey, request)
  while (receipt.state === 'building') {
    if (performance.now() >= deadline) throw new Error('Actual journal capture did not settle before the case deadline')
    await new Promise<void>(resolve => setTimeout(resolve, 5))
    receipt = await service.journalFieldsStatus(identityKey, request)
  }
  return receipt
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(controllers.splice(0), controller => controller.close())
  await runInSeries(fixtures.splice(0), fixture => fixture.close())
})

test('field journal controller owns guarded capture and replacement observes the same completed immutable artifact', async () => {
  const f = await fixture(true),
    issued = await f.first.offerJournalFieldsReader(identityKey, options)
  if (issued === undefined) throw new Error('Actual journal offer unavailable')
  const accepted = await f.first.admitJournalFieldsReader(identityKey, issued.request)
  expect(accepted.outcome).toBe('accepted')
  const ready = await terminal(f.second, issued.request)
  expect(ready.state).toBe('ready')
  if (ready.state !== 'ready' || ready.archiveId === undefined) throw new Error('Actual journal artifact not ready')
  const archiveId = ready.archiveId
  await f.first.close()
  expect(await f.second.journalFieldsStatus(identityKey, issued.request)).toEqual(ready)
  const directory = await f.second.journalFieldsDirectory(identityKey, archiveId)
  expect(directory.digest).toBe(ready.digest)
  expect(JSON.parse(directory.bindingJson)).toMatchObject({
    version: 4,
    journal: { bootstrap: true, low: '0' },
    user: { identityKey }
  })
  expect((await f.second.readJournalFields(identityKey, archiveId, 0)).bytes.byteLength).toBeGreaterThan(4)
  expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  await expect(f.second.directory(identityKey, archiveId)).rejects.toThrow('unavailable')
  await f.second.cancelJournalFieldsReader(identityKey, issued.request)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
}, 90000)

test('cross-replica cancellation keeps quota through actual guarded reader close and cannot acknowledge physical cleanup early', async () => {
  const f = await fixture(),
    original = Backend.closeSnapshotJournalCapturePool
  let entered!: () => void, release!: () => void
  const closing = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  let held = false
  jest.spyOn(Backend, 'closeSnapshotJournalCapturePool').mockImplementation(async (owner, connection) => {
    const modes: Array<{ query_only: number }> = await owner.raw('PRAGMA query_only').connection(connection)
    if (modes[0].query_only === 1 && !held) {
      held = true
      entered()
      await gate
    }
    await original(owner, connection)
  })
  const issued = await f.first.offerJournalFieldsReader(identityKey, options)
  if (issued === undefined) throw new Error('Actual journal offer unavailable')
  await f.first.admitJournalFieldsReader(identityKey, issued.request)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Actual guarded reader close not reached')), 20000)
      })
    ])
    expect(await f.storage.knex('snapshot_archives').first()).toMatchObject({ state: 'building' })
    await expect(f.second.cancelJournalFieldsReader(identityKey, issued.request)).rejects.toBeInstanceOf(
      SnapshotArchiveCleanupPendingError
    )
    expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(1)
    expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 1,
      reservedBytes: options.maxBytes
    })
    await f.storage.findOrInsertTxLabel(f.user.userId, 'foreground during guarded cancellation')
    release()
    await f.first.close()
    await f.second.cancelJournalFieldsReader(identityKey, issued.request)
    expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
    expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    release()
  }
})

test('field journal resource exhaustion retains its terminal classification after real source and reservation cleanup', async () => {
  const f = await fixture(),
    issued = await f.first.offerJournalFieldsReader(identityKey, { ...options, maxBytes: 4097 })
  if (issued === undefined) throw new Error('Actual bounded journal offer unavailable')
  await f.first.admitJournalFieldsReader(identityKey, issued.request)
  expect(await terminal(f.second, issued.request)).toMatchObject({
    state: 'resource-limited',
    requestId: issued.request.requestId
  })
  expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await f.second.cancelJournalFieldsReader(identityKey, issued.request)
})

test('matching future field journal position fails before artifact creation and drains the already admitted guarded owner', async () => {
  const f = await fixture(),
    prior = await f.open(),
    position = { binding: prior.receipt.binding, highWater: (BigInt(prior.receipt.highWater) + 100n).toString() }
  await prior.close()
  await prior.closed
  const issued = await f.first.offerJournalFieldsReader(identityKey, options, position)
  if (issued === undefined) throw new Error('Actual journal offer unavailable')
  await f.first.admitJournalFieldsReader(identityKey, issued.request)
  expect(await terminal(f.second, issued.request)).toMatchObject({
    state: 'failed',
    requestId: issued.request.requestId
  })
  expect(await f.storage.knex('snapshot_archives')).toHaveLength(0)
  expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await f.second.cancelJournalFieldsReader(identityKey, issued.request)
})
