import type { SnapshotJournalDeltaPage } from './SnapshotJournalDeltaPage'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
import {
  decodeSnapshotJournalDeltaFrame,
  encodeSnapshotJournalDeltaFrame,
  SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES,
  type SnapshotJournalDeltaFrameContext
} from './SnapshotJournalDeltaFrame'

jest.setTimeout(30000)
const bound: SnapshotJournalDeltaFrameContext = { stream: 'scope', tableId: 3 }
const when = new Date('2026-01-01T00:00:00.000Z')

function page(): SnapshotJournalDeltaPage {
  const metadata = {
    revision: snapshotJournalRevision('9223372036854775807'),
    id1: 7,
    id2: 0,
    exactText: '',
    present: true
  }
  return {
    table: 'txLabels',
    changes: [
      {
        metadata,
        present: true,
        row: {
          txLabelId: 7,
          userId: 3,
          label: 'é\u0000😀',
          nullable: null,
          rawBoolean: 0,
          boolean: false,
          negativeZero: -0,
          integer64: 9223372036854775807n,
          minimum64: -9223372036854775808n,
          created_at: when,
          rawTx: Uint8Array.of(0, 128, 255)
        }
      }
    ],
    examined: 1,
    payloadBytes: 1024,
    complete: true,
    after: { revision: metadata.revision, id1: 7, id2: 0, exactText: '' }
  }
}

function envelope(bytes: Uint8Array): { header: Record<string, unknown>; body: Uint8Array } {
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false)
  return {
    header: JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))),
    body: bytes.subarray(4 + length)
  }
}

function corrupt(change: (header: Record<string, unknown>) => void, body?: Uint8Array): Uint8Array {
  const original = envelope(encodeSnapshotJournalDeltaFrame(page(), bound))
  change(original.header)
  const header = new TextEncoder().encode(JSON.stringify(original.header))
  const payload = body ?? original.body
  const result = new Uint8Array(4 + header.byteLength + payload.byteLength)
  new DataView(result.buffer).setUint32(0, header.byteLength, false)
  result.set(header, 4)
  result.set(payload, 4 + header.byteLength)
  return result
}

test('raw nullable, numeric, date, exact text and packed cells retain their representations', () => {
  const source = page()
  const encoded = encodeSnapshotJournalDeltaFrame(source, bound)
  const result = decodeSnapshotJournalDeltaFrame(encoded, bound)
  expect(result).toEqual(source)
  const row = result.changes[0]
  expect(row.present).toBe(true)
  if (!row.present) throw new Error('Expected raw row')
  expect(Object.hasOwn(row.row, 'nullable')).toBe(true)
  expect(row.row.nullable).toBeNull()
  expect(row.row.rawBoolean).toBe(0)
  expect(row.row.boolean).toBe(false)
  expect(Object.is(row.row.negativeZero, -0)).toBe(true)
  expect(row.row.integer64).toBe(9223372036854775807n)
  expect(row.row.minimum64).toBe(-9223372036854775808n)
  expect(row.row.created_at).toBeInstanceOf(Date)
  expect(row.row.rawTx).toBeInstanceOf(Uint8Array)
  expect(envelope(encoded).body).toEqual(Uint8Array.of(0, 128, 255))
})

test('encoded and decoded bytes and dates are detached from all caller inputs and earlier decodes', () => {
  const source = page(),
    encoded = encodeSnapshotJournalDeltaFrame(source, bound)
  const input = source.changes[0]
  if (!input.present) throw new Error('Expected raw row')
  ;(input.row.rawTx as Uint8Array).fill(42)
  const first = decodeSnapshotJournalDeltaFrame(encoded, bound)
  const row = first.changes[0]
  if (!row.present) throw new Error('Expected raw row')
  ;(row.row.rawTx as Uint8Array).fill(23)
  ;(row.row.created_at as Date).setTime(0)
  const second = decodeSnapshotJournalDeltaFrame(encoded, bound).changes[0]
  if (!second.present) throw new Error('Expected raw row')
  expect(second.row.rawTx).toEqual(Uint8Array.of(0, 128, 255))
  expect(second.row.created_at).toEqual(when)
  expect(second.row.created_at).not.toBe(when)
})

test('all thirteen observer-order table identities and exact certificate-field tombstones round trip', () => {
  const examples: Array<[SnapshotJournalDeltaPage['table'], Record<string, unknown>, number, string]> = [
    ['transactions', { transactionId: 7 }, 0, ''],
    ['outputs', { outputId: 7 }, 0, ''],
    ['certificates', { certificateId: 7 }, 0, ''],
    ['txLabels', { txLabelId: 7 }, 0, ''],
    ['outputBaskets', { basketId: 7 }, 0, ''],
    ['outputTags', { outputTagId: 7 }, 0, ''],
    ['commissions', { commissionId: 7 }, 0, ''],
    ['syncStates', { syncStateId: 7 }, 0, ''],
    ['provenTxs', { provenTxId: 7 }, 0, ''],
    ['provenTxReqs', { provenTxReqId: 7 }, 0, ''],
    ['txLabelMaps', { txLabelId: 7, transactionId: 9 }, 9, ''],
    ['outputTagMaps', { outputTagId: 7, outputId: 9 }, 9, ''],
    ['certificateFields', { certificateId: 7, fieldName: 'é\u0000😀' }, 0, 'é\u0000😀']
  ]
  examples.forEach(([table, row, id2, exactText], tableId) => {
    const metadata = {
      revision: snapshotJournalRevision('3'),
      id1: 7,
      id2,
      exactText,
      present: true
    }
    const data: SnapshotJournalDeltaPage = {
      table,
      changes: [{ metadata, present: true, row }],
      examined: 1,
      complete: true,
      payloadBytes: 256,
      after: { revision: metadata.revision, id1: 7, id2, exactText }
    }
    const context: SnapshotJournalDeltaFrameContext = { stream: 'scope', tableId }
    expect(decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(data, context), context)).toEqual(data)
    data.changes = [{ metadata: { ...metadata, present: false }, present: false }]
    expect(decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(data, context), context)).toEqual(data)
  })
})

test('physical irrelevant events consume the examined cursor and preserve the exact generation', () => {
  const metadata = {
    revision: snapshotJournalRevision('4'),
    id1: 7,
    id2: 0,
    exactText: '',
    present: true,
    generation: snapshotJournalRevision('3')
  }
  const data: SnapshotJournalDeltaPage = {
    table: 'provenTxs',
    changes: [{ metadata, present: true, row: { provenTxId: 7 } }],
    examined: 2,
    complete: false,
    payloadBytes: 1024,
    after: { revision: snapshotJournalRevision('5'), id1: 9, id2: 0, exactText: '' }
  }
  const context: SnapshotJournalDeltaFrameContext = { stream: 'physical', tableId: 8 }
  expect(decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(data, context), context)).toEqual(data)
  data.changes = []
  expect(decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(data, context), context)).toEqual(data)
})

test('empty completion retains an existing cursor and cannot claim unfinished zero progress', () => {
  const data = { ...page(), changes: [], examined: 0, payloadBytes: 0 }
  expect(decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(data, bound), bound)).toEqual(data)
  expect(() => encodeSnapshotJournalDeltaFrame({ ...data, complete: false }, bound)).toThrow('Invalid raw')
})

test('scope counts, identities, metadata, ordering and final cursors reject inconsistent input', () => {
  const invalid: Array<(value: SnapshotJournalDeltaPage) => void> = [
    value => {
      value.examined = 2
    },
    value => {
      value.after = undefined
    },
    value => {
      value.table = 'outputs'
    },
    value => {
      value.payloadBytes = -1
    },
    value => {
      value.examined = 257
    },
    value => {
      value.complete = 1 as unknown as boolean
    },
    value => {
      value.changes.push(value.changes[0])
      value.examined = 2
    },
    value => {
      value.changes[0].metadata.present = false
    },
    value => {
      value.changes[0].metadata.generation = snapshotJournalRevision('1')
    },
    value => {
      value.changes[0].metadata.exactText = 'unexpected'
    },
    value => {
      value.changes[0].metadata.id2 = 2
    },
    value => {
      if (value.changes[0].present) value.changes[0].row.txLabelId = 8
    },
    value => {
      if (value.after) value.after.id1 = 8
    }
  ]
  for (const change of invalid) {
    const data = page()
    change(data)
    expect(() => encodeSnapshotJournalDeltaFrame(data, bound)).toThrow()
  }
  for (const context of [
    { stream: 'physical', tableId: 3 },
    { stream: 'scope', tableId: 13 },
    { stream: 'scope', tableId: -1 }
  ])
    expect(() => encodeSnapshotJournalDeltaFrame(page(), context as SnapshotJournalDeltaFrameContext)).toThrow(
      'Invalid raw'
    )
})

test('flat own SQL cells reject unsupported values, oversized allocations, getters and sparse arrays', () => {
  for (const value of [
    undefined,
    {},
    [],
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date(Number.NaN),
    9223372036854775808n,
    -9223372036854775809n,
    '\ud800',
    'x'.repeat(SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES),
    new Uint8Array(SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES)
  ]) {
    const data = page()
    if (!data.changes[0].present) throw new Error('Expected raw row')
    data.changes[0].row.cell = value
    expect(() => encodeSnapshotJournalDeltaFrame(data, bound)).toThrow('Invalid raw')
  }
  const data = page()
  if (!data.changes[0].present) throw new Error('Expected raw row')
  const getter = jest.fn(() => 'should not run')
  Object.defineProperty(data.changes[0].row, 'accessor', { enumerable: true, get: getter })
  expect(() => encodeSnapshotJournalDeltaFrame(data, bound)).toThrow('Invalid raw')
  expect(getter).not.toHaveBeenCalled()
  const misleadingBytes = page()
  if (!misleadingBytes.changes[0].present) throw new Error('Expected raw row')
  const oversizedBytes = new Uint8Array(SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES)
  Object.defineProperty(oversizedBytes, 'byteLength', { get: getter })
  misleadingBytes.changes[0].row.rawTx = oversizedBytes
  expect(() => encodeSnapshotJournalDeltaFrame(misleadingBytes, bound)).toThrow('Invalid raw')
  expect(() => decodeSnapshotJournalDeltaFrame(oversizedBytes, bound)).toThrow()
  expect(getter).not.toHaveBeenCalled()
  const sparse = page()
  sparse.changes = []
  sparse.changes.length = 1
  expect(() => encodeSnapshotJournalDeltaFrame(sparse, bound)).toThrow('Invalid raw')
})

test('closed decoder refuses changed context, malformed typed cells, truncated bodies and trailing bytes', () => {
  const frame = encodeSnapshotJournalDeltaFrame(page(), bound)
  expect(() => decodeSnapshotJournalDeltaFrame(frame, { stream: 'scope', tableId: 1 })).toThrow('Invalid raw')
  const edits: Array<(header: Record<string, unknown>) => void> = [
    header => {
      header.version = 2
    },
    header => {
      header.extra = true
    },
    header => {
      header.examined = 2
    },
    header => {
      header.stream = 'physical'
    },
    header => {
      header.complete = 'true'
    },
    header => {
      const changes = header.changes as Array<{ row: unknown[] }>
      changes[0].row.push(['txLabelId', 'number', 7])
    },
    header => {
      const changes = header.changes as Array<{ row: unknown[] }>
      changes[0].row[0] = ['txLabelId', 'unknown', 7]
    },
    header => {
      const changes = header.changes as Array<{ row: unknown[] }>
      changes[0].row[0] = ['txLabelId', 'number', '7']
    },
    header => {
      const changes = header.changes as Array<{ row: unknown[] }>
      changes[0].row[0] = ['txLabelId', 'number', 8]
    }
  ]
  for (const edit of edits) expect(() => decodeSnapshotJournalDeltaFrame(corrupt(edit), bound)).toThrow()
  for (const value of [
    new Uint8Array(0),
    new Uint8Array(SNAPSHOT_JOURNAL_DELTA_FRAME_BYTES + 1),
    frame.subarray(0, frame.length - 1),
    corrupt(() => undefined, Uint8Array.of(0, 128, 255, 4))
  ])
    expect(() => decodeSnapshotJournalDeltaFrame(value, bound)).toThrow()
})

test('reserved property names and binary marker text remain plain raw SQL values', () => {
  const source = page()
  if (!source.changes[0].present) throw new Error('Expected raw row')
  Object.defineProperty(source.changes[0].row, '__proto__', { value: null, enumerable: true })
  Object.defineProperty(source.changes[0].row, 'constructor', {
    value: '$bsvBinary',
    enumerable: true
  })
  const result = decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(source, bound), bound).changes[0]
  if (!result.present) throw new Error('Expected raw row')
  expect(Object.getPrototypeOf(result.row)).toBe(Object.prototype)
  expect(Object.hasOwn(result.row, '__proto__')).toBe(true)
  expect(result.row.__proto__).toBeNull()
  expect(result.row.constructor).toBe('$bsvBinary')
})

test.each([-Number.MAX_SAFE_INTEGER, -1, 0, Number.MAX_SAFE_INTEGER])(
  'signed sync-state provenance key %i round trips without changing ordinary key refusal',
  id => {
    const metadata = { revision: snapshotJournalRevision('3'), id1: id, id2: 0, exactText: '', present: true }
    const input: SnapshotJournalDeltaPage = {
      table: 'syncStates',
      changes: [{ metadata, present: true, row: { syncStateId: id, userId: 3, syncMap: 'original\u0000雪' } }],
      examined: 1,
      payloadBytes: 0,
      complete: false,
      after: { revision: metadata.revision, id1: id, id2: 0, exactText: '' }
    }
    const signedBound: SnapshotJournalDeltaFrameContext = { stream: 'scope', tableId: 7 }
    const decoded = decodeSnapshotJournalDeltaFrame(encodeSnapshotJournalDeltaFrame(input, signedBound), signedBound)
    expect(decoded).toMatchObject({
      table: input.table,
      changes: input.changes,
      examined: 1,
      complete: false,
      after: input.after
    })
    expect(decoded.payloadBytes).toBe(input.payloadBytes)
    if (id < 1) {
      const ordinary: SnapshotJournalDeltaPage = {
        ...input,
        table: 'txLabels',
        changes: [{ metadata, present: true, row: { txLabelId: id } }]
      }
      expect(() => encodeSnapshotJournalDeltaFrame(ordinary, bound)).toThrow('Invalid raw')
    }
  }
)

test('a leading U+FEFF is exact SQL text in version-one frames, including NUL and astral characters', () => {
  const data = page(),
    change = data.changes[0],
    exact = '\ufeffstart\0雪😀end'
  if (!change.present) throw new Error('Independent exact SQL row is required')
  change.row.label = exact
  const encoded = encodeSnapshotJournalDeltaFrame(data, bound),
    decoded = decodeSnapshotJournalDeltaFrame(encoded, bound),
    actual = decoded.changes[0]
  if (!actual.present) throw new Error('Decoded exact SQL row is required')
  expect(actual.row.label).toBe(exact)
  expect(Buffer.from(actual.row.label as string)).toEqual(
    Buffer.from([239, 187, 191, 115, 116, 97, 114, 116, 0, 233, 155, 170, 240, 159, 152, 128, 101, 110, 100])
  )
  expect(decoded).toEqual(data)
})
