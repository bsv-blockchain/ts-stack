import { createHash } from 'node:crypto'
import { Brc38StreamedNotifyProjection } from './Brc38StreamedNotifyProjection'
import { prepareBrc38StreamedNotifyField } from './Brc38StreamedNotifyField'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { createSyncMap } from '../schema/entities/EntityBase'
import type { Brc38JsonMember, Brc38JsonMemberIndex, Brc38StreamedStructured } from './Brc38StructuredJson'
import type { Brc38StructuredProjectionOwners } from './Brc38StructuredProjectionOwners'

/** Small independent portable fixture; this index is never a host authority or
 * evidence of native IndexedDB/SQLite physical resource qualification. */
class FixtureIndex implements Brc38JsonMemberIndex {
  readonly members = new Map<number, Map<string, Brc38JsonMember>>()
  readonly first = new Map<number, Map<string, number>>()
  closed = false
  sealed = false
  async put(offset: number, value: Brc38JsonMember): Promise<void> {
    if (this.closed || this.sealed) throw new Error('Fixture index unavailable')
    if (!this.members.has(offset)) {
      this.members.set(offset, new Map())
      this.first.set(offset, new Map())
    }
    const original = this.first.get(offset)!.get(value.key)
    this.first.get(offset)!.set(value.key, Math.min(original ?? value.keyOffset, value.keyOffset))
    this.members.get(offset)!.set(value.key, { ...value })
  }
  async seal(): Promise<void> {
    this.sealed = true
  }
  async lookup(
    offset: number,
    key: string
  ): Promise<Readonly<Brc38JsonMember & { firstKeyOffset: number }> | undefined> {
    if (!this.sealed || this.closed) throw new Error('Fixture index unavailable')
    const value = this.members.get(offset)?.get(key)
    return value === undefined ? undefined : { ...value, firstKeyOffset: this.first.get(offset)!.get(key)! }
  }
  async *entries(offset: number): AsyncGenerator<Brc38JsonMember> {
    if (!this.sealed || this.closed) throw new Error('Fixture index unavailable')
    for (const key of [...(this.members.get(offset)?.keys() ?? [])].sort())
      yield { ...this.members.get(offset)!.get(key)! }
  }
  async close(): Promise<void> {
    this.closed = true
  }
}
function fixture(raw: string, indexes: FixtureIndex[]): Brc38StreamedStructured {
  const bytes = new TextEncoder().encode(raw)
  return {
    encoding: 'utf8',
    length: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    read: async (offset, length) => bytes.slice(offset, offset + length),
    openIndex: async () => {
      const index = new FixtureIndex()
      indexes.push(index)
      return index
    }
  }
}
const policy = {
  maximumTemporaryIndexBytes: 2097152,
  maximumMembers: 1000,
  maximumOutputBytes: 4096,
  maximumReadBytes: 64,
  maximumGrammarAllocationBytes: 65536,
  maximumIndexAllocationBytes: 65536
}
async function ids(projection: Brc38StreamedNotifyProjection): Promise<number[]> {
  let text = ''
  for await (const bytes of projection.chunks(64)) {
    expect(bytes.byteLength).toBeLessThanOrEqual(64)
    text += new TextDecoder().decode(bytes)
  }
  return JSON.parse(text) as number[]
}
test('existing notification IDs stay local while distinct incoming IDs map and union in numeric order', async () => {
  const indexes: FixtureIndex[] = [],
    mappings: number[][] = [],
    owners: Brc38StructuredProjectionOwners = {
      check: () => undefined,
      openIndex: async () => {
        const index = new FixtureIndex()
        indexes.push(index)
        return index
      },
      readMappings: async (entity, incoming) => {
        expect(entity).toBe('transaction')
        mappings.push([...incoming])
        return incoming.map(value => (({ 1: 20, 2: 10, 3: 20 }) as Record<number, number>)[value])
      }
    },
    projection = await Brc38StreamedNotifyProjection.prepare(
      owners,
      fixture('{"transactionIds":[1,2,3,1,9]}', indexes),
      { ...policy, expiresAt: Date.now() + 60000 },
      fixture('{"transactionIds":[0,-3,10,10,21]}', indexes)
    )
  try {
    expect(await ids(projection)).toEqual([-3, 0, 10, 20, 21])
    expect(mappings.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 9])
    expect(projection.unmappedIds).toBe(1)
    expect(projection.mappedIncomingIds).toBe(3)
  } finally {
    await projection.close()
  }
  expect(indexes.every(index => index.closed)).toBe(true)
})
test('duplicate-key visibility and empty incoming mappings preserve the current destination IDs', async () => {
  const indexes: FixtureIndex[] = [],
    readMappings = jest.fn(
      async (_entity: Parameters<Brc38StructuredProjectionOwners['readMappings']>[0], incoming: readonly number[]) =>
        incoming.map(() => undefined)
    ),
    projection = await Brc38StreamedNotifyProjection.prepare(
      {
        check: () => undefined,
        openIndex: async () => {
          const index = new FixtureIndex()
          indexes.push(index)
          return index
        },
        readMappings
      },
      fixture('{"transactionIds":[5],"transactionIds":null}', indexes),
      { ...policy, expiresAt: Date.now() + 60000 },
      fixture('{"transactionIds":[999],"transactionIds":[3,1,3]}', indexes)
    )
  try {
    expect(await ids(projection)).toEqual([1, 3])
    expect(readMappings).not.toHaveBeenCalled()
    expect(projection.mappedIncomingIds).toBe(0)
  } finally {
    await projection.close()
  }
  expect(indexes.every(index => index.closed)).toBe(true)
})
test('an invalid current destination notification is not laundered through incoming projection', async () => {
  const indexes: FixtureIndex[] = [],
    owners: Brc38StructuredProjectionOwners = {
      check: () => undefined,
      openIndex: async () => {
        const index = new FixtureIndex()
        indexes.push(index)
        return index
      },
      readMappings: async (_entity, incoming) => incoming
    }
  await expect(
    Brc38StreamedNotifyProjection.prepare(
      owners,
      fixture('{}', indexes),
      { ...policy, expiresAt: Date.now() + 60000 },
      fixture('{"transactionIds":[1.5]}', indexes)
    )
  ).rejects.toThrow()
  expect(indexes.every(index => index.closed)).toBe(true)
})
test.each([
  ['{"before":null,"transactionIds":[8,3,3],"after":true}', '{}'],
  ['{"transactionIds":[8,3,3]}', '{"transactionIds":[]}'],
  ['{"transactionIds":[8,3,3]}', '{"transactionIds":[99]}'],
  ['{"before":null,"after":true}', '{"transactionIds":[]}'],
  ['{"before":null,"transactionIds":null,"after":true}', '{"transactionIds":[99]}'],
  ['{"before":null,"transactionIds":[8,3,3],"after":true}', '{"transactionIds":[1,1,99]}'],
  ['{"transactionIds":[8,3,3]}', '{"transactionIds":null}']
])('occupied notify spelling follows actual legacy conditional sorting: case%#', async (existing, incoming) => {
  const indexes: FixtureIndex[] = [],
    working = new Brc38WorkingAllocation(4194304),
    map = createSyncMap()
  map.transaction.idMap[1] = 3
  const current = EntityProvenTxReq.fromTxid('a'.repeat(64), []),
    other = EntityProvenTxReq.fromTxid('a'.repeat(64), [])
  current.apiNotify = existing
  other.apiNotify = incoming
  current.notified = true
  current.mergeNotifyTransactionIds(other.toApi(), map)
  const field = await prepareBrc38StreamedNotifyField(
    {
      check: () => undefined,
      openIndex: async () => {
        const index = new FixtureIndex()
        indexes.push(index)
        return index
      },
      readMappings: async (_entity, ids) => ids.map(id => map.transaction.idMap[id])
    },
    fixture(incoming, indexes),
    {
      ...policy,
      legacyNormalizedIntegers: true,
      maximumGrammarAllocationBytes: 1048576,
      maximumIndexAllocationBytes: 1048576,
      workingAllocation: working,
      expiresAt: Date.now() + 60000
    },
    fixture(existing, indexes)
  )
  const text = async (chunks: AsyncIterable<Uint8Array>): Promise<string> => {
    const parts: Uint8Array[] = []
    for await (const bytes of chunks) {
      expect(bytes.length).toBeLessThanOrEqual(64)
      parts.push(bytes)
    }
    return Buffer.concat(parts).toString('utf8')
  }
  try {
    expect(await text(field.measureChunks())).toBe(current.apiNotify)
    expect(await text(field.chunks())).toBe(current.apiNotify)
    expect(field.notifiedReset).toBe(!current.notified)
  } finally {
    await field.close()
  }
  expect(indexes.every(index => index.closed)).toBe(true)
  expect(working.used).toBe(0)
})
