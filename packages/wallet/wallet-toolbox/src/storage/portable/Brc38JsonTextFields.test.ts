import { createHash } from 'node:crypto'
import { readBrc38JsonStream, type Brc38JsonStagingSink } from './Brc38JsonStream'
import { semanticStageFixture } from './Brc38SemanticStageFixture'
import type { Brc38JsonTextFieldSink } from './Brc38JsonTextFields'
import { parseBRC38Json, type BRC38Tables } from './index'
import type { Brc38JsonStructuredFieldSink } from './Brc38JsonStructuredFields'
import type { Brc38JsonStreamedFieldSink, Brc38JsonStreamedRow } from './Brc38JsonBinaryFields'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

// Independent small materialized oracle in cases only. The production reader
// captures raw bytes and never receives this fixture's whole-value parser.
async function* input(text: string, width: number) {
  const bytes = Buffer.from(text)
  for (let offset = 0; offset < bytes.length; offset += width)
    yield Uint8Array.from(bytes.subarray(offset, offset + width))
}
const policy = {
  maximumArchiveBytes: 2097152,
  maximumRowAllocationBytes: 32768,
  streamedFields: { maximumBinaryBytes: 1048576, maximumChunkBytes: 64 },
  streamedStructuredFields: { maximumStructuredBytes: 1048576, maximumChunkBytes: 64 },
  streamedTextFields: { maximumTextBytes: 1048576, maximumChunkBytes: 64 }
}
// Independent original-field coordinates, separate from the production whitelist.
const coordinates = {
  transactions: ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix'],
  outputs: [
    'outputDescription',
    'spendingDescription',
    'customInstructions',
    'derivationPrefix',
    'derivationSuffix',
    'type',
    'purpose'
  ],
  commissions: ['keyOffset'],
  certificates: ['subject', 'revocationOutpoint', 'signature', 'verifier'],
  certificateFields: ['fieldValue', 'masterKey']
}
function staging() {
  const rows = Object.fromEntries(
      Object.keys(semanticStageFixture().tables).map(table => [table, []])
    ) as unknown as BRC38Tables,
    payloads = new Map<string, Buffer[]>(),
    sizes = new Map<string, number>(),
    discarded: unknown[] = []
  const key = (table: keyof BRC38Tables, index: number, field: string) => JSON.stringify([table, index, field])
  const begin = async (table: keyof BRC38Tables, index: number, field: string) => {
    const identity = key(table, index, field)
    expect(payloads.has(identity)).toBe(false)
    payloads.set(identity, [])
    sizes.set(identity, 0)
  }
  const append = async (table: keyof BRC38Tables, index: number, field: string, offset: number, bytes: Uint8Array) => {
    const identity = key(table, index, field)
    expect(offset).toBe(sizes.get(identity))
    expect(bytes.length).toBeGreaterThan(0)
    expect(bytes.length).toBeLessThanOrEqual(64)
    payloads.get(identity)!.push(Buffer.from(bytes))
    sizes.set(identity, offset + bytes.length)
    bytes.fill(199) // Digest must precede callback ownership/mutation.
  }
  const finish = jest.fn(
    async (table: keyof BRC38Tables, index: number, descriptor: { field: string; bytes: number; sha256: string }) => {
      const bytes = Buffer.concat(payloads.get(key(table, index, descriptor.field))!)
      expect(descriptor.bytes).toBe(bytes.length)
      expect(descriptor.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(Object.isFrozen(descriptor)).toBe(true)
    }
  )
  const row = async (table: keyof BRC38Tables, index: number, source: Brc38JsonStreamedRow) => {
    expect(index).toBe(rows[table].length)
    const complete = { ...source.fields }
    for (const [field, descriptor] of Object.entries(source.binaries)) {
      const bytes = Buffer.concat(payloads.get(key(table, index, field))!)
      complete[field] = descriptor.encoding === 'base64' ? bytes.toString('base64') : Array.from(bytes)
    }
    for (const field of Object.keys(source.texts ?? {}))
      complete[field] = Buffer.concat(payloads.get(key(table, index, field))!).toString('utf8')
    for (const field of Object.keys(source.structured ?? {}))
      complete[field] = JSON.parse(Buffer.concat(payloads.get(key(table, index, field))!).toString('utf8'))
    rows[table].push(complete)
  }
  const binaryRow = jest.fn(async () => {
    throw new Error('A binary-only row callback would lose scalar TEXT descriptors')
  })
  const text: Brc38JsonTextFieldSink = { begin, append, finish, row },
    structured: Brc38JsonStructuredFieldSink = { begin, append, finish, row: binaryRow },
    binaries: Brc38JsonStreamedFieldSink = { begin, append, finish, row: binaryRow }
  const sink: Brc38JsonStagingSink = {
    streamedFields: binaries,
    streamedStructuredFields: structured,
    streamedTextFields: text,
    provisionalRow: async () => {
      throw new Error('Legacy callback cannot own structured extents')
    },
    validateCompleted: async (header, counts) => {
      for (const table of Object.keys(rows) as Array<keyof BRC38Tables>) expect(counts[table]).toBe(rows[table].length)
      parseBRC38Json(JSON.stringify({ ...header, tables: rows }))
    },
    discard: async cause => {
      discarded.push(cause)
    }
  }
  return { sink, rows, discarded, sizes, payloads, finish, binaryRow }
}
test.each([1, 2, 7, 64, 65536])(
  'all13 complete portable values agree with independent scalar TEXT capture at input width%s',
  async width => {
    const data = semanticStageFixture()
    for (const [table, fields] of Object.entries(coordinates))
      for (const field of fields)
        data.tables[table as keyof BRC38Tables][0][field] = 'original ' + table + ':' + field + ' \ufeff😄é\n\\"'
    data.tables.provenTxReqs[0].history = { notes: [{ what: '😄é\n\\"' }] }
    data.tables.provenTxReqs[0].rawTx = 'AQI='
    const text = JSON.stringify(data),
      state = staging(),
      result = await readBrc38JsonStream(input(text, width), state.sink, policy)
    expect({ ...result.header, tables: state.rows }).toEqual(parseBRC38Json(text))
    expect(state.discarded).toEqual([])
    expect(state.binaryRow).not.toHaveBeenCalled()
  }
)
test('large one-field scalar string stages in finite extents while the original row-allocation path refuses', async () => {
  const data = semanticStageFixture()
  data.tables.transactions[0].description = '😄é\n'.repeat(32768)
  const text = JSON.stringify(data),
    state = staging(),
    result = await readBrc38JsonStream(input(text, 65536), state.sink, policy)
  expect({ ...result.header, tables: state.rows }).toEqual(parseBRC38Json(text))
  const original = {
    ...state.sink,
    streamedFields: undefined,
    streamedStructuredFields: undefined,
    streamedTextFields: undefined,
    provisionalRow: async () => {}
  }
  await expect(
    readBrc38JsonStream(input(text, 65536), original, {
      ...policy,
      streamedFields: undefined,
      streamedStructuredFields: undefined,
      streamedTextFields: undefined
    })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
})
test.each([
  '"\\ud800"',
  '"\\udc00"',
  '"\\ud800x"',
  '"\\uD83D\\u0041"',
  '"\\x"',
  '"\\u00q0"',
  '"unterminated',
  '42',
  'null'
])('invalid scalar string refuses before completion and discards: %s', async raw => {
  const text = JSON.stringify(semanticStageFixture()).replace('"description":"original"', '"description":' + raw),
    state = staging()
  await expect(readBrc38JsonStream(input(text, 1), state.sink, policy)).rejects.toThrow()
  expect(state.discarded).toHaveLength(1)
  expect(
    state.finish.mock.calls.some(([table, , value]) => table === 'transactions' && value.field === 'description')
  ).toBe(false)
})
test('empty string stays present with the independent empty UTF-8 digest', async () => {
  const data = semanticStageFixture(),
    state = staging()
  data.tables.transactions[0].description = ''
  const result = await readBrc38JsonStream(input(JSON.stringify(data), 2), state.sink, policy)
  expect({ ...result.header, tables: state.rows }).toEqual(data)
  const empty = state.finish.mock.calls.find(
    ([table, , value]) => table === 'transactions' && value.field === 'description'
  )!
  expect(empty[2]).toEqual({
    field: 'description',
    encoding: 'utf8',
    bytes: 0,
    sha256: createHash('sha256').digest('hex')
  })
})
test('decoded UTF-8 quota is separate from JSON escape spelling and row metadata', async () => {
  const data = semanticStageFixture(),
    state = staging()
  data.tables.transactions[0].description = '😄'.repeat(17)
  await expect(
    readBrc38JsonStream(input(JSON.stringify(data), 7), state.sink, {
      ...policy,
      streamedTextFields: { maximumTextBytes: 64, maximumChunkBytes: 64 }
    })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  expect(state.discarded).toHaveLength(1)
})
test('explicit scalar TEXT policy and sink are required together', async () => {
  const state = staging()
  await expect(
    readBrc38JsonStream(input(JSON.stringify(semanticStageFixture()), 64), state.sink, {
      ...policy,
      streamedTextFields: undefined
    })
  ).rejects.toThrow('together')
  expect(state.discarded).toHaveLength(1)
})
test('cancellation drains a pending scalar append before rejecting and discarding', async () => {
  const data = semanticStageFixture(),
    state = staging(),
    controller = new AbortController()
  data.tables.transactions[0].description = 'a'.repeat(262144)
  let entered!: () => void, release!: () => void
  const ready = new Promise<void>(resolve => {
      entered = resolve
    }),
    held = new Promise<void>(resolve => {
      release = resolve
    }),
    append = state.sink.streamedTextFields!.append
  state.sink.streamedTextFields!.append = async (...args) => {
    entered()
    await held
    await append(...args)
  }
  const parsing = readBrc38JsonStream(input(JSON.stringify(data), 64), state.sink, {
    ...policy,
    signal: controller.signal
  })
  let settled = false
  void parsing.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await ready
  controller.abort(new Error('original cancellation'))
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(state.discarded).toEqual([])
  release()
  await expect(parsing).rejects.toThrow('original cancellation')
  expect(state.discarded).toHaveLength(1)
})

test.each(['token', ':', '[', ']'])(
  'a scalar field followed by %s refuses before field finish or row admission',
  async suffix => {
    const text = JSON.stringify(semanticStageFixture()).replace(
        '"description":"original"',
        '"description":"original"' + suffix
      ),
      state = staging()
    await expect(readBrc38JsonStream(input(text, 1), state.sink, policy)).rejects.toThrow()
    expect(state.discarded).toHaveLength(1)
    expect(
      state.finish.mock.calls.some(([table, , value]) => table === 'transactions' && value.field === 'description')
    ).toBe(false)
    expect(state.rows.transactions).toHaveLength(0)
  }
)
