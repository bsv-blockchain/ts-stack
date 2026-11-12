import { createHash } from 'node:crypto'
import {
  snapshotJournalArchiveFixture,
  journalArchiveIdentity as identityKey,
  journalArchiveForeign as foreignKey
} from '../../../../test/utils/snapshotJournalArchiveFixture'
import { runInSeries } from '../../../utility/runInSeries'
import { KnexSnapshotArchiveRequestStore } from '../archive/KnexSnapshotArchiveRequestStore'
import { parseSnapshotArchiveReaderRequest } from '../archive/SnapshotArchiveReaderRequest'
import {
  snapshotJournalFieldArchiveReaderRequestId,
  parseSnapshotJournalFieldArchiveReaderRequest,
  validateSnapshotJournalFieldArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import { captureSnapshotJournalFieldArchiveSource } from './captureSnapshotJournalFieldArchiveSource'
import { parseSnapshotJournalFieldArchiveBinding } from './SnapshotJournalArchiveBinding'
import { snapshotJournalFieldArchiveEncoding } from './SnapshotJournalArchivePacket'

const fixtures: Array<Awaited<ReturnType<typeof snapshotJournalArchiveFixture>>> = [],
  options = { lifetimeMs: 300000, maxBytes: 524288 }
async function fixture(full = false) {
  const value = await snapshotJournalArchiveFixture(full)
  fixtures.push(value)
  return value
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(fixtures.splice(0), fixture => fixture.close())
})

test('field journal reader request has an independent domain and binds every lower-bound coordinate and lease field', () => {
  const fields = {
      version: 4 as const,
      nonce: '11'.repeat(32),
      notAfter: 1900000000000,
      maxBytes: 524288,
      position: { binding: '22'.repeat(32), highWater: '9007199254740993' }
    },
    expected = createHash('sha256')
      .update(
        JSON.stringify([
          'wallet-journal-field-reader-request/1',
          4,
          fields.nonce,
          fields.notAfter,
          fields.maxBytes,
          [fields.position.binding, fields.position.highWater]
        ])
      )
      .digest('hex'),
    request = { ...fields, requestId: snapshotJournalFieldArchiveReaderRequestId(fields) }
  expect(request.requestId).toBe(expected)
  expect(parseSnapshotJournalFieldArchiveReaderRequest(request)).toEqual(request)
  for (const changed of [
    { ...fields, nonce: '33'.repeat(32) },
    { ...fields, notAfter: fields.notAfter + 1 },
    { ...fields, maxBytes: fields.maxBytes + 1 },
    { ...fields, position: null },
    { ...fields, position: { ...fields.position, binding: '44'.repeat(32) } },
    { ...fields, position: { ...fields.position, highWater: '9007199254740994' } }
  ]) {
    expect(snapshotJournalFieldArchiveReaderRequestId(changed)).not.toBe(expected)
    expect(() => parseSnapshotJournalFieldArchiveReaderRequest({ ...changed, requestId: expected })).toThrow()
  }
  expect(() => parseSnapshotArchiveReaderRequest(request)).toThrow()
  expect(() => parseSnapshotJournalFieldArchiveReaderRequest({ ...request, version: 2 })).toThrow()
  expect(() => validateSnapshotJournalFieldArchiveReaderRequest(request, fields.notAfter)).toThrow()
  expect(validateSnapshotJournalFieldArchiveReaderRequest(request, fields.notAfter - 1)).toEqual(request)
  const getter = jest.fn(() => fields.position)
  expect(() =>
    parseSnapshotJournalFieldArchiveReaderRequest(
      Object.defineProperty({ ...request }, 'position', { get: getter, enumerable: true })
    )
  ).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

test('server-offered field journal tuple claims once across replicas; absent, changed and foreign tuples never reserve a source', async () => {
  const f = await fixture(),
    first = new KnexSnapshotArchiveRequestStore(f.storage.knex),
    second = new KnexSnapshotArchiveRequestStore(f.storage.knex),
    position = { binding: '55'.repeat(32), highWater: '9007199254740993' },
    issued = await first.offerJournalFields(identityKey, options, position)
  if (issued === undefined) throw new Error('Actual journal offer was not issued')
  const request = issued.request,
    claimed = await first.claimJournalFieldsReader(identityKey, request)
  expect(claimed.owner).toBeDefined()
  expect((await second.claimJournalFieldsReader(identityKey, request)).owner).toBeUndefined()
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
    archives: 1,
    reservedBytes: options.maxBytes
  })
  await expect(second.claimJournalFieldsReader(foreignKey, request)).rejects.toThrow('unavailable')
  const changedFields = {
      version: 4 as const,
      nonce: request.nonce,
      notAfter: request.notAfter,
      maxBytes: request.maxBytes,
      position: { ...position, highWater: '9007199254740994' }
    },
    changed = { ...changedFields, requestId: snapshotJournalFieldArchiveReaderRequestId(changedFields) }
  await expect(second.claimJournalFieldsReader(identityKey, changed)).rejects.toThrow('unavailable')
  await expect(second.claimReader(identityKey, request)).rejects.toThrow()
  await second.markJournalFieldsReaderCancellation(identityKey, request)
  await second.close(identityKey, request.requestId)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(first.claimJournalFieldsReader(identityKey, request)).rejects.toThrow('unavailable')
})

test('actual guarded source capture publishes a durable journal receipt only after closure and survives controller replacement', async () => {
  const f = await fixture(true),
    first = new KnexSnapshotArchiveRequestStore(f.storage.knex, true, true),
    second = new KnexSnapshotArchiveRequestStore(f.storage.knex, true, true),
    issued = await first.offerJournalFields(identityKey, options)
  if (issued === undefined) throw new Error('Actual guarded offer was not issued')
  const request = issued.request,
    claimed = await first.claimJournalFieldsReader(identityKey, request)
  if (claimed.owner === undefined) throw new Error('Actual guarded owner was not claimed')
  const owner = claimed.owner,
    opened = await f.storage.openSnapshotSyncContentSource(identityKey, options, owner)
  if (opened === undefined) throw new Error('Actual guarded journal source unavailable')
  const source = f.own(opened),
    manifest = await captureSnapshotJournalFieldArchiveSource(source, {
      beginJournalFields: binding => first.beginJournalFields(owner, binding),
      appendJournalFields: (writer, page) => first.appendJournalFields(owner, writer, page),
      sealJournalFields: async writer => {
        await first.sourceClosed(owner)
        return await first.sealJournalFields(owner, writer)
      },
      close: async () => {
        await first.sourceClosed(owner)
        await first.close(identityKey, request.requestId)
      }
    })
  expect(source.isOpen).toBe(false)
  expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await second.journalFieldsStatus(identityKey, request)).toEqual({
    version: 1,
    requestId: request.requestId,
    expiresAt: request.notAfter,
    state: 'ready',
    archiveId: manifest.archiveId,
    digest: manifest.digest
  })
  expect((await f.store.journalFieldsDirectory(identityKey, manifest.archiveId)).encoding).toBe(
    snapshotJournalFieldArchiveEncoding
  )
  expect((await second.claimJournalFieldsReader(identityKey, request)).owner).toBeUndefined()
  await second.markJournalFieldsReaderCancellation(identityKey, request)
  await second.close(identityKey, request.requestId)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  expect(await f.storage.knex('snapshot_archive_requests').where('requestId', request.requestId)).toHaveLength(0)
  await expect(first.claimJournalFieldsReader(identityKey, request)).rejects.toThrow('unavailable')
}, 90000)

test('a field journal offer cannot become a row capture or silently adopt a different requested lower bound', async () => {
  const f = await fixture(),
    requests = new KnexSnapshotArchiveRequestStore(f.storage.knex, true, true),
    issued = await requests.offerJournalFields(identityKey, options)
  if (issued === undefined) throw new Error('Actual journal offer missing')
  const claimed = await requests.claimJournalFieldsReader(identityKey, issued.request)
  if (claimed.owner === undefined) throw new Error('Actual journal owner missing')
  const owner = claimed.owner,
    opened = await f.storage.openSnapshotSyncContentSource(identityKey, options, owner)
  if (opened === undefined) throw new Error('Actual guarded journal source unavailable')
  const source = f.own(opened)
  try {
    await expect(
      requests.begin(owner, {
        version: 1,
        snapshotId: source.snapshotId,
        sourceStorage: source.sourceStorage,
        user: source.user,
        sourceSchema: source.sourceSchema
      })
    ).rejects.toThrow('unavailable')
    const mismatched = parseSnapshotJournalFieldArchiveBinding({
      version: 4,
      encoding: snapshotJournalFieldArchiveEncoding,
      snapshotId: source.snapshotId,
      sourceStorage: source.sourceStorage,
      user: source.user,
      sourceSchema: source.sourceSchema,
      journal: {
        source: source.receiptBinding,
        receipt: source.receipt,
        low: '0',
        bootstrap: false,
        primary: source.primary
      }
    })
    await expect(requests.beginJournalFields(owner, mismatched)).rejects.toThrow('unavailable')
    expect(await f.storage.knex('snapshot_archives')).toHaveLength(0)
    expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 1,
      reservedBytes: options.maxBytes
    })
  } finally {
    await source.close()
    await source.closed
    await requests.sourceClosed(owner)
    await requests.close(identityKey, issued.request.requestId)
  }
})

test('actual field upload request recovers its SQL owner across controllers and permanently fences a cancelled admission until original expiry', async () => {
  const f = await fixture(),
    source = await f.open(),
    manifest = await captureSnapshotJournalFieldArchiveSource(source, f.store),
    binding = manifest.binding,
    first = new KnexSnapshotArchiveRequestStore(f.storage.knex),
    second = new KnexSnapshotArchiveRequestStore(f.storage.knex),
    { parseSnapshotJournalFieldUploadRequest } = await import('./SnapshotJournalFieldUploadRequest')
  await f.store.close(identityKey, manifest.archiveId)
  const cancelled = await first.offerJournalFieldUpload(identityKey, binding)
  if (cancelled === undefined) throw new Error('Actual upload offer unavailable')
  expect(cancelled.request.version).toBe(5)
  expect(() => parseSnapshotJournalFieldArchiveReaderRequest(cancelled.request)).toThrow()
  await expect(second.claimJournalFieldsReader(identityKey, cancelled.request)).rejects.toThrow()
  await second.cancelJournalFieldUpload(identityKey, cancelled.request)
  await expect(first.beginJournalFieldUpload(identityKey, cancelled.request, binding)).rejects.toThrow('unavailable')
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  const retained = await f.storage
    .knex('snapshot_archive_requests')
    .where('requestId', cancelled.request.requestId)
    .first()
  expect(retained).toMatchObject({ state: 'closed', released: 1, expiresAt: cancelled.request.notAfter })
  const issued = await first.offerJournalFieldUpload(identityKey, binding)
  if (issued === undefined) throw new Error('Second actual upload offer unavailable')
  expect(parseSnapshotJournalFieldUploadRequest(issued.request)).toEqual(issued.request)
  await expect(second.beginJournalFieldUpload(foreignKey, issued.request, binding)).rejects.toThrow()
  await expect(
    second.beginJournalFieldUpload(identityKey, issued.request, { ...binding, snapshotId: '44'.repeat(32) })
  ).rejects.toThrow('unavailable')
  const original = await first.beginJournalFieldUpload(identityKey, issued.request, binding),
    recovered = await second.beginJournalFieldUpload(identityKey, issued.request, binding)
  expect(recovered).toEqual(original)
  expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
    archives: 1,
    reservedBytes: issued.request.maxBytes
  })
  await second.cancelJournalFieldUpload(identityKey, issued.request)
  await expect(first.journalFieldUploadOwner(identityKey, issued.request)).rejects.toThrow('unavailable')
  await expect(first.beginJournalFieldUpload(identityKey, issued.request, binding)).rejects.toThrow('unavailable')
  await second.cancelJournalFieldUpload(identityKey, issued.request)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  expect(await f.storage.knex('snapshot_archives')).toHaveLength(0)
}, 90000)
