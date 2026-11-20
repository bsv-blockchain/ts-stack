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
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'

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

test.each(['legacy', 'paired-frame', 'paired-prefix'] as const)(
  'actual HTTP %s corruption cannot reach an identity consumer and still drains its owner',
  async mode => {
    const fixture = await snapshotHttpFixture()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const { server, url } = await fixture.serve()
      if (mode === 'legacy') {
        const target = server as unknown as { snapshotArchiveSettings: () => Promise<Record<string, unknown>> }
        const original = target.snapshotArchiveSettings.bind(target)
        jest.spyOn(target, 'snapshotArchiveSettings').mockImplementation(async () => {
          const settings = await original()
          delete settings.snapshotJournalArchivePairVersion
          return settings
        })
      }
      const client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      archive = await client.openSnapshotJournalArchive(fixture.identityKey)
      if (archive === undefined) throw new Error('Actual journal artifact unavailable')
      const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc,
        dispatch = rpc.dispatch.bind(rpc)
      let corrupted = false
      jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identityKey) => {
        const result = await dispatch(method, params, identityKey)
        if (mode === 'legacy' && method === 'readSnapshotJournalArchivePage') {
          const bytes = new Uint8Array(Reflect.get(result as object, 'bytes'))
          bytes[bytes.length - 1] ^= 1
          corrupted = true
          return { ...(result as object), bytes }
        }
        if (mode !== 'legacy' && method === 'readSnapshotJournalArchivePair') {
          const pages = Reflect.get(result as object, 'pages') as Array<Record<string, unknown>>
          const index = mode === 'paired-frame' ? 0 : 1
          const bytes = new Uint8Array(pages[index].bytes as Uint8Array)
          bytes[bytes.length - 1] ^= 1
          corrupted = true
          return { ...(result as object), pages: pages.map((page, i) => (i === index ? { ...page, bytes } : page)) }
        }
        return result
      })
      const capture = jest.fn(async () => {
        await fixture.storage.knex('users').first()
      })
      await expect(archive.readFrame(0, capture)).rejects.toThrow()
      expect(corrupted).toBe(true)
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
  }
)

test.each([StorageClient, StorageMobile])('negotiated %p reads a frame and prefix in one RPC', async Client => {
  const fixture = await snapshotHttpFixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const { server, url } = await fixture.serve()
    const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc
    const calls = jest.spyOn(rpc, 'dispatch')
    const client = new Client(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    expect((await client.makeAvailable()).snapshotJournalArchivePairVersion).toBe(1)
    archive = await client.openSnapshotJournalArchive(fixture.identityKey)
    if (archive === undefined) throw new Error('Journal artifact unavailable')
    calls.mockClear()
    const capture = jest.fn(async () => {})
    const frame = await archive.readFrame(0, capture)
    expect(frame.page.changes.length).toBeGreaterThan(0)
    expect(capture).toHaveBeenCalled()
    expect(calls.mock.calls.map(call => call[0])).toEqual(['readSnapshotJournalArchivePair'])
  } finally {
    await archive?.close()
    await fixture.close()
  }
})

test('missing pair negotiation retains the original page RPCs', async () => {
  const fixture = await snapshotHttpFixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const { server, url } = await fixture.serve()
    const settings = server as unknown as { snapshotArchiveSettings: () => Promise<Record<string, unknown>> }
    const original = settings.snapshotArchiveSettings.bind(settings)
    jest.spyOn(settings, 'snapshotArchiveSettings').mockImplementation(async () => {
      const value = await original()
      delete value.snapshotJournalArchivePairVersion
      return value
    })
    const calls = jest.spyOn(Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc, 'dispatch')
    const client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    expect((await client.makeAvailable()).snapshotJournalArchivePairVersion).toBeUndefined()
    archive = await client.openSnapshotJournalArchive(fixture.identityKey)
    if (archive === undefined) throw new Error('Journal artifact unavailable')
    calls.mockClear()
    await archive.readFrame(0, async () => {})
    expect(calls.mock.calls.length).toBeGreaterThan(1)
    expect(calls.mock.calls.every(call => call[0] === 'readSnapshotJournalArchivePage')).toBe(true)
  } finally {
    await archive?.close()
    await fixture.close()
  }
})

test('an explicit bounded-pair fallback uses ordinary verified page reads', async () => {
  const fixture = await snapshotHttpFixture()
  let archive: RemoteSnapshotJournalArchive | undefined
  try {
    const { server, url } = await fixture.serve()
    const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc
    const original = rpc.dispatch.bind(rpc)
    const calls = jest
      .spyOn(rpc, 'dispatch')
      .mockImplementation(async (method, params, identity) =>
        method === 'readSnapshotJournalArchivePair'
          ? { version: 1, outcome: 'individual' }
          : await original(method, params, identity)
      )
    const client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
    await client.makeAvailable()
    archive = await client.openSnapshotJournalArchive(fixture.identityKey)
    if (archive === undefined) throw new Error('Journal artifact unavailable')
    calls.mockClear()
    const capture = jest.fn(async () => {})
    expect((await archive.readFrame(0, capture)).page.changes.length).toBeGreaterThan(0)
    expect(capture).toHaveBeenCalled()
    expect(calls.mock.calls.map(call => call[0])).toEqual([
      'readSnapshotJournalArchivePair',
      'readSnapshotJournalArchivePage',
      'readSnapshotJournalArchivePage'
    ])
  } finally {
    await archive?.close()
    await fixture.close()
  }
})

test.each(['missing page', 'extra page', 'extra field', 'wrong version', 'swapped pages', 'combined budget'])(
  'malformed pair %s refuses before identity consumption',
  async fault => {
    const fixture = await snapshotHttpFixture()
    let archive: RemoteSnapshotJournalArchive | undefined
    try {
      const { server, url } = await fixture.serve()
      const rpc = Reflect.get(server, 'snapshotArchives') as KnexSnapshotArchiveRpc
      const original = rpc.dispatch.bind(rpc)
      jest.spyOn(rpc, 'dispatch').mockImplementation(async (method, params, identity) => {
        const result = await original(method, params, identity)
        if (method !== 'readSnapshotJournalArchivePair') return result
        const value = result as { version: number; outcome: string; pages: unknown[] }
        if (fault === 'missing page') return { ...value, pages: value.pages.slice(0, 1) }
        if (fault === 'extra page') return { ...value, pages: [...value.pages, value.pages[0]] }
        if (fault === 'extra field') return { ...value, unexpected: true }
        if (fault === 'wrong version') return { ...value, version: 2 }
        if (fault === 'combined budget')
          return {
            ...value,
            pages: value.pages.map(page => ({
              ...(page as object),
              bytes: new Uint8Array(snapshotArchiveLimits.pageBytes / 2 + 1)
            }))
          }
        return { ...value, pages: [...value.pages].reverse() }
      })
      const client = new StorageClient(fixture.wallet, url, { serverIdentityKey: fixture.serverIdentityKey })
      archive = await client.openSnapshotJournalArchive(fixture.identityKey)
      if (archive === undefined) throw new Error('Journal artifact unavailable')
      const capture = jest.fn(async () => {})
      await expect(archive.readFrame(0, capture)).rejects.toThrow(
        fault === 'combined budget' ? 'original page budget' : undefined
      )
      expect(capture).not.toHaveBeenCalled()
    } finally {
      await archive?.close()
      await fixture.close()
    }
  }
)
