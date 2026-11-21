import { planCertificateMerge } from './EntityCertificate'
import { planCertificateFieldMerge } from './EntityCertificateField'

const dates = { created_at: new Date('2026-01-01'), updated_at: new Date('2026-02-01') }
test('certificate selection keeps local identity/creation/certifier and copies only newer legacy mutable properties', () => {
  const old: Readonly<{ kind: 'utf16le'; bytes: number; sha256: string }> = Object.freeze({
      kind: 'utf16le',
      bytes: 100000000,
      sha256: 'aa'.repeat(32)
    }),
    newer = Object.freeze({ kind: 'utf16le', bytes: 200000000, sha256: 'bb'.repeat(32) }),
    current = {
      ...dates,
      certificateId: 3,
      userId: 1,
      type: 'old-type',
      certifier: 'current-certifier',
      serialNumber: 'serial',
      subject: old,
      revocationOutpoint: old,
      signature: old,
      verifier: old,
      isDeleted: false
    },
    incoming = {
      ...current,
      created_at: new Date('2020-01-01'),
      updated_at: new Date('2026-03-01'),
      certificateId: 21,
      userId: 77,
      type: 'new-type',
      certifier: 'incoming-certifier',
      subject: newer,
      revocationOutpoint: newer,
      signature: newer,
      verifier: undefined,
      isDeleted: true
    },
    selected = planCertificateMerge(current, incoming)!
  expect(selected).toEqual({
    ...current,
    type: 'new-type',
    subject: newer,
    revocationOutpoint: newer,
    signature: newer,
    verifier: undefined,
    isDeleted: true,
    updated_at: incoming.updated_at
  })
  expect(selected.signature).toBe(newer)
  expect(selected.updated_at).not.toBe(incoming.updated_at)
  expect(planCertificateMerge(current, { ...incoming, updated_at: dates.updated_at })).toBeUndefined()
  expect(current.signature).toBe(old)
})

test('certificate-field selection retains original natural/local identity and requires a strictly newer timestamp', () => {
  const a: Readonly<{ kind: 'utf16le'; bytes: number }> = Object.freeze({ kind: 'utf16le', bytes: 2000000 }),
    b = Object.freeze({ kind: 'utf16le', bytes: 4000000 }),
    current = { ...dates, certificateId: 3, userId: 1, fieldName: 'name', fieldValue: a, masterKey: a },
    incoming = {
      ...current,
      certificateId: 21,
      userId: 77,
      fieldName: 'incoming',
      created_at: new Date('2020-01-01'),
      updated_at: new Date('2026-03-01'),
      fieldValue: b,
      masterKey: b
    }
  expect(planCertificateFieldMerge(current, incoming)).toEqual({
    ...current,
    fieldValue: b,
    masterKey: b,
    updated_at: incoming.updated_at
  })
  expect(planCertificateFieldMerge(current, { ...incoming, updated_at: dates.updated_at })).toBeUndefined()
})
