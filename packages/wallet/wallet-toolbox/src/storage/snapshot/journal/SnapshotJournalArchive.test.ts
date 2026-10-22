import { verifySnapshotJournalArchiveDirectory } from './SnapshotJournalArchiveDirectory'
import {
  snapshotJournalArchiveFixture,
  journalArchiveIdentity as identityKey,
  journalArchiveForeign as foreignKey
} from '../../../../test/utils/snapshotJournalArchiveFixture'
import type { KnexSnapshotArchiveStore } from '../archive/KnexSnapshotArchiveStore'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import { captureSnapshotJournalArchiveSource } from './captureSnapshotJournalArchiveSource'
import { decodeSnapshotJournalArchivePacket, snapshotJournalArchiveEncoding } from './SnapshotJournalArchivePacket'
import { snapshotJournalArchiveStreams, type SnapshotJournalArchiveManifest } from './SnapshotJournalArchiveBinding'
import * as Backend from './SnapshotJournalCaptureBackend'
import { runInSeries } from '../../../utility/runInSeries'

const fixtures: Array<Awaited<ReturnType<typeof snapshotJournalArchiveFixture>>> = []
async function fixture(fullClosure = false) {
  const value = await snapshotJournalArchiveFixture(fullClosure)
  fixtures.push(value)
  return value
}
async function packets(store: KnexSnapshotArchiveStore, manifest: SnapshotJournalArchiveManifest) {
  const directory = await store.journalDirectory(identityKey, manifest.archiveId)
  expect(directory.encoding).toBe(snapshotJournalArchiveEncoding)
  const result: Array<{ streamIndex: number; packet: ReturnType<typeof decodeSnapshotJournalArchivePacket> }> = []
  let streamIndex = 0
  await runInSeries(directory.receipts, async receipt => {
    const stream = snapshotJournalArchiveStreams[streamIndex]
    expect(receipt.table).toBe(stream.table)
    const page = await store.readJournal(identityKey, manifest.archiveId, receipt.sequence),
      packet = decodeSnapshotJournalArchivePacket(
        page.bytes,
        { stream: stream.stream, tableId: stream.tableId },
        manifest.binding.journal.receipt.highWater
      )
    expect(page.rows).toBe(packet.kind === 'frame' ? packet.page.changes.length : 0)
    expect(page.done).toBe(packet.kind === 'frame' && packet.page.complete)
    result.push({ streamIndex, packet })
    if (page.done) streamIndex++
  })
  expect(streamIndex).toBe(15)
  return result
}
afterEach(async () => {
  jest.restoreAllMocks()
  await runInSeries(fixtures.splice(0), fixture => fixture.close())
})

test('actual full journal capture streams fifteen sealed streams, exact identities and one profile; row archive APIs refuse it', async () => {
  const f = await fixture(true),
    source = await f.open(),
    originalReceipt = source.receipt,
    originalBinding = source.receiptBinding,
    originalPrimary = source.primary
  source.receipt.highWater = '0' as typeof source.receipt.highWater
  source.receiptBinding.storageIdentity = 'changed public DATA'
  source.primary.activeStorage = 'changed public DATA'
  expect(source.receipt).toEqual(originalReceipt)
  expect(source.receiptBinding).toEqual(originalBinding)
  expect(source.primary).toEqual(originalPrimary)
  const manifest = await captureSnapshotJournalArchiveSource(source, f.store)
  expect(source.isOpen).toBe(false)
  expect(manifest.binding.journal).toMatchObject({
    bootstrap: true,
    low: '0',
    source: originalBinding,
    receipt: originalReceipt
  })
  const entries = await packets(f.store, manifest),
    frames = entries
      .filter(x => x.packet.kind === 'frame')
      .flatMap(x => (x.packet.kind === 'frame' ? x.packet.page.changes : [])),
    rows = frames.flatMap(x => (x.present ? [x.row] : []))
  const populated = entries.flatMap(entry =>
    entry.packet.kind === 'frame' && entry.packet.page.changes.some(change => change.present)
      ? [entry.packet.page.table]
      : []
  )
  expect([...new Set(populated)].sort()).toEqual(
    [...new Set(snapshotJournalArchiveStreams.map(stream => stream.table))].sort()
  )
  const proof = entries
    .flatMap(entry =>
      entry.packet.kind === 'frame' && entry.packet.page.table === 'provenTxs'
        ? entry.packet.page.changes.flatMap(change => (change.present ? [change.row] : []))
        : []
    )
    .find(row => row.provenTxId === 1)
  expect(proof?.merklePath).toEqual(Uint8Array.of(1, 0, 255))
  expect(rows.filter(x => x.label === 'original label')).toHaveLength(1)
  expect(rows.some(x => x.label === 'foreign label')).toBe(false)
  expect(rows.every(x => !Object.hasOwn(x, 'userId') || Number(x.userId) === f.user.userId)).toBe(true)
  expect(
    entries.some(entry => {
      const groups =
        entry.packet.kind === 'identities'
          ? [entry.packet]
          : entry.packet.kind === 'identity-groups'
            ? entry.packet.groups
            : []
      return groups.some(group =>
        [...group.identities.values()].some(i => i.tableId === 3 && i.incomingId === f.original.txLabelId)
      )
    })
  ).toBe(true)
  await expect(f.store.inspect(identityKey, manifest.archiveId)).rejects.toThrow('unavailable')
  await expect(f.store.directory(identityKey, manifest.archiveId)).rejects.toThrow('unavailable')
  await expect(f.store.read(identityKey, manifest.archiveId, 0)).rejects.toThrow('unavailable')
  const actual = await f.store.readJournal(identityKey, manifest.archiveId, 0),
    saved = actual.bytes.slice()
  actual.bytes.fill(0)
  expect((await f.store.readJournal(identityKey, manifest.archiveId, 0)).bytes).toEqual(saved)
  await expect(f.store.inspectJournal(foreignKey, manifest.archiveId)).rejects.toThrow('unavailable')
  await f.store.close(identityKey, manifest.archiveId)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('next actual artifact captures retained hard-delete tombstones and new rows above the previous high-water', async () => {
  const f = await fixture(),
    first = await captureSnapshotJournalArchiveSource(await f.open(), f.store)
  await f.store.close(identityKey, first.archiveId)
  await f.storage.knex('tx_labels').where('txLabelId', f.original.txLabelId).delete()
  const added = await f.storage.findOrInsertTxLabel(f.user.userId, 'next label')
  await f.storage.findOrInsertTxLabel(f.foreign.userId, 'another foreign label')
  const second = await captureSnapshotJournalArchiveSource(await f.open(), f.store, {
    binding: first.binding.journal.receipt.binding,
    highWater: first.binding.journal.receipt.highWater
  })
  expect(second.binding.journal).toMatchObject({ bootstrap: false, low: first.binding.journal.receipt.highWater })
  const entries = await packets(f.store, second),
    changes = entries
      .filter(x => x.streamIndex === 3)
      .flatMap(x => (x.packet.kind === 'frame' ? x.packet.page.changes : []))
  expect(changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ present: false, metadata: expect.objectContaining({ id1: f.original.txLabelId }) }),
      expect.objectContaining({
        present: true,
        row: expect.objectContaining({ txLabelId: added.txLabelId, label: 'next label' })
      })
    ])
  )
  expect(changes).toHaveLength(2)
  expect(changes.every(x => BigInt(x.metadata.revision) > BigInt(first.binding.journal.receipt.highWater))).toBe(true)
})

test('malformed and matching future positions close the real source without reserving artifact capacity', async () => {
  const f = await fixture(),
    malformed = await f.open()
  await expect(
    captureSnapshotJournalArchiveSource(malformed, f.store, { binding: 'invalid', highWater: '0' })
  ).rejects.toThrow()
  expect(malformed.isOpen).toBe(false)
  const future = await f.open()
  await expect(
    captureSnapshotJournalArchiveSource(future, f.store, {
      binding: future.receipt.binding,
      highWater: (BigInt(future.receipt.highWater) + 1n).toString()
    })
  ).rejects.toThrow('exceeds')
  expect(future.isOpen).toBe(false)
  expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 0, reservedBytes: 0 })
})

test('actual physical reader close must finish before ready publication; foreground SQL remains available', async () => {
  const f = await fixture(),
    source = await f.open(),
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
    const rows: Array<{ query_only: number }> = await owner.raw('PRAGMA query_only').connection(connection)
    if (rows[0].query_only === 1 && !held) {
      held = true
      entered()
      await gate
    }
    await original(owner, connection)
  })
  const capture = captureSnapshotJournalArchiveSource(source, f.store)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      closing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Actual reader close not reached')), 5000)
      })
    ])
    expect(await f.storage.knex('snapshot_archives').first()).toMatchObject({ state: 'building' })
    expect(await f.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 1,
      reservedBytes: snapshotArchiveLimits.archiveBytes
    })
    await f.storage.findOrInsertTxLabel(f.user.userId, 'foreground while closing')
    release()
    const manifest = await capture
    expect(await f.store.inspectJournal(identityKey, manifest.archiveId)).toMatchObject({ digest: manifest.digest })
    const entries = await packets(f.store, manifest)
    expect(
      entries.some(
        x =>
          x.packet.kind === 'frame' &&
          x.packet.page.changes.some(c => c.present && c.row.label === 'foreground while closing')
      )
    ).toBe(false)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    release()
    await capture.catch(() => undefined)
  }
})

test('small prefixes coalesce within a fixed packet bound and the directory indexes real frame ordinals', async () => {
  const f = await fixture()
  const when = new Date('2026-01-01T00:00:00.000Z')
  await f.storage.knex('tx_labels').insert(
    Array.from({ length: 64 }, (_, index) => ({
      userId: f.user.userId,
      label: 'batched label ' + index,
      isDeleted: false,
      created_at: when,
      updated_at: when
    }))
  )
  const source = await f.open(),
    observer = jest.spyOn(source, 'readArchiveDeltaPage'),
    manifest = await captureSnapshotJournalArchiveSource(source, f.store),
    entries = await packets(f.store, manifest)
  expect(observer).toHaveBeenCalled()
  expect(manifest.pages).toBeLessThan(45)
  const verified = verifySnapshotJournalArchiveDirectory(
    await f.store.journalDirectory(identityKey, manifest.archiveId),
    {
      identityKey,
      chain: 'test',
      sourceStorageIdentityKey: 'source',
      sourceSchema: manifest.binding.sourceSchema,
      archiveId: manifest.archiveId,
      digest: manifest.digest,
      expiresAt: manifest.expiresAt
    },
    Date.now()
  )
  expect(verified.frames).toHaveLength(entries.filter(entry => entry.packet.kind === 'frame').length)
  for (const [ordinal, frame] of verified.frames.entries()) {
    expect(verified.receipts[frame.sequence].packet).toBe('frame')
    expect(frame.firstPrefix).toBe(ordinal === 0 ? 0 : verified.frames[ordinal - 1].sequence + 1)
  }

  const groups = entries.flatMap(entry => (entry.packet.kind === 'identity-groups' ? [entry.packet.groups] : []))
  expect(groups.some(batch => batch.length > 1)).toBe(true)
  expect(groups.every(batch => batch.reduce((count, group) => count + group.identities.size, 0) <= 128)).toBe(true)
  expect(
    entries
      .flatMap(entry => (entry.packet.kind === 'frame' ? entry.packet.page.changes : []))
      .filter(
        change =>
          change.present && typeof change.row.label === 'string' && change.row.label.startsWith('batched label ')
      )
  ).toHaveLength(64)
})

test('artifact DATA observers cannot borrow the local reentrant SQL writer fence', async () => {
  const f = await fixture(),
    source = await f.open(),
    commit = jest.fn(async () => {
      await f.storage.knex.raw('SELECT 1')
      return 'must not run'
    })
  const denied: unknown[] = []
  try {
    if (source.readArchiveDeltaPage === undefined) throw new Error('Actual bounded artifact producer unavailable')
    await source.readArchiveDeltaPage(
      {
        stream: 'scope',
        tableId: 3,
        low: source.receipt.floor,
        bootstrap: true,
        maximumRows: 8,
        maximumBytes: 262144
      },
      () =>
        source.withCommitFence(commit).then(
          () => undefined,
          error => {
            denied.push(error)
          }
        )
    )
    expect(denied).toHaveLength(1)
    expect(commit).not.toHaveBeenCalled()
    expect(source.isOpen).toBe(true)
  } finally {
    await source.close()
    await source.closed
  }
})

test('journal directory binds exact metadata, packet kinds, source scope and all fifteen stream completions', async () => {
  const f = await fixture(),
    manifest = await captureSnapshotJournalArchiveSource(await f.open(), f.store),
    directory = await f.store.journalDirectory(identityKey, manifest.archiveId),
    expected = {
      identityKey,
      chain: 'test' as const,
      sourceStorageIdentityKey: 'source',
      sourceSchema: manifest.binding.sourceSchema,
      archiveId: manifest.archiveId,
      digest: manifest.digest,
      expiresAt: manifest.expiresAt
    }
  expect(verifySnapshotJournalArchiveDirectory(directory, expected, Date.now()).manifest.digest).toBe(manifest.digest)
  const mutations = [
    (value: typeof directory) => {
      value.bindingJson = ' ' + value.bindingJson
    },
    (value: typeof directory) => {
      value.receipts[0].packet = value.receipts[0].packet === 'frame' ? 'identities' : 'frame'
    },
    (value: typeof directory) => {
      value.receipts[0].stream = 'physical'
    },
    (value: typeof directory) => {
      value.receipts.pop()
      value.pages--
    },
    (value: typeof directory) => {
      value.rows++
    }
  ]
  for (const change of mutations) {
    const copy = structuredClone(directory)
    change(copy)
    expect(() => verifySnapshotJournalArchiveDirectory(copy, expected, Date.now())).toThrow()
  }
  expect(() =>
    verifySnapshotJournalArchiveDirectory(directory, { ...expected, identityKey: foreignKey }, Date.now())
  ).toThrow()
  expect(() => verifySnapshotJournalArchiveDirectory(directory, { ...expected, chain: 'main' }, Date.now())).toThrow()
  expect(() => verifySnapshotJournalArchiveDirectory(directory, expected, manifest.expiresAt)).toThrow()
})
