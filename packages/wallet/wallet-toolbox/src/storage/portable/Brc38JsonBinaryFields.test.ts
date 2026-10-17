import { createHash } from 'node:crypto'
import { readBrc38JsonStream, type Brc38JsonStagingSink } from './Brc38JsonStream'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'
import { parseBRC38Json, type BRC38Tables } from './index'
import type { PortableRow } from './Brc38PortableRows'
import type { Brc38JsonStreamedFieldSink } from './Brc38JsonBinaryFields'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

async function* chunks(text: string, width: number) {
  const bytes = Buffer.from(text)
  for (let start = 0; start < bytes.length; start += width) yield Uint8Array.from(bytes.subarray(start, start + width))
}
const policy = {
  maximumArchiveBytes: 2097152,
  maximumRowAllocationBytes: 32768,
  streamedFields: { maximumBinaryBytes: 1048576, maximumChunkBytes: 64 }
}
function staging() {
  const rows = Object.fromEntries(
    Object.keys(jsonStreamFixture().tables).map(key => [key, []])
  ) as unknown as BRC38Tables
  const fields = new Map<string, Buffer[]>(),
    sizes = new Map<string, number>()
  const discarded: unknown[] = []
  const key = (table: keyof BRC38Tables, index: number, field: string) => JSON.stringify([table, index, field])
  const streamedFields: Brc38JsonStreamedFieldSink = {
    async begin(table, index, field) {
      const identity = key(table, index, field)
      expect(fields.has(identity)).toBe(false)
      fields.set(identity, [])
      sizes.set(identity, 0)
    },
    async append(table, index, field, offset, bytes) {
      const identity = key(table, index, field)
      expect(offset).toBe(sizes.get(identity))
      expect(bytes.byteLength).toBeGreaterThan(0)
      expect(bytes.byteLength).toBeLessThanOrEqual(64)
      fields.get(identity)!.push(Buffer.from(bytes))
      sizes.set(identity, offset + bytes.byteLength)
      // A host may retain/mutate its chunk after taking ownership. The parser
      // must already have hashed it and must own a separate next working buffer.
      bytes.fill(211)
    },
    async finish(table, index, descriptor) {
      const data = Buffer.concat(fields.get(key(table, index, descriptor.field))!)
      expect(descriptor.bytes).toBe(data.length)
      expect(descriptor.sha256).toBe(createHash('sha256').update(data).digest('hex'))
      expect(Object.isFrozen(descriptor)).toBe(true)
    },
    async row(table, index, row) {
      expect(index).toBe(rows[table].length)
      expect(Object.isFrozen(row)).toBe(true)
      const complete: PortableRow = { ...row.fields }
      for (const [field, descriptor] of Object.entries(row.binaries)) {
        const data = Buffer.concat(fields.get(key(table, index, field))!)
        complete[field] = descriptor.encoding === 'base64' ? data.toString('base64') : Array.from(data)
      }
      rows[table].push(complete)
    }
  }
  const sink: Brc38JsonStagingSink = {
    streamedFields,
    provisionalRow: async () => {
      throw new Error('Streamed fields cannot use the legacy row callback')
    },
    validateCompleted: async (header, counts) => {
      for (const table of Object.keys(rows) as Array<keyof BRC38Tables>) expect(counts[table]).toBe(rows[table].length)
      parseBRC38Json(JSON.stringify({ ...header, tables: rows }))
    },
    discard: async cause => {
      discarded.push(cause)
    }
  }
  return { sink, rows, discarded, sizes }
}

test.each([1, 2, 7, 64, 65536])(
  'all thirteen legacy tables agree with private field staging at input width%s',
  async width => {
    const data = jsonStreamFixture()
    data.tables.transactions[0].rawTx = 'AQI='
    data.tables.transactions[0].noSendExpiryReclaimRawTx = [0, 1, 254, 255]
    const state = staging(),
      text = JSON.stringify(data)
    const result = await readBrc38JsonStream(chunks(text, width), state.sink, policy)
    expect({ ...result.header, tables: state.rows }).toEqual(parseBRC38Json(text))
    expect(state.discarded).toEqual([])
  }
)

test('a large binary record stages through bounded writes while the legacy one-row allocation guard refuses', async () => {
  const data = jsonStreamFixture(),
    binary = Buffer.alloc(262144, 37)
  data.tables.transactions[0].rawTx = binary.toString('base64')
  data.tables.transactions[0].noSendExpiryReclaimRawTx = Array.from(binary.subarray(0, 32768))
  const text = JSON.stringify(data),
    state = staging()
  const result = await readBrc38JsonStream(chunks(text, 65536), state.sink, policy)
  expect({ ...result.header, tables: state.rows }).toEqual(parseBRC38Json(text))
  const legacy = { ...state.sink, streamedFields: undefined, provisionalRow: async () => {} }
  await expect(
    readBrc38JsonStream(chunks(text, 65536), legacy, { ...policy, streamedFields: undefined })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
})

test('escaped base64 and historical unused padding bits preserve accepted decoded bytes', async () => {
  const state = staging(),
    text = JSON.stringify(jsonStreamFixture()).replace('"rawTx":"AQI="', '"rawTx":"\\u0051h=="')
  await readBrc38JsonStream(chunks(text, 1), state.sink, policy)
  expect(state.rows.provenTxs[0].rawTx).toBe('Qg==')
})

test.each(['A', 'AAA', 'A===', 'AA=A', 'AA==A', 'AA==\\n', 'éAAA', 'AAAA='])(
  'malformed base64 %s discards provisional staging',
  async encoded => {
    const state = staging(),
      text = JSON.stringify(jsonStreamFixture()).replace('"rawTx":"AQI="', '"rawTx":' + JSON.stringify(encoded))
    await expect(readBrc38JsonStream(chunks(text, 2), state.sink, policy)).rejects.toThrow()
    expect(state.discarded).toHaveLength(1)
  }
)

test.each(['[1,]', '[256]', '[-1]', '[1.1]', '[true]', '[1,,2]', '[01]', '[null]'])(
  'malformed no-send byte array %s refuses',
  async value => {
    const data = jsonStreamFixture()
    data.tables.transactions[0].noSendExpiryReclaimRawTx = []
    const text = JSON.stringify(data).replace('"noSendExpiryReclaimRawTx":[]', '"noSendExpiryReclaimRawTx":' + value),
      state = staging()
    await expect(readBrc38JsonStream(chunks(text, 3), state.sink, policy)).rejects.toThrow()
    expect(state.discarded).toHaveLength(1)
  }
)

test('byte quota refuses before an over-budget chunk is written', async () => {
  const state = staging(),
    data = jsonStreamFixture()
  data.tables.transactions[0].rawTx = Buffer.alloc(100, 7).toString('base64')
  await expect(
    readBrc38JsonStream(chunks(JSON.stringify(data), 65536), state.sink, {
      ...policy,
      streamedFields: { ...policy.streamedFields, maximumBinaryBytes: 65 }
    })
  ).rejects.toBeInstanceOf(SnapshotResourceLimitError)
  expect([...state.sizes.values()].every(value => value <= 65)).toBe(true)
})

test('an in-flight private write drains before cancellation disposal and does not finish its field', async () => {
  const state = staging(),
    controller = new AbortController(),
    cause = new Error('caller stopped')
  let started!: () => void, release!: () => void
  const observed = new Promise<void>(resolve => {
      started = resolve
    }),
    held = new Promise<void>(resolve => {
      release = resolve
    })
  const original = state.sink.streamedFields!.append
  state.sink.streamedFields!.append = async (...args) => {
    started()
    await held
    await original(...args)
  }
  const finish = jest.fn(state.sink.streamedFields!.finish)
  state.sink.streamedFields!.finish = finish
  const pending = readBrc38JsonStream(chunks(JSON.stringify(jsonStreamFixture()), 65536), state.sink, {
    ...policy,
    signal: controller.signal
  })
  const rejection = expect(pending).rejects.toBe(cause)
  await observed
  controller.abort(cause)
  await Promise.resolve()
  expect(state.discarded).toEqual([])
  expect(finish).not.toHaveBeenCalled()
  release()
  await rejection
  expect(state.discarded).toEqual([cause])
  expect(finish).not.toHaveBeenCalled()
})

test('streamed policy and callback set must be paired before input is read', async () => {
  const state = staging(),
    next = jest.fn(),
    input = { [Symbol.asyncIterator]: () => ({ next }) }
  await expect(readBrc38JsonStream(input, state.sink, { ...policy, streamedFields: undefined })).rejects.toThrow(
    'together'
  )
  expect(next).not.toHaveBeenCalled()
})
