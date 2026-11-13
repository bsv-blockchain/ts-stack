import 'fake-indexeddb/auto'
import { runInNewContext } from 'node:vm'
import { packedIdbCurrentMetadataEqual, type PackedIdbCurrentMetadata } from '../idbPackedCurrentMetadata'
import { verifyIdbSnapshotSyncCertificateFields } from './IdbSnapshotSyncCertificateFields.browser.case'

// Emulated component coverage only; actual browser qualification needs the
// fresh original controller and complete frozen implementation admission.
test('actual occupied certificate fields stream, fence concurrent changes and commit a durable ACK', async () => {
  await verifyIdbSnapshotSyncCertificateFields(Date.now() + 30000)
}, 30000)

function comparedMetadata(): { -readonly [Key in keyof PackedIdbCurrentMetadata]: PackedIdbCurrentMetadata[Key] } {
  return {
    store: 'certificate_fields',
    key: [1, 'name'],
    revision: 17,
    fields: { fieldName: 'name', fieldValue: 'value', updated_at: new Date('2026-01-01') },
    extents: { fieldValue: { kind: 'utf16', content: 'a'.repeat(32), bytes: 10, sha256: 'b'.repeat(64) } },
    allocationBytes: 512
  }
}

test('shared metadata comparison repeats full current data comparison without retaining a verdict', () => {
  const before = comparedMetadata(),
    current = comparedMetadata()
  expect(packedIdbCurrentMetadataEqual(before, current)).toBe(true)
  expect(packedIdbCurrentMetadataEqual(undefined, undefined)).toBe(true)
  expect(packedIdbCurrentMetadataEqual(before, undefined)).toBe(false)
  expect(packedIdbCurrentMetadataEqual(undefined, current)).toBe(false)
  current.fields = { ...current.fields, fieldValue: 'changed after the first comparison' }
  expect(packedIdbCurrentMetadataEqual(before, current)).toBe(false)
  expect(before.fields.fieldValue).toBe('value')
})

test.each([
  'store',
  'revision',
  'key',
  'missingField',
  'extraField',
  'date',
  'missingExtent',
  'extraExtent',
  'kind',
  'content',
  'bytes',
  'sha256'
])('metadata comparison rejects a changed %s independently', change => {
  const before = comparedMetadata(),
    current = comparedMetadata()
  if (change === 'store') current.store = 'certificates'
  else if (change === 'revision') current.revision++
  else if (change === 'key') current.key = [2, 'name']
  else if (change === 'missingField') current.fields = { fieldName: 'name', fieldValue: 'value' }
  else if (change === 'extraField') current.fields = { ...current.fields, absent: undefined }
  else if (change === 'date') current.fields = { ...current.fields, updated_at: new Date('2026-01-02') }
  else if (change === 'missingExtent') current.extents = {}
  else if (change === 'extraExtent') current.extents = { ...current.extents, extra: { ...current.extents.fieldValue } }
  else
    current.extents = {
      fieldValue: {
        ...current.extents.fieldValue,
        ...(change === 'kind'
          ? { kind: 'array' as const }
          : change === 'content'
            ? { content: 'c'.repeat(32) }
            : change === 'bytes'
              ? { bytes: 12 }
              : { sha256: 'd'.repeat(64) })
      }
    }
  expect(packedIdbCurrentMetadataEqual(before, current)).toBe(false)
})

test('metadata dates use genuine internal slots across realms and reject prototype copies', () => {
  const before = comparedMetadata(),
    current = comparedMetadata()
  current.fields = { ...current.fields, updated_at: runInNewContext("new Date('2026-01-01')") as unknown }
  expect(packedIdbCurrentMetadataEqual(before, current)).toBe(true)
  current.fields = { ...current.fields, updated_at: Object.create(Date.prototype) as unknown }
  expect(packedIdbCurrentMetadataEqual(before, current)).toBe(false)
  current.fields = { ...current.fields, updated_at: new Proxy(new Date('2026-01-01'), {}) }
  expect(packedIdbCurrentMetadataEqual(before, current)).toBe(false)
})
