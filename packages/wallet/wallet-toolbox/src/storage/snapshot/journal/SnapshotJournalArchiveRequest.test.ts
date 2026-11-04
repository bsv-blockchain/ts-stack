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
  snapshotJournalArchiveReaderRequestId,
  parseSnapshotJournalArchiveReaderRequest,
  validateSnapshotJournalArchiveReaderRequest
} from './SnapshotJournalArchiveReaderRequest'
import { captureSnapshotJournalArchiveSource } from './captureSnapshotJournalArchiveSource'
import { parseSnapshotJournalArchiveBinding } from './SnapshotJournalArchiveBinding'
import { snapshotJournalArchiveEncoding } from './SnapshotJournalArchivePacket'

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

test('journal reader request has an independent domain and binds every lower-bound coordinate and lease field', () => {
  const fields = {
      version: 3 as const,
      nonce: '11'.repeat(32),
      notAfter: 1900000000000,
      maxBytes: 524288,
      position: { binding: '22'.repeat(32), highWater: '9007199254740993' }
    },
    expected = createHash('sha256')
      .update(
        JSON.stringify([
          'wallet-journal-reader-request/1',
          3,
          fields.nonce,
          fields.notAfter,
          fields.maxBytes,
          [fields.position.binding, fields.position.highWater]
        ])
      )
      .digest('hex'),
    request = { ...fields, requestId: snapshotJournalArchiveReaderRequestId(fields) }
  expect(request.requestId).toBe(expected)
  expect(parseSnapshotJournalArchiveReaderRequest(request)).toEqual(request)
  for (const changed of [
    { ...fields, nonce: '33'.repeat(32) },
    { ...fields, notAfter: fields.notAfter + 1 },
    { ...fields, maxBytes: fields.maxBytes + 1 },
    { ...fields, position: null },
    { ...fields, position: { ...fields.position, binding: '44'.repeat(32) } },
    { ...fields, position: { ...fields.position, highWater: '9007199254740994' } }
  ]) {
    expect(snapshotJournalArchiveReaderRequestId(changed)).not.toBe(expected)
    expect(() => parseSnapshotJournalArchiveReaderRequest({ ...changed, requestId: expected })).toThrow()
  }
  expect(() => parseSnapshotArchiveReaderRequest(request)).toThrow()
  expect(() => parseSnapshotJournalArchiveReaderRequest({ ...request, version: 2 })).toThrow()
  expect(() => validateSnapshotJournalArchiveReaderRequest(request, fields.notAfter)).toThrow()
  expect(validateSnapshotJournalArchiveReaderRequest(request, fields.notAfter - 1)).toEqual(request)
  const getter = jest.fn(() => fields.position)
  expect(() =>
    parseSnapshotJournalArchiveReaderRequest(
      Object.defineProperty({ ...request }, 'position', { get: getter, enumerable: true })
    )
  ).toThrow()
  expect(getter).not.toHaveBeenCalled()
})

test('server-offered journal tuple claims once across replicas; absent, changed and foreign tuples never reserve a source', async () => {
  const f = await fixture(),
    first = new KnexSnapshotArchiveRequestStore(f.storage.knex),
    second = new KnexSnapshotArchiveRequestStore(f.storage.knex),
    position = { binding: '55'.repeat(32), highWater: '9007199254740993' },
    issued = await first.offerJournal(identityKey, options, position)
  if (issued === undefined) throw new Error('Actual journal offer was not issued')
  const request = issued.request,
    claimed = await first.claimJournalReader(identityKey, request)
  expect(claimed.owner).toBeDefined()
  expect((await second.claimJournalReader(identityKey, request)).owner).toBeUndefined()
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
    archives: 1,
    reservedBytes: options.maxBytes
  })
  await expect(second.claimJournalReader(foreignKey, request)).rejects.toThrow('unavailable')
  const changedFields = {
      version: 3 as const,
      nonce: request.nonce,
      notAfter: request.notAfter,
      maxBytes: request.maxBytes,
      position: { ...position, highWater: '9007199254740994' }
    },
    changed = { ...changedFields, requestId: snapshotJournalArchiveReaderRequestId(changedFields) }
  await expect(second.claimJournalReader(identityKey, changed)).rejects.toThrow('unavailable')
  await expect(second.claimReader(identityKey, request)).rejects.toThrow()
  await second.markJournalReaderCancellation(identityKey, request)
  await second.close(identityKey, request.requestId)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  await expect(first.claimJournalReader(identityKey, request)).rejects.toThrow('unavailable')
})

test('actual guarded source capture publishes a durable journal receipt only after closure and survives controller replacement', async () => {
  const f = await fixture(true),
    first = new KnexSnapshotArchiveRequestStore(f.storage.knex, true, true),
    second = new KnexSnapshotArchiveRequestStore(f.storage.knex, true, true),
    issued = await first.offerJournal(identityKey, options)
  if (issued === undefined) throw new Error('Actual guarded offer was not issued')
  const request = issued.request,
    claimed = await first.claimJournalReader(identityKey, request)
  if (claimed.owner === undefined) throw new Error('Actual guarded owner was not claimed')
  const owner = claimed.owner,
    opened = await f.storage.openSnapshotSyncContentSource(identityKey, options, owner)
  if (opened === undefined) throw new Error('Actual guarded journal source unavailable')
  const source = f.own(opened),
    manifest = await captureSnapshotJournalArchiveSource(source, {
      beginJournal: binding => first.beginJournal(owner, binding),
      appendJournal: (writer, page) => first.appendJournal(owner, writer, page),
      sealJournal: async writer => {
        await first.sourceClosed(owner)
        return await first.sealJournal(owner, writer)
      },
      close: async () => {
        await first.sourceClosed(owner)
        await first.close(identityKey, request.requestId)
      }
    })
  expect(source.isOpen).toBe(false)
  expect(await f.storage.knex('snapshot_archive_owners')).toHaveLength(0)
  expect(await second.journalStatus(identityKey, request)).toEqual({
    version: 1,
    requestId: request.requestId,
    expiresAt: request.notAfter,
    state: 'ready',
    archiveId: manifest.archiveId,
    digest: manifest.digest
  })
  expect((await f.store.journalDirectory(identityKey, manifest.archiveId)).encoding).toBe(
    snapshotJournalArchiveEncoding
  )
  expect((await second.claimJournalReader(identityKey, request)).owner).toBeUndefined()
  await second.markJournalReaderCancellation(identityKey, request)
  await second.close(identityKey, request.requestId)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
  expect(await f.storage.knex('snapshot_archive_requests').where('requestId', request.requestId)).toHaveLength(0)
  await expect(first.claimJournalReader(identityKey, request)).rejects.toThrow('unavailable')
})

test('a journal offer cannot become a row capture or silently adopt a different requested lower bound', async () => {
  const f = await fixture(),
    requests = new KnexSnapshotArchiveRequestStore(f.storage.knex, true, true),
    issued = await requests.offerJournal(identityKey, options)
  if (issued === undefined) throw new Error('Actual journal offer missing')
  const claimed = await requests.claimJournalReader(identityKey, issued.request)
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
    const mismatched = parseSnapshotJournalArchiveBinding({
      version: 3,
      encoding: snapshotJournalArchiveEncoding,
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
    await expect(requests.beginJournal(owner, mismatched)).rejects.toThrow('unavailable')
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
