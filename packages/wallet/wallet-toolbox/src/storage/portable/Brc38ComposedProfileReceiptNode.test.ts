import {
  copyBrc38ComposedProfileReceipt,
  readBrc38ComposedProfileReceipt,
  type Brc38ComposedProfileReceipt
} from './Brc38ComposedProfileReceiptNode'
import { snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'

// UNRUN original-lineage DATA cases; no native claim, semantic qualification,
// prepared publication, durable source retirement or manager selection grant.
describe('composed profile original lineage data', () => {
  const receipt = (): Brc38ComposedProfileReceipt => ({
    protocol: 'brc38-composed-profile/v1',
    decisionId: '00000000-0000-4000-8000-000000000001',
    source: {
      inventory: {
        rootId: '00000000-0000-4000-8000-000000000002',
        profileId: '00000000-0000-4000-8000-000000000003',
        policySha256: 'a'.repeat(64)
      },
      fixedSha256: 'b'.repeat(64),
      copySha256: 'c'.repeat(64),
      copyBytes: 4096,
      epoch: '00000000-0000-4000-8000-000000000004',
      revision: snapshotJournalRevision('9223372036854775807'),
      primaryEpoch: snapshotJournalRevision('9007199254740993'),
      userId: 1,
      activeStorage: 'original-selected-provider'
    },
    image: {
      protocol: 'brc38-composed-database-image/v1',
      sha256: 'd'.repeat(64),
      schemaObjects: 200,
      tables: 80,
      rows: '9007199254740993',
      cellBytes: '9007199254740994'
    },
    maximumReadBytes: 1
  })
  test('canonical signed64 and unrounded image counters survive independent capture and persisted read', () => {
    const input = receipt(),
      value = copyBrc38ComposedProfileReceipt(input)
    expect(readBrc38ComposedProfileReceipt(JSON.stringify(value))).toEqual(value)
    expect(value).not.toBe(input)
    expect(value.source).not.toBe(input.source)
    expect(value.source.inventory).not.toBe(input.source.inventory)
    expect(value.image).not.toBe(input.image)
    expect(Object.isFrozen(value.source.inventory)).toBe(true)
    expect(Object.isFrozen(value.image)).toBe(true)
    Object.assign(input.source.inventory, { profileId: '00000000-0000-4000-8000-000000000005' })
    Object.assign(input.image, { rows: '0' })
    expect(value.source.inventory.profileId).toBe('00000000-0000-4000-8000-000000000003')
    expect(value.image.rows).toBe('9007199254740993')
  })
  test('unknown nested members, accessors and noncanonical persisted forms refuse without invoking the accessor', () => {
    const input = receipt()
    for (const changed of [
      { ...input, unexpected: true },
      { ...input, source: { ...input.source, unexpected: true } },
      { ...input, source: { ...input.source, inventory: { ...input.source.inventory, unexpected: true } } },
      { ...input, image: { ...input.image, unexpected: true } }
    ])
      expect(() => copyBrc38ComposedProfileReceipt(changed)).toThrow('lineage data')
    let invoked = false
    Object.defineProperty(input, 'decisionId', {
      enumerable: true,
      get: () => {
        invoked = true
        return 'substituted'
      }
    })
    expect(() => copyBrc38ComposedProfileReceipt(input)).toThrow('lineage data')
    expect(invoked).toBe(false)
    const value = receipt(),
      { source, ...rest } = value
    expect(() => readBrc38ComposedProfileReceipt(JSON.stringify({ source, ...rest }))).toThrow('lineage data')
    expect(() => readBrc38ComposedProfileReceipt(JSON.stringify(value, null, 2))).toThrow('lineage data')
    expect(() => readBrc38ComposedProfileReceipt(' '.repeat(4097))).toThrow('lineage data')
  })
  test('invalid source generation, physical lineage, image type and original read allowance refuse', () => {
    const input = receipt()
    for (const changed of [
      { ...input, maximumReadBytes: 0 },
      { ...input, maximumReadBytes: 16385 },
      { ...input, source: { ...input.source, revision: '01' as Brc38ComposedProfileReceipt['source']['revision'] } },
      {
        ...input,
        source: {
          ...input.source,
          primaryEpoch: '9223372036854775808' as Brc38ComposedProfileReceipt['source']['primaryEpoch']
        }
      },
      { ...input, source: { ...input.source, copyBytes: 4095 } },
      { ...input, source: { ...input.source, fixedSha256: 'B'.repeat(64) } },
      { ...input, source: { ...input.source, activeStorage: '' } },
      { ...input, image: { ...input.image, tables: 46 } },
      { ...input, image: { ...input.image, rows: '01' } },
      { ...input, image: { ...input.image, cellBytes: '36028797018963965' } }
    ])
      expect(() => copyBrc38ComposedProfileReceipt(changed)).toThrow()
  })
})
