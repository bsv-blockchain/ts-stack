import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import knexModule from 'knex'
import * as journalGeneration from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import * as captureBackend from '../snapshot/journal/SnapshotJournalCaptureBackend'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { randomUUID } from 'node:crypto'
import {
  previewDestinationFixture,
  previewPrivateFixture,
  previewReceiptPolicy as policy
} from './Brc38ImportPreviewFixture'
import {
  previewBrc38PrivateImport,
  readBrc38PrivateImportPreview,
  withBrc38PrivateImportPreview
} from './Brc38PrivateImportPreviewNode'
import { captureBrc38KnexDestinationFence, brc38DestinationSelection } from './Brc38KnexDestinationFence'
import { Brc38SemanticStage } from './Brc38SemanticStage'
import { readBrc38JsonStream } from './Brc38JsonStream'
import { semanticStageFixture } from './Brc38SemanticStageFixture'

let target: Awaited<ReturnType<typeof previewDestinationFixture>>,
  staged: Awaited<ReturnType<typeof previewPrivateFixture>>
beforeEach(async () => {
  target = await previewDestinationFixture()
  staged = await previewPrivateFixture()
})
afterEach(async () => {
  jest.restoreAllMocks()
  try {
    await staged?.close()
  } finally {
    await target?.close()
  }
})
const store = () => staged.value.reservation.store
const selection = () => ({
  identityKey: staged.selected.binding.identityKey,
  chain: staged.selected.binding.chain,
  targetStorageIdentityKey: staged.selected.binding.targetStorageIdentityKey,
  mode: 'merge' as const
})
async function preview(mode: 'restore' | 'merge' = 'merge') {
  return await previewBrc38PrivateImport(store(), target.storage, mode, policy)
}
test('real authenticated preview persists actual target schema/epoch/exact clock without active writes', async () => {
  const before = await target.k('snapshot_journal_clock').first(),
    queries: string[] = [],
    listener = (query: { sql: string }) => queries.push(query.sql)
  const original = knexModule.knex
  const factory = jest.spyOn(knexModule, 'knex').mockImplementation((...args) => {
    const owned = original(...args)
    owned.on('query', listener)
    return owned
  })
  const value = await preview('restore')
  factory.mockRestore()
  expect(value.target).toMatchObject({
    ...selection(),
    mode: 'restore',
    backend: 'SQLite',
    userId: null,
    activeStorage: null,
    primaryEpoch: null
  })
  expect(value.target.schemaSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(value.target.epoch).toMatch(/^[0-9a-f-]{36}$/)
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
  expect(await target.k('snapshot_journal_clock').first()).toEqual(before)
  expect(await target.k('users')).toEqual([])
  expect(queries.some(sql => /^(?:update|insert|delete)/i.test(sql))).toBe(false)
  expect(
    queries.filter(sql => sql.includes(' AS occupied') && !sql.includes('snapshot_journal_receipts'))
  ).toHaveLength(15)
  expect(queries.filter(sql => sql.includes(' AS occupied')).some(sql => /count\(|offset /i.test(sql))).toBe(false)
  expect(Object.isFrozen(value.target)).toBe(true)
})
test('compressed profiles retain the same authenticated preview binding as accepted bounded legacy identities', async () => {
  await staged.close()
  const identityKey = '02' + '11'.repeat(32)
  staged = await previewPrivateFixture(identityKey)
  const value = await preview()
  expect(value.target.identityKey).toBe(identityKey)
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
  await expect(
    withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async () => 'bound')
  ).resolves.toBe('bound')
  for (const identityKey of ['', 'x'.repeat(257)])
    expect(() => brc38DestinationSelection({ ...selection(), identityKey })).toThrow('profile')
})
test('actual independent WAL writer between pinned clock and profile/settings reads cannot mix generations', async () => {
  const old = await target.k('snapshot_journal_clock').select(target.k.raw('CAST(revision AS TEXT) revision')).first()
  const read = journalGeneration.readSnapshotJournalSqliteGeneration
  const observer = jest
    .spyOn(journalGeneration, 'readSnapshotJournalSqliteGeneration')
    .mockImplementation(async (...args) => {
      const generation = await read(...args)
      await target.writer('settings').update({ chain: 'main' })
      return generation
    })
  const value = await preview()
  observer.mockRestore()
  expect(value.target.revision).toBe(old.revision)
  expect(value.target.chain).toBe('test')
  const write = jest.fn(async () => 'should never write')
  await expect(withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)).rejects.toThrow(
    'identity or network'
  )
  expect(write).not.toHaveBeenCalled()
  expect(await target.k('users')).toEqual([])
})
test('clock values beyond Number precision are captured and fenced as exact decimal text', async () => {
  await target
    .k('snapshot_journal_clock')
    .update({ revision: target.k.raw('CAST(? AS INTEGER)', ['9007199254740993']) })
  const value = await preview()
  expect(value.target.revision).toBe('9007199254740993')
  await expect(
    withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async () => 17)
  ).resolves.toBe(17)
  await target
    .writer('snapshot_journal_clock')
    .update({ revision: target.writer.raw('CAST(? AS INTEGER)', ['9007199254740994']) })
  const write = jest.fn(async () => 18)
  await expect(withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)).rejects.toThrow(
    'changed after'
  )
  expect(write).not.toHaveBeenCalled()
})
test('primary away-and-back with equal visible profile still invalidates its original preview', async () => {
  const { user } = await target.storage.findOrInsertUser(staged.selected.binding.identityKey)
  const value = await preview(),
    before = await target.k('users').where({ userId: user.userId }).first(),
    beforeClock = await target.k('snapshot_journal_clock').first()
  expect(value.target.primaryEpoch).toBe('0')
  await target.writer('users').where({ userId: user.userId }).update({ activeStorage: 'synthetic other primary' })
  await target.writer('users').where({ userId: user.userId }).update({ activeStorage: before.activeStorage })
  expect(await target.k('snapshot_journal_clock').first()).toEqual(beforeClock)
  expect(await target.k('snapshot_sync_primary_epochs').where({ userId: user.userId }).first()).toMatchObject({
    epoch: 2
  })
  const write = jest.fn(async () => 1)
  await expect(withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)).rejects.toThrow(
    'changed after'
  )
  expect(write).not.toHaveBeenCalled()
  expect(await target.k('users').where({ userId: user.userId }).first()).toEqual(before)
})
test('actual primary epochs above Number precision remain distinct durable decimal fences', async () => {
  const { user } = await target.storage.findOrInsertUser(staged.selected.binding.identityKey)
  await target.k('snapshot_sync_primary_epochs').insert({
    userId: user.userId,
    epoch: target.k.raw('CAST(? AS INTEGER)', ['9007199254740993'])
  })
  const value = await preview()
  expect(value.target.primaryEpoch).toBe('9007199254740993')
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
  await target.writer('users').where({ userId: user.userId }).update({ activeStorage: 'synthetic other primary' })
  await target.writer('users').where({ userId: user.userId }).update({ activeStorage: user.activeStorage })
  const write = jest.fn(async () => 1)
  await expect(withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)).rejects.toThrow(
    'changed after'
  )
  expect(write).not.toHaveBeenCalled()
})
test.each([
  { label: 'negative', epoch: -1 },
  { label: 'fractional', epoch: 2.5 },
  { label: 'oversized text', epoch: 'x'.repeat(1000) }
])('invalid actual primary epoch refuses before preview persistence ($label)', async ({ epoch }) => {
  const { user } = await target.storage.findOrInsertUser(staged.selected.binding.identityKey)
  await target.k('snapshot_sync_primary_epochs').insert({ userId: user.userId, epoch })
  await expect(preview()).rejects.toThrow()
  expect(await store().readImportPreview()).toBeUndefined()
})
test.each(['epoch', 'schema', 'incomplete', 'disabled'] as const)(
  'actual %s drift refuses before a target step',
  async kind => {
    const value = await preview()
    if (kind === 'epoch') await target.writer('snapshot_journal_generation').update({ epoch: randomUUID() })
    if (kind === 'schema')
      await target.writer.raw(
        "CREATE TRIGGER synthetic_preview_drift AFTER INSERT ON users BEGIN SELECT 'different schema'; END"
      )
    if (kind === 'incomplete') await target.writer('snapshot_journal_generation').update({ complete: 0 })
    if (kind === 'disabled')
      await target.writer('snapshot_journal_clock').update({ enabled: 0, reason: 'capacity-exhausted' })
    const before = await target.k('snapshot_journal_clock').first(),
      write = jest.fn(async () => 1)
    await expect(
      withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)
    ).rejects.toThrow()
    expect(write).not.toHaveBeenCalled()
    expect(await target.k('snapshot_journal_clock').first()).toEqual(before)
  }
)
test('restore cannot overwrite a foreign profile or accept a selected profile that is merely empty', async () => {
  await target.storage.findOrInsertUser('03' + '22'.repeat(32))
  await expect(preview('restore')).rejects.toThrow('empty target storage except settings')
  expect(await store().readImportPreview()).toBeUndefined()
  await expect(preview('merge')).resolves.toMatchObject({ target: { userId: null } })
})
test('legacy monitor occupancy is rechecked even when it does not advance the archive journal clock', async () => {
  const value = await preview('restore'),
    before = await target.k('snapshot_journal_clock').first()
  await target.storage.insertMonitorEvent({
    id: 0,
    created_at: new Date(),
    updated_at: new Date(),
    event: 'synthetic preview',
    details: 'synthetic monitor occupancy'
  })
  expect(await target.k('snapshot_journal_clock').first()).toEqual(before)
  const write = jest.fn(async () => 1)
  await expect(withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)).rejects.toThrow(
    'empty target'
  )
  expect(write).not.toHaveBeenCalled()
  expect(await target.k('monitor_events')).toHaveLength(1)
})
test('re-preview supersedes the old ID while keeping the original archive binding, quota and deadline', async () => {
  const first = await preview(),
    meta = await store().knex('metadata').first(),
    second = await preview()
  expect(second.previewId).not.toBe(first.previewId)
  expect(second.expiresAt).toBe(first.expiresAt)
  expect(second.bindingSha256).toBe(first.bindingSha256)
  expect(await store().knex('metadata').first()).toEqual(meta)
  const write = jest.fn(async () => 1)
  await expect(withBrc38PrivateImportPreview(store(), target.storage, first.previewId, policy, write)).rejects.toThrow(
    'superseded'
  )
  expect(write).not.toHaveBeenCalled()
  await expect(
    withBrc38PrivateImportPreview(store(), target.storage, second.previewId, policy, async () => 2)
  ).resolves.toBe(2)
})
test('durable authenticated preview reopens under the same reservation without replay or deadline renewal', async () => {
  const value = await preview(),
    id = staged.value.reservation.id
  await store().close()
  const reopened = await staged.root.resume(id, staged.selected.limits, staged.selected.binding)
  staged.held.push(reopened)
  expect(await readBrc38PrivateImportPreview(reopened.store)).toEqual(value)
  expect((await staged.root.usage()).imports).toBe(1)
  await expect(
    withBrc38PrivateImportPreview(reopened.store, target.storage, value.previewId, policy, async () => 'owned')
  ).resolves.toBe('owned')
})
test('private semantic seal by itself cannot stand in for complete envelope authentication', async () => {
  await staged.root.discard(staged.value.reservation, new Error('replace with unauthenticated fixture'))
  const reservation = await staged.root.admit(staged.selected.limits, staged.selected.binding)
  staged.held.push(reservation)
  expect(await reservation.store.knex.schema.hasTable('private_import')).toBe(false)
  const semantic = new Brc38SemanticStage(reservation.store, {
    expectedIdentityKey: staged.selected.binding.identityKey,
    expectedChain: 'test',
    expectedSourceStorageIdentityKey: staged.selected.binding.sourceStorageIdentityKey,
    maximumRows: 10000
  })
  async function* source() {
    yield Buffer.from(JSON.stringify(semanticStageFixture()))
  }
  await readBrc38JsonStream(source(), semantic, {
    maximumArchiveBytes: 1048576,
    maximumRowAllocationBytes: 65536,
    maximumMetadataAllocationBytes: 65536,
    maximumInputChunkBytes: 65536,
    maximumInputChunks: 100
  })
  await expect(previewBrc38PrivateImport(reservation.store, target.storage, 'merge', policy)).rejects.toThrow(
    'actual archive authentication'
  )
  expect(await reservation.store.knex.schema.hasTable('private_import')).toBe(false)
  expect(await target.k('users')).toEqual([])
})
test('persisted oversized preview is rejected by SQL extent before its payload is selected', async () => {
  await preview()
  const actual = store(),
    guardName = 'brc38_source_seal_private_import_update',
    oversized = 'x'.repeat(8193)
  await expect(actual.knex('private_import').update({ previewJson: oversized })).rejects.toThrow('seal')
  // Synthetic physical corruption is separate from the ordinary write refusal.
  // The read runs only after the exact source guard has been restored.
  await actual.knex.transaction(async trx => {
    const guard = await trx('sqlite_schema').where({ name: guardName, type: 'trigger' }).first('sql')
    expect(typeof guard?.sql).toBe('string')
    await trx.raw('DROP TRIGGER ??', [guardName])
    await trx('private_import').update({ previewJson: oversized })
    await trx.raw(guard.sql)
  })
  await verifyBrc38AuthenticatedSourceSeal(actual.knex)
  const queries: string[] = [],
    listener = (query: { sql: string }) => queries.push(query.sql)
  store().knex.on('query', listener)
  await expect(readBrc38PrivateImportPreview(store())).rejects.toThrow('metadata bounds')
  store().knex.off('query', listener)
  expect(queries.some(sql => sql.startsWith('select * from `private_import`'))).toBe(false)
})
test('private preview metadata quota failure preserves the previous receipt and logical charge', async () => {
  const value = await preview()
  await store()
    .knex('metadata')
    .update({ logicalBytes: store().limits.maximumLogicalBytes - 1 })
  const before = await store().knex('metadata').first()
  await expect(store().saveImportPreview('x'.repeat(8192))).rejects.toThrow('metadata quota')
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
  expect(await store().knex('metadata').first()).toEqual(before)
})
test('actual private ownership remains held throughout the destination transaction', async () => {
  const value = await preview()
  let began!: () => void, release!: () => void
  const started = new Promise<void>(resolve => {
      began = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    })
  const step = withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async () => {
    began()
    await gate
    return 'done'
  })
  try {
    await started
    await expect(store().close()).rejects.toThrow('owned private')
    await expect(preview()).rejects.toThrow('already owned')
    await expect(target.writer('settings').update({ storageName: 'concurrent writer' })).rejects.toMatchObject({
      code: 'SQLITE_BUSY'
    })
  } finally {
    release()
    await step
  }
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
})
test('unsupported destination driver refuses before any provider read transaction', async () => {
  const read = jest.spyOn(target.storage, 'readSnapshot'),
    factory = jest.spyOn(knexModule, 'knex'),
    original = target.storage.knex.client.config.client
  target.storage.knex.client.config.client = 'mysql2'
  try {
    await expect(captureBrc38KnexDestinationFence(target.storage, selection(), policy)).rejects.toThrow('owned SQLite')
  } finally {
    target.storage.knex.client.config.client = original
  }
  expect(read).not.toHaveBeenCalled()
  expect(factory).not.toHaveBeenCalled()
})
test('a logically identical copied SQLite file cannot replace the actual preview backend', async () => {
  const value = await preview()
  await target.k.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  const filename = join(target.directory, 'clone.sqlite'),
    original = target.storage.knex.client.config.connection
  await fs.copyFile(join(target.directory, 'target.sqlite'), filename)
  target.storage.knex.client.config.connection = { filename }
  const write = jest.fn(async () => 1)
  try {
    await expect(
      withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, write)
    ).rejects.toThrow('changed after')
  } finally {
    target.storage.knex.client.config.connection = original
  }
  expect(write).not.toHaveBeenCalled()
  expect(await target.k('users')).toEqual([])
})
test('failed destination close retains private ownership and quota until concrete physical retry', async () => {
  const failure = new Error('synthetic target native close failure')
  const close = jest.spyOn(captureBackend, 'closeSnapshotJournalCapturePool').mockRejectedValueOnce(failure)
  let retained: Brc38StagingCleanupError | undefined
  try {
    await preview()
  } catch (cause) {
    if (!(cause instanceof Brc38StagingCleanupError)) throw cause
    retained = cause
  }
  close.mockRestore()
  if (retained === undefined) throw new Error('Expected retained actual target owner')
  await expect(store().count('outputs')).rejects.toBe(retained)
  expect((await staged.root.usage()).imports).toBe(1)
  await expect(
    staged.root.resume(staged.value.reservation.id, staged.selected.limits, staged.selected.binding)
  ).rejects.toMatchObject({ code: 'SQLITE_BUSY' })
  await retained.retryCleanup()
  expect(await store().count('outputs')).toBe(1)
  await expect(preview()).resolves.toMatchObject({ protocol: 'brc38-private-import-preview/v1' })
})
test('an original destination-step failure rolls back its active rows and preserves exact error identity', async () => {
  const value = await preview(),
    failure = new Error('synthetic step failure'),
    before = await target.k('snapshot_journal_clock').first()
  await expect(
    withBrc38PrivateImportPreview(store(), target.storage, value.previewId, policy, async trx => {
      await trx('monitor_events').insert({
        id: 1,
        created_at: Date.now(),
        updated_at: Date.now(),
        event: 'synthetic rollback'
      })
      throw failure
    })
  ).rejects.toBe(failure)
  expect(await target.k('monitor_events')).toEqual([])
  expect(await target.k('snapshot_journal_clock').first()).toEqual(before)
  expect(await readBrc38PrivateImportPreview(store())).toEqual(value)
})
test('a global proof row independently prevents restore even when there are no wallet profiles', async () => {
  await target.storage.insertProvenTx({
    provenTxId: 0,
    created_at: new Date(),
    updated_at: new Date(),
    txid: 'a'.repeat(64),
    height: 1,
    index: 0,
    merklePath: [1],
    rawTx: [2],
    blockHash: 'b'.repeat(64),
    merkleRoot: 'c'.repeat(64)
  })
  expect(await target.k('users')).toEqual([])
  await expect(preview('restore')).rejects.toThrow('empty target storage except settings')
  expect(await store().readImportPreview()).toBeUndefined()
})
