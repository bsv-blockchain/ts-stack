import type { PackedSnapshotRow, WalletSnapshotTables } from '../WalletReadSnapshot'
import { encodeSyncTransfer } from '../../remoting/SyncTransfer'
import { decodeRemoteSnapshotFrame, detachRemoteSnapshotRow, remoteSnapshotKeys } from './RemoteSnapshotRows'
import { snapshotArchiveLimits } from './SnapshotArchive'
import type { SnapshotArchiveReceipt } from './SnapshotArchiveDirectory'
import { label } from '../../../../test/utils/remoteSnapshotReaderFixtures'

const receipt: SnapshotArchiveReceipt = { sequence: 0, table: 'txLabels', rows: 1, done: true, digest: 'a'.repeat(64) }
const encode = (rows: unknown[], changes: object = {}) =>
  encodeSyncTransfer({ version: 1, table: 'txLabels', rows, ...changes })

test('a raw row frame reconstructs fresh dates, retains exact Unicode and charges its payload budget', () => {
  const row = label(1, 'é\u0000😀')
  const decoded = decodeRemoteSnapshotFrame(encode([row]), receipt, 7)
  expect(decoded.rows).toEqual([row])
  expect(decoded.charges).toEqual([6 * 64 + row.label.length * 2])
  const first = detachRemoteSnapshotRow(decoded.rows[0])
  const second = detachRemoteSnapshotRow(decoded.rows[0])
  expect(first).toEqual(row)
  expect(second).toEqual(row)
  expect(first.created_at).not.toBe(second.created_at)
  ;(first.created_at as Date).setTime(0)
  first.label = 'caller mutation'
  expect(detachRemoteSnapshotRow(decoded.rows[0])).toEqual(row)
})

test('transaction bytes remain packed and detached, including the optional no-send recovery field', () => {
  const row = {
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    transactionId: 3,
    userId: 7,
    status: 'completed',
    reference: 'reference',
    isOutgoing: true,
    satoshis: 1,
    description: 'synthetic transaction',
    rawTx: Uint8Array.of(0, 255),
    noSendExpiryReclaimRawTx: Uint8Array.of(1, 128, 255)
  }
  const result = decodeRemoteSnapshotFrame(
    encodeSyncTransfer({ version: 1, table: 'transactions', rows: [row] }),
    { ...receipt, table: 'transactions' },
    7
  )
  expect(result.rows).toEqual([row])
  expect(result.charges).toEqual([
    Object.values(row).reduce(
      (sum, value) =>
        sum + 64 + (typeof value === 'string' ? value.length * 2 : value instanceof Uint8Array ? value.length * 2 : 0),
      0
    )
  ])
  const first = detachRemoteSnapshotRow(result.rows[0])
  ;(first.rawTx as Uint8Array).fill(42)
  ;(first.noSendExpiryReclaimRawTx as Uint8Array).fill(42)
  expect(detachRemoteSnapshotRow(result.rows[0])).toEqual(row)
  expect(Array.isArray(result.rows[0].rawTx)).toBe(false)
})

test('unknown columns, foreign profiles, missing required fields and wrong cell representations reject', () => {
  const invalid = [
    { ...label(1), userId: 8 },
    { ...label(1), userId: 0 },
    { ...label(1), txLabelId: 1.5 },
    { ...label(1), isDeleted: 1 },
    { ...label(1), label: 1 },
    { ...label(1), extra: 'column' },
    { ...label(1), updated_at: '2026-01-01' },
    { ...label(1), created_at: 'not-a-date' },
    { ...label(1), created_at: 0 },
    { ...label(1), label: null },
    Object.fromEntries(Object.entries(label(1)).filter(([name]) => name !== 'isDeleted')),
    Object.assign(label(1), Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`extra${n}`, n])))
  ]
  for (const row of invalid)
    expect(() => decodeRemoteSnapshotFrame(encode([row]), receipt, 7)).toThrow('Invalid snapshot archive row frame')
})

test('a frame must match its authenticated table and exact row count within hard byte and row bounds', () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array(snapshotArchiveLimits.pageBytes + 1)]) {
    expect(() => decodeRemoteSnapshotFrame(bytes, receipt, 7)).toThrow('Invalid snapshot archive row frame')
  }
  for (const fields of [{ version: 2 }, { table: 'outputs' }, { extra: true }, { rows: {} }]) {
    expect(() => decodeRemoteSnapshotFrame(encode([label(1)], fields), receipt, 7)).toThrow(
      'Invalid snapshot archive row frame'
    )
  }
  expect(() => decodeRemoteSnapshotFrame(encode([]), receipt, 7)).toThrow('Invalid snapshot archive row frame')
  const large = Array.from({ length: snapshotArchiveLimits.rowsPerPage + 1 }, (_, n) => label(n + 1))
  expect(() => decodeRemoteSnapshotFrame(encode(large), { ...receipt, rows: large.length }, 7)).toThrow(
    'Invalid snapshot archive row frame'
  )
  expect(decodeRemoteSnapshotFrame(encode([]), { ...receipt, rows: 0 }, 7)).toEqual({ rows: [], charges: [] })
})

test('source-key declarations are detached and inherited table names never select a schema', () => {
  const keys = remoteSnapshotKeys('certificateFields') as string[]
  expect(keys).toEqual(['fieldName', 'certificateId'])
  keys[0] = 'caller replacement'
  expect(remoteSnapshotKeys('certificateFields')).toEqual(['fieldName', 'certificateId'])
  for (const name of ['toString', '__proto__', 'constructor', 'unknown']) {
    expect(() => remoteSnapshotKeys(name as 'txLabels')).toThrow('Invalid snapshot archive row frame')
  }
})

test.each([null, 7, 'row', [], Uint8Array.of(1)])('non-record row %p cannot be returned as wallet data', input => {
  expect(() => decodeRemoteSnapshotFrame(encode([input]), receipt, 7)).toThrow('Invalid snapshot archive row frame')
})

test('binary, numeric and certificate-field values retain strict representations and inclusive Unicode bounds', () => {
  const when = new Date('2026-01-01T00:00:00.000Z')
  const proven = {
    created_at: when,
    updated_at: when,
    provenTxId: 1,
    txid: 'transaction',
    height: 0,
    index: 0,
    merklePath: new Uint8Array(),
    rawTx: new Uint8Array(),
    blockHash: 'block',
    merkleRoot: 'root'
  }
  const decode = (table: 'provenTxs' | 'certificateFields', input: object) =>
    decodeRemoteSnapshotFrame(encodeSyncTransfer({ version: 1, table, rows: [input] }), { ...receipt, table }, 7)
  expect(decode('provenTxs', proven).rows).toEqual([proven])
  for (const value of [null, [], [0, 255], 'binary'])
    expect(() => decode('provenTxs', { ...proven, rawTx: value })).toThrow('Invalid snapshot archive row frame')
  for (const value of [null, '0', true])
    expect(() => decode('provenTxs', { ...proven, height: value })).toThrow('Invalid snapshot archive row frame')
  const field = {
    created_at: when,
    updated_at: when,
    userId: 7,
    certificateId: 1,
    fieldName: '😀'.repeat(100),
    fieldValue: 'value',
    masterKey: 'key'
  }
  expect(decode('certificateFields', field).rows).toEqual([field])
  for (const fieldName of [1, 'a'.repeat(101), '😀'.repeat(101)])
    expect(() => decode('certificateFields', { ...field, fieldName })).toThrow('Invalid snapshot archive row frame')
})

test('all thirteen public row shapes retain their columns and reject changed representations and profiles', () => {
  const when = new Date('2026-01-01T00:00:00.000Z')
  const timestamps = { created_at: when, updated_at: when }
  const txid = '12'.repeat(32)
  const identity = '02' + '34'.repeat(32)
  const packed = Uint8Array.of(0, 128, 255)
  type Complete<T extends keyof WalletSnapshotTables> = Required<PackedSnapshotRow<WalletSnapshotTables[T]>>
  const examples: { [T in keyof WalletSnapshotTables]: Complete<T> } = {
    provenTxs: {
      ...timestamps,
      provenTxId: 1,
      txid,
      height: 0,
      index: 0,
      merklePath: packed,
      rawTx: packed,
      blockHash: txid,
      merkleRoot: txid
    },
    outputBaskets: {
      ...timestamps,
      basketId: 1,
      userId: 7,
      name: 'default',
      numberOfDesiredUTXOs: 10,
      minimumDesiredUTXOValue: 1000,
      isDeleted: false
    },
    commissions: {
      ...timestamps,
      commissionId: 1,
      userId: 7,
      transactionId: 1,
      satoshis: 1,
      keyOffset: 'synthetic offset',
      isRedeemed: false,
      lockingScript: packed
    },
    outputTags: { ...timestamps, outputTagId: 1, userId: 7, tag: 'tag', isDeleted: false },
    outputTagMaps: { ...timestamps, outputTagId: 1, outputId: 2, isDeleted: false },
    txLabels: label(1),
    txLabelMaps: { ...timestamps, txLabelId: 1, transactionId: 2, isDeleted: false },
    certificateFields: {
      ...timestamps,
      userId: 7,
      certificateId: 1,
      fieldName: 'name',
      fieldValue: 'value',
      masterKey: 'synthetic key'
    },
    transactions: {
      ...timestamps,
      transactionId: 1,
      userId: 7,
      provenTxId: 2,
      status: 'completed',
      reference: 'cmVm',
      isOutgoing: true,
      satoshis: 1000,
      description: 'synthetic history',
      version: 2,
      lockTime: 0,
      txid,
      inputBEEF: packed,
      rawTx: packed,
      noSendExpiryMode: 'seconds',
      noSendExpiryValue: 60,
      noSendExpiryDeadline: 1790812860,
      noSendExpiryState: 'reclaimed',
      noSendExpiryAnchorTxid: txid,
      noSendExpiryAnchorVout: 1,
      noSendExpiryReleasedAt: 1790812861,
      noSendExpiryObservedAt: 1790812862,
      noSendExpiryReclaimTxid: txid,
      noSendExpiryReclaimRawTx: packed,
      noSendExpiryReclaimDerivationPrefix: 'cHJlZml4',
      noSendExpiryReclaimDerivationSuffix: 'c3VmZml4',
      noSendExpiryReclaimSatoshis: 500
    },
    outputs: {
      ...timestamps,
      outputId: 1,
      userId: 7,
      transactionId: 1,
      basketId: 1,
      spendable: false,
      change: false,
      outputDescription: 'synthetic output',
      vout: 0,
      satoshis: 1000,
      providedBy: 'you-and-storage',
      purpose: 'purpose',
      type: 'P2PKH',
      txid,
      senderIdentityKey: identity,
      derivationPrefix: 'cHJlZml4',
      derivationSuffix: 'c3VmZml4',
      customInstructions: 'retained metadata',
      spentBy: 2,
      sequenceNumber: 0,
      spendingDescription: 'spent description',
      scriptLength: 3,
      scriptOffset: 0,
      lockingScript: packed
    },
    provenTxReqs: {
      ...timestamps,
      provenTxReqId: 1,
      provenTxId: 2,
      status: 'completed',
      attempts: 0,
      notified: true,
      txid,
      batch: 'batch',
      history: '{}',
      notify: '{}',
      rawTx: packed,
      inputBEEF: packed,
      wasBroadcast: false,
      rebroadcastAttempts: 0
    },
    certificates: {
      ...timestamps,
      certificateId: 1,
      userId: 7,
      type: 'dHlwZQ==',
      serialNumber: 'c2VyaWFs',
      certifier: identity,
      subject: identity,
      verifier: identity,
      revocationOutpoint: txid + '.0',
      signature: '1234',
      isDeleted: false
    },
    syncStates: {
      ...timestamps,
      syncStateId: 1,
      userId: 7,
      storageIdentityKey: identity,
      storageName: 'original storage',
      status: 'success',
      init: true,
      refNum: 'reference',
      syncMap: '{}',
      when,
      satoshis: 1000,
      errorLocal: 'historical local error',
      errorOther: 'historical remote error'
    }
  }
  for (const [name, example] of Object.entries(examples)) {
    const table = name as keyof typeof examples
    const decode = (row: object) =>
      decodeRemoteSnapshotFrame(encodeSyncTransfer({ version: 1, table, rows: [row] }), { ...receipt, table }, 7)
    expect(decode(example).rows).toEqual([example])
    if ('userId' in example)
      expect(() => decode({ ...example, userId: 8 })).toThrow('Invalid snapshot archive row frame')
    for (const [field, value] of Object.entries(example)) {
      // Derive only the invalid representation from independently typed public
      // fixtures, without reading the decoder's private schema declaration.
      const wrong = typeof value === 'string' ? 1 : typeof value === 'boolean' ? 0 : 'wrong representation'
      expect(() => decode({ ...example, [field]: wrong })).toThrow('Invalid snapshot archive row frame')
    }
  }
})

test('every source table preserves the established scalar or composite key order', () => {
  const expected: Record<keyof WalletSnapshotTables, string[]> = {
    provenTxs: ['provenTxId'],
    provenTxReqs: ['provenTxReqId'],
    outputBaskets: ['basketId'],
    transactions: ['transactionId'],
    commissions: ['commissionId'],
    outputs: ['outputId'],
    outputTags: ['outputTagId'],
    outputTagMaps: ['outputTagId', 'outputId'],
    txLabels: ['txLabelId'],
    txLabelMaps: ['txLabelId', 'transactionId'],
    certificates: ['certificateId'],
    certificateFields: ['fieldName', 'certificateId'],
    syncStates: ['syncStateId']
  }
  for (const [name, keys] of Object.entries(expected)) {
    const table = name as keyof WalletSnapshotTables
    const actual = remoteSnapshotKeys(table) as string[]
    expect(actual).toEqual(keys)
    actual.length = 0
    expect(remoteSnapshotKeys(table)).toEqual(keys)
  }
})

test('the inclusive authenticated row limit accepts a full page', () => {
  const rows = Array.from({ length: snapshotArchiveLimits.rowsPerPage }, (_, index) => label(index + 1))
  expect(decodeRemoteSnapshotFrame(encode(rows), { ...receipt, rows: rows.length }, 7).rows).toEqual(rows)
})
