import { StorageClient } from '../../remoting/StorageClient'
import { StorageClient as StorageMobile } from '../../remoting/StorageMobile'
import { snapshotHttpFixture, gate } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import { runInSeries } from '../../../utility/runInSeries'
import { SnapshotCancelledError } from '../SnapshotCancelledError'
import { snapshotJournalArchiveEncoding } from './SnapshotJournalArchivePacket'
import { snapshotJournalArchiveStreams } from './SnapshotJournalArchiveBinding'
import type { RemoteSnapshotJournalArchive } from './openRemoteSnapshotJournalArchive'
import type { KnexSnapshotArchiveRpc } from '../archive/KnexSnapshotArchiveRpc'
import { snapshotJournalArchiveReaderRequestId } from './SnapshotJournalArchiveReaderRequest'
import { PrivateKey } from '@bsv/sdk'

afterEach(() => jest.restoreAllMocks())

test.each([StorageClient, StorageMobile])(
  'authenticated %p opens a bounded journal artifact and retries the same frame without a new capture',
  async Client => {
    const fixture = await snapshotHttpFixture()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const { url } = await fixture.serve()
      const original = await fixture.storage.findOrInsertTxLabel(
        (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
        'HTTP journal label'
      )
      const client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      expect((await client.makeAvailable()).snapshotJournalArchive?.encoding).toBe(snapshotJournalArchiveEncoding)
      archive = await client.openSnapshotJournalArchive(fixture.identityKey)
      if (archive === undefined) throw new Error('Actual authenticated journal artifact unavailable')
      expect(archive.manifest.binding.version).toBe(3)
      expect(archive.manifest.binding.journal.bootstrap).toBe(true)
      expect(Reflect.get(archive, 'withCommitFence')).toBeUndefined()
      expect(Reflect.get(archive, 'readPage')).toBeUndefined()
      const seen: string[] = [],
        labels: unknown[] = [],
        identities: number[] = []
      await runInSeries(
        Array.from({ length: archive.frameCount }, (_, i) => i),
        async ordinal => {
          const frame = await archive!.readFrame(ordinal, async (_digest, _index, batch) => {
            for (const identity of batch.values()) if (identity.tableId === 3) identities.push(identity.incomingId)
            // This await is a real SQL read, rather than a fabricated writer grant.
            expect(
              await fixture.storage.knex('users').where({ identityKey: fixture.identityKey }).first()
            ).toBeDefined()
          })
          seen.push(frame.stream + '/' + frame.tableId)
          labels.push(
            ...frame.page.changes.flatMap(change =>
              change.present && change.row.label !== undefined ? [change.row.label] : []
            )
          )
          const retried = await archive!.readFrame(ordinal, async () => {
            await fixture.storage.knex('users').first()
          })
          expect(retried).toEqual(frame)
        }
      )
      expect([...new Set(seen)]).toEqual(snapshotJournalArchiveStreams.map(s => s.stream + '/' + s.tableId))
      expect(labels).toContain('HTTP journal label')
      expect(identities).toContain(original.txLabelId)
      expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(1)
      const binding = archive.manifest.binding
      Reflect.set(binding.journal.receipt, 'highWater', '0')
      expect(archive.manifest.binding.journal.receipt.highWater).not.toBe('0')
      await expect(
        archive.readFrame(-1, async () => {
          await fixture.storage.knex('users').first()
        })
      ).rejects.toThrow('ordinal')
      await archive.close()
      await archive.closed
      const previous = archive.manifest.binding.journal.receipt
      await fixture.storage.knex('tx_labels').where('txLabelId', original.txLabelId).delete()
      await fixture.storage.findOrInsertTxLabel(
        (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
        'HTTP incremental label'
      )
      archive = await client.openSnapshotJournalArchive(fixture.identityKey, {
        binding: previous.binding,
        highWater: previous.highWater
      })
      if (archive === undefined) throw new Error('Actual incremental HTTP journal artifact unavailable')
      expect(archive.manifest.binding.journal).toMatchObject({ bootstrap: false, low: previous.highWater })
      const incremental = []
      for (let ordinal = 0; ordinal < archive.frameCount; ordinal++) {
        const frame = await archive.readFrame(ordinal, async () => {
          await fixture.storage.knex('users').first()
        })
        if (frame.stream === 'scope' && frame.tableId === 3) incremental.push(...frame.page.changes)
      }
      expect(incremental).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ present: false, metadata: expect.objectContaining({ id1: original.txLabelId }) }),
          expect.objectContaining({ present: true, row: expect.objectContaining({ label: 'HTTP incremental label' }) })
        ])
      )
      expect(incremental).toHaveLength(2)
      expect(incremental.every(change => BigInt(change.metadata.revision) > BigInt(previous.highWater))).toBe(true)
      await archive.close()

      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      await archive?.close()
      await fixture.close()
    }
  }
)

test.each([StorageClient, StorageMobile])(
  'authenticated %p keeps its exact journal owner until an in-flight identity consumer drains',
  async Client => {
    const fixture = await snapshotHttpFixture(),
      entered = gate(),
      release = gate()
    let archive: RemoteSnapshotJournalArchive | undefined,
      reading: Promise<unknown> | undefined,
      closing: Promise<void> | undefined
    try {
      const { url } = await fixture.serve(),
        client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      const controller = new AbortController()
      archive = await client.openSnapshotJournalArchive(fixture.identityKey, undefined, { signal: controller.signal })
      if (archive === undefined) throw new Error('Actual authenticated journal artifact unavailable')
      reading = archive.readFrame(0, async () => {
        entered.resolve()
        await release.promise
      })
      void reading.catch(() => undefined)
      await Promise.race([
        entered.promise,
        reading.then(() => {
          throw new Error('Identity consumer was not invoked')
        })
      ])
      controller.abort()
      closing = archive.close()
      expect(archive.isOpen).toBe(false)
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({ archives: 1 })
      release.resolve()
      await expect(reading).rejects.toBeInstanceOf(SnapshotCancelledError)
      await closing
      expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
        archives: 0,
        reservedBytes: 0
      })
    } finally {
      release.resolve()
      await Promise.allSettled([reading, closing])
      await archive?.close()
      await fixture.close()
    }
  }
)

test('journal HTTP authenticates before source work, rejects unissued DATA, and honors mixed-version disable', async () => {
  const fixture = await snapshotHttpFixture()
  try {
    const { server, url } = await fixture.serve(),
      client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    await client.makeAvailable()
    const open = jest.spyOn(fixture.storage, 'openSnapshotSyncContentSource'),
      rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc
    const fields = {
        version: 3 as const,
        nonce: 'a'.repeat(64),
        notAfter: Date.now() + 300000,
        maxBytes: 524288,
        position: null
      },
      request = { ...fields, requestId: snapshotJournalArchiveReaderRequestId(fields) }
    const call = Reflect.get(client, 'snapshotRpcCall').bind(client)
    await expect(
      call('admitSnapshotJournalArchive', [{ version: 1, identityKey: fixture.identityKey, request }])
    ).rejects.toThrow()
    await expect(
      rpc.dispatch(
        'getSnapshotJournalArchiveReaderOffer',
        [
          {
            version: 1,
            identityKey: PrivateKey.fromRandom().toPublicKey().toString(),
            options: { lifetimeMs: 300000, maxBytes: 524288 },
            position: null
          }
        ],
        fixture.identityKey
      )
    ).rejects.toThrow('authentication')
    expect(open).not.toHaveBeenCalled()
    const disabled = new StorageClient(fixture.wallet, url, {
      serverIdentityKey: fixture.serverIdentityKey,
      snapshotArchives: false
    })
    expect(await disabled.openSnapshotJournalArchive(fixture.identityKey)).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
    expect(await fixture.storage.knex('snapshot_archive_requests')).toHaveLength(0)
  } finally {
    await fixture.close()
  }
})

test('actual HTTP journal packet corruption cannot reach an identity consumer and still drains its owner', async () => {
  const fixture = await snapshotHttpFixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const { server, url } = await fixture.serve(),
      client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    archive = await client.openSnapshotJournalArchive(fixture.identityKey)
    if (archive === undefined) throw new Error('Actual journal artifact unavailable')
    const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc,
      dispatch = rpc.dispatch.bind(rpc)
    jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identityKey) => {
      const result = await dispatch(method, params, identityKey)
      if (method !== 'readSnapshotJournalArchivePage') return result
      const bytes = new Uint8Array(Reflect.get(result as object, 'bytes'))
      bytes[bytes.length - 1] ^= 1
      return { ...(result as object), bytes }
    })
    const capture = jest.fn(async () => {
      await fixture.storage.knex('users').first()
    })
    await expect(archive.readFrame(0, capture)).rejects.toThrow()
    expect(capture).not.toHaveBeenCalled()
    await archive.close()
    expect(await fixture.storage.knex('snapshot_archive_capacity').first()).toMatchObject({
      archives: 0,
      reservedBytes: 0
    })
  } finally {
    await archive?.close()
    await fixture.close()
  }
})
