import { readBrc38JsonStream, type Brc38JsonStagingSink, type Brc38JsonStreamOptions } from './Brc38JsonStream'
import { jsonStreamFixture } from './Brc38JsonStreamFixture'
import { parseBRC38Json, type BRC38Tables, type BRC38WalletData } from './index'

const policy: Brc38JsonStreamOptions = {
  maximumArchiveBytes: 1048576,
  maximumRowAllocationBytes: 65536,
  maximumInputChunkBytes: 65536
}
async function* chunks(text: string, width = 127) {
  const bytes = new TextEncoder().encode(text)
  for (let offset = 0; offset < bytes.length; offset += width) yield bytes.slice(offset, offset + width)
}
function staging(): Brc38JsonStagingSink & { staged: BRC38Tables; completed: number; discarded: unknown[] } {
  const staged = jsonStreamFixture().tables
  for (const name of Object.keys(staged) as Array<keyof BRC38Tables>) staged[name] = []
  const state = {
    staged,
    completed: 0,
    discarded: [] as unknown[],
    async provisionalRow(table: keyof BRC38Tables, index: number, row: BRC38Tables[keyof BRC38Tables][number]) {
      expect(index).toBe(state.staged[table].length)
      expect(Object.isFrozen(row)).toBe(true)
      state.staged[table].push(row)
    },
    async validateCompleted(header: Readonly<BRC38WalletData>, counts: Readonly<Record<keyof BRC38Tables, number>>) {
      expect(Object.isFrozen(header)).toBe(true)
      expect(Object.isFrozen(header.user)).toBe(true)
      expect(Object.isFrozen(counts)).toBe(true)
      for (const table of Object.keys(staged) as Array<keyof BRC38Tables>)
        expect(counts[table]).toBe(staged[table].length)
      // Materialization is confined to this small independent legacy oracle.
      parseBRC38Json(JSON.stringify({ ...header, tables: staged }))
      state.completed++
    },
    async discard(cause: unknown) {
      state.discarded.push(cause)
    }
  }
  return state
}

test.each([1, 2, 3, 7, 64, 127, 4096])(
  'all thirteen tables and original provenance agree with legacy JSON at byte width %s',
  async width => {
    const data = jsonStreamFixture(),
      sink = staging(),
      text = JSON.stringify(data)
    const before = JSON.stringify(data)
    const result = await readBrc38JsonStream(chunks(text, width), sink, policy)
    expect({ ...result.header, tables: sink.staged }).toEqual(parseBRC38Json(text))
    expect(result.inputBytes).toBe(new TextEncoder().encode(text).length)
    expect(sink.completed).toBe(1)
    expect(sink.discarded).toEqual([])
    expect(JSON.stringify(data)).toBe(before)
  }
)

test('arbitrary root/table order and escaped punctuation preserve nested historical arrays', async () => {
  const data = jsonStreamFixture()
  data.tables.provenTxReqs[0].history = {
    notes: [{ what: 'string } [ , : \\" 🙂', when: 'original' }],
    extra: [true, false, 1e20, []]
  }
  const reversed = Object.fromEntries(Object.entries(data.tables).reverse())
  const text = JSON.stringify({
    user: data.user,
    tables: reversed,
    sourceStorage: data.sourceStorage,
    title: data.title,
    exportedAt: data.exportedAt,
    formatVersion: 1,
    brc: 38
  })
  const sink = staging()
  await readBrc38JsonStream(chunks(' \r\n' + text + '\t ', 3), sink, policy)
  expect(sink.staged).toEqual(data.tables)
})

test('multi-window rows preserve exact long base64 and Unicode strings', async () => {
  const data = jsonStreamFixture()
  data.tables.outputs[0].lockingScript = 'ABCD'.repeat(2048)
  data.tables.outputTags[0].tag = 'long 🙂 '.repeat(400)
  const sink = staging()
  await readBrc38JsonStream(chunks(JSON.stringify(data), 7), sink, policy)
  expect(sink.staged).toEqual(data.tables)
  expect(sink.completed).toBe(1)
  expect(sink.discarded).toEqual([])
})

test('queued host cancellation runs between bounded CPU batches on buffered input', async () => {
  const controller = new AbortController(),
    cause = new Error('host cancel'),
    data = jsonStreamFixture()
  data.tables.outputs = Array.from({ length: 256 }, (_, index) => ({ ...data.tables.outputs[0], outputId: 16 + index }))
  const sink = staging(),
    timer = setTimeout(() => controller.abort(cause), 0)
  try {
    await expect(
      readBrc38JsonStream(chunks(JSON.stringify(data), 65536), sink, { ...policy, signal: controller.signal })
    ).rejects.toBe(cause)
    expect(sink.completed).toBe(0)
    expect(sink.staged.outputs.length).toBeLessThan(32)
    expect(sink.discarded).toEqual([cause])
  } finally {
    clearTimeout(timer)
  }
})

test('queued foreground work runs before the buffered archive finishes', async () => {
  const data = jsonStreamFixture(),
    sink = staging()
  data.tables.outputs = Array.from({ length: 256 }, (_, index) => ({ ...data.tables.outputs[0], outputId: 16 + index }))
  let ran = false,
    firstObserved: number | undefined
  const timer = setTimeout(() => {
      ran = true
    }, 0),
    original = sink.provisionalRow
  sink.provisionalRow = async (table, index, row) => {
    if (table === 'outputs' && ran && firstObserved === undefined) firstObserved = index
    await original(table, index, row)
  }
  try {
    await readBrc38JsonStream(chunks(JSON.stringify(data), 65536), sink, policy)
    expect(ran).toBe(true)
    expect(firstObserved).toBeDefined()
    expect(firstObserved).toBeLessThan(32)
    expect(sink.completed).toBe(1)
  } finally {
    clearTimeout(timer)
  }
})

test('large leading whitespace yields to host cancellation before any staged row', async () => {
  const controller = new AbortController(),
    cause = new Error('whitespace cancel'),
    sink = staging(),
    timer = setTimeout(() => controller.abort(cause), 0)
  try {
    await expect(
      readBrc38JsonStream(chunks(' '.repeat(10000) + JSON.stringify(jsonStreamFixture()), 65536), sink, {
        ...policy,
        signal: controller.signal
      })
    ).rejects.toBe(cause)
    expect(Object.values(sink.staged).every(rows => rows.length === 0)).toBe(true)
    expect(sink.completed).toBe(0)
    expect(sink.discarded).toEqual([cause])
  } finally {
    clearTimeout(timer)
  }
})

test.each([
  '',
  '{}',
  '[]',
  '{"tables":{}}',
  '{"tables":[]}',
  '{"tables":{"outputs":[',
  '{"brc":38,}',
  '{"brc":38,"brc":38}',
  JSON.stringify(jsonStreamFixture()).slice(0, -1),
  JSON.stringify(jsonStreamFixture()) + '{}',
  '\ufeff' + JSON.stringify(jsonStreamFixture()),
  JSON.stringify(jsonStreamFixture()).replace('"outputs":[', '"outputs":[null,'),
  JSON.stringify(jsonStreamFixture()).replace('"tag":"tag 🙂"', '"tag":"\\ud800"'),
  JSON.stringify(jsonStreamFixture()).replace('"tag":"tag 🙂"', '"tag":"\\udfff"'),
  JSON.stringify(jsonStreamFixture()).replace('"userId":7', '"userId":1e999')
])('malformed/trailing/nonportable input refuses before completion: %s', async text => {
  const sink = staging()
  await expect(readBrc38JsonStream(chunks(text, 2), sink, policy)).rejects.toThrow()
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('a host yielding a different typed array refuses and closes the private source', async () => {
  const next = jest.fn().mockResolvedValue({ done: false, value: new Uint16Array([123]) })
  const close = jest.fn().mockResolvedValue({ done: true, value: undefined })
  const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next, return: close }) }
  const sink = staging()
  await expect(readBrc38JsonStream(source, sink, policy)).rejects.toThrow('Invalid bounded')
  expect(next).toHaveBeenCalledTimes(1)
  expect(close).toHaveBeenCalledTimes(1)
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('real chunk bytes are used without reading host length, slice or iterator properties', async () => {
  const text = JSON.stringify(jsonStreamFixture()),
    bytes = new TextEncoder().encode(text),
    sink = staging(),
    read = jest.fn(() => {
      throw new Error('host property was invoked')
    })
  Object.defineProperties(bytes, {
    byteLength: { get: read },
    length: { get: read },
    slice: { get: read },
    [Symbol.iterator]: { get: read }
  })
  async function* source() {
    yield bytes
  }
  const result = await readBrc38JsonStream(source(), sink, policy)
  expect(result.inputBytes).toBe(new TextEncoder().encode(text).length)
  expect(sink.staged).toEqual(jsonStreamFixture().tables)
  expect(read).not.toHaveBeenCalled()
  expect(sink.completed).toBe(1)
})

test('a shadowed chunk length cannot bypass the actual archive ceiling', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(jsonStreamFixture())),
    sink = staging(),
    copy = jest.fn(() => {
      throw new Error('copy before limit')
    })
  Object.defineProperties(bytes, { byteLength: { value: 0 }, slice: { value: copy } })
  async function* source() {
    yield bytes
  }
  await expect(readBrc38JsonStream(source(), sink, { ...policy, maximumArchiveBytes: 10 })).rejects.toThrow('policy')
  expect(copy).not.toHaveBeenCalled()
  expect(Object.values(sink.staged).every(rows => rows.length === 0)).toBe(true)
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('shared backing refuses before any private row can be staged', async () => {
  const original = new TextEncoder().encode(JSON.stringify(jsonStreamFixture())),
    bytes = new Uint8Array(new SharedArrayBuffer(original.length)),
    sink = staging()
  bytes.set(original)
  async function* source() {
    yield bytes
  }
  await expect(readBrc38JsonStream(source(), sink, policy)).rejects.toThrow()
  expect(Object.values(sink.staged).every(rows => rows.length === 0)).toBe(true)
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('Node Buffer views retain only their actual offset and length', async () => {
  const encoded = Buffer.from(JSON.stringify(jsonStreamFixture())),
    bytes = Buffer.concat([Buffer.from('prefix'), encoded, Buffer.from('suffix')]).subarray(6, 6 + encoded.length),
    sink = staging()
  async function* source() {
    yield bytes
  }
  const result = await readBrc38JsonStream(source(), sink, policy)
  expect(result.inputBytes).toBe(encoded.length)
  expect(sink.staged).toEqual(jsonStreamFixture().tables)
  expect(sink.completed).toBe(1)
})

test('a repeated table refuses rather than staging its second occurrence', async () => {
  const text = JSON.stringify(jsonStreamFixture()).replace('"syncStates":', '"provenTxs":[],"syncStates":')
  const sink = staging()
  await expect(readBrc38JsonStream(chunks(text), sink, policy)).rejects.toThrow('Invalid bounded')
  expect(sink.discarded).toHaveLength(1)
  expect(sink.completed).toBe(0)
})

test.each([
  { maximumArchiveBytes: 10 },
  { maximumRowAllocationBytes: 128 },
  { maximumMetadataAllocationBytes: 128 },
  { maximumInputChunkBytes: 1 },
  { maximumInputChunks: 1 }
])('fixed input/row/metadata/chunk ceilings refuse with private discard: %j', async changes => {
  const sink = staging()
  await expect(
    readBrc38JsonStream(chunks(JSON.stringify(jsonStreamFixture())), sink, { ...policy, ...changes })
  ).rejects.toThrow('policy')
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('deep values refuse before JSON.parse or a row callback', async () => {
  const text = JSON.stringify(jsonStreamFixture()).replace(
    '"provenTxs":[',
    '"provenTxs":[' + '['.repeat(65) + '1' + ']'.repeat(65) + ','
  )
  const sink = staging()
  await expect(readBrc38JsonStream(chunks(text), sink, policy)).rejects.toThrow('64 levels')
  expect(sink.staged.provenTxs).toHaveLength(0)
})

test('row and source backpressure retain one private callback in flight', async () => {
  let resolve: (() => void) | undefined, rowStarted: (() => void) | undefined
  const blocked = new Promise<void>(done => {
    resolve = done
  })
  const started = new Promise<void>(done => {
    rowStarted = done
  })
  let reads = 0,
    active = 0,
    maximum = 0
  const sink = staging(),
    original = sink.provisionalRow
  sink.provisionalRow = async (...args) => {
    maximum = Math.max(maximum, ++active)
    rowStarted?.()
    await blocked
    await original(...args)
    active--
  }
  async function* input() {
    for await (const part of chunks(JSON.stringify(jsonStreamFixture()), 1)) {
      reads++
      yield part
    }
  }
  const pending = readBrc38JsonStream(input(), sink, policy)
  await started
  const atPause = reads
  await Promise.resolve()
  await Promise.resolve()
  expect(reads).toBe(atPause)
  resolve?.()
  await pending
  expect(maximum).toBe(1)
})

test('cancellation waits for owned row I/O then closes the source and discards', async () => {
  const controller = new AbortController(),
    cause = new Error('cancelled by host'),
    sink = staging()
  const order: string[] = []
  let closed = false
  async function* input() {
    try {
      yield* chunks(JSON.stringify(jsonStreamFixture()), 1)
    } finally {
      closed = true
      order.push('source closed')
    }
  }
  sink.provisionalRow = async () => {
    controller.abort(cause)
    await Promise.resolve()
    order.push('row settled')
  }
  sink.discard = async error => {
    expect(error).toBe(cause)
    expect(closed).toBe(true)
    order.push('staging discarded')
  }
  await expect(readBrc38JsonStream(input(), sink, { ...policy, signal: controller.signal })).rejects.toBe(cause)
  expect(order).toEqual(['row settled', 'source closed', 'staging discarded'])
})

test('semantic completion still refuses an orphan after complete syntax', async () => {
  const data = jsonStreamFixture(),
    sink = staging()
  data.tables.outputs[0].transactionId = 999
  await expect(readBrc38JsonStream(chunks(JSON.stringify(data)), sink, policy)).rejects.toThrow('exported transaction')
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('source and private cleanup failures retain the exact original cause', async () => {
  const original = new Error('source failed'),
    cleanup = new Error('source close failed'),
    discard = new Error('discard failed')
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        throw original
      },
      return: async () => {
        throw cleanup
      }
    })
  }
  const sink = staging()
  sink.discard = async () => {
    throw discard
  }
  let failure: unknown
  try {
    await readBrc38JsonStream(source, sink, policy)
  } catch (error) {
    failure = error
  }
  expect(failure).toBeInstanceOf(AggregateError)
  expect((failure as AggregateError).cause).toBe(original)
  expect((failure as AggregateError).errors).toEqual([original, cleanup, discard])
})

test('invalid UTF-8 and unlimited empty chunks refuse and discard', async () => {
  const sink = staging()
  async function* invalidBytes() {
    yield new Uint8Array([0xff])
  }
  await expect(readBrc38JsonStream(invalidBytes(), sink, policy)).rejects.toThrow()
  const second = staging()
  async function* empty() {
    for (;;) yield new Uint8Array()
  }
  await expect(readBrc38JsonStream(empty(), second, { ...policy, maximumInputChunks: 3 })).rejects.toThrow('policy')
  expect(sink.discarded).toHaveLength(1)
  expect(second.discarded).toHaveLength(1)
})

test.each([
  { maximumArchiveBytes: 0 },
  { maximumArchiveBytes: Number.POSITIVE_INFINITY },
  { maximumRowAllocationBytes: -1 },
  { maximumRowAllocationBytes: 16777217 },
  { maximumMetadataAllocationBytes: 65537 },
  { maximumInputChunkBytes: 65537 },
  { maximumInputChunks: 1.5 }
])('invalid policies refuse before reading any input: %j', async changes => {
  let reads = 0
  const sink = staging()
  async function* input() {
    reads++
    yield* chunks(JSON.stringify(jsonStreamFixture()))
  }
  await expect(readBrc38JsonStream(input(), sink, { ...policy, ...changes })).rejects.toBeInstanceOf(RangeError)
  expect(reads).toBe(0)
  expect(sink.discarded).toHaveLength(1)
})

test('absent standard tables and non-object rows refuse private completion', async () => {
  for (const replacement of ['"txLabels":false', '"removedTable":[]']) {
    const text = JSON.stringify(jsonStreamFixture()).replace(/"txLabels":\[[^\]]*\]/, replacement)
    const sink = staging()
    await expect(readBrc38JsonStream(chunks(text), sink, policy)).rejects.toThrow()
    expect(sink.completed).toBe(0)
    expect(sink.discarded).toHaveLength(1)
  }
  const text = JSON.stringify(jsonStreamFixture()).replace('"provenTxs":[', '"provenTxs":[42,')
  await expect(readBrc38JsonStream(chunks(text), staging(), policy)).rejects.toThrow('Invalid bounded')
})

test('bounded unknown metadata and table properties retain legacy acceptance', async () => {
  const document = jsonStreamFixture()
  const text = JSON.stringify({
    ...document,
    hint: { values: [true, 1, 'original'] },
    tables: { ...document.tables, future: [] }
  })
  const sink = staging()
  const result = await readBrc38JsonStream(chunks(text), sink, policy)
  expect(result.header).toHaveProperty('hint', { values: [true, 1, 'original'] })
  expect(sink.staged).toEqual(document.tables)
})

test('source cleanup failure prevents even the semantic completion callback', async () => {
  const cause = new Error('physical source cleanup failed'),
    iterator = chunks(JSON.stringify(jsonStreamFixture()))
  const input: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => iterator.next(),
      return: async () => {
        throw cause
      }
    })
  }
  const sink = staging()
  await expect(readBrc38JsonStream(input, sink, policy)).rejects.toBe(cause)
  expect(sink.completed).toBe(0)
  expect(sink.discarded).toEqual([cause])
})

test('already cancelled input is never read and semantic failure preserves its identity', async () => {
  const controller = new AbortController(),
    cancellation = new Error('already cancelled')
  controller.abort(cancellation)
  let reads = 0
  async function* input() {
    reads++
    yield* chunks(JSON.stringify(jsonStreamFixture()))
  }
  const first = staging()
  await expect(readBrc38JsonStream(input(), first, { ...policy, signal: controller.signal })).rejects.toBe(cancellation)
  expect(reads).toBe(0)
  const second = staging(),
    semantic = new Error('staged proof rejected')
  second.validateCompleted = async () => {
    throw semantic
  }
  await expect(readBrc38JsonStream(chunks(JSON.stringify(jsonStreamFixture())), second, policy)).rejects.toBe(semantic)
  expect(second.discarded).toEqual([semantic])
})

test('cancellation during final private validation discards after that I/O settles', async () => {
  const controller = new AbortController(),
    cause = new Error('cancelled at semantic validation'),
    sink = staging()
  let settled = false
  sink.validateCompleted = async () => {
    controller.abort(cause)
    await Promise.resolve()
    settled = true
  }
  sink.discard = async error => {
    expect(settled).toBe(true)
    expect(error).toBe(cause)
  }
  await expect(
    readBrc38JsonStream(chunks(JSON.stringify(jsonStreamFixture())), sink, { ...policy, signal: controller.signal })
  ).rejects.toBe(cause)
})

test('a source without a return hook still closes successfully at EOF', async () => {
  const iterator = chunks(JSON.stringify(jsonStreamFixture()))
  const input: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => iterator.next() }) }
  const sink = staging()
  await readBrc38JsonStream(input, sink, policy)
  expect(sink.completed).toBe(1)
})

test('metadata field cardinality is fixed before allocating another property', async () => {
  const document = {
    ...jsonStreamFixture(),
    ...Object.fromEntries(Array.from({ length: 58 }, (_, index) => ['extra' + index, true]))
  }
  const sink = staging()
  await expect(readBrc38JsonStream(chunks(JSON.stringify(document)), sink, policy)).rejects.toThrow('Invalid bounded')
  expect(sink.completed).toBe(0)
})
