import { createHash } from 'node:crypto'
import { readBrc38JsonStream, type Brc38JsonStagingSink } from './Brc38JsonStream'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'
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
  streamedStructuredFields: { maximumStructuredBytes: 1048576, maximumChunkBytes: 64 }
}
function staging() {
  const rows = Object.fromEntries(
      Object.keys(jsonStreamFixture().tables).map(table => [table, []])
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
    for (const field of Object.keys(source.structured ?? {}))
      complete[field] = JSON.parse(Buffer.concat(payloads.get(key(table, index, field))!).toString('utf8'))
    rows[table].push(complete)
  }
  const binaryRow = jest.fn(async () => {
    throw new Error('A binary-only row callback would lose structured descriptors')
  })
  const structured: Brc38JsonStructuredFieldSink = { begin, append, finish, row },
    binaries: Brc38JsonStreamedFieldSink = { begin, append, finish, row: binaryRow }
  const sink: Brc38JsonStagingSink = {
    streamedFields: binaries,
    streamedStructuredFields: structured,
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
  'all13 legacy table values agree with independent structured capture at input width%s',
  async width => {
    const data = jsonStreamFixture()
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
test('large one-field history stages in finite extents while the original row-allocation path refuses', async () => {
  const data = jsonStreamFixture()
  data.tables.provenTxReqs[0].history = { notes: [{ what: 'a'.repeat(262144) }] }
  const text = JSON.stringify(data),
    state = staging(),
    result = await readBrc38JsonStream(input(text, 65536), state.sink, policy)
  expect({ ...result.header, tables: state.rows }).toEqual(parseBRC38Json(text))
  const original = {
    ...state.sink,
    streamedFields: undefined,
    streamedStructuredFields: undefined,
    provisionalRow: async () => {}
  }
  await expect(
    readBrc38JsonStream(input(text, 65536), original, {
      ...policy,
      streamedFields: undefined,
      streamedStructuredFields: undefined
    })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
})
test('raw duplicate object keys and original escape spellings remain byte-exact in staging', async () => {
  const raw =
      '{"duplicate":null,"duplicate":7,"\\u0062":"ignored\\ud800","b":"kept","notes":[{"what":"\\uD83D\\uDE04"}]}',
    text = JSON.stringify(jsonStreamFixture()).replace('"history":{"notes":[]}', '"history":' + raw),
    state = staging()
  const result = await readBrc38JsonStream(input(text, 1), state.sink, policy)
  const retained = state.payloads.get(JSON.stringify(['provenTxReqs', 0, 'history']))!
  expect(Buffer.concat(retained).toString('utf8')).toBe(raw)
  expect({ ...result.header, tables: state.rows }).toEqual(parseBRC38Json(text))
})
test.each([
  '{"v":01}',
  '{"v":1e}',
  '{"v":truefalse}',
  '{"v":nul}',
  '{"v":"\\x"}',
  '{"v":"\\u00q0"}',
  '{"v":[1,]}',
  '{"v":{]}}',
  '{"v":1,}',
  '{"v" 1}',
  '{"v":}',
  '[1]',
  'null',
  '{"v":"unterminated}'
])('malformed structured grammar refuses and discards provisional content: %s', async raw => {
  const text = JSON.stringify(jsonStreamFixture()).replace('"history":{"notes":[]}', '"history":' + raw),
    state = staging()
  await expect(readBrc38JsonStream(input(text, 3), state.sink, policy)).rejects.toThrow()
  expect(state.discarded).toHaveLength(1)
  expect(
    state.finish.mock.calls.some(([table, , value]) => table === 'provenTxReqs' && value.field === 'history')
  ).toBe(false)
})
test.each([
  '{"' + 'k'.repeat(8193) + '":1}',
  '{"v":' + '1'.repeat(8193) + '}',
  '{"v":' + '['.repeat(64) + '0' + ']'.repeat(64) + '}'
])('bounded keys/numbers/nesting refuse without whole-value allocation', async raw => {
  const state = staging(),
    text = JSON.stringify(jsonStreamFixture()).replace('"history":{"notes":[]}', '"history":' + raw)
  await expect(readBrc38JsonStream(input(text, 65536), state.sink, policy)).rejects.toBeInstanceOf(
    SnapshotResourceLimitError
  )
  expect(state.discarded).toHaveLength(1)
})
test('structured byte quota prevents an over-budget private write', async () => {
  const state = staging(),
    data = jsonStreamFixture()
  data.tables.provenTxReqs[0].history = { value: 'x'.repeat(100) }
  await expect(
    readBrc38JsonStream(input(JSON.stringify(data), 65536), state.sink, {
      ...policy,
      streamedStructuredFields: { ...policy.streamedStructuredFields, maximumStructuredBytes: 65 }
    })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  for (const [identity, size] of state.sizes) if (identity.includes('history')) expect(size).toBeLessThanOrEqual(65)
})
test('structured policy/sink mismatch refuses before any input acquisition', async () => {
  const state = staging(),
    next = jest.fn(),
    source = { [Symbol.asyncIterator]: () => ({ next }) }
  await expect(
    readBrc38JsonStream(source, state.sink, { ...policy, streamedStructuredFields: undefined })
  ).rejects.toThrow('together')
  expect(next).not.toHaveBeenCalled()
})
test('actual in-flight structured staging finishes drainage before cancellation disposal', async () => {
  const state = staging(),
    controller = new AbortController(),
    reason = new Error('original structured abort')
  let entered!: () => void, release!: () => void
  const observed = new Promise<void>(resolve => {
      entered = resolve
    }),
    held = new Promise<void>(resolve => {
      release = resolve
    }),
    append = state.sink.streamedStructuredFields!.append
  state.sink.streamedStructuredFields!.append = async (...args) => {
    entered()
    await held
    await append(...args)
  }
  const running = readBrc38JsonStream(input(JSON.stringify(jsonStreamFixture()), 65536), state.sink, {
      ...policy,
      signal: controller.signal
    }),
    rejected = expect(running).rejects.toBe(reason)
  await observed
  controller.abort(reason)
  await Promise.resolve()
  expect(state.discarded).toEqual([])
  release()
  await rejected
  expect(state.discarded).toEqual([reason])
  expect(
    state.finish.mock.calls.some(([table, , field]) => table === 'provenTxReqs' && field.field === 'history')
  ).toBe(false)
})
