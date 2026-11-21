import {
  nativeSimplePayloadRow,
  nativeSimplePayloadMerge,
  nativeSimplePayloadMetadata
} from './NativeSnapshotSyncSimpleRows'

const oldDate = new Date('2020-01-01T00:00:00Z'),
  newDate = new Date('2020-01-02T00:00:00Z'),
  common = { created_at: oldDate, updated_at: oldDate, userId: 9 },
  cert = {
    ...common,
    certificateId: 4,
    type: 'type',
    certifier: 'certifier',
    serialNumber: 'serial',
    isDeleted: false
  },
  strings = { subject: 'old subject', revocationOutpoint: 'old revocation', signature: 'old signature' },
  extent = { kind: 'utf8' as const, bytes: 131072, sha256: 'a'.repeat(64) }
test('native certificate selection preserves original local identity and replaces only newer incoming payload DATA', () => {
  const current = nativeSimplePayloadRow('certificates', { ...cert, ...strings }, {}),
    incoming = nativeSimplePayloadRow(
      'certificates',
      {
        ...cert,
        userId: 27,
        certificateId: 84,
        updated_at: newDate,
        revocationOutpoint: '',
        signature: 'new signature',
        isDeleted: true
      },
      { subject: extent }
    ),
    result = nativeSimplePayloadMerge(current, incoming, 9)
  expect(result?.table).toBe('certificates')
  if (result?.table !== 'certificates') throw new Error('Expected certificate policy form')
  expect(result.value.certificateId).toBe(4)
  expect(result.value.userId).toBe(9)
  expect(result.value.created_at).toEqual(oldDate)
  expect(result.value.updated_at).toEqual(newDate)
  expect(result.value.subject).toBe(extent)
  expect(result.value.verifier).toBeUndefined()
  expect(nativeSimplePayloadMetadata(result, true)).toEqual({
    ...cert,
    updated_at: newDate,
    isDeleted: true,
    revocationOutpoint: '',
    signature: 'new signature',
    verifier: undefined
  })
  expect(nativeSimplePayloadMerge(current, current, 9)).toBeUndefined()
})
test('native certificate-field parent remap preserves composite identity and original timestamp policy', () => {
  const incoming = nativeSimplePayloadRow(
      'certificateFields',
      { ...common, certificateId: 99, fieldName: 'real field', masterKey: 'key' },
      { fieldValue: extent }
    ),
    result = nativeSimplePayloadMerge(undefined, incoming, 9, 4)
  expect(result?.table).toBe('certificateFields')
  if (result?.table !== 'certificateFields') throw new Error('Expected composite certificate-field policy form')
  expect(result.value.certificateId).toBe(4)
  expect(result.value.fieldName).toBe('real field')
  expect(Object.hasOwn(result.value, 'certificateFieldId')).toBe(false)
  expect(result.value.fieldValue).toBe(extent)
  expect(() => nativeSimplePayloadMerge(undefined, incoming, 9, 0)).toThrow()
})
test('native commission redemption updates retain exact current value, parent and immutable payload references', () => {
  const script = { kind: 'binary' as const, bytes: 131072, sha256: 'b'.repeat(64) },
    fields = {
      ...common,
      commissionId: 17,
      transactionId: 21,
      satoshis: 100,
      isRedeemed: false,
      keyOffset: 'original'
    },
    current = nativeSimplePayloadRow('commissions', fields, { lockingScript: script }),
    incoming = nativeSimplePayloadRow(
      'commissions',
      {
        ...fields,
        userId: 29,
        commissionId: 35,
        transactionId: 81,
        satoshis: 999,
        isRedeemed: true,
        keyOffset: 'incoming',
        updated_at: newDate
      },
      { lockingScript: { ...script, sha256: 'c'.repeat(64) } }
    ),
    result = nativeSimplePayloadMerge(current, incoming, 9, 21)
  if (result?.table !== 'commissions') throw new Error('Expected commission policy form')
  expect(result.value.lockingScript).toBe(script)
  expect(result.value.keyOffset).toBe('original')
  expect(result.value.satoshis).toBe(100)
  expect(result.value.transactionId).toBe(21)
  expect(result.value.isRedeemed).toBe(true)
  expect(nativeSimplePayloadMetadata(result, true)).toEqual({
    ...common,
    updated_at: newDate,
    commissionId: 17,
    transactionId: 21,
    satoshis: 100,
    isRedeemed: true
  })
})
test('native scalar/field forms refuse hidden payloads and wrong coordinates instead of producing partial wallet DTOs', () => {
  expect(() => nativeSimplePayloadRow('certificates', { ...cert, ...strings }, { subject: extent })).toThrow()
  expect(() =>
    nativeSimplePayloadRow('certificates', { ...cert, ...strings }, { lockingScript: { kind: 'binary', bytes: 1 } })
  ).toThrow()
  expect(() => nativeSimplePayloadRow('certificates', { ...cert, ...strings, userId: 0 }, {})).toThrow()
})
