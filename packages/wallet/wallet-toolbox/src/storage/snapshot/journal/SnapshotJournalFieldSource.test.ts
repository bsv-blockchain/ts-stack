import { readSnapshotJournalNativeCustody } from './SnapshotJournalNativeCustody'
import { hashSnapshotJournalOwnedPointFields } from './SnapshotJournalOwnedRowFingerprint'
import { readSnapshotJournalNativeOwnedRow } from './SnapshotJournalNativeRows'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import { createHash } from 'node:crypto'
import { snapshotHttpFixture } from '../../../../test/utils/snapshotArchiveHttpFixtures'
import * as Archive from '../archive/KnexSnapshotArchiveSource'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import type { SnapshotJournalReconciliationSource, SnapshotJournalDeltaRequest } from './SnapshotJournalProvider'
import type { SnapshotJournalFieldDelta, SnapshotJournalFieldReader } from './SnapshotJournalFieldTypes'

let fixture: Awaited<ReturnType<typeof snapshotHttpFixture>>
const raw = Buffer.from(Array.from({ length: 2097153 }, (_, at) => (at * 31 + 7) % 256))
const text = 'independent\0雪😀'.repeat(30000)
const request: SnapshotJournalDeltaRequest = {
  bootstrap: true,
  stream: 'scope',
  tableId: 0,
  low: snapshotJournalRevision('0'),
  maximumRows: 8,
  maximumBytes: 16384
}
let source: SnapshotJournalReconciliationSource | undefined
beforeAll(async () => {
  fixture = await snapshotHttpFixture()
})
beforeEach(async () => {
  await fixture.storage.knex('transactions').where('transactionId', 1).update({ rawTx: raw, description: text })
})
afterEach(async () => {
  await source?.close()
  await source?.closed
  source = undefined
  jest.restoreAllMocks()
})
afterAll(async () => {
  await fixture?.close()
})
function present(change: SnapshotJournalFieldDelta | undefined) {
  if (change === undefined || !change.present) throw new Error('Independent actual source row is required')
  return change
}

test('actual field metadata omits large bytes/TEXT, while bounded extents remain in the original view across a foreground write', async () => {
  const create = Archive.createKnexSnapshotArchiveSource
  const payloads: number[] = []
  let responses = 0
  jest.spyOn(Archive, 'createKnexSnapshotArchiveSource').mockImplementation((storage, view, header) => {
    storage.knex.on('query-response', (rows: unknown) => {
      responses++
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue
        for (const name of ['rawTx', 'description', 'bytes']) {
          const value = Reflect.get(row, name)
          if (value instanceof Uint8Array) payloads.push(value.byteLength)
          if (typeof value === 'string') payloads.push(Buffer.byteLength(value))
        }
      }
    })
    return create(storage, view, header)
  })
  source = await fixture.storage.openCurrentSnapshotJournalSource(fixture.identityKey)
  const reader = source.fieldDeltaReader
  if (reader === undefined) throw new Error('Actual field source was not issued')
  payloads.length = 0
  const page = await reader.readPage(request),
    row = present(page.changes.find(value => value.metadata.id1 === 1))
  expect(row.row).not.toHaveProperty('rawTx')
  expect(row.row).not.toHaveProperty('description')
  expect(row.row.noSendExpiryReclaimRawTx).toBeNull()
  expect(row.fields).not.toHaveProperty('noSendExpiryReclaimRawTx')
  expect(row.fields.rawTx).toEqual({ kind: 'binary', bytes: raw.length })
  expect(row.fields.description).toEqual({ kind: 'utf8', bytes: Buffer.byteLength(text) })
  expect(page.metadataBytes).toBeLessThanOrEqual(request.maximumBytes)
  expect(page.fieldBytes).toBeGreaterThan(raw.length)
  expect(responses).toBeGreaterThan(0)
  expect(payloads.every(size => size === 0)).toBe(true)
  expect(await reader.readExtent(request, row.metadata, 'rawTx', 65530, 65536, row.fields.rawTx)).toEqual(
    new Uint8Array(raw.subarray(65530, 65530 + 65536))
  )
  const utf8 = Buffer.from(text)
  expect(await reader.readExtent(request, row.metadata, 'description', 65530, 65536, row.fields.description)).toEqual(
    new Uint8Array(utf8.subarray(65530, 65530 + 65536))
  )
  await fixture.storage
    .knex('transactions')
    .where('transactionId', 1)
    .update({ rawTx: Buffer.alloc(raw.length, 0xab), description: 'new current text' })
  expect(await reader.readExtent(request, row.metadata, 'rawTx', 0, 65536, row.fields.rawTx)).toEqual(
    new Uint8Array(raw.subarray(0, 65536))
  )
  expect(payloads.every(size => size <= 65536)).toBe(true)
  const hash = createHash('sha256')
  for (let offset = 0; offset < raw.length; offset += 65536)
    hash.update(
      await reader.readExtent(
        request,
        row.metadata,
        'rawTx',
        offset,
        Math.min(65536, raw.length - offset),
        row.fields.rawTx
      )
    )
  expect(hash.digest('hex')).toBe(createHash('sha256').update(raw).digest('hex'))
  await source.close()
  await source.closed
  await expect(reader.readExtent(request, row.metadata, 'rawTx', 0, 1, row.fields.rawTx)).rejects.toThrow()
  source = await fixture.storage.openCurrentSnapshotJournalSource(fixture.identityKey)
  const nextReader = source.fieldDeltaReader
  if (nextReader === undefined) throw new Error('Fresh actual field source is required')
  const next = present((await nextReader.readPage(request)).changes.find(value => value.metadata.id1 === 1))
  expect(next.metadata.revision).not.toBe(row.metadata.revision)
  expect(await nextReader.readExtent(request, next.metadata, 'rawTx', 0, 1, next.fields.rawTx)).toEqual(
    Uint8Array.of(0xab)
  )
})

test('a bounded ordinary full-row read refuses the real large payload instead of returning a marker', async () => {
  source = await fixture.storage.openCurrentSnapshotJournalSource(fixture.identityKey)
  const page = await source.fieldDeltaReader!.readPage(request),
    row = present(page.changes.find(value => value.metadata.id1 === 1))
  const failed = source.readDeltaPage(
    { ...request, bootstrap: undefined, low: snapshotJournalRevision((BigInt(row.metadata.revision) - 1n).toString()) },
    async () => undefined
  )
  const error = await failed.catch((error: unknown) => error)
  expect(error).toBeInstanceOf(SnapshotResourceLimitError)
  await expect(source.close()).rejects.toBe(error)
  await expect(source.closed).rejects.toBe(error)
  source = undefined
})

test('copied header/coordinates, another profile, changed length and unknown fields cannot select payload bytes', async () => {
  source = await fixture.storage.openCurrentSnapshotJournalSource(fixture.identityKey)
  const reader = source.fieldDeltaReader!
  const actualUser = await fixture.storage.knex('users').where('identityKey', fixture.identityKey).first('userId')
  source.user.userId = 999
  source.receipt.highWater = snapshotJournalRevision('9223372036854775807')
  const page = await reader.readPage(request),
    row = present(page.changes.find(value => value.metadata.id1 === 1))
  expect(page.changes.every(value => !value.present || value.row.userId === actualUser.userId)).toBe(true)
  expect(page.changes.some(value => value.metadata.id1 === 2)).toBe(false)
  expect(BigInt(row.metadata.revision)).toBeGreaterThan(1n)
  await source.close()
  await source.closed
  source = undefined
  const cases: Array<(reader: SnapshotJournalFieldReader, row: ReturnType<typeof present>) => Promise<Uint8Array>> = [
    (reader, row) => reader.readExtent(request, { ...row.metadata, id1: 2 }, 'rawTx', 0, 1, row.fields.rawTx),
    (reader, row) =>
      reader.readExtent(request, row.metadata, 'rawTx', 0, 1, { ...row.fields.rawTx, bytes: raw.length - 1 }),
    (reader, row) => reader.readExtent(request, row.metadata, 'rawTx', 0, 65537, row.fields.rawTx),
    (reader, row) => reader.readExtent(request, row.metadata, 'rawTx', -1, 1, row.fields.rawTx),
    (reader, row) => reader.readExtent(request, row.metadata, 'rawTx; SELECT secret', 0, 1, row.fields.rawTx),
    (reader, row) => reader.readExtent(request, row.metadata, 'rawTx', 0, 1, { ...row.fields.rawTx, kind: 'utf8' }),
    (reader, row) =>
      reader.readExtent(
        request,
        { ...row.metadata, revision: snapshotJournalRevision('1') },
        'rawTx',
        0,
        1,
        row.fields.rawTx
      )
  ]
  for (const refuse of cases) {
    source = await fixture.storage.openCurrentSnapshotJournalSource(fixture.identityKey)
    const current = source.fieldDeltaReader!
    const selected = present((await current.readPage(request)).changes.find(value => value.metadata.id1 === 1))
    const outcome = await refuse(current, selected).then(
      value => ({ value }),
      (error: unknown) => ({ error })
    )
    expect(outcome).toHaveProperty('error')
    if (!('error' in outcome)) throw new Error('The actual retained source accepted invalid field coordinates')
    await expect(source.close()).rejects.toBe(outcome.error)
    await expect(source.closed).rejects.toBe(outcome.error)
    source = undefined
  }
})

test('NULL, empty and embedded-NUL Unicode fields retain distinct logical values', async () => {
  const description = '\ufeffstart\0雪😀end'
  await fixture.storage
    .knex('transactions')
    .where('transactionId', 1)
    .update({ rawTx: Buffer.alloc(0), description })
  source = await fixture.storage.openCurrentSnapshotJournalSource(fixture.identityKey)
  const reader = source.fieldDeltaReader!,
    page = await reader.readPage(request),
    row = present(page.changes.find(value => value.metadata.id1 === 1))
  expect(row.row.noSendExpiryReclaimRawTx).toBeNull()
  expect(row.fields).not.toHaveProperty('noSendExpiryReclaimRawTx')
  expect(row.fields.rawTx).toEqual({ kind: 'binary', bytes: 0 })
  expect(await reader.readExtent(request, row.metadata, 'rawTx', 0, 0, row.fields.rawTx)).toEqual(new Uint8Array())
  const actual = await reader.readExtent(
    request,
    row.metadata,
    'description',
    0,
    row.fields.description.bytes,
    row.fields.description
  )
  expect(actual).toEqual(new Uint8Array(Buffer.from(description)))
  const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(actual)
  expect(decoded).toBe(description)
  const full = await source.readDeltaPage(request, async () => undefined),
    complete = full.page.changes.find(value => value.metadata.id1 === 1)
  if (complete === undefined || !complete.present) throw new Error('Full bounded source row is missing')
  expect(complete.row.rawTx).toEqual(Buffer.alloc(0))
  expect(complete.row.description).toBe(description)
  expect(complete.row.noSendExpiryReclaimRawTx).toBeNull()
})

test('streamed custody preserves independent original raw-frame hashes for SQL cells and split UTF8', async () => {
  const binary = new Uint8Array(64001).map((_, index) => index % 251),
    value = '\ufeff\0"\\雪😀'.repeat(2000),
    textBytes = new TextEncoder().encode(value),
    row = {
      transactionId: 7,
      nullable: null,
      flag: true,
      number: 3.5,
      negativeZero: -0,
      integer: -9223372036854775808n,
      date: new Date('2026-10-17T00:00:00.000Z'),
      text: value,
      rawTx: binary,
      empty: new Uint8Array(0),
      emptyText: '',
      inline: '\ufeff\0\\"雪😀',
      '0': 'numeric-key-order'
    },
    fields = {
      text: { kind: 'utf8' as const, bytes: textBytes.length },
      rawTx: { kind: 'binary' as const, bytes: binary.length },
      empty: { kind: 'binary' as const, bytes: 0 },
      emptyText: { kind: 'utf8' as const, bytes: 0 }
    },
    smallRow = Object.fromEntries(Object.entries(row).filter(([name]) => !Object.hasOwn(fields, name))),
    content: Record<string, Uint8Array> = {
      text: textBytes,
      rawTx: binary,
      empty: new Uint8Array(0),
      emptyText: new Uint8Array(0)
    },
    requests: Array<{ name: string; offset: number; length: number }> = [],
    point = {
      names: Object.keys(row),
      smallRow,
      fields,
      readExtent: async (name: string, offset: number, length: number) => {
        requests.push({ name, offset, length })
        return new Uint8Array(content[name].subarray(offset, offset + length))
      }
    },
    local = { id1: 7, id2: 0, exactText: '' },
    revision = snapshotJournalRevision('1'),
    expected = createHash('sha256')
      .update(
        encodeSnapshotJournalDeltaFrame(
          {
            table: 'transactions',
            changes: [{ present: true, metadata: { ...local, revision, present: true }, row }],
            examined: 1,
            payloadBytes: 0,
            complete: false,
            after: { ...local, revision }
          },
          { tableId: 0, stream: 'scope' }
        )
      )
      .digest('hex'),
    result = await hashSnapshotJournalOwnedPointFields(point, 'transactions', 0, local)
  expect(result.fingerprint).toBe(expected)
  for (const name of Object.keys(content))
    expect(result.fields[name].sha256).toBe(createHash('sha256').update(content[name]).digest('hex'))
  expect(requests.every(request => request.length <= 65536)).toBe(true)
  expect(
    requests.filter(request => request.name === 'text' && request.offset === 0 && request.length > 0)
  ).toHaveLength(2)
  await expect(
    hashSnapshotJournalOwnedPointFields(
      { ...point, fields: { ...fields, rawTx: { ...fields.rawTx, sha256: '0'.repeat(64) } } },
      'transactions',
      0,
      local
    )
  ).rejects.toThrow('custody field')
})

test('actual current-row custody hashes large fields in bounded SQL reads and detects same-length payload changes', async () => {
  const userId = (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
    key = { id1: 1, id2: 0, exactText: '' },
    payloads: number[] = [],
    observe = (rows: unknown) => {
      if (!Array.isArray(rows)) return
      for (const row of rows)
        if (row !== null && typeof row === 'object')
          for (const name of ['rawTx', 'description', 'bytes']) {
            const value = Reflect.get(row, name)
            if (value instanceof Uint8Array) payloads.push(value.byteLength)
            if (typeof value === 'string') payloads.push(Buffer.byteLength(value))
          }
    },
    read = async () =>
      await fixture.storage.runSnapshotJournalWriter(async trx => {
        trx.on('query-response', observe)
        try {
          return await readSnapshotJournalNativeOwnedRow(trx, 0, userId, key, { remaining: 16777216 })
        } finally {
          trx.removeListener('query-response', observe)
        }
      })
  try {
    const first = await read()
    expect(first).toBeDefined()
    expect(first?.row).not.toHaveProperty('rawTx')
    expect(first?.row).not.toHaveProperty('description')
    expect(first?.fields?.rawTx).toEqual({
      kind: 'binary',
      bytes: raw.length,
      sha256: createHash('sha256').update(raw).digest('hex')
    })
    expect(first?.fields?.description).toEqual({
      kind: 'utf8',
      bytes: Buffer.byteLength(text),
      sha256: createHash('sha256').update(text).digest('hex')
    })
    expect(payloads.length).toBeGreaterThan(0)
    expect(payloads.every(bytes => bytes <= 65536)).toBe(true)
    payloads.length = 0
    const changed = Buffer.from(raw)
    changed[65535] ^= 1
    await fixture.storage.knex('transactions').where({ transactionId: 1, userId }).update({ rawTx: changed })
    const second = await read()
    expect(second?.fingerprint).not.toBe(first?.fingerprint)
    expect(second?.fields?.description).toEqual(first?.fields?.description)
    expect(second?.fields?.rawTx?.sha256).toBe(createHash('sha256').update(changed).digest('hex'))
    expect(payloads.every(bytes => bytes <= 65536)).toBe(true)
    expect(
      await fixture.storage.runSnapshotJournalWriter(
        async trx => await readSnapshotJournalNativeOwnedRow(trx, 0, userId + 100, key, { remaining: 16777216 })
      )
    ).toBeUndefined()
    await expect(
      fixture.storage.runSnapshotJournalWriter(
        async trx => await readSnapshotJournalNativeOwnedRow(trx, 0, userId, key, { remaining: 1024 })
      )
    ).rejects.toThrow('allocation')
  } finally {
    fixture.storage.knex.removeListener('query-response', observe)
  }
})

test('actual moderately sized SQL rows retain their exact historical custody fingerprint on the streamed path', async () => {
  const userId = (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
    key = { id1: 1, id2: 0, exactText: '' },
    revision = snapshotJournalRevision('1')
  await fixture.storage
    .knex('transactions')
    .where({ transactionId: 1, userId })
    .update({ rawTx: raw.subarray(0, 65536), description: '\ufeffquote"\0\\雪😀'.repeat(1000) })
  const stored = await fixture.storage.knex('transactions').where({ transactionId: 1, userId }).first(),
    row = Object.fromEntries(Object.entries(stored)),
    expected = createHash('sha256')
      .update(
        encodeSnapshotJournalDeltaFrame(
          {
            table: 'transactions',
            changes: [{ present: true, metadata: { ...key, revision, present: true }, row }],
            examined: 1,
            payloadBytes: 0,
            complete: false,
            after: { ...key, revision }
          },
          { tableId: 0, stream: 'scope' }
        )
      )
      .digest('hex'),
    budget = { remaining: 16777216 },
    actual = await fixture.storage.runSnapshotJournalWriter(
      async trx => await readSnapshotJournalNativeOwnedRow(trx, 0, userId, key, budget)
    )
  expect(actual?.fields?.rawTx?.bytes).toBe(65536)
  expect(actual?.fingerprint).toBe(expected)
  expect(budget.remaining).toBeGreaterThan(16777216 - 1048576)
})

test('actual large-row custody retains generation protection when an identical physical key is deleted and reused', async () => {
  const userId = (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
    original = await fixture.storage.knex('transactions').where({ transactionId: 1, userId }).first(),
    candidate = { ...original, transactionId: 33, reference: 'large-custody-reused-key', txid: null },
    key = { id1: 33, id2: 0, exactText: '' },
    read = async () =>
      await fixture.storage.runSnapshotJournalWriter(
        async trx => await readSnapshotJournalNativeCustody(trx, 0, userId, key, { remaining: 16777216 })
      )
  await fixture.storage.knex('transactions').insert(candidate)
  try {
    const first = await read()
    expect(first?.fields?.rawTx?.bytes).toBe(raw.length)
    await fixture.storage.knex('transactions').where({ transactionId: 33, userId }).delete()
    expect(await read()).toBeUndefined()
    await fixture.storage.knex('transactions').insert(candidate)
    const reused = await read()
    expect(reused?.fingerprint).toBe(first?.fingerprint)
    expect(reused?.generation).not.toBe(first?.generation)
    expect(reused?.fields).toEqual(first?.fields)
  } finally {
    await fixture.storage.knex('transactions').where({ transactionId: 33, userId }).delete()
  }
})

test('actual certificate field custody preserves compound Unicode/NUL/trailing-space keys and separate field bytes', async () => {
  const userId = (await fixture.storage.findOrInsertUser(fixture.identityKey)).user.userId,
    existing = await fixture.storage.knex('certificate_fields').where('userId', userId).first(),
    firstName = 'point\0雪 ',
    secondName = 'point\0雪',
    values = ['first\0雪😀'.repeat(12000), 'other\0雪😀'.repeat(12000)]
  if (existing === undefined) throw new Error('Actual certificate field parent fixture missing')
  await fixture.storage.knex('certificate_fields').insert([
    { ...existing, fieldName: firstName, fieldValue: values[0] },
    { ...existing, fieldName: secondName, fieldValue: values[1] }
  ])
  try {
    const results = []
    for (const [index, fieldName] of [firstName, secondName].entries()) {
      const actual = await fixture.storage.runSnapshotJournalWriter(
        async trx =>
          await readSnapshotJournalNativeOwnedRow(
            trx,
            12,
            userId,
            { id1: existing.certificateId, id2: 0, exactText: fieldName },
            { remaining: 16777216 }
          )
      )
      expect(actual?.row.fieldName).toBe(fieldName)
      expect(actual?.row).not.toHaveProperty('fieldValue')
      expect(actual?.fields?.fieldValue).toEqual({
        kind: 'utf8',
        bytes: Buffer.byteLength(values[index]),
        sha256: createHash('sha256').update(values[index]).digest('hex')
      })
      results.push(actual?.fingerprint)
    }
    expect(results[0]).not.toBe(results[1])
  } finally {
    await fixture.storage
      .knex('certificate_fields')
      .where({ certificateId: existing.certificateId, userId })
      .whereIn('fieldName', [firstName, secondName])
      .delete()
  }
})
