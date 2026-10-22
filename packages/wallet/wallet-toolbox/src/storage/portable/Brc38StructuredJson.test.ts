import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { SHA256 } from '@bsv/sdk/primitives/Hash'
import {
  canonicalBrc38StructuredJson,
  validateBrc38StructuredWalletField,
  validatedCanonicalBrc38StructuredWalletField,
  visitBrc38StructuredWalletField,
  canonicalBrc38ProjectedNotify,
  canonicalBrc38StructuredStringSpan,
  verifyBrc38StructuredSourceDigest,
  compareBrc38StructuredStringSpans,
  compareBrc38StructuredStringSequences,
  inspectBrc38StructuredScalarSpan,
  visitBrc38StructuredJsonValues,
  stringifyBrc38StructuredJsonSpan,
  type Brc38JsonMember,
  type Brc38JsonMemberIndex,
  type Brc38StreamedStructured
} from './Brc38StructuredJson'
import { projectBrc38PackedRow } from './Brc38PackedRow'
import { canonicalPortableChunks } from './CanonicalPortableChunks'
import { encodeBrc38StreamedRow } from './Brc38StreamedRow'
import { brc38StructuredArrayText } from './Brc38JsonStructuredFields'
import { checkpointBrc38SyncMap } from './Brc38CheckpointSyncMap'
import { createSyncMap } from '../schema/entities/EntityBase'

/** Small independent in-memory fixture only, never a production host index. */
class FixtureIndex implements Brc38JsonMemberIndex {
  members = new Map<number, Map<string, Brc38JsonMember>>()
  first = new Map<number, Map<string, number>>()
  closed = false
  sealed = false
  async put(offset: number, member: Brc38JsonMember): Promise<void> {
    if (this.closed || this.sealed) throw new Error('Fixture is closed or sealed')
    let object = this.members.get(offset)
    if (object === undefined) {
      object = new Map()
      this.members.set(offset, object)
    }
    let first = this.first.get(offset)
    if (first === undefined) {
      first = new Map()
      this.first.set(offset, first)
    }
    if (!first.has(member.key)) first.set(member.key, member.keyOffset)
    object.set(member.key, { ...member })
  }
  async seal(): Promise<void> {
    this.sealed = true
  }
  async lookup(
    offset: number,
    key: string
  ): Promise<Readonly<Brc38JsonMember & { firstKeyOffset: number }> | undefined> {
    if (!this.sealed || this.closed) throw new Error('Fixture is unavailable')
    const value = this.members.get(offset)?.get(key)
    return value === undefined ? undefined : { ...value, firstKeyOffset: this.first.get(offset)!.get(key)! }
  }
  async *entries(offset: number): AsyncGenerator<Brc38JsonMember> {
    if (!this.sealed || this.closed) throw new Error('Fixture is unavailable')
    for (const key of [...(this.members.get(offset)?.keys() ?? [])].sort())
      yield { ...this.members.get(offset)!.get(key)! }
  }
  async close(): Promise<void> {
    this.closed = true
  }
}
class PointFixtureIndex extends FixtureIndex {
  override entries(_offset: number): AsyncGenerator<Brc38JsonMember> {
    throw new Error('Point fixture cannot retain a member iterator')
  }
  async nextEntry(offset: number, after?: string): Promise<Brc38JsonMember | undefined> {
    if (!this.sealed || this.closed) throw new Error('Point fixture is unavailable')
    const key = [...(this.members.get(offset)?.keys() ?? [])].sort().find(key => after === undefined || key > after)
    return key === undefined ? undefined : { ...this.members.get(offset)!.get(key)! }
  }
}
function source(raw: string, encoding: 'utf8' | 'utf16le' = 'utf8', createIndex = () => new FixtureIndex()) {
  const bytes = encoding === 'utf8' ? new TextEncoder().encode(raw) : new Uint8Array(Buffer.from(raw, 'utf16le'))
  const indexes: FixtureIndex[] = [],
    calls: Array<[number, number]> = []
  const result: Brc38StreamedStructured = {
    encoding,
    length: bytes.length,
    sha256: new SHA256().update(bytes).digestHex(),
    async read(offset, length) {
      calls.push([offset, length])
      return bytes.slice(offset, offset + length)
    },
    async openIndex() {
      const index = createIndex()
      indexes.push(index)
      return index
    }
  }
  return { result, bytes, indexes, calls }
}
async function text(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = []
  for await (const part of chunks) {
    expect(part.length).toBeLessThanOrEqual(64)
    parts.push(part)
  }
  return Buffer.concat(parts).toString('utf8')
}
const policy = { maximumInputBytes: 1048576, maximumOutputBytes: 1048576, maximumChunkBytes: 64 }
test.each(['utf8', 'utf16le'] as const)(
  'nested point traversal retains exact legacy spelling without host iterators: %s',
  async encoding => {
    const raw =
        '{"z":{"z":1,"1":"first","a":[{"nested":{"x":null,"x":false}},"😀","\\ud800"]},"0":0,"z":{"a":[{"b":2,"a":1}]}}',
      fixture = source(raw, encoding, () => new PointFixtureIndex()),
      working = new Brc38WorkingAllocation(1048576)
    expect(
      await text(
        stringifyBrc38StructuredJsonSpan(
          fixture.result,
          { start: 0, end: fixture.bytes.length },
          { ...policy, workingAllocation: working }
        )
      )
    ).toBe(JSON.stringify(JSON.parse(raw)))
    expect(fixture.indexes.every(index => index.closed)).toBe(true)
    expect(working.used).toBe(0)
  }
)
test('point traversal canonicalizes every nested member using the independent ordinary oracle', async () => {
  const raw = '{"nested":{"z":[{"b":2,"a":1}],"a":false},"notes":[]}',
    fixture = source(raw, 'utf8', () => new PointFixtureIndex())
  expect(await text(canonicalBrc38StructuredJson('history', fixture.result, policy))).toBe(oracle('history', raw))
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
})
test('point traversal refuses an index that repeats its last member and drains its original owner', async () => {
  class RepeatingIndex extends PointFixtureIndex {
    override async nextEntry(offset: number): Promise<Brc38JsonMember | undefined> {
      return await super.nextEntry(offset)
    }
  }
  const fixture = source('{"a":1,"b":2}', 'utf8', () => new RepeatingIndex()),
    working = new Brc38WorkingAllocation(1048576)
  await expect(
    text(canonicalBrc38StructuredJson('history', fixture.result, { ...policy, workingAllocation: working }))
  ).rejects.toThrow()
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
  expect(working.used).toBe(0)
})
test('current checkpoint rewrites a finite page while retaining a map larger than the page and unknown JSON', async () => {
  const map = createSyncMap(),
    previous = '2026-10-01T00:00:00.000Z',
    later = '2026-10-07T00:00:00.000Z'
  for (let id = 1; id <= 6000; id++) map.output.idMap[id] = id + 9000
  map.output.count = 19
  map.output.maxUpdated_at = new Date(previous)
  const current = JSON.parse(JSON.stringify(map)) as Record<string, Record<string, unknown>>
  current.output.extra = { nested: [null, false, '😀', '\ud800'] }
  current.future = { values: [null, true], status: 'unchanged' }
  const expected = JSON.parse(JSON.stringify(current)) as typeof current
  expected.output.count = 21
  ;(expected.output.idMap as Record<string, number>)['-7'] = 20000
  expected.output.maxUpdated_at = later
  const fixture = source(JSON.stringify(current)),
    working = new Brc38WorkingAllocation(1048576)
  const actual = await text(
    checkpointBrc38SyncMap(
      fixture.result,
      { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working },
      {
        entity: 'output',
        count: 2,
        done: false,
        mappings: [
          { incomingId: -7, localId: 20000 },
          { incomingId: 1, localId: 9001 }
        ],
        maximumUpdatedAt: new Date(later)
      }
    )
  )
  expect(JSON.parse(actual)).toEqual(expected)
  expect(fixture.calls.every(([, length]) => length <= 64)).toBe(true)
  expect(fixture.indexes).toHaveLength(1)
  expect(fixture.indexes[0].closed).toBe(true)
  expect(working.used).toBe(0)
}, 30000)
test('completed current checkpoint clears all counters and reports the actual maximum without dropping mappings', async () => {
  const map = createSyncMap(),
    maximum = '2026-10-07T03:00:00.000Z'
  map.transaction.count = 23
  map.output.count = 6
  map.transaction.idMap[0] = 9
  map.output.maxUpdated_at = new Date(maximum)
  const fixture = source(JSON.stringify(map), 'utf16le'),
    working = new Brc38WorkingAllocation(1048576),
    iterator = checkpointBrc38SyncMap(
      fixture.result,
      { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working },
      { count: 0, done: true, mappings: [] }
    ),
    parts: Uint8Array[] = []
  let result: Readonly<{ maximumUpdatedAt?: string }> | undefined
  for (;;) {
    const next = await iterator.next()
    if (next.done) {
      result = next.value
      break
    }
    parts.push(next.value)
  }
  const actual = JSON.parse(Buffer.concat(parts).toString('utf8')) as ReturnType<typeof createSyncMap>
  for (const entry of Object.values(actual)) expect(entry.count).toBe(0)
  expect(actual.transaction.idMap).toEqual({ 0: 9 })
  expect(result).toEqual({ maximumUpdatedAt: maximum })
  expect(fixture.indexes[0].closed).toBe(true)
  expect(working.used).toBe(0)
})
test.each(['missing entity', 'missing count', 'missing map', 'bad count', 'bad map', 'conflicting map', 'bad date'])(
  'current checkpoint refuses %s before provisional output becomes usable',
  async defect => {
    const current = JSON.parse(JSON.stringify(createSyncMap())) as Record<string, Record<string, unknown>>
    if (defect === 'missing entity') delete current.output
    if (defect === 'missing count') delete current.output.count
    if (defect === 'missing map') delete current.output.idMap
    if (defect === 'bad count') current.output.count = Number.MAX_SAFE_INTEGER
    if (defect === 'bad map') current.output.idMap = { 4: 'not an integer' }
    if (defect === 'conflicting map') current.output.idMap = { 4: 777 }
    if (defect === 'bad date') current.output.maxUpdated_at = 'not a date'
    const fixture = source(JSON.stringify(current)),
      working = new Brc38WorkingAllocation(1048576)
    await expect(
      text(
        checkpointBrc38SyncMap(
          fixture.result,
          { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working },
          { entity: 'output', count: 1, done: false, mappings: [{ incomingId: 4, localId: 123 }] }
        )
      )
    ).rejects.toThrow()
    expect(fixture.indexes.every(index => index.closed)).toBe(true)
    expect(working.used).toBe(0)
  }
)
test('ordered checkpoint pages share one reconstruction and preserve resets, dates, mappings and unknown JSON', async () => {
  const map = createSyncMap()
  map.output.count = 19
  map.transaction.count = 7
  map.output.idMap[-7] = 20
  map.output.maxUpdated_at = new Date('2026-10-01T00:00:00.000Z')
  const current = { ...JSON.parse(JSON.stringify(map)), future: { nested: [null, false, '😀', '\\ud800'] } },
    expected = JSON.parse(JSON.stringify(current)),
    deltas: import('./Brc38CheckpointSyncMap').Brc38CheckpointSyncMapDelta[] = [
      {
        entity: 'output',
        count: 2,
        mappings: [{ incomingId: -7, localId: 20 }],
        maximumUpdatedAt: new Date('2026-10-07T00:00:00Z'),
        done: false
      },
      { entity: 'transaction', count: 3, mappings: [{ incomingId: 8, localId: 99 }], done: false },
      {
        entity: 'output',
        count: 1,
        mappings: [
          { incomingId: -7, localId: 20 },
          { incomingId: 2, localId: 30 }
        ],
        done: true
      },
      {
        entity: 'transaction',
        count: 4,
        mappings: [{ incomingId: 9, localId: 100 }],
        maximumUpdatedAt: new Date('2026-10-05T00:00:00Z'),
        done: false
      }
    ]
  // Independent ordinary-value oracle; no codec output supplies the expectation.
  for (const delta of deltas) {
    if (delta.entity !== undefined) {
      const entry = expected[delta.entity]
      entry.count += delta.count
      for (const value of delta.mappings) entry.idMap[value.incomingId] = value.localId
      if (
        delta.maximumUpdatedAt !== undefined &&
        (entry.maxUpdated_at === undefined || new Date(entry.maxUpdated_at) < delta.maximumUpdatedAt)
      )
        entry.maxUpdated_at = delta.maximumUpdatedAt.toISOString()
    }
    if (delta.done) for (const name of Object.keys(map)) expected[name].count = 0
  }
  const fixture = source(JSON.stringify(current), 'utf16le'),
    working = new Brc38WorkingAllocation(1048576)
  expect(
    JSON.parse(
      await text(
        checkpointBrc38SyncMap(
          fixture.result,
          { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working },
          deltas
        )
      )
    )
  ).toEqual(expected)
  expect(fixture.indexes).toHaveLength(1)
  expect(fixture.indexes[0].closed).toBe(true)
  expect(working.used).toBe(0)
})
test.each([
  'duplicate within page',
  'cross-page conflict',
  'overflow before reset',
  'overflow after reset',
  'empty batch',
  'too many pages',
  'changed source',
  'cancellation'
])('batched checkpoints retain provisional refusal and complete cleanup: %s', async defect => {
  const map = createSyncMap(),
    working = new Brc38WorkingAllocation(1048576),
    controller = new AbortController(),
    deltas: import('./Brc38CheckpointSyncMap').Brc38CheckpointSyncMapDelta[] = [
      { entity: 'output', count: 1, mappings: [{ incomingId: 4, localId: 123 }], done: false },
      { entity: 'output', count: 0, mappings: [], done: true }
    ]
  if (defect === 'duplicate within page')
    deltas[0] = {
      ...deltas[0],
      mappings: [
        { incomingId: 4, localId: 123 },
        { incomingId: 4, localId: 123 }
      ]
    }
  if (defect === 'cross-page conflict') deltas[1] = { ...deltas[1], mappings: [{ incomingId: 4, localId: 124 }] }
  if (defect === 'overflow before reset') map.output.count = Number.MAX_SAFE_INTEGER
  if (defect === 'overflow after reset')
    deltas.push(
      { entity: 'output', count: Number.MAX_SAFE_INTEGER, mappings: [], done: false },
      { entity: 'output', count: 1, mappings: [], done: true }
    )
  if (defect === 'empty batch') deltas.length = 0
  if (defect === 'too many pages') while (deltas.length <= 128) deltas.push({ count: 0, mappings: [], done: false })
  if (defect === 'cancellation') controller.abort(new Error('original checkpoint cancellation'))
  const fixture = source(JSON.stringify(map)),
    iterator = checkpointBrc38SyncMap(
      fixture.result,
      { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working, signal: controller.signal },
      deltas
    )
  if (defect === 'changed source') {
    expect((await iterator.next()).done).toBe(false)
    fixture.bytes[fixture.bytes.length - 1] = 32
  }
  await expect(text(iterator)).rejects.toThrow()
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
  expect(working.used).toBe(0)
})
test('current checkpoint remains provisional through changed source, explicit budgets and cancellation', async () => {
  const current = JSON.stringify(createSyncMap()),
    fixture = source(current),
    working = new Brc38WorkingAllocation(1048576),
    delta = { entity: 'output' as const, count: 1, done: false, mappings: [{ incomingId: 8, localId: 16 }] }
  const iterator = checkpointBrc38SyncMap(
    fixture.result,
    { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working },
    delta
  )
  expect((await iterator.next()).done).toBe(false)
  fixture.bytes[fixture.bytes.length - 1] = 32
  await expect(text(iterator)).rejects.toThrow()
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
  expect(working.used).toBe(0)
  const controller = new AbortController(),
    reason = new Error('original checkpoint cancellation')
  controller.abort(reason)
  await expect(
    text(
      checkpointBrc38SyncMap(
        source(current).result,
        { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working, signal: controller.signal },
        delta
      )
    )
  ).rejects.toBe(reason)
  await expect(
    text(
      checkpointBrc38SyncMap(
        source(current).result,
        { ...policy, maximumDateCodeUnits: 8192, workingAllocation: working, maximumOutputBytes: 64 },
        delta
      )
    )
  ).rejects.toThrow()
  expect(working.used).toBe(0)
})
test.each(['\ufeff[]', '[true,]', '["unfinished]', '[null]true', '[1e]', '[{"a":}]'])(
  'derived array grammar rejects malformed/BOM bytes without a whole array: case%#',
  async raw => {
    const working = new Brc38WorkingAllocation(1048576),
      bytes = new TextEncoder().encode(raw)
    const chunks = async function* (): AsyncGenerator<Uint8Array> {
      for (let offset = 0; offset < bytes.length; offset += 2) yield bytes.slice(offset, offset + 2)
    }
    await expect(
      (async () => {
        for await (const _part of brc38StructuredArrayText(
          chunks(),
          { maximumStructuredBytes: 4096, maximumChunkBytes: 64 },
          working,
          () => undefined
        )) {
          /* Small independent malformed-data oracle. */
        }
      })()
    ).rejects.toThrow()
    expect(working.used).toBe(0)
  }
)
test('full concatenated sort keys preserve prefix/control-unit ordering across segment boundaries', async () => {
  const a = source('"a"'),
    b = source('"a\\u0000"'),
    working = new Brc38WorkingAllocation(1048576),
    compare = {
      maximumInputBytes: 1048576,
      maximumDecodedCodeUnits: 1048576,
      maximumReadBytes: 64,
      workingAllocation: working,
      expiresAt: Date.now() + 60000,
      check: () => undefined
    }
  expect(
    await compareBrc38StructuredStringSequences(
      [{ source: a.result, span: { start: 0, end: a.bytes.length } }, { literal: ' ' }, { literal: 'z' }],
      [{ source: b.result, span: { start: 0, end: b.bytes.length } }, { literal: ' ' }, { literal: 'a' }],
      compare
    )
  ).toBe(1)
  expect(working.used).toBe(0)
})
test.each(['null', 'true', 'false', '-0', '1e400', '""', '"' + 'x'.repeat(70000) + '"', '[null]', '{"x":true}'])(
  'fresh scalar inspection drains exact spans with bounded capture: case%#',
  async raw => {
    const f = source(raw),
      working = new Brc38WorkingAllocation(1048576),
      value = JSON.parse(raw),
      result = await inspectBrc38StructuredScalarSpan(
        f.result,
        { start: 0, end: f.bytes.length },
        {
          maximumInputBytes: 1048576,
          maximumDecodedCodeUnits: 1048576,
          maximumReadBytes: 64,
          workingAllocation: working,
          expiresAt: Date.now() + 60000,
          check: () => undefined
        },
        24
      )
    if (result.kind === 'string') {
      expect(result.codeUnits).toBe((value as string).length)
      expect(result.captured).toBe((value as string).length <= 24 ? value : undefined)
    } else if (result.kind === 'number' || result.kind === 'boolean') expect(result.value).toBe(value)
    else expect(result.kind).toBe(value === null ? 'null' : Array.isArray(value) ? 'array' : 'object')
    expect(working.used).toBe(0)
  },
  30000
)
test.each([
  '{"z":1,"2":"two","1":"one","a":null,"z":3,"0":"zero","4294967295":"string"}',
  '{"z":{"b":true,"a":null,"2":2,"1":1},"a":[null,false,-0,1e20,1e400,"\\ud800"]}',
  '{"notes":[{"what":"' + 'x'.repeat(70000) + '😀' + '","when":"2026-01-01T00:00:00.000Z","extra":null}]}',
  '{"\\ud800":"first","x":"last"}',
  '{"x":"aaaaaa\\ud800\\ud800\\udc00zzzzzz\\udc00"}'
])(
  'bounded legacy spelling exactly matches independent JSON.parse/stringify: case%#',
  async raw => {
    const fixture = source(raw, 'utf16le'),
      working = new Brc38WorkingAllocation(1048576)
    const actual = await text(
      stringifyBrc38StructuredJsonSpan(
        fixture.result,
        { start: 0, end: fixture.bytes.length },
        { ...policy, workingAllocation: working }
      )
    )
    expect(actual).toBe(JSON.stringify(JSON.parse(raw)))
    expect(fixture.indexes).toHaveLength(2)
    expect(fixture.indexes.every(index => index.closed)).toBe(true)
    expect(working.used).toBe(0)
  },
  30000
)

test('legacy span spelling validates exact nested coordinates, output limits and retained cleanup', async () => {
  const raw = '{"outside":false,"notes":[{"z":null,"a":"actual"}]}',
    literal = '{"z":null,"a":"actual"}',
    fixture = source(raw),
    start = raw.indexOf(literal),
    working = new Brc38WorkingAllocation(1048576)
  expect(
    await text(
      stringifyBrc38StructuredJsonSpan(
        fixture.result,
        { start, end: start + literal.length },
        { ...policy, workingAllocation: working }
      )
    )
  ).toBe(JSON.stringify(JSON.parse(literal)))
  await expect(
    text(
      stringifyBrc38StructuredJsonSpan(
        fixture.result,
        { start, end: start + literal.length - 1 },
        { ...policy, workingAllocation: working }
      )
    )
  ).rejects.toThrow()
  await expect(
    text(
      stringifyBrc38StructuredJsonSpan(
        fixture.result,
        { start, end: start + literal.length },
        { ...policy, maximumOutputBytes: 4, workingAllocation: working }
      )
    )
  ).rejects.toThrow('original output allowance')
  expect(working.used).toBe(0)
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
})
test('legacy spelling releases recursive frame admission when a concrete source read fails inside a child', async () => {
  const fixture = source('{"a":{"x":true}}'),
    working = new Brc38WorkingAllocation(1048576),
    read = fixture.result.read
  let selectedReads = 0
  fixture.result.read = async (offset, length) => {
    if (fixture.indexes.length === 2 && fixture.indexes.every(index => index.sealed) && ++selectedReads === 3)
      throw new Error('Actual nested source read interrupted')
    return await read(offset, length)
  }
  await expect(
    text(
      stringifyBrc38StructuredJsonSpan(
        fixture.result,
        { start: 0, end: fixture.bytes.length },
        { ...policy, workingAllocation: working }
      )
    )
  ).rejects.toThrow('Actual nested source read interrupted')
  expect(working.used).toBe(0)
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
})
test.each(['{"what":"actual","extra":null}', '{"what":"actual","when":"","extra":null}'])(
  'prepared default note time preserves legacy property insertion on %s',
  async raw => {
    const fixture = source(raw),
      working = new Brc38WorkingAllocation(1048576),
      value = '2026-10-07T00:00:00.000Z',
      expected = JSON.parse(raw) as { when?: string }
    expected.when = value
    expect(
      await text(
        stringifyBrc38StructuredJsonSpan(
          fixture.result,
          { start: 0, end: fixture.bytes.length },
          { ...policy, workingAllocation: working },
          { value }
        )
      )
    ).toBe(JSON.stringify(expected))
    expect(working.used).toBe(0)
    expect(fixture.indexes.every(index => index.closed)).toBe(true)
  }
)
test('raw occupied JSON visitation preserves nulls, containers, original insertion and last duplicate values', async () => {
  const raw =
      '{"z":null,"notes":[{"what":"discarded","what":"last\\ud800","extra":{"flag":null},"list":[null,false]}],"z":false}',
    fixture = source(raw),
    working = new Brc38WorkingAllocation(1048576),
    texts: string[] = [],
    nulls: Array<readonly (string | number)[]> = [],
    members: Array<{ key: string; first: number; last: number }> = []
  await visitBrc38StructuredJsonValues(
    fixture.result,
    { ...policy, workingAllocation: working },
    {
      text: (path, value) => {
        if (path.join('.') === 'notes.0.what') texts.push(value)
      },
      null: path => {
        nulls.push(path)
      },
      member: (path, value) => {
        if ((path.length === 1 && path[0] === 'z') || path.join('.') === 'notes.0.what')
          members.push({ key: value.key, first: value.firstKeyOffset, last: value.keyOffset })
      }
    }
  )
  expect(texts.join('')).toBe((JSON.parse(raw) as { notes: Array<{ what: string }> }).notes[0].what)
  expect(nulls).toEqual([
    ['notes', 0, 'extra', 'flag'],
    ['notes', 0, 'list', 0]
  ])
  expect(members.every(value => value.first < value.last)).toBe(true)
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
  expect(working.used).toBe(0)
  // Existing canonical BRC-38 rules continue to refuse the raw lone surrogate.
  await expect(
    text(validatedCanonicalBrc38StructuredWalletField('history', fixture.result, policy, 'req[0]'))
  ).rejects.toThrow()
})

test('raw visitation remains provisional through full digest and retains concrete index cleanup failure', async () => {
  const fixture = source('{"notes":[{"what":"actual"}]}'),
    working = new Brc38WorkingAllocation(1048576)
  let emitted = false
  await expect(
    visitBrc38StructuredJsonValues(
      fixture.result,
      { ...policy, workingAllocation: working },
      {
        text: () => {
          emitted = true
          fixture.bytes[fixture.bytes.length - 1] = 32
        }
      }
    )
  ).rejects.toThrow()
  expect(emitted).toBe(true)
  expect(fixture.indexes[0].closed).toBe(true)
  expect(working.used).toBe(0)
  const clean = source('{}'),
    reason = new Error('Actual original index close failed')
  let closeFails = true
  clean.result.openIndex = async () => {
    const index = new FixtureIndex()
    index.close = async () => {
      if (closeFails) throw reason
      index.closed = true
    }
    clean.indexes.push(index)
    return index
  }
  let failure: unknown
  try {
    await visitBrc38StructuredJsonValues(clean.result, { ...policy, workingAllocation: working }, {})
  } catch (cause) {
    failure = cause
  }
  expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
  closeFails = false
  await (failure as Brc38StagingCleanupError).retryCleanup()
  expect(clean.indexes[0].closed).toBe(true)
  expect(working.used).toBe(0)
})
test.each([
  ['"a"', '"b"'],
  ['"a"', '"a"'],
  ['""', '"longer"'],
  ['"ab"', '"a"'],
  ['"\\u0061\\u0062"', '"ab"'],
  ['"😀"', '"\\ue000"'],
  ['"\\ud800"', '"\\ud801"'],
  ['"\\n\\t\\\"\\\\"', '"\\u000a\\u0009\\u0022\\u005c"'],
  [JSON.stringify('x'.repeat(70000) + 'a'), JSON.stringify('x'.repeat(70000) + 'b')]
])(
  'bounded JSON-string span order preserves independent ECMAScript UTF-16 comparison: case%#',
  async (a, b) => {
    const left = source('[false,' + a + ',true]', 'utf8'),
      right = source('[false,' + b + ',true]', 'utf16le'),
      start = new TextEncoder().encode('[false,').length,
      working = new Brc38WorkingAllocation(1048576),
      values = [JSON.parse(a) as string, JSON.parse(b) as string],
      expected = values[0] < values[1] ? -1 : values[0] > values[1] ? 1 : 0,
      check = jest.fn()
    const actual = await compareBrc38StructuredStringSpans(
      left.result,
      { start, end: start + new TextEncoder().encode(a).length },
      right.result,
      { start: 14, end: 14 + b.length * 2 },
      {
        maximumInputBytes: 1048576,
        maximumDecodedCodeUnits: 100000,
        maximumReadBytes: 4096,
        maximumAllocationBytes: 1048576,
        workingAllocation: working,
        expiresAt: Date.now() + 30000,
        check
      }
    )
    expect(actual).toBe(expected)
    expect(check).toHaveBeenCalled()
    expect(working.used).toBe(0)
    expect(left.indexes).toEqual([])
    expect(right.indexes).toEqual([])
    expect([...left.calls, ...right.calls].every(([, length]) => length <= 4096)).toBe(true)
  },
  30000
)

test.each(['"z\\q"', '"z"false', '"z\\u00"', '"z\n"'])(
  'string comparison drains and rejects malformed tails after an earlier unit decides the order: %s',
  async malformed => {
    const first = source('"a"'),
      second = source(malformed),
      working = new Brc38WorkingAllocation(65536)
    await expect(
      compareBrc38StructuredStringSpans(
        first.result,
        { start: 0, end: first.bytes.length },
        second.result,
        { start: 0, end: second.bytes.length },
        {
          maximumInputBytes: 1024,
          maximumDecodedCodeUnits: 100,
          maximumReadBytes: 64,
          workingAllocation: working,
          expiresAt: Date.now() + 30000,
          check: () => {}
        }
      )
    ).rejects.toThrow()
    expect(working.used).toBe(0)
  }
)

test('string comparisons retain original unit allowance and recheck current owners after yielding', async () => {
  const first = source('"aa"'),
    second = source('"ab"'),
    working = new Brc38WorkingAllocation(65536),
    selected = {
      maximumInputBytes: 1024,
      maximumDecodedCodeUnits: 1,
      maximumReadBytes: 64,
      workingAllocation: working,
      expiresAt: Date.now() + 30000,
      check: () => {}
    }
  const limited = compareBrc38StructuredStringSpans(
    first.result,
    { start: 0, end: first.bytes.length },
    second.result,
    { start: 0, end: second.bytes.length },
    selected
  )
  selected.maximumDecodedCodeUnits = 100
  await expect(limited).rejects.toThrow('original decoded-unit allowance')
  expect(working.used).toBe(0)
  let checks = 0
  await expect(
    compareBrc38StructuredStringSpans(
      first.result,
      { start: 0, end: first.bytes.length },
      second.result,
      { start: 0, end: second.bytes.length },
      {
        ...selected,
        check: () => {
          if (++checks === 5) throw new Error('Actual retained owner changed')
        }
      }
    )
  ).rejects.toThrow('Actual retained owner changed')
  expect(working.used).toBe(0)
})
test.each([
  '{"z":true,"a":"' + 'large'.repeat(100) + '","transactionIds":[3,1,3]}',
  '{"a":1,"transactionIds":null,"z":true}',
  '{"z":true}',
  '{}'
])('projected notify preserves other members and replaces or inserts IDs in canonical order: case%#', async raw => {
  const fixture = source(raw),
    close = jest.fn(async () => {})
  const actual = await text(
    canonicalBrc38ProjectedNotify(fixture.result, policy, 'provenTxReqs[0]', {
      async *chunks() {
        yield new TextEncoder().encode('[2,')
        yield new TextEncoder().encode('9]')
      },
      close
    })
  )
  const expected = { ...JSON.parse(raw), transactionIds: [2, 9] }
  expect(actual).toBe(
    Buffer.concat([...canonicalPortableChunks(expected, { maximumValueBytes: 1048576 })]).toString('utf8')
  )
  expect(close).toHaveBeenCalled()
  expect(fixture.indexes[0].closed).toBe(true)
})
test.each(['[2,2]', '[9,2]', '[1.5]', '[01]', '[-0]', '[9007199254740992]', '[1,]', '[]false', '[1'])(
  'invalid derived notification IDs remain provisional and close both indexes: %s',
  async replacement => {
    const fixture = source('{"transactionIds":[1]}'),
      close = jest.fn(async () => {})
    await expect(
      text(
        canonicalBrc38ProjectedNotify(fixture.result, policy, 'provenTxReqs[0]', {
          async *chunks() {
            yield new TextEncoder().encode(replacement)
          },
          close
        })
      )
    ).rejects.toThrow()
    expect(close).toHaveBeenCalled()
    expect(fixture.indexes[0].closed).toBe(true)
  }
)
test('projection visitation selects final duplicate values and streams text while retaining array order', async () => {
  const fixture = source('{"transactionIds":[999],"transactionIds":[3,-1,3],"extra":"' + '😀é'.repeat(200) + '"}'),
    numbers: number[] = [],
    pieces: string[] = []
  await visitBrc38StructuredWalletField('notify', fixture.result, policy, 'provenTxReqs[0]', {
    number: async (path, value) => {
      if (path.length === 2 && path[0] === 'transactionIds') numbers.push(value)
    },
    text: async (path, value) => {
      expect(Object.isFrozen(path)).toBe(true)
      expect(value.length).toBeLessThanOrEqual(12)
      if (path.length === 1 && path[0] === 'extra') pieces.push(value)
    }
  })
  expect(numbers).toEqual([3, -1, 3])
  expect(pieces.join('')).toBe('😀é'.repeat(200))
  expect(fixture.indexes[0].closed).toBe(true)
})
test('projection callback failure drains the actual index and never completes provisional effects', async () => {
  const fixture = source('{"transactionIds":[1,2]}'),
    reason = new Error('projection rejected')
  let completed = false
  await expect(
    (async () => {
      await visitBrc38StructuredWalletField('notify', fixture.result, policy, 'provenTxReqs[0]', {
        number: async () => {
          throw reason
        }
      })
      completed = true
    })()
  ).rejects.toBe(reason)
  expect(completed).toBe(false)
  expect(fixture.indexes[0].closed).toBe(true)
})
test('wallet-validated canonical output matches the original projector while raw replay bytes remain intact', async () => {
  const raw =
    '{"notes":[{"what":7,"what":"kept","optional":null,"when":"2026-10-03T00:00:00.000Z"}],"notes":null,"notes":[{"what":"last"}]}'
  const fixture = source(raw),
    before = fixture.bytes.slice()
  expect(
    await text(validatedCanonicalBrc38StructuredWalletField('history', fixture.result, policy, 'provenTxReqs[0]'))
  ).toBe(oracle('history', raw))
  expect(fixture.bytes).toEqual(before)
  expect(fixture.indexes[0].closed).toBe(true)
})
test('derived output cannot complete when the actual index close fails after valid wallet bytes', async () => {
  const fixture = source('{"notes":[{"what":"' + 'x'.repeat(500) + '"}]}')
  fixture.result.openIndex = async () => {
    const index = new FixtureIndex()
    index.close = async () => {
      throw new Error('owned index cleanup failed')
    }
    return index
  }
  let chunks = 0,
    completed = false
  await expect(
    (async () => {
      for await (const _chunk of validatedCanonicalBrc38StructuredWalletField(
        'history',
        fixture.result,
        policy,
        'provenTxReqs[0]'
      ))
        chunks++
      completed = true
    })()
  ).rejects.toThrow('owned index cleanup failed')
  expect(chunks).toBeGreaterThan(0)
  expect(completed).toBe(false)
})
test.each([
  ['history', '{"notes":[{"what":"' + 'large'.repeat(20000) + '","when":"2026-10-03T00:00:00.000Z"}]}'],
  ['history', '{"notes":[{"what":7,"what":"last"}]}'],
  ['notify', '{"transactionIds":[0,-1,1e16]}'],
  ['syncMap', '{"map":{}}'],
  ['errorLocal', '{}'],
  ['errorOther', '{}']
])('fresh indexed wallet rules validate %s without materializing field values', async (field, raw) => {
  const fixture = source(raw)
  await validateBrc38StructuredWalletField(field, fixture.result, policy, 'provenTxReqs[0]')
  expect(fixture.indexes).toHaveLength(1)
  expect(fixture.indexes[0].closed).toBe(true)
})
test.each([
  ['history', '{"notes":{}}'],
  ['history', '{"notes":[1]}'],
  ['history', '{"notes":[{}]}'],
  ['history', '{"notes":[{"what":7}]}'],
  ['history', '{"notes":[{"what":"ok","when":"2026-02-30T00:00:00.000Z"}]}'],
  ['history', '{"notes":[{"what":"ok","when":"' + 'x'.repeat(100000) + '"}]}'],
  ['notify', '{"transactionIds":{}}'],
  ['notify', '{"transactionIds":[1.5]}'],
  ['notify', '{"transactionIds":["1"]}']
])('indexed wallet rule case%# closes the actual owned index for%s', async (field, raw) => {
  const fixture = source(raw)
  await expect(validateBrc38StructuredWalletField(field, fixture.result, policy, 'provenTxReqs[0]')).rejects.toThrow()
  expect(fixture.indexes).toHaveLength(1)
  expect(fixture.indexes[0].closed).toBe(true)
})
function oracle(field: string, raw: string): string {
  const table = ['history', 'notify'].includes(field) ? 'provenTxReqs' : 'syncStates'
  const projected = projectBrc38PackedRow(table, { [field]: raw }, { maximumAllocationBytes: 16777216 })
  return Buffer.concat([...canonicalPortableChunks(projected[field], { maximumValueBytes: 16777216 })]).toString('utf8')
}

test.each(['utf8', 'utf16le'] as const)(
  'indexed canonical JSON matches the original projector for %s',
  async encoding => {
    const values = [
      [
        'history',
        '{"z":[1,-0,1e-7,1.25,true,false,"\\n\\t\\b\\f\\r\\/\\\\\\\"😀é"],"notes":[{"what":"old","optional":null},{"what":"new","n":2}],"a":{}}'
      ],
      ['notify', '{"transactionIds":null,"kept":[0,1]}'],
      ['syncMap', '{"transaction":{"maxUpdated_at":null,"idMap":{"2":4,"10":3,"1":2}},"other":{}}'],
      ['errorLocal', '{"stack":null,"message":"An error"}'],
      ['errorOther', '{"message":"A different error","stack":"kept"}'],
      [
        'history',
        '{"":[],"duplicate":null,"duplicate":1,"a":"ignored\\ud800","a":"kept","\\u0062":2,"b":3,"notes":null}'
      ]
    ]
    for (const [field, raw] of values) {
      const fixture = source(raw, encoding)
      expect(await text(canonicalBrc38StructuredJson(field, fixture.result, policy))).toBe(oracle(field, raw))
      expect(fixture.calls.every(([, length]) => length <= 64)).toBe(true)
      expect(fixture.indexes).toHaveLength(1)
      expect(fixture.indexes[0].closed).toBe(true)
    }
  }
)
test('more than 4096 map keys sort by raw UTF16 units through the external index', async () => {
  const raw = JSON.stringify({
      map: Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`key-${4097 - i}`, i]))
    }),
    fixture = source(raw)
  expect(await text(canonicalBrc38StructuredJson('syncMap', fixture.result, policy))).toBe(oracle('syncMap', raw))
  expect(fixture.indexes[0].members.size).toBe(2)
})
test.each([
  '{"required":null}',
  '{"notes":[null]}',
  '{"notes":[{"what":null}]}',
  '{"value":"\\ud800"}',
  '{"value":1e400}',
  '{"value":[1,]}',
  '{"value":01}',
  '{}{}',
  '[]'
])('required/array null, malformed or nonportable JSON fails and closes the index: %s', async raw => {
  const fixture = source(raw)
  await expect(text(canonicalBrc38StructuredJson('history', fixture.result, policy))).rejects.toThrow()
  expect(fixture.indexes.every(index => index.closed)).toBe(true)
})
test('UTF16 key ordering and multibyte/escaped strings remain exact across extent boundaries', async () => {
  const raw = JSON.stringify({ '\ue000': 'last', '😀': 'before', value: 'A'.repeat(31) + '😀'.repeat(200) + '\n\t' }),
    fixture = source(raw)
  expect(await text(canonicalBrc38StructuredJson('history', fixture.result, policy))).toBe(oracle('history', raw))
})
test('bad input digest fails before index allocation and truncation never completes', async () => {
  const fixture = source('{"value":1}')
  fixture.result.sha256 = '00'.repeat(32)
  await expect(text(canonicalBrc38StructuredJson('history', fixture.result, policy))).rejects.toThrow('digest differs')
  expect(fixture.indexes).toHaveLength(0)
  fixture.result.sha256 = new SHA256().update(fixture.bytes).digestHex()
  fixture.result.read = async (offset, length) => fixture.bytes.slice(offset, offset + length - 1)
  await expect(text(canonicalBrc38StructuredJson('history', fixture.result, policy))).rejects.toThrow()
})
test('abandonment closes the actual index and schedules no more reads', async () => {
  const fixture = source(JSON.stringify({ values: Array.from({ length: 100 }, (_, i) => i) }))
  const iterator = canonicalBrc38StructuredJson('history', fixture.result, policy)
  expect((await iterator.next()).done).toBe(false)
  const count = fixture.calls.length
  await iterator.return(undefined)
  expect(fixture.calls).toHaveLength(count)
  expect(fixture.indexes[0].closed).toBe(true)
})
test('an injected consumer failure and actual index teardown failure remain observable after one cleanup attempt', async () => {
  const fixture = source(JSON.stringify({ values: Array.from({ length: 100 }, (_, i) => i) })),
    original = { consumer: 'stopped accepting provisional bytes' },
    cleanup = new Error('actual index close failed'),
    index = new FixtureIndex(),
    close = jest.fn(async () => {
      throw cleanup
    })
  index.close = close
  fixture.result.openIndex = async () => index
  const iterator = canonicalBrc38StructuredJson('history', fixture.result, policy)
  expect((await iterator.next()).done).toBe(false)
  const reads = fixture.calls.length
  const result = await Promise.allSettled([iterator.throw(original)])
  expect(result[0].status).toBe('rejected')
  if (result[0].status !== 'rejected') throw new Error('Consumer failure unexpectedly completed')
  expect(result[0].reason).toBeInstanceOf(AggregateError)
  expect(result[0].reason.errors).toEqual([original, cleanup])
  expect(close).toHaveBeenCalledTimes(1)
  expect(fixture.calls).toHaveLength(reads)
  expect((await iterator.next()).done).toBe(true)
})
test('iterator return awaits the actual pending index drain before completing and starts no further source reads', async () => {
  const fixture = source(JSON.stringify({ values: Array.from({ length: 100 }, (_, i) => i) })),
    index = new FixtureIndex()
  let release!: () => void
  const pending = new Promise<void>(resolve => {
      release = resolve
    }),
    close = jest.fn(async () => {
      await pending
      index.closed = true
    })
  index.close = close
  fixture.result.openIndex = async () => index
  const iterator = canonicalBrc38StructuredJson('history', fixture.result, policy)
  expect((await iterator.next()).done).toBe(false)
  const reads = fixture.calls.length
  let returned = false
  const closing = iterator.return(undefined).then(value => {
    returned = true
    return value
  })
  try {
    await Promise.resolve()
    expect(returned).toBe(false)
    expect(index.closed).toBe(false)
  } finally {
    release()
    await closing
  }
  expect(returned).toBe(true)
  expect(index.closed).toBe(true)
  expect(close).toHaveBeenCalledTimes(1)
  expect(fixture.calls).toHaveLength(reads)
})
test('caller policy mutation cannot enlarge the original encoded output allowance', async () => {
  const fixture = source(JSON.stringify({ value: 'A'.repeat(200) })),
    selected = { ...policy, maximumOutputBytes: 96 },
    iterator = canonicalBrc38StructuredJson('history', fixture.result, selected)
  expect((await iterator.next()).value).toHaveLength(64)
  selected.maximumOutputBytes = 1048576
  await expect(text({ [Symbol.asyncIterator]: () => iterator })).rejects.toThrow('output exceeds')
  expect(fixture.indexes[0].closed).toBe(true)
})
test('structured extents are integrated with ordinary metadata and preserve canonical row spelling', async () => {
  const raw = '{"notes":[{"what":"original","optional":null}],"z":[1,2]}',
    fixture = source(raw, 'utf16le')
  const value = await text(
    encodeBrc38StreamedRow(
      'provenTxReqs',
      { fields: { provenTxReqId: 1 }, binaries: {}, structured: { history: fixture.result } },
      {
        maximumBinaryBytes: 1048576,
        maximumStructuredBytes: 1048576,
        maximumMetadataAllocationBytes: 65536,
        maximumRowBytes: 1048576,
        maximumChunkBytes: 64
      }
    )
  )
  const projected = projectBrc38PackedRow(
    'provenTxReqs',
    { provenTxReqId: 1, history: raw },
    { maximumAllocationBytes: 65536 }
  )
  expect(value).toBe(
    Buffer.concat([...canonicalPortableChunks(projected, { maximumValueBytes: 65536 })]).toString('utf8')
  )
})

// Span positions are independently checked against the original byte encoding,
// not canonical output offsets or an in-memory source-admission result.
test.each(['utf8', 'utf16le'] as const)(
  'visitor spans retain actual %s coordinates for bounded name projection',
  async encoding => {
    const raw = '{"transaction":{"entityName":"' + '😀é'.repeat(150) + '\\nend","idMap":{"01":7,"1":8,"01":9}}}',
      fixture = source(raw, encoding)
    let start = -1,
      end = -1
    await visitBrc38StructuredWalletField('syncMap', fixture.result, policy, 'syncStates[0]', {
      enter: (path, kind, offset) => {
        if (path.join('.') === 'transaction.entityName' && kind === 'string') start = offset
      },
      end: (path, offset) => {
        if (path.join('.') === 'transaction.entityName') end = offset
      }
    })
    const original =
      encoding === 'utf8'
        ? Buffer.from(fixture.bytes.subarray(start, end)).toString('utf8')
        : Buffer.from(fixture.bytes.subarray(start, end)).toString('utf16le')
    expect(JSON.parse(original)).toBe(JSON.parse(raw).transaction.entityName)
    expect(await text(canonicalBrc38StructuredStringSpan(fixture.result, { start, end }, policy))).toBe(
      JSON.stringify(JSON.parse(raw).transaction.entityName)
    )
    expect(fixture.calls.every(([, length]) => length <= 64)).toBe(true)
  }
)
test('string spans cannot complete on a changed whole source or a false source boundary', async () => {
  const fixture = source('{"x":"name","z":1}')
  await expect(
    text(canonicalBrc38StructuredStringSpan(fixture.result, { start: 5, end: 10 }, policy))
  ).rejects.toThrow()
  fixture.bytes[fixture.bytes.length - 2] = 50
  await expect(verifyBrc38StructuredSourceDigest(fixture.result, 1000000)).rejects.toThrow()
  await expect(
    text(canonicalBrc38StructuredStringSpan(fixture.result, { start: 5, end: 11 }, policy))
  ).rejects.toThrow()
})

test('large visible strings use the original shared grammar allocation and preserve independent canonical bytes', async () => {
  const invalidRaw = '{"notes":[{"what":"' + '😀é'.repeat(4000) + '"}],"optional":null}',
    invalidSource = source(invalidRaw)
  // The historical projector only omits nullable note members. Preserve the
  // original top-level null input as a refusal case for both implementations.
  expect(() => oracle('history', invalidRaw)).toThrow()
  await expect(
    text(
      validatedCanonicalBrc38StructuredWalletField(
        'history',
        invalidSource.result,
        { ...policy, maximumAllocationBytes: 32768 },
        'provenTxReqs[0]'
      )
    )
  ).rejects.toThrow()
  expect(invalidSource.indexes[0].closed).toBe(true)
  const raw = '{"notes":[{"what":"' + '😀é'.repeat(4000) + '","optional":null}]}',
    fixture = source(raw),
    before = fixture.bytes.slice()
  expect(
    await text(
      validatedCanonicalBrc38StructuredWalletField(
        'history',
        fixture.result,
        { ...policy, maximumAllocationBytes: 32768 },
        'provenTxReqs[0]'
      )
    )
  ).toBe(oracle('history', raw))
  expect(fixture.bytes).toEqual(before)
  expect(fixture.calls.every(([, length]) => length <= 64)).toBe(true)
  expect(fixture.indexes[0].closed).toBe(true)
})
test('nested retained keys draw from one original allocation rather than renewing a budget per reader', async () => {
  const name = 'k'.repeat(1000),
    raw = ('{"' + name + '":').repeat(8) + 'true' + '}'.repeat(8),
    fixture = source(raw),
    before = fixture.bytes.slice()
  // The syntax is valid under the unchanged legacy policy. Only the explicit
  // original resource budget refuses the simultaneous retained parent keys.
  expect(await text(canonicalBrc38StructuredJson('history', fixture.result, policy))).toBe(oracle('history', raw))
  const bounded = source(raw)
  await expect(
    text(canonicalBrc38StructuredJson('history', bounded.result, { ...policy, maximumAllocationBytes: 32768 }))
  ).rejects.toThrow('original working allocation')
  expect(bounded.indexes[0].closed).toBe(true)
  expect(fixture.bytes).toEqual(before)
})
test('returning early drains parser/index scopes without erasing a transferred output chunk', async () => {
  const workingAllocation = new Brc38WorkingAllocation(32768),
    fixture = source('{"notes":[{"what":"' + 'kept'.repeat(1000) + '"}]}'),
    iterator = validatedCanonicalBrc38StructuredWalletField(
      'history',
      fixture.result,
      { ...policy, maximumAllocationBytes: 32768, workingAllocation },
      'provenTxReqs[0]'
    ),
    first = await iterator.next()
  if (first.done) throw new Error('Fixture must produce an output chunk')
  const original = first.value.slice()
  await iterator.return(undefined)
  expect(first.value).toEqual(original)
  expect(first.value.some(byte => byte !== 0)).toBe(true)
  expect(workingAllocation.used).toBe(0)
  expect(fixture.indexes[0].closed).toBe(true)
})
test('caller grammar budget mutation during a read cannot shrink or enlarge the captured policy', async () => {
  const fixture = source('{"notes":[{"what":"' + 'data'.repeat(1000) + '"}]}'),
    selected = { ...policy, maximumAllocationBytes: 32768 },
    read = fixture.result.read
  fixture.result.read = async (offset, length) => {
    selected.maximumAllocationBytes = 4096
    return await read(offset, length)
  }
  expect(
    await text(validatedCanonicalBrc38StructuredWalletField('history', fixture.result, selected, 'provenTxReqs[0]'))
  ).toBe(oracle('history', '{"notes":[{"what":"' + 'data'.repeat(1000) + '"}]}'))
  expect(fixture.indexes[0].closed).toBe(true)
  const denied = source('{}'),
    options = { ...policy, maximumAllocationBytes: 4096 },
    originalRead = denied.result.read
  denied.result.read = async (offset, length) => {
    options.maximumAllocationBytes = 16777216
    return await originalRead(offset, length)
  }
  await expect(text(canonicalBrc38StructuredJson('history', denied.result, options))).rejects.toThrow(
    'original working allocation'
  )
  expect(denied.calls).toEqual([])
  expect(denied.indexes).toEqual([])
})
test('digest-only windows keep an explicit original allocation and refuse before an oversized transfer', async () => {
  const fixture = source('{"large":"' + 'x'.repeat(10000) + '"}')
  await verifyBrc38StructuredSourceDigest(fixture.result, fixture.bytes.length, undefined, 64, 16384)
  expect(fixture.calls.every(([, length]) => length <= 64)).toBe(true)
  fixture.calls.length = 0
  await expect(
    verifyBrc38StructuredSourceDigest(fixture.result, fixture.bytes.length, undefined, 65536, 16384)
  ).rejects.toThrow('original working allocation')
  expect(fixture.calls).toEqual([])
})

test('grammar admission accounts an independently retained component before the first source read', async () => {
  const workingAllocation = new Brc38WorkingAllocation(32768),
    retained = workingAllocation.claim(30000),
    fixture = source('{"transactionIds":[1,2]}'),
    options = { ...policy, maximumAllocationBytes: 32768, workingAllocation }
  await expect(text(canonicalBrc38StructuredJson('notify', fixture.result, options))).rejects.toThrow(
    SnapshotResourceLimitError
  )
  expect(fixture.calls).toEqual([])
  expect(fixture.indexes).toEqual([])
  expect(workingAllocation.used).toBe(30000)
  retained.close()
  expect(await text(canonicalBrc38StructuredJson('notify', fixture.result, options))).toBe('{"transactionIds":[1,2]}')
  expect(workingAllocation.used).toBe(0)
  expect(fixture.indexes[0].closed).toBe(true)
})
