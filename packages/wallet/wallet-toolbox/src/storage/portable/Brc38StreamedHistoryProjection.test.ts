import { createHash } from 'node:crypto'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { Brc38StreamedHistoryProjection } from './Brc38StreamedHistoryProjection'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'
import type { Brc38JsonMember, Brc38JsonMemberIndex, Brc38StreamedStructured } from './Brc38StructuredJson'

/** Small fixture only. Actual legacy EntityProvenTxReq is the independent
 * semantic oracle; this fixture supplies no native/browser qualification. */
class FixtureIndex implements Brc38JsonMemberIndex {
  members = new Map<number, Map<string, Brc38JsonMember>>()
  first = new Map<number, Map<string, number>>()
  sealed = false
  closed = false
  failClose = false
  async put(offset: number, member: Brc38JsonMember): Promise<void> {
    if (this.closed || this.sealed) throw new Error('Fixture index unavailable')
    if (!this.members.has(offset)) {
      this.members.set(offset, new Map())
      this.first.set(offset, new Map())
    }
    const original = this.first.get(offset)!.get(member.key)
    this.first.get(offset)!.set(member.key, Math.min(original ?? member.keyOffset, member.keyOffset))
    this.members.get(offset)!.set(member.key, { ...member })
  }
  async seal(): Promise<void> {
    this.sealed = true
  }
  async *entries(offset: number): AsyncGenerator<Brc38JsonMember> {
    if (!this.sealed || this.closed) throw new Error('Fixture index unavailable')
    for (const key of [...(this.members.get(offset)?.keys() ?? [])].sort())
      yield { ...this.members.get(offset)!.get(key)! }
  }
  async lookup(
    offset: number,
    key: string
  ): Promise<Readonly<Brc38JsonMember & { firstKeyOffset: number }> | undefined> {
    if (!this.sealed || this.closed) throw new Error('Fixture index unavailable')
    const value = this.members.get(offset)?.get(key)
    return value === undefined ? undefined : { ...value, firstKeyOffset: this.first.get(offset)!.get(key)! }
  }
  async close(): Promise<void> {
    if (this.failClose) {
      this.failClose = false
      throw new Error('Actual fixture retirement interrupted')
    }
    this.closed = true
  }
}
function fixture(existing: string, incoming: string, encoding: 'utf8' | 'utf16le' = 'utf8') {
  const indexes: FixtureIndex[] = [],
    working = new Brc38WorkingAllocation(4194304)
  let current = true
  const check = (): void => {
    if (!current) throw new Error('Actual source owner revoked')
  }
  const open = async (): Promise<FixtureIndex> => {
    check()
    const index = new FixtureIndex()
    indexes.push(index)
    return index
  }
  const source = (raw: string): Brc38StreamedStructured => {
    const bytes = new Uint8Array(Buffer.from(raw, encoding === 'utf8' ? 'utf8' : 'utf16le'))
    return {
      encoding,
      length: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      read: async (offset, length) => {
        check()
        expect(length).toBeLessThanOrEqual(64)
        return bytes.slice(offset, offset + length)
      },
      openIndex: open
    }
  }
  const owners: Brc38StructuredProjectionOwners = {
    check,
    openIndex: open,
    readMappings: async () => {
      throw new Error('History union must not read an ID map')
    }
  }
  return {
    indexes,
    working,
    owners,
    existing: source(existing),
    incoming: source(incoming),
    revoke: () => {
      current = false
    },
    policy: {
      maximumTemporaryIndexBytes: 6291456,
      maximumMembers: 10000,
      maximumOutputBytes: 1048576,
      maximumReadBytes: 64,
      maximumGrammarAllocationBytes: 1048576,
      maximumIndexAllocationBytes: 1048576,
      workingAllocation: working,
      expiresAt: Date.now() + 60000
    }
  }
}
async function output(chunks: AsyncIterable<Uint8Array>): Promise<string> {
  const parts: Uint8Array[] = []
  for await (const bytes of chunks) {
    expect(bytes.length).toBeLessThanOrEqual(64)
    parts.push(bytes)
  }
  return Buffer.concat(parts).toString('utf8')
}
function legacy(existing: string, incoming: string): string {
  const current = EntityProvenTxReq.fromTxid('a'.repeat(64), []),
    other = EntityProvenTxReq.fromTxid('a'.repeat(64), [])
  current.apiHistory = existing
  other.apiHistory = incoming
  current.mergeHistory(other.toApi())
  return current.apiHistory
}
const when = '2026-10-07T00:00:00.000Z'
test.each([
  ['{"notes":[{"what":"added","tag":"same"}]}', '{"notes":[{"what":"added","tag":"same","when":"' + when + '"}]}'],
  [
    '{"notes":[{"what":"added","when":"","tag":"same"}]}',
    '{"notes":[{"what":"added","when":"' + when + '","tag":"same"}]}'
  ]
])(
  'portable missing-time notes use the archived timestamp and repeat without additions: case%#',
  async (incoming, expected) => {
    for (const existing of ['{"notes":[]}', expected]) {
      const f = fixture(existing, incoming),
        field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing, when)
      try {
        expect(await output(field.measureChunks(64))).toBe(expected)
        expect(await output(field.chunks(64))).toBe(expected)
        expect(field.addedNotes).toBe(existing === expected ? 0 : 1)
      } finally {
        await field.close()
      }
      expect(f.indexes.every(index => index.closed)).toBe(true)
      expect(f.working.used).toBe(0)
    }
  },
  30000
)

test('portable history refuses a noncanonical archived fallback timestamp before index allocation', async () => {
  const f = fixture('{"notes":[]}', '{"notes":[{"what":"added"}]}')
  await expect(
    Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing, '2026-10-07T00:00:00Z')
  ).rejects.toThrow('UTC ISO timestamp')
  expect(f.indexes).toHaveLength(0)
  expect(f.working.used).toBe(0)
})
test.each([
  [
    '{"before":1,"notes":[{"what":"same","when":"' + when + '"},{"what":"same","when":"' + when + '"}],"after":null}',
    '{"ignored":true,"notes":[{"what":"same","when":"' + when + '","extra":true}]}'
  ],
  [
    '{"notes":[{"what":"same","when":"' + when + '","extra":true}]}',
    '{"notes":[{"what":"same","when":"' + when + '"}]}'
  ],
  [
    '{"notes":[{"what":"same","when":"' + when + '","extra":{"x":1}}]}',
    '{"notes":[{"what":"same","when":"' + when + '","extra":{"x":1}}]}'
  ],
  [
    '{"notes":[{"what":"same","when":"' + when + '","extra":null}]}',
    '{"notes":[{"what":"same","when":"' + when + '","extra":null}]}'
  ],
  [
    '{"notes":[{"what":"z","when":"' + when + '"},{"what":"a","when":"' + when + '"}]}',
    '{"notes":[{"what":"a","when":"' + when + '"}]}'
  ],
  [
    '{"z":true,"notes":[{"what":"z","when":"' + when + '"},{"what":"a","when":"' + when + '"}],"a":false}',
    '{"notes":[{"what":"m","when":"' + when + '"}]}'
  ],
  ['{"z":true}', '{}'],
  ['{"notes":null,"a":1}', '{"notes":null}'],
  ['{"z":true}', '{"notes":[{"what":"added","when":"' + when + '"}]}'],
  ['{"notes":[{"what":"z","when":"a"},{"what":"a","when":"a\\u0000"}]}', '{"notes":[{"what":"b","when":"a"}]}'],
  [
    '{"notes":[{"what":"object","when":{"x":1}},{"what":"array","when":[null,"a",["b",null]]}]}',
    '{"notes":[{"what":"boolean","when":true},{"what":"number","when":12}]}'
  ],
  [
    '{"notes":[{"what":"old","when":"' + when + '"}]}',
    '{"notes":[{"what":"new","when":"' + when + '"},{"what":"new","when":"' + when + '","extra":true}]}'
  ],
  [
    '{"2":"two","z":null,"1":"one","notes":[{"what":"lost","what":"actual","when":"' + when + '","2":true,"1":false}]}',
    '{"notes":[{"what":"actual","when":"' + when + '","2":true,"1":false}]}'
  ]
])(
  'full occupied history matches actual legacy merge: case%#',
  async (existing, incoming) => {
    const f = fixture(existing, incoming, 'utf16le'),
      field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing)
    try {
      expect(await output(field.chunks(64))).toBe(legacy(existing, incoming))
    } finally {
      await field.close()
    }
    expect(f.indexes.every(index => index.closed)).toBe(true)
    expect(f.working.used).toBe(0)
  },
  30000
)

test('missing/empty incoming when gets the processing time with original property insertion', async () => {
  jest.useFakeTimers({ now: new Date(when) })
  try {
    const existing = '{"before":null,"notes":null,"after":true}',
      incoming = '{"notes":[{"what":"actual","extra":null},{"what":"other","when":"","extra":false}]}',
      f = fixture(existing, incoming),
      field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing)
    try {
      expect(await output(field.chunks())).toBe(legacy(existing, incoming))
    } finally {
      await field.close()
    }
    expect(f.working.used).toBe(0)
  } finally {
    jest.useRealTimers()
  }
})
test('large what values, UTF16 pairs and legacy lone units sort without a materialized key', async () => {
  const a = 'x'.repeat(70000) + '\ud800',
    b = 'x'.repeat(70000) + '😀',
    existing = JSON.stringify({ notes: [{ what: b, when }] }),
    incoming = JSON.stringify({ notes: [{ what: a, when }] }),
    f = fixture(existing, incoming),
    field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing)
  try {
    expect(await output(field.chunks())).toBe(legacy(existing, incoming))
  } finally {
    await field.close()
  }
  expect(f.working.used).toBe(0)
}, 30000)
test('fresh owner revocation refuses output and closes physical indexes without renewing admission', async () => {
  const f = fixture('{}', '{"notes":[{"what":"actual","when":"' + when + '"}]}'),
    field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing)
  f.revoke()
  await expect(Promise.resolve().then(() => output(field.chunks()))).rejects.toThrow('Actual source owner revoked')
  await field.close()
  expect(f.indexes.every(index => index.closed)).toBe(true)
  expect(f.working.used).toBe(0)
})
test('failed physical output retirement retains reservation until concrete retry succeeds', async () => {
  const f = fixture('{}', '{"notes":[{"what":"actual","when":"' + when + '"}]}'),
    field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing),
    retained = f.indexes.find(index => !index.closed)!
  retained.failClose = true
  let failure: unknown
  try {
    await field.close()
  } catch (cause) {
    failure = cause
  }
  expect(failure).toBeInstanceOf(Brc38StagingCleanupError)
  expect(f.working.used).toBeGreaterThan(0)
  await (failure as Brc38StagingCleanupError).retryCleanup()
  expect(f.indexes.every(index => index.closed)).toBe(true)
  expect(f.working.used).toBe(0)
})
test('legacy object date with shadowed toString fails instead of silently changing its sort key', async () => {
  const existing = '{"notes":[{"what":"old","when":{"toString":"unusable"}}]}',
    incoming = '{"notes":[{"what":"new","when":"' + when + '"}]}',
    f = fixture(existing, incoming)
  expect(() => legacy(existing, incoming)).toThrow(TypeError)
  await expect(Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing)).rejects.toThrow(
    'Cannot convert'
  )
  expect(f.indexes.every(index => index.closed)).toBe(true)
  expect(f.working.used).toBe(0)
})
test('measurement and final replay use the same captured default-date DATA under original admission', async () => {
  jest.useFakeTimers({ now: new Date(when) })
  try {
    const existing = '{"notes":null,"extra":true}',
      incoming = '{"notes":[{"what":"actual"}]}',
      expected = legacy(existing, incoming),
      f = fixture(existing, incoming),
      field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing)
    expect(await output(field.measureChunks())).toBe(expected)
    expect(f.working.used).toBeGreaterThan(0)
    jest.advanceTimersByTime(1500)
    expect(await output(field.chunks())).toBe(expected)
    await field.close()
    expect(f.working.used).toBe(0)
    expect(f.indexes.every(index => index.closed)).toBe(true)
  } finally {
    jest.useRealTimers()
  }
})
test('partial measurement cannot become completed replay permission and close drains its actual iterator', async () => {
  const f = fixture('{}', '{"notes":[{"what":"actual","when":"' + when + '"}]}'),
    field = await Brc38StreamedHistoryProjection.prepareField(f.owners, f.incoming, f.policy, f.existing),
    iterator = field.measureChunks()[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  expect(() => field.chunks()).toThrow('actual EOF')
  await field.close()
  expect(f.working.used).toBe(0)
  expect(f.indexes.every(index => index.closed)).toBe(true)
})

test('nested complete-field history spelling keeps each actual source at two indexes and uses the original projection scratch', async () => {
  const existing = '{"notes":[{"when":"2026-01-01T00:00:00.000Z","what":"original","detail":"A"}],"tail":"kept"}',
    incoming = '{"notes":[{"when":"2026-01-02T00:00:00.000Z","what":"incoming","detail":"B"}]}'
  const f = fixture(existing, incoming),
    expected = legacy(existing, incoming)
  let sourcePeak = 0,
    projectionBytes = 0,
    projectionPeak = 0
  const boundedSource = (source: Brc38StreamedStructured): Brc38StreamedStructured => {
    let open = 0
    return {
      ...source,
      openIndex: async () => {
        if (open >= 2) throw new Error('Original two source grammar indexes remain owned')
        const index = await source.openIndex(),
          close = index.close.bind(index)
        open++
        sourcePeak = Math.max(sourcePeak, open)
        let closed = false
        index.close = async () => {
          await close()
          if (!closed) {
            closed = true
            open--
          }
        }
        return index
      }
    }
  }
  const owners: Brc38StructuredProjectionOwners = {
    ...f.owners,
    openIndex: async policy => {
      if (projectionBytes + policy.maximumTemporaryPhysicalBytes > f.policy.maximumTemporaryIndexBytes)
        throw new Error('Original aggregate projection scratch is owned')
      const index = await f.owners.openIndex(policy),
        close = index.close.bind(index)
      projectionBytes += policy.maximumTemporaryPhysicalBytes
      projectionPeak = Math.max(projectionPeak, projectionBytes)
      let closed = false
      index.close = async () => {
        await close()
        if (!closed) {
          closed = true
          projectionBytes -= policy.maximumTemporaryPhysicalBytes
        }
      }
      return index
    }
  }
  const field = await Brc38StreamedHistoryProjection.prepareField(
    owners,
    boundedSource(f.incoming),
    f.policy,
    boundedSource(f.existing)
  )
  try {
    expect(await output(field.measureChunks(64))).toBe(expected)
    expect(await output(field.chunks(64))).toBe(expected)
    expect(sourcePeak).toBe(2)
    expect(projectionPeak).toBeLessThanOrEqual(f.policy.maximumTemporaryIndexBytes)
  } finally {
    await field.close()
  }
  expect(projectionBytes).toBe(0)
  expect(f.indexes.every(index => index.closed)).toBe(true)
  expect(f.working.used).toBe(0)
})
