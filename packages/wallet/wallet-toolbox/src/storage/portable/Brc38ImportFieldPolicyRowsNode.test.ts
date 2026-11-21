import { createHash } from 'node:crypto'
import { createSyncMap } from '../schema/entities/EntityBase'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import { decodePortableRow } from './Brc38PortableRows'
import { brc38ImportRowForm } from './Brc38ImportForms'
import { snapshotSyncTransactionMetadata } from '../snapshot/SnapshotSyncActionMetadata'
import { nativeSimplePayloadRow } from '../snapshot/NativeSnapshotSyncSimpleRows'
import {
  prepareBrc38ImportOriginalFieldPolicy,
  prepareBrc38ImportCurrentFieldPolicy,
  selectBrc38ImportExistingFieldPolicy,
  type Brc38ImportFieldPolicyTable,
  type Brc38ImportPolicyField
} from './Brc38ImportFieldPolicyRowsNode'
import type { Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import type { Brc38ImportExistingFieldRow } from './Brc38ImportExistingRows'

// Independent finite DATA fixtures. These cases do not admit an archive, claim
// native provenance or grant any field/write/primary/receipt effect. UNRUN.
const payloads: Readonly<Record<Brc38ImportFieldPolicyTable, readonly string[]>> = {
    provenTxs: ['rawTx', 'merklePath'],
    transactions: [
      'rawTx',
      'inputBEEF',
      'noSendExpiryReclaimRawTx',
      'description',
      'noSendExpiryReclaimDerivationPrefix',
      'noSendExpiryReclaimDerivationSuffix'
    ],
    outputs: [
      'lockingScript',
      'outputDescription',
      'spendingDescription',
      'customInstructions',
      'derivationPrefix',
      'derivationSuffix',
      'type',
      'purpose'
    ],
    commissions: ['lockingScript', 'keyOffset'],
    certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
    certificateFields: ['fieldValue', 'masterKey'],
    provenTxReqs: ['rawTx', 'inputBEEF', 'history', 'notify'],
    syncStates: ['syncMap', 'errorLocal', 'errorOther']
  },
  binary = new Set(['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx', 'merklePath', 'lockingScript']),
  structured = new Set(['history', 'notify', 'syncMap', 'errorLocal', 'errorOther']),
  hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex'),
  budget = () => ({ maximum: 16777216, remaining: 16777216 }),
  original = (table: Brc38ImportFieldPolicyTable): Record<string, unknown> => {
    const row = decodePortableRow<Record<string, unknown>>(
      brc38ImportRowForm(table).kind,
      semanticStageFixture().tables[table][0]
    )
    // Policy DATA requires a wallet SyncStatus, distinct from TX status.
    if (table === 'syncStates') row.status = 'unknown'
    return row
  }
function incoming(table: Brc38ImportFieldPolicyTable, row: Record<string, unknown>) {
  const metadata = { ...row },
    source: Brc38JsonStreamedRow = { fields: {}, binaries: {}, structured: {}, texts: {} },
    binaries: Record<string, { field: string; encoding: 'base64'; bytes: number; sha256: string }> = {},
    json: Record<string, { field: string; encoding: 'utf8-json'; bytes: number; sha256: string }> = {},
    texts: Record<string, { field: string; encoding: 'utf8'; bytes: number; sha256: string }> = {}
  for (const name of payloads[table]) {
    const value = row[name]
    if (value == null) continue
    if (binary.has(name)) continue // Exercise actual independent decoded inline bytes.
    const bytes = Buffer.from(String(value), 'utf8')
    if (structured.has(name))
      json[name] = { field: name, encoding: 'utf8-json', bytes: bytes.length, sha256: hash(bytes) }
    else texts[name] = { field: name, encoding: 'utf8', bytes: bytes.length, sha256: hash(bytes) }
    delete metadata[name]
  }
  return prepareBrc38ImportOriginalFieldPolicy(
    table,
    0,
    metadata,
    { ...source, binaries, structured: json, texts },
    budget()
  )
}
function current(table: Brc38ImportFieldPolicyTable, row: Record<string, unknown>) {
  const metadata = { ...row },
    binaries: Record<string, { bytes: number; sha256: string }> = {},
    texts: Record<string, { bytes: number; sha256: string }> = {},
    json: Record<string, { bytes: number; sha256: string }> = {}
  for (const name of payloads[table]) {
    const value = row[name]
    delete metadata[name]
    if (value == null) continue
    const bytes = binary.has(name) ? Buffer.from(value as number[]) : Buffer.from(String(value), 'utf8'),
      descriptor = { bytes: bytes.length, sha256: hash(bytes) }
    if (binary.has(name)) binaries[name] = descriptor
    else {
      texts[name] = descriptor
      if (structured.has(name)) json[name] = descriptor
    }
  }
  const selected: Brc38ImportExistingFieldRow = {
    table,
    metadata: { ...metadata, created_at: row.created_at as Date, updated_at: row.updated_at as Date },
    binaries,
    texts,
    structured: json,
    binaryRowId: 43,
    textRowId: table === 'syncStates' ? -7 : 43,
    allocationBytes: 32768
  }
  return prepareBrc38ImportCurrentFieldPolicy(selected, budget())!
}
test.each(Object.keys(payloads) as Brc38ImportFieldPolicyTable[])(
  'complete archive %s preserves zero/signed IDs and actual field DATA',
  table => {
    const row = original(table),
      form = brc38ImportRowForm(table)
    if (Object.hasOwn(row, 'userId')) row.userId = 0
    if (form.id !== undefined) row[form.id] = -7
    const selected = incoming(table, row)
    expect(selected.table).toBe(table)
    if (form.id !== undefined) expect(Reflect.get(selected.value, form.id)).toBe(-7)
    for (const name of payloads[table]) {
      if (row[name] == null) continue
      const field = Reflect.get(selected.value, name) as Brc38ImportPolicyField,
        bytes = binary.has(name) ? Buffer.from(row[name] as number[]) : Buffer.from(String(row[name]), 'utf8')
      expect(field).toMatchObject({
        field: name,
        sourceIndex: 0,
        origin: binary.has(name) ? 'inline' : 'original',
        bytes: bytes.length,
        sha256: hash(bytes)
      })
      expect(Object.hasOwn(field, 'readFieldExtent')).toBe(false)
    }
  }
)
test('archive scalar parsers preserve original IDs without relaxing native producer IDs', () => {
  const transaction = original('transactions')
  transaction.userId = 0
  transaction.transactionId = -1
  expect(incoming('transactions', transaction).table).toBe('transactions')
  expect(() => snapshotSyncTransactionMetadata(transaction, {})).toThrow()
  const certificate = original('certificates')
  certificate.userId = 0
  certificate.certificateId = -1
  expect(incoming('certificates', certificate).table).toBe('certificates')
  expect(() => nativeSimplePayloadRow('certificates', certificate, {})).toThrow()
})
test('commission selection retains current value, parent and exact payload DATA while updating redemption', () => {
  const old = original('commissions'),
    next = {
      ...old,
      commissionId: -17,
      userId: 0,
      transactionId: -29,
      isRedeemed: true,
      satoshis: 999999,
      keyOffset: 'incoming',
      lockingScript: [6, 7],
      updated_at: new Date((old.updated_at as Date).getTime() + 1)
    },
    before = current('commissions', old),
    result = selectBrc38ImportExistingFieldPolicy(before, incoming('commissions', next), createSyncMap())
  if (before.table !== 'commissions' || result?.row.table !== 'commissions') throw new Error('Expected commission DATA')
  expect(result.row.value.userId).toBe(before.value.userId)
  expect(result.row.value.transactionId).toBe(before.value.transactionId)
  expect(result.row.value.satoshis).toBe(before.value.satoshis)
  expect(result.row.value.lockingScript).toBe(before.value.lockingScript)
  expect(result.row.value.keyOffset).toBe(before.value.keyOffset)
  expect(result.row.value.isRedeemed).toBe(true)
})
test('certificate and composite certificate-field selection replace newer incoming fields and preserve current identity', () => {
  for (const table of ['certificates', 'certificateFields'] as const) {
    const old = original(table),
      next = { ...old, userId: 0, certificateId: -21, updated_at: new Date((old.updated_at as Date).getTime() + 1) },
      before = current(table, old),
      received = incoming(table, next),
      result = selectBrc38ImportExistingFieldPolicy(before, received, createSyncMap())
    expect(Reflect.get(result!.row.value, 'userId')).toBe(Reflect.get(before.value, 'userId'))
    expect(Reflect.get(result!.row.value, 'certificateId')).toBe(Reflect.get(before.value, 'certificateId'))
    for (const name of payloads[table])
      if (Reflect.get(next, name) != null)
        expect(Reflect.get(result!.row.value, name)).toBe(Reflect.get(received.value, name))
    expect(selectBrc38ImportExistingFieldPolicy(before, incoming(table, old), createSyncMap())).toBeUndefined()
  }
})
test('request metadata keeps current status, attempts and payload/history references pending independent history preparation', () => {
  const old = original('provenTxReqs'),
    next = {
      ...old,
      attempts: 999,
      notified: true,
      rawTx: [9],
      history: '{"incoming":true}',
      notify: '{"transactionIds":[99]}',
      updated_at: new Date((old.updated_at as Date).getTime() + 1)
    },
    before = current('provenTxReqs', old),
    result = selectBrc38ImportExistingFieldPolicy(before, incoming('provenTxReqs', next), createSyncMap())
  if (before.table !== 'provenTxReqs' || result?.row.table !== 'provenTxReqs') throw new Error('Expected request DATA')
  for (const name of ['status', 'attempts', 'notified', 'rawTx', 'history', 'notify'] as const)
    expect(result.row.value[name]).toBe(before.value[name])
})
test.each(['success', 'error', 'identified', 'updated', 'unknown'] as const)(
  'archived sync-state %s never changes current operational progress',
  status => {
    const old = { ...original('syncStates'), status },
      before = current('syncStates', old),
      received = incoming('syncStates', { ...old, syncStateId: -9, init: true })
    expect(selectBrc38ImportExistingFieldPolicy(before, received, createSyncMap())).toBeUndefined()
  }
)
test('field policy refuses partial, overlapping and invalid inline DATA before supplying a complete form', () => {
  const row = original('certificates')
  delete row.subject
  expect(() =>
    prepareBrc38ImportOriginalFieldPolicy('certificates', 0, row, { fields: {}, binaries: {} }, budget())
  ).toThrow()
  const proof = original('provenTxs')
  proof.rawTx = [256]
  expect(() => incoming('provenTxs', proof)).toThrow()
  const limited = { maximum: 16384, remaining: 16384 }
  expect(() =>
    prepareBrc38ImportOriginalFieldPolicy('provenTxs', 0, original('provenTxs'), { fields: {}, binaries: {} }, limited)
  ).toThrow()
  const good = original('certificates'),
    bytes = Buffer.from(String(good.subject)),
    descriptor = {
      field: 'subject',
      encoding: 'utf8' as const,
      bytes: bytes.length,
      sha256: hash(bytes)
    }
  expect(() =>
    prepareBrc38ImportOriginalFieldPolicy(
      'certificates',
      0,
      good,
      { fields: {}, binaries: {}, texts: { subject: descriptor } },
      budget()
    )
  ).toThrow()
  expect(() =>
    selectBrc38ImportExistingFieldPolicy(
      current('provenTxs', original('provenTxs')),
      incoming('provenTxs', original('provenTxs')),
      createSyncMap()
    )
  ).toThrow()
})

test.each(['completed', '', null, 1])(
  'invalid sync-state status %p remains refused in original and current DATA',
  status => {
    const row = { ...original('syncStates'), status }
    expect(() => incoming('syncStates', row)).toThrow('Private import field policy differs')
    expect(() => current('syncStates', row)).toThrow('Private import field policy differs')
  }
)
