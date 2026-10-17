import { collectSnapshotSyncFieldReferences, collectSnapshotSyncReferences } from './SnapshotSyncRows'
import { detachSnapshotSyncFieldPage } from './SnapshotSyncFieldRows'
import type { TableOutput } from '../schema/tables'
import type { SnapshotSyncCheckpoint } from './SnapshotSync'
import type { WalletSnapshotFieldMetadataPage } from './WalletReadSnapshot'

const cp: SnapshotSyncCheckpoint = {
  version: 1,
  snapshotId: 'aa'.repeat(32),
  sessionId: 'bb'.repeat(32),
  identityKey: '02' + '11'.repeat(32),
  sourceStorageIdentityKey: 'source',
  destinationStorageIdentityKey: 'target',
  sequence: 9,
  tableIndex: 9,
  done: false
}
function page(): WalletSnapshotFieldMetadataPage<'certificateFields'> {
  const cursor = {
      version: 1 as const,
      snapshotId: cp.snapshotId,
      table: 'certificateFields' as const,
      after: ['name', 21]
    },
    dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-02-01') }
  return {
    rows: [
      {
        fields: { ...dates, userId: 77, certificateId: 21, fieldName: 'name', masterKey: 'small' },
        extents: { fieldValue: { kind: 'utf16le', bytes: 100000000, sha256: 'cc'.repeat(32) } },
        cursor
      }
    ],
    payloadBytes: 2048,
    done: false,
    cursor
  }
}

test('field ID references match full-row dependencies without accessing payloads or notifications', () => {
  const row: TableOutput = {
      outputId: 1,
      userId: 77,
      transactionId: 2,
      basketId: 3,
      spentBy: 4,
      created_at: new Date('2026-01-01'),
      updated_at: new Date('2026-01-01'),
      spendable: false,
      change: false,
      satoshis: 1,
      outputDescription: '',
      vout: 0,
      type: '',
      providedBy: 'you',
      purpose: ''
    },
    metadata = collectSnapshotSyncFieldReferences(77, 'outputs', [{ ...row }]),
    full = collectSnapshotSyncReferences(77, 'outputs', {
      userIdentityKey: cp.identityKey,
      fromStorageIdentityKey: 'source',
      toStorageIdentityKey: 'target',
      outputs: [row]
    })
  expect(metadata).toEqual(full)
  const request = { provenTxReqId: 5, provenTxId: 6 }
  Object.defineProperty(request, 'notify', {
    get: () => {
      throw new Error('Notification payload must not be hydrated')
    }
  })
  const refs = collectSnapshotSyncFieldReferences(77, 'provenTxReqs', [request])
  expect(refs.wanted.get('provenTxReq')).toEqual(new Set([5]))
  expect(refs.required.get('provenTx')).toEqual(new Set([6]))
  row.transactionId = 999
  expect(metadata.required.get('transaction')).toEqual(new Set([2, 4]))
})

test('field references reject another profile and ID getters without calling them', () => {
  expect(() => collectSnapshotSyncFieldReferences(77, 'certificateFields', [{ userId: 78, certificateId: 1 }])).toThrow(
    'profile'
  )
  let called = false
  const row = { userId: 77 }
  Object.defineProperty(row, 'certificateId', {
    enumerable: true,
    get: () => {
      called = true
      return 1
    }
  })
  expect(() => collectSnapshotSyncFieldReferences(77, 'certificateFields', [row])).toThrow('scalar')
  expect(called).toBe(false)
})

test('large fields remain descriptors and all caller metadata/positions detach before provider admission', () => {
  const input = page(),
    captured = detachSnapshotSyncFieldPage(cp, input)
  input.rows[0].fields.userId = 999
  input.rows[0].fields.updated_at!.setUTCFullYear(2030)
  Reflect.set(input.rows[0].extents.fieldValue, 'bytes', 2)
  Reflect.set(input.rows[0].cursor.after, '0', 'other')
  expect(captured.rows[0].fields.userId).toBe(77)
  expect((captured.rows[0].fields.updated_at as Date).toISOString()).toBe('2026-02-01T00:00:00.000Z')
  expect(captured.rows[0].extents.fieldValue.bytes).toBe(100000000)
  expect(captured.rows[0].cursor.after).toEqual(['name', 21])
  expect(captured.nextTable).toBe(9)
  expect(JSON.parse(captured.nextCursor!)).toEqual(captured.rows[0].cursor)
})

test.each(['collision', 'odd text', 'position', 'undercharge', 'getter', 'duplicate'])(
  'field page refuses %s before a source/provider operation',
  failure => {
    const input = page()
    if (failure === 'collision') Reflect.set(input.rows[0].fields, 'fieldValue', 'payload')
    if (failure === 'odd text') Reflect.set(input.rows[0].extents.fieldValue, 'bytes', 3)
    if (failure === 'position') input.rows[0].fields.fieldName = 'other'
    if (failure === 'undercharge') input.payloadBytes = 1
    if (failure === 'getter')
      Object.defineProperty(input.rows[0].fields, 'userId', {
        enumerable: true,
        get: () => {
          throw new Error('Getter executed')
        }
      })
    if (failure === 'duplicate') input.rows.push(input.rows[0])
    expect(() => detachSnapshotSyncFieldPage(cp, input)).toThrow()
  }
)
