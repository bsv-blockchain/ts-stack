import { createHash } from 'node:crypto'
import {
  snapshotJournalArchiveFixture,
  journalArchiveIdentity as identityKey
} from '../../../../test/utils/snapshotJournalArchiveFixture'
import { captureSnapshotJournalFieldArchiveSource } from './captureSnapshotJournalFieldArchiveSource'
import {
  verifySnapshotJournalFieldArchiveDirectory,
  verifySnapshotJournalArchiveDirectory
} from './SnapshotJournalArchiveDirectory'
import {
  encodeSnapshotJournalFieldFrame,
  decodeSnapshotJournalFieldFrame,
  decodeSnapshotJournalDeltaFrame
} from './SnapshotJournalDeltaFrame'
import {
  decodeSnapshotJournalArchivePacket,
  decodeSnapshotJournalFieldArchivePacket,
  encodeSnapshotJournalFieldArchiveContent,
  snapshotJournalFieldArchiveEncoding
} from './SnapshotJournalArchivePacket'
import { snapshotJournalArchiveStreams } from './SnapshotJournalArchiveBinding'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import type { SnapshotJournalHashedFieldPage } from './SnapshotJournalFieldTypes'

const fixtures: Array<Awaited<ReturnType<typeof snapshotJournalArchiveFixture>>> = []
async function fixture(full = false) {
  const result = await snapshotJournalArchiveFixture(full)
  fixtures.push(result)
  return result
}
afterEach(async () => {
  jest.restoreAllMocks()
  for (const value of fixtures.splice(0)) await value.close()
})
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
function gate() {
  let resolve!: () => void
  return {
    promise: new Promise<void>(done => {
      resolve = done
    }),
    resolve: () => resolve()
  }
}

function smallPage(): SnapshotJournalHashedFieldPage {
  const metadata = { revision: snapshotJournalRevision('7'), id1: 1, id2: 0, exactText: '', present: true }
  return {
    table: 'transactions',
    examined: 1,
    metadataBytes: 1024,
    fieldBytes: 2097153,
    complete: true,
    after: { revision: metadata.revision, id1: 1, id2: 0, exactText: '' },
    changes: [
      {
        metadata,
        present: true,
        row: { transactionId: 1, userId: 1, description: null },
        fields: { rawTx: { kind: 'binary', bytes: 2097153, sha256: 'a'.repeat(64) } }
      }
    ]
  }
}
test('field metadata is separate from version-one SQL rows and malformed descriptors or chunks refuse', () => {
  const context = { stream: 'scope' as const, tableId: 0 },
    page = smallPage(),
    bytes = encodeSnapshotJournalFieldFrame(page, context),
    decoded = decodeSnapshotJournalFieldFrame(bytes, context)
  expect(bytes.length).toBeLessThan(4096)
  expect(decoded).toEqual(page)
  expect(() => decodeSnapshotJournalDeltaFrame(bytes, context)).toThrow()
  expect(() => decodeSnapshotJournalFieldFrame(bytes, { ...context, tableId: 1 })).toThrow()
  const changed = structuredClone(page),
    entry = changed.changes[0]
  if (!entry.present) throw new Error('Independent metadata row missing')
  Reflect.set(entry.row, 'rawTx', new Uint8Array())
  expect(() => encodeSnapshotJournalFieldFrame(changed, context)).toThrow()
  expect(() => encodeSnapshotJournalFieldFrame({ ...page, fieldBytes: 2097152 }, context)).toThrow()
  const descriptor = { kind: 'binary' as const, bytes: 2097153, sha256: 'a'.repeat(64) },
    chunk = Uint8Array.of(7, 8)
  const encoded = encodeSnapshotJournalFieldArchiveContent(
    context,
    'b'.repeat(64),
    0,
    'rawTx',
    descriptor,
    65535,
    chunk
  )
  chunk.fill(0)
  const content = decodeSnapshotJournalFieldArchivePacket(encoded, context, snapshotJournalRevision('7'))
  expect(content.kind).toBe('field-content')
  if (content.kind !== 'field-content') throw new Error('Content packet missing')
  expect(content.bytes).toEqual(Uint8Array.of(7, 8))
  expect(() => decodeSnapshotJournalArchivePacket(encoded, context, snapshotJournalRevision('7'))).toThrow()
  expect(() =>
    encodeSnapshotJournalFieldArchiveContent(context, 'b'.repeat(64), 0, 'rawTx', descriptor, 2097153, Uint8Array.of(1))
  ).toThrow()
  expect(() =>
    encodeSnapshotJournalFieldArchiveContent(context, 'b'.repeat(64), 0, 'rawTx', descriptor, 0, new Uint8Array(65537))
  ).toThrow()
})

// This complete new2MiB/1MiB-JSON case passed in23.88s and timed out at30.095s
// with a simultaneous type reader. Its own60s case guard changes no existing
// test/benchmark guard, source lease, production limit or qualification verdict.
test('actual capture stores one verified multichunk content value, streamed profile-safe identities and fifteen streams before READY', async () => {
  const f = await fixture(true),
    raw = Buffer.alloc(2097153),
    description = '\ufeffold\0雪😀'.repeat(18000),
    label = '\ufefflabel\0雪😀',
    notify =
      '{"transactionIds":[2],"unknown":"' +
      'x'.repeat(1048576) +
      '","transactionIds":' +
      JSON.stringify([...Array.from({ length: 257 }, (_, i) => (i % 3) + 1), -1, 0, 1.5, '1', null, {}, true]) +
      '}'
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + 7) % 256
  await f.storage.knex('transactions').where('transactionId', 1).update({ rawTx: raw, description })
  await f.storage.knex('proven_tx_reqs').where('provenTxReqId', 1).update({ rawTx: raw, notify })
  await f.storage.knex('tx_labels').where('txLabelId', f.original.txLabelId).update({ label })
  const source = await f.storage.openCurrentSnapshotJournalSource(identityKey),
    close = source.close.bind(source),
    entered = gate(),
    release = gate()
  jest.spyOn(source, 'close').mockImplementation(async () => {
    entered.resolve()
    await release.promise
    await close()
  })
  const running = captureSnapshotJournalFieldArchiveSource(source, f.store)
  try {
    await entered.promise
    const building = await f.storage.knex('snapshot_archives').where('identityKey', identityKey).first('state')
    expect(building.state).toBe('building')
    expect(source.isOpen).toBe(true)
    await f.storage.knex('transactions').where('transactionId', 1).update({ description: 'later foreground write' })
  } finally {
    release.resolve()
  }
  const manifest = await running
  expect(source.isOpen).toBe(false)
  expect(manifest.binding.version).toBe(4)
  expect(manifest.binding.encoding).toBe(snapshotJournalFieldArchiveEncoding)
  const observed: string[] = []
  f.storage.knex.on('query', ({ sql }: { sql: string }) => {
    observed.push(sql)
  })
  const directory = await f.store.journalFieldsDirectory(identityKey, manifest.archiveId),
    expected = {
      identityKey,
      chain: 'test' as const,
      sourceStorageIdentityKey: 'source',
      sourceSchema: source.sourceSchema,
      archiveId: manifest.archiveId,
      digest: manifest.digest,
      expiresAt: manifest.expiresAt
    },
    verified = verifySnapshotJournalFieldArchiveDirectory(directory, expected, Date.now())
  expect(observed.some(sql => sql.includes('substr(payload,1,4096)'))).toBe(true)
  expect(verified.frames.length).toBeGreaterThanOrEqual(15)
  expect(() => verifySnapshotJournalArchiveDirectory(directory, expected, Date.now())).toThrow()
  await expect(f.store.inspect(identityKey, manifest.archiveId)).rejects.toThrow('unavailable')
  await expect(f.store.inspectJournal(identityKey, manifest.archiveId)).rejects.toThrow('unavailable')
  await expect(f.store.readJournal(identityKey, manifest.archiveId, 0)).rejects.toThrow('unavailable')
  const hashes = new Map<string, { hash: ReturnType<typeof createHash>; offset: number; size: number }>(),
    notificationIds = new Set<number>(),
    capturedLabels: string[] = []
  let rawPackets = 0,
    oldDescription: string | undefined
  const descriptionParts: Uint8Array[] = []
  for (const frameReceipt of verified.frames) {
    const context = snapshotJournalArchiveStreams[frameReceipt.streamIndex],
      frameData = await f.store.readJournalFields(identityKey, manifest.archiveId, frameReceipt.sequence),
      packet = decodeSnapshotJournalFieldArchivePacket(
        frameData.bytes,
        { stream: context.stream, tableId: context.tableId },
        manifest.binding.journal.receipt.highWater
      )
    expect(sha(frameData.bytes)).toBe(frameData.digest)
    if (packet.kind !== 'field-frame') throw new Error('Actual metadata frame is missing')
    expect(
      packet.page.changes.every(
        change => !change.present || change.row.userId === undefined || Number(change.row.userId) === f.user.userId
      )
    ).toBe(true)
    for (const change of packet.page.changes)
      if (change.present && packet.page.table === 'txLabels') capturedLabels.push(change.row.label as string)
    for (let sequence = frameReceipt.firstPrefix; sequence < frameReceipt.sequence; sequence++) {
      const receipt = verified.receipts[sequence],
        data = await f.store.readJournalFields(identityKey, manifest.archiveId, sequence),
        value = decodeSnapshotJournalFieldArchivePacket(
          data.bytes,
          { stream: context.stream, tableId: context.tableId },
          manifest.binding.journal.receipt.highWater
        )
      expect(sha(data.bytes)).toBe(receipt.digest)
      expect(value.frameDigest).toBe(packet.frameDigest)
      if (value.kind === 'field-identities') {
        if (context.tableId === 9)
          for (const id of value.identities.values()) if (id.tableId === 0) notificationIds.add(id.incomingId)
        continue
      }
      if (value.kind !== 'field-content') throw new Error('Metadata frame appeared in prefixes')
      expect(receipt.content).toEqual({
        frameDigest: value.frameDigest,
        changeIndex: value.changeIndex,
        field: value.field,
        descriptor: value.descriptor,
        offset: value.offset,
        length: value.bytes.length
      })
      expect(value.bytes.length).toBeLessThanOrEqual(65536)
      let state = hashes.get(value.descriptor.sha256)
      if (state === undefined) {
        state = { hash: createHash('sha256'), offset: 0, size: value.descriptor.bytes }
        hashes.set(value.descriptor.sha256, state)
      }
      expect(value.offset).toBe(state.offset)
      state.hash.update(value.bytes)
      state.offset += value.bytes.length
      if (value.descriptor.sha256 === sha(raw)) rawPackets++
      if (value.descriptor.sha256 === sha(description)) descriptionParts.push(value.bytes)
    }
  }
  for (const [digest, state] of hashes) {
    expect(state.offset).toBe(state.size)
    expect(state.hash.digest('hex')).toBe(digest)
  }
  oldDescription = Buffer.concat(descriptionParts).toString('utf8')
  expect(oldDescription).toBe(description)
  expect(capturedLabels).toContain(label)
  expect(notificationIds.has(1)).toBe(true)
  expect(notificationIds.has(3)).toBe(true)
  expect(notificationIds.has(2)).toBe(false)
  expect(rawPackets).toBe(33)
  const tampered = structuredClone(directory),
    candidate = tampered.receipts.find(receipt => receipt.content !== null)
  if (candidate === undefined || candidate.content == null)
    throw new Error('Independent content-index sample is missing')
  Reflect.set(candidate.content, 'field', 'inputBEEF')
  expect(() => verifySnapshotJournalFieldArchiveDirectory(tampered, expected, Date.now())).toThrow()
}, 60000)

test('field artifacts preserve incremental hard-delete tombstones and refuse a future same-source position', async () => {
  const f = await fixture(),
    first = await captureSnapshotJournalFieldArchiveSource(
      await f.storage.openCurrentSnapshotJournalSource(identityKey),
      f.store
    ),
    position = { binding: first.binding.journal.receipt.binding, highWater: first.binding.journal.receipt.highWater }
  await f.store.close(identityKey, first.archiveId)
  await f.storage.knex('tx_labels').where('txLabelId', f.original.txLabelId).del()
  const source = await f.storage.openCurrentSnapshotJournalSource(identityKey),
    second = await captureSnapshotJournalFieldArchiveSource(source, f.store, position)
  expect(second.binding.journal.bootstrap).toBe(false)
  const directory = verifySnapshotJournalFieldArchiveDirectory(
    await f.store.journalFieldsDirectory(identityKey, second.archiveId),
    {
      identityKey,
      chain: 'test',
      sourceStorageIdentityKey: 'source',
      sourceSchema: source.sourceSchema,
      archiveId: second.archiveId,
      digest: second.digest,
      expiresAt: second.expiresAt,
      position
    },
    Date.now()
  )
  let deleted = false
  for (const entry of directory.frames) {
    const stream = snapshotJournalArchiveStreams[entry.streamIndex],
      packet = decodeSnapshotJournalFieldArchivePacket(
        (await f.store.readJournalFields(identityKey, second.archiveId, entry.sequence)).bytes,
        { stream: stream.stream, tableId: stream.tableId },
        second.binding.journal.receipt.highWater
      )
    if (stream.tableId === 3 && packet.kind === 'field-frame')
      deleted ||= packet.page.changes.some(change => change.metadata.id1 === f.original.txLabelId && !change.present)
  }
  expect(deleted).toBe(true)
  await f.store.close(identityKey, second.archiveId)
  const future = await f.storage.openCurrentSnapshotJournalSource(identityKey)
  await expect(
    captureSnapshotJournalFieldArchiveSource(future, f.store, {
      binding: future.receipt.binding,
      highWater: '9223372036854775807'
    })
  ).rejects.toThrow('exceeds')
  expect(future.isOpen).toBe(false)
  expect(await f.storage.knex('snapshot_archives').first('archiveId')).toBeUndefined()
})

test('actual private small-row comparison refuses forged field identity metadata and drains before retry', async () => {
  const f = await fixture(),
    source = await f.storage.openCurrentSnapshotJournalSource(identityKey),
    request = {
      bootstrap: true as const,
      stream: 'scope' as const,
      tableId: 3,
      low: snapshotJournalRevision('0'),
      maximumRows: 8,
      maximumBytes: 16384
    },
    page = await source.fieldDeltaReader!.readPage(request),
    forged: SnapshotJournalHashedFieldPage = {
      ...page,
      changes: page.changes.map(change =>
        change.present ? { ...change, row: { ...change.row, label: 'forged detached DATA' }, fields: {} } : change
      )
    },
    capture = jest.fn()
  const outcome = await source.readFieldIdentities!(request, forged, capture).then(
    () => ({ accepted: true }),
    (error: unknown) => ({ error })
  )
  expect(capture).not.toHaveBeenCalled()
  expect(outcome).toHaveProperty('error')
  if (!('error' in outcome)) throw new Error('Actual private metadata comparison accepted forged DATA')
  await expect(source.close()).rejects.toBe(outcome.error)
  await expect(source.closed).rejects.toBe(outcome.error)
  expect((await f.storage.knex('tx_labels').where('txLabelId', f.original.txLabelId).first('label')).label).toBe(
    'original label'
  )
  const retry = await captureSnapshotJournalFieldArchiveSource(
    await f.storage.openCurrentSnapshotJournalSource(identityKey),
    f.store
  )
  expect(retry.binding.journal.bootstrap).toBe(true)
})

test('a corrupted real replay never publishes READY and releases only after actual source and staging cleanup', async () => {
  const f = await fixture(true),
    source = await f.storage.openCurrentSnapshotJournalSource(identityKey),
    reader = source.fieldDeltaReader!,
    read = reader.readExtent.bind(reader),
    seal = jest.spyOn(f.store, 'sealJournalFields')
  let reads = 0
  jest.spyOn(reader, 'readExtent').mockImplementation(async (...args) => {
    const bytes = await read(...args)
    if (args[0].tableId === 0 && args[1].id1 === 1 && args[2] === 'rawTx' && ++reads === 2) bytes[0] ^= 255
    return bytes
  })
  await expect(captureSnapshotJournalFieldArchiveSource(source, f.store)).rejects.toThrow('replay digest differs')
  await source.closed
  expect(reads).toBe(2)
  expect(seal).not.toHaveBeenCalled()
  expect(await f.storage.knex('snapshot_archives').first('archiveId')).toBeUndefined()
  const capacity = await f.storage.knex('snapshot_archive_capacity').where('id', 1).first('archives', 'reservedBytes')
  expect(Number(capacity.archives)).toBe(0)
  expect(Number(capacity.reservedBytes)).toBe(0)
  expect((await f.storage.knex('transactions').where('transactionId', 1).first('rawTx')).rawTx).toEqual(
    Buffer.from([1, 2, 255])
  )
})

test('cancellation after a real prefix commit drains the source and removes provisional field staging', async () => {
  const f = await fixture(true),
    controller = new AbortController(),
    source = await f.storage.openCurrentSnapshotJournalSource(identityKey, { signal: controller.signal }),
    append = f.store.appendJournalFields.bind(f.store),
    seal = jest.spyOn(f.store, 'sealJournalFields')
  jest.spyOn(f.store, 'appendJournalFields').mockImplementation(async (...args) => {
    await append(...args)
    controller.abort(new Error('Independent cancellation after actual prefix commit'))
  })
  await expect(
    captureSnapshotJournalFieldArchiveSource(source, f.store, undefined, { signal: controller.signal })
  ).rejects.toThrow()
  expect(source.isOpen).toBe(false)
  expect(seal).not.toHaveBeenCalled()
  expect(await f.storage.knex('snapshot_archives').first('archiveId')).toBeUndefined()
  expect(Number((await f.storage.knex('snapshot_archive_capacity').where('id', 1).first('archives')).archives)).toBe(0)
  const next = await f.storage.openCurrentSnapshotJournalSource(identityKey)
  await next.close()
  await next.closed
})
