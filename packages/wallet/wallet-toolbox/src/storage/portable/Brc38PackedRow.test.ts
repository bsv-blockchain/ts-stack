import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import fc from 'fast-check'
import { Utils } from '@bsv/sdk'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { StorageIdb } from '../StorageIdb'
import { StorageProvider } from '../StorageProvider'
import { exportBRC38 } from './index'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

const policy = { maximumAllocationBytes: 1048576 }
const iso = '2026-10-03T00:00:00.000Z'
const date = new Date(iso)
function project(row: unknown) {
  return projectBrc38PackedRow('provenTxReqs', row, policy)
}
function oneHoleArray(): unknown[] {
  const array: unknown[] = []
  array.length = 1
  return array
}
afterEach(() => jest.restoreAllMocks())

test.each([0, 1, 2, 3, 3071, 3072, 3073, 6144, 6145])(
  'native binary matches the independent SDK base64 oracle (%i)',
  size => {
    const value = Uint8Array.from({ length: size }, (_, index) => index % 256)
    expect(project({ rawTx: value }).rawTx).toBe(Utils.toBase64(Array.from(value)))
    expect(project({ rawTx: Array.from(value) }).rawTx).toBe(Utils.toBase64(Array.from(value)))
  }
)

test('native binary never expands more than one 3072-byte window', () => {
  const native = new Uint8Array(3072 * 4 + 1).fill(173)
  const encode = jest.spyOn(Utils, 'toBase64')
  const result = project({ rawTx: native })
  expect(encode.mock.calls.map(call => call[0].length)).toEqual([3072, 3072, 3072, 3072, 1])
  expect(result.rawTx).toBe(Buffer.from(native).toString('base64'))
})

test('historical optional object properties omit only absent values and retain array positions and falsy values', () => {
  const input = {
    history: { notes: [{ what: 'broadcast', when: null, code: 0, accepted: false, detail: '' }] },
    notify: JSON.stringify({ transactionIds: null, enabled: false }),
    rawTx: new Uint8Array([0, 255]),
    created_at: date,
    updated_at: date,
    batch: null,
    logger: undefined
  }
  const historyBefore = JSON.stringify(input.history)
  const result = project(input)
  expect(result).toEqual({
    history: { notes: [{ what: 'broadcast', code: 0, accepted: false, detail: '' }] },
    notify: { enabled: false },
    rawTx: 'AP8=',
    created_at: iso,
    updated_at: iso
  })
  expect(JSON.stringify(input.history)).toBe(historyBefore)
  input.history.notes[0].what = 'later'
  input.rawTx.fill(1)
  expect(result.history).toEqual({ notes: [{ what: 'broadcast', code: 0, accepted: false, detail: '' }] })
  expect(result.rawTx).toBe('AP8=')
})

test('sync state nullable history paths preserve source checkpoints and meaningful values', () => {
  const row = {
    syncMap: { transaction: { maxUpdated_at: null, count: 0, idMap: { '1': 7 } } },
    errorLocal: '{"message":"failure","stack":null}',
    errorOther: { message: '', stack: undefined },
    init: false,
    when: date,
    storageIdentityKey: 'original'
  }
  expect(projectBrc38PackedRow('syncStates', row, policy)).toEqual({
    syncMap: { transaction: { count: 0, idMap: { '1': 7 } } },
    errorLocal: { message: 'failure' },
    errorOther: { message: '' },
    init: false,
    when: iso,
    storageIdentityKey: 'original'
  })
})

test.each([
  { history: { notes: [null] } },
  { history: { notes: [{ what: null }] } },
  { history: { other: null } },
  { notify: { transactionIds: [null] } },
  { history: 'null' },
  { history: '[]' },
  { history: '{"notes":[null]}' },
  { rawTx: [NaN] },
  { rawTx: [-1] },
  { rawTx: [256] },
  { rawTx: oneHoleArray() },
  { value: Infinity },
  { value: new Map() },
  { value: '\ud800' }
])('meaningful invalid values refuse without silently altering the archive (%#)', row => {
  expect(() => project(row)).toThrow(TypeError)
})

test('accessors, absent array entries, cycles and over-depth objects refuse before output', () => {
  const getter = jest.fn(() => 'value')
  const row = Object.defineProperty({}, 'history', { enumerable: true, get: getter })
  expect(() => project(row)).toThrow(TypeError)
  expect(getter).not.toHaveBeenCalled()
  const cycle: Record<string, unknown> = {}
  cycle.child = cycle
  expect(() => project({ history: cycle })).toThrow(TypeError)
  expect(() => project({ history: { notes: oneHoleArray() } })).toThrow(TypeError)
  let deep: unknown = 'leaf'
  for (let depth = 0; depth < 65; depth++) deep = { child: deep }
  expect(() => project({ history: deep })).toThrow(SnapshotResourceLimitError)
})

test('structured JSON admission rejects size, node and depth overflow before JSON.parse', () => {
  const parse = jest.spyOn(JSON, 'parse')
  const bounded = (history: string) =>
    projectBrc38PackedRow('provenTxReqs', { history }, { maximumAllocationBytes: 1024 })
  expect(() => bounded('{"value":"' + 'a'.repeat(1024) + '"}')).toThrow(SnapshotResourceLimitError)
  expect(() => bounded('{"value":[' + Array(30).fill('0').join(',') + ']}')).toThrow(SnapshotResourceLimitError)
  expect(parse).not.toHaveBeenCalled()
  expect(() => project({ history: '{"child":'.repeat(65) + '0' + '}'.repeat(65) })).toThrow(SnapshotResourceLimitError)
  expect(parse).not.toHaveBeenCalled()
})

test.each(['{', '{"a":}', '{"a":1,}', '{"a":"\\x"}'])(
  'JSON syntax is independently rejected after bounded admission (%s)',
  history => {
    expect(() => project({ history })).toThrow(SyntaxError)
  }
)

test('escaped structural characters do not alter admission nesting or parsed content', () => {
  const value = { text: '[[[{{{\\"\n\t🙂', nested: { valid: true }, escaped: '\\' }
  expect(project({ history: JSON.stringify(value) }).history).toEqual(value)
})

test.each([0, -1, NaN, Infinity, 1.5, 16777217])(
  'allocation policy rejects invalid values (%s)',
  maximumAllocationBytes => {
    expect(() => projectBrc38PackedRow('user', {}, { maximumAllocationBytes })).toThrow(RangeError)
  }
)

test('binary byte policy refuses before base64 allocation and cancellation retains its exact reason', () => {
  const encode = jest.spyOn(Utils, 'toBase64')
  expect(() =>
    projectBrc38PackedRow('outputs', { lockingScript: new Uint8Array(1000) }, { maximumAllocationBytes: 256 })
  ).toThrow(SnapshotResourceLimitError)
  expect(encode).not.toHaveBeenCalled()
  const controller = new AbortController(),
    reason = new Error('cancel projection')
  controller.abort(reason)
  expect(() => projectBrc38PackedRow('user', {}, { ...policy, signal: controller.signal })).toThrow(reason)
})

test('certificate embedded field views are omitted while separate standard field rows retain original values', () => {
  expect(
    projectBrc38PackedRow('certificates', { certificateId: 19, fields: { name: 'private expanded view' } }, policy)
  ).toEqual({ certificateId: 19 })
  expect(
    projectBrc38PackedRow('certificateFields', { certificateId: 19, fieldName: 'name', fieldValue: 'original' }, policy)
  ).toEqual({ certificateId: 19, fieldName: 'name', fieldValue: 'original' })
})

test('real IndexedDB source projection matches the original coherent legacy exporter', async () => {
  const storage = new StorageIdb(StorageProvider.createStorageBaseOptions('test'))
  storage.dbName = 'packed-portable-' + randomUUID()
  try {
    await storage.migrate('original source', 'source-storage')
    await storage.makeAvailable()
    const identity = '02' + '11'.repeat(32)
    const { user } = await storage.findOrInsertUser(identity)
    await storage.insertTransaction({
      created_at: date,
      updated_at: date,
      transactionId: 0,
      userId: user.userId,
      status: 'unproven',
      reference: 'original',
      isOutgoing: false,
      satoshis: 0,
      description: '',
      txid: 'a'.repeat(64),
      rawTx: [0, 255]
    })
    await storage.insertProvenTxReq({
      created_at: date,
      updated_at: date,
      provenTxReqId: 0,
      status: 'unmined',
      attempts: 0,
      notified: false,
      txid: 'a'.repeat(64),
      history: '{"notes":[{"what":"broadcast","when":null,"code":0}]}',
      notify: '{"transactionIds":null}',
      rawTx: [0, 255]
    })
    const legacy = await exportBRC38(storage, identity, { requireSnapshot: true })
    expect(projectBrc38PackedRow('sourceStorage', await storage.readSettings(), policy)).toEqual(legacy.sourceStorage)
    expect(projectBrc38PackedRow('user', user, policy)).toEqual(legacy.user)
    const [transaction] = await storage.findTransactions({ partial: { userId: user.userId } })
    const [request] = await storage.getProvenTxReqsForUser({ userId: user.userId })
    expect(
      projectBrc38PackedRow('transactions', { ...transaction, rawTx: Uint8Array.from(transaction.rawTx!) }, policy)
    ).toEqual(legacy.tables.transactions[0])
    expect(project({ ...request, rawTx: Uint8Array.from(request.rawTx) })).toEqual(legacy.tables.provenTxReqs[0])
  } finally {
    await storage.destroy()
    await storage.dropAllData()
  }
})

test('generated binary and structured histories retain exact bytes, falsy values and bounded canonical output', () => {
  fc.assert(
    fc.property(fc.uint8Array({ maxLength: 8192 }), fc.integer(), fc.boolean(), (rawTx, code, accepted) => {
      const row = project({
        rawTx,
        history: JSON.stringify({ notes: [{ what: 'original', detail: null, code, accepted }] })
      })
      expect(row.rawTx).toBe(Buffer.from(rawTx).toString('base64'))
      expect(row.history).toEqual({ notes: [{ what: 'original', code, accepted }] })
      const chunks = [...canonicalPortableChunks(row, { maximumValueBytes: 1048576, maximumChunkBytes: 64 })]
      expect(chunks.every(chunk => chunk.length <= 64)).toBe(true)
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual(row)
    }),
    {
      numRuns: Math.max(300, Number(process.env.FAST_CHECK_NUM_RUNS ?? 300)),
      seed: Number(process.env.FAST_CHECK_SEED ?? 3242026),
      ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
      interruptAfterTimeLimit: 150000,
      markInterruptAsFailure: true
    }
  )
}, 180000)

test('plain data rows from another realm normalize while class and accessor values refuse', () => {
  const row: unknown = runInNewContext('({history:{notes:[{what:"original",when:null}]}})')
  expect(project(row)).toEqual({ history: { notes: [{ what: 'original' }] } })
  class Custom {
    value = 'non-plain'
  }
  expect(() => project({ history: new Custom() })).toThrow(TypeError)
})

test('non-base64 legacy numeric columns keep their original JSON array shape within the row budget', () => {
  expect(projectBrc38PackedRow('transactions', { noSendExpiryReclaimRawTx: new Uint8Array([0, 255]) }, policy)).toEqual(
    { noSendExpiryReclaimRawTx: [0, 255] }
  )
  expect(() =>
    projectBrc38PackedRow(
      'transactions',
      { noSendExpiryReclaimRawTx: new Uint8Array(10) },
      { maximumAllocationBytes: 256 }
    )
  ).toThrow(SnapshotResourceLimitError)
})

test('native Date branding preserves timestamps across realms and still refuses invalid dates', () => {
  const value: unknown = runInNewContext('new Date("2026-10-03T00:00:00.000Z")')
  expect(project({ created_at: value })).toEqual({ created_at: iso })
  expect(() => project({ created_at: new Date(NaN) })).toThrow(RangeError)
})
