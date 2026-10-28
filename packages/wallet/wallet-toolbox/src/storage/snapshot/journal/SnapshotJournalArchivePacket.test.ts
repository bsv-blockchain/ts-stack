import { createHash } from 'node:crypto'
import {
  encodeSnapshotJournalArchiveFrame,
  encodeSnapshotJournalArchiveIdentities,
  encodeSnapshotJournalArchiveIdentityGroups,
  decodeSnapshotJournalArchivePacket
} from './SnapshotJournalArchivePacket'
import {
  hashSnapshotJournalReceiptBinding,
  parseSnapshotJournalReceiptBindingData,
  parseSnapshotJournalReceiptData
} from './SnapshotJournalReceiptData'
import { encodeSnapshotJournalDeltaFrame } from './SnapshotJournalDeltaFrame'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import type { SnapshotJournalDeltaPage, SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'

const high = snapshotJournalRevision('9223372036854775807'),
  context = { stream: 'scope' as const, tableId: 3 },
  binding = {
    backend: '11'.repeat(32),
    epoch: '12345678-1234-4234-9234-123456789012',
    source: '22'.repeat(32),
    schema: '33'.repeat(32),
    storageIdentity: 'opaque é\u0000😀',
    identityKey: '02' + '44'.repeat(32),
    userId: 7,
    chain: 'test'
  }
function page(): SnapshotJournalDeltaPage {
  return {
    table: 'txLabels',
    changes: [
      {
        present: true,
        metadata: { revision: high, id1: 4, id2: 0, exactText: '', present: true },
        row: {
          txLabelId: 4,
          userId: 7,
          label: 'é\u0000😀',
          raw: Uint8Array.of(0, 128, 255),
          created_at: new Date('2026-01-01T00:00:00.000Z')
        }
      }
    ],
    examined: 1,
    payloadBytes: 1024,
    complete: true,
    after: { revision: high, id1: 4, id2: 0, exactText: '' }
  }
}
function identity(): SnapshotJournalSourceIdentity {
  return {
    tableId: 3,
    incomingId: 4,
    generation: snapshotJournalRevision('9007199254740993'),
    revision: high,
    naturalIdentity: '55'.repeat(32),
    naturalKey: { tableId: 3, label: 'é\u0000😀' },
    required: false
  }
}

test('portable receipt DATA has the unchanged independent SHA-256 preimage, exact64-bit positions and no lease grant', () => {
  const parsed = parseSnapshotJournalReceiptBindingData(binding),
    digest = createHash('sha256')
      .update(
        'snapshot-journal-receipt-binding-v1\n' +
          JSON.stringify([
            binding.backend,
            binding.epoch,
            binding.source,
            binding.schema,
            binding.storageIdentity,
            binding.identityKey,
            binding.userId,
            binding.chain
          ])
      )
      .digest('hex')
  expect(hashSnapshotJournalReceiptBinding(parsed)).toBe(digest)
  // Expiry is offline DATA here; current admission belongs to the real owner.
  expect(
    parseSnapshotJournalReceiptData(
      { requestId: '66'.repeat(32), binding: digest, highWater: high, floor: '9007199254740993', expiresAt: 1 },
      parsed
    )
  ).toMatchObject({ highWater: high, expiresAt: 1 })
  expect(() =>
    parseSnapshotJournalReceiptData(
      { requestId: '66'.repeat(32), binding: '77'.repeat(32), highWater: high, floor: '0', expiresAt: 1 },
      parsed
    )
  ).toThrow()
  const getter = jest.fn(() => binding.epoch)
  const actualAccessor = Object.defineProperty({ ...binding }, 'epoch', { get: getter, enumerable: true })
  expect(() => parseSnapshotJournalReceiptBindingData(actualAccessor)).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() => parseSnapshotJournalReceiptBindingData({ ...binding, storageIdentity: '\ud800' })).toThrow()
  expect(() => parseSnapshotJournalReceiptBindingData({ ...binding, grant: true })).toThrow()
})

test('journal frames and binding hashes operate without a global Buffer and preserve original frame bytes', () => {
  const source = page(),
    expected = encodeSnapshotJournalDeltaFrame(source, context),
    original = globalThis.Buffer
  let encoded: Uint8Array | undefined, digest: string | undefined
  try {
    Reflect.set(globalThis, 'Buffer', undefined)
    encoded = encodeSnapshotJournalArchiveFrame(context, source)
    digest = hashSnapshotJournalReceiptBinding(binding)
  } finally {
    Reflect.set(globalThis, 'Buffer', original)
  }
  expect(digest).toMatch(/^[0-9a-f]{64}$/)
  const length = new DataView(encoded!.buffer).getUint32(0, false)
  expect(encoded!.subarray(4 + length)).toEqual(expected)
  expect(decodeSnapshotJournalArchivePacket(encoded!, context, high)).toMatchObject({ kind: 'frame', page: source })
})

test('separate bounded identity prefixes round-trip exact keys and revisions without invoking Map or cell accessors', () => {
  const value = identity(),
    map = new Map([['3:4', value]]),
    getter = jest.fn(() => 1000000)
  Object.defineProperty(map, 'size', { get: getter })
  const encoded = encodeSnapshotJournalArchiveIdentities(context, '88'.repeat(32), 0, map, high)
  expect(getter).not.toHaveBeenCalled()
  const decoded = decodeSnapshotJournalArchivePacket(encoded, context, high)
  if (decoded.kind !== 'identities') throw new Error('Expected identity packet')
  expect([...decoded.identities]).toEqual([['3:4', value]])
  expect(decoded.identities.get('3:4')).not.toBe(value)
  const accessor = Object.defineProperty({ ...value }, 'naturalKey', { get: getter, enumerable: true })
  expect(() =>
    encodeSnapshotJournalArchiveIdentities(context, '88'.repeat(32), 0, new Map([['3:4', accessor]]), high)
  ).toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(() =>
    encodeSnapshotJournalArchiveIdentities(context, '88'.repeat(32), 0, new Map([['3:5', value]]), high)
  ).toThrow()
})

test('framing, context, high-water and digest failures refuse before an artifact or writer can be admitted', () => {
  const encoded = encodeSnapshotJournalArchiveFrame(context, page()),
    getter = jest.fn(() => Number.MAX_SAFE_INTEGER)
  Object.defineProperty(encoded, 'byteLength', { get: getter })
  expect(decodeSnapshotJournalArchivePacket(encoded, context, high).kind).toBe('frame')
  expect(getter).not.toHaveBeenCalled()
  expect(() => decodeSnapshotJournalArchivePacket(encoded, { stream: 'scope', tableId: 4 }, high)).toThrow()
  expect(() =>
    decodeSnapshotJournalArchivePacket(encoded, context, snapshotJournalRevision('9007199254740993'))
  ).toThrow()
  const corrupt = encoded.slice()
  corrupt[corrupt.length - 1] ^= 1
  expect(() => decodeSnapshotJournalArchivePacket(corrupt, context, high)).toThrow()
  const truncated = encoded.slice(0, 6)
  expect(() => decodeSnapshotJournalArchivePacket(truncated, context, high)).toThrow()
  const impossible = new Uint8Array(4)
  new DataView(impossible.buffer).setUint32(0, 0xffffffff)
  expect(() => decodeSnapshotJournalArchivePacket(impossible, context, high)).toThrow()
})

test('grouped prefixes preserve change boundaries and exact maps within one fixed128-identity packet', () => {
  const groups = Array.from({ length: 8 }, (_, changeIndex) => ({
      changeIndex,
      identities: new Map([['3:4', identity()]])
    })),
    encoded = encodeSnapshotJournalArchiveIdentityGroups(context, '88'.repeat(32), groups, high),
    decoded = decodeSnapshotJournalArchivePacket(encoded, context, high)
  if (decoded.kind !== 'identity-groups') throw new Error('Expected actual identity group packet')
  expect(decoded.groups.map(group => ({ changeIndex: group.changeIndex, identities: [...group.identities] }))).toEqual(
    groups.map(group => ({ changeIndex: group.changeIndex, identities: [...group.identities] }))
  )
  const tooMany = Array.from({ length: 2 }, (_, changeIndex) => ({
    changeIndex,
    identities: new Map(
      Array.from({ length: 65 }, (_, index) => {
        const value = { ...identity(), incomingId: index + 1 }
        return ['3:' + value.incomingId, value] as const
      })
    )
  }))
  expect(() => encodeSnapshotJournalArchiveIdentityGroups(context, '88'.repeat(32), tooMany, high)).toThrow('bound')
})
