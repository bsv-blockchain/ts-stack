import {
  validateDate,
  validateEntities,
  validateEntity,
  validateSyncChunkEntities
} from '../entityValidationHelpers'
import { EntityTimeStamp } from '../../../sdk/types'
import { SyncChunk } from '../../../sdk/WalletStorage.interfaces'

interface TestEntity extends EntityTimeStamp {
  id?: number
  name?: string | null
  blob?: Uint8Array | number[] | null
  ts?: Date | string
  optional?: string | null
  [key: string]: unknown
}

const isoFromMs = (ms: number): string => new Date(ms).toISOString()

const makeEntity = (overrides: Partial<TestEntity> = {}): TestEntity => ({
  created_at: new Date('2024-01-01T00:00:00.000Z'),
  updated_at: new Date('2024-01-02T00:00:00.000Z'),
  ...overrides
})

describe('entityValidationHelpers', () => {
  describe('validateDate', () => {
    test('returns the same Date instance when input is already a Date', () => {
      const d = new Date('2024-06-15T12:34:56.000Z')
      const result = validateDate(d)
      expect(result).toBe(d)
      expect(result).toBeInstanceOf(Date)
    })

    test('parses an ISO date string into a Date', () => {
      const iso = '2023-03-04T05:06:07.000Z'
      const result = validateDate(iso)
      expect(result).toBeInstanceOf(Date)
      expect(result.toISOString()).toBe(iso)
    })

    test('parses a numeric timestamp into a Date', () => {
      const ms = 1_700_000_000_000
      const result = validateDate(ms)
      expect(result).toBeInstanceOf(Date)
      expect(result.getTime()).toBe(ms)
    })

    test('handles epoch (0) numeric input', () => {
      const result = validateDate(0)
      expect(result).toBeInstanceOf(Date)
      expect(result.getTime()).toBe(0)
    })

    test('returns an Invalid Date when given an unparsable string', () => {
      const result = validateDate('not-a-real-date')
      expect(result).toBeInstanceOf(Date)
      expect(Number.isNaN(result.getTime())).toBe(true)
    })
  })

  describe('validateEntity', () => {
    test('coerces created_at and updated_at strings to Date instances', () => {
      const e: TestEntity = {
        created_at: '2024-01-01T00:00:00.000Z' as unknown as Date,
        updated_at: '2024-01-02T00:00:00.000Z' as unknown as Date
      }
      const result = validateEntity(e)
      expect(result.created_at).toBeInstanceOf(Date)
      expect(result.updated_at).toBeInstanceOf(Date)
      expect(result.created_at.toISOString()).toBe('2024-01-01T00:00:00.000Z')
      expect(result.updated_at.toISOString()).toBe('2024-01-02T00:00:00.000Z')
    })

    test('preserves existing Date instances unchanged', () => {
      const created = new Date('2024-01-01T00:00:00.000Z')
      const updated = new Date('2024-01-02T00:00:00.000Z')
      const e = makeEntity({ created_at: created, updated_at: updated })
      const result = validateEntity(e)
      expect(result.created_at).toBe(created)
      expect(result.updated_at).toBe(updated)
    })

    test('replaces null fields with undefined', () => {
      const e = makeEntity({ name: null, optional: null })
      const result = validateEntity(e)
      expect(result.name).toBeUndefined()
      expect(result.optional).toBeUndefined()
      // The keys are still present; their values are now undefined.
      expect('name' in result).toBe(true)
      expect('optional' in result).toBe(true)
    })

    test('converts Uint8Array fields to plain number[]', () => {
      const bytes = new Uint8Array([0, 1, 2, 250, 255])
      const e = makeEntity({ blob: bytes })
      const result = validateEntity(e)
      expect(Array.isArray(result.blob)).toBe(true)
      expect(result.blob).not.toBeInstanceOf(Uint8Array)
      expect(result.blob).toEqual([0, 1, 2, 250, 255])
    })

    test('converts Buffer fields to plain number[] (Buffer is a Uint8Array)', () => {
      const buf = Buffer.from([10, 20, 30, 40])
      const e = makeEntity({ blob: buf as unknown as Uint8Array })
      const result = validateEntity(e)
      expect(Array.isArray(result.blob)).toBe(true)
      expect(Buffer.isBuffer(result.blob)).toBe(false)
      expect(result.blob).not.toBeInstanceOf(Uint8Array)
      expect(result.blob).toEqual([10, 20, 30, 40])
    })

    test('coerces additional date fields supplied via dateFields argument', () => {
      const e = makeEntity({ ts: '2025-05-05T00:00:00.000Z' })
      const result = validateEntity(e, ['ts'])
      expect(result.ts).toBeInstanceOf(Date)
      expect((result.ts as Date).toISOString()).toBe('2025-05-05T00:00:00.000Z')
    })

    test('skips falsy custom date fields without throwing', () => {
      const e = makeEntity({ ts: undefined })
      // ts is undefined (falsy) so the helper should not attempt to coerce it.
      const result = validateEntity(e, ['ts', 'missingField'])
      expect(result.ts).toBeUndefined()
    })

    test('coerces a numeric custom date field', () => {
      const ms = 1_700_000_000_000
      const e = makeEntity({ ts: ms as unknown as Date })
      const result = validateEntity(e, ['ts'])
      expect(result.ts).toBeInstanceOf(Date)
      expect((result.ts as Date).getTime()).toBe(ms)
    })

    test('returns the same object reference (mutates in place)', () => {
      const e = makeEntity({ name: null })
      const result = validateEntity(e)
      expect(result).toBe(e)
    })

    test('handles an entity with no optional or nullable fields', () => {
      const e = makeEntity({ id: 7, name: 'alice' })
      const result = validateEntity(e)
      expect(result.id).toBe(7)
      expect(result.name).toBe('alice')
      expect(result.created_at).toBeInstanceOf(Date)
      expect(result.updated_at).toBeInstanceOf(Date)
    })

    test('processes a mixed entity with nulls, Uint8Array, and string dates together', () => {
      const e: TestEntity = {
        created_at: isoFromMs(1_000_000_000_000) as unknown as Date,
        updated_at: isoFromMs(1_000_000_001_000) as unknown as Date,
        id: 1,
        name: null,
        blob: new Uint8Array([9, 8, 7])
      }
      const result = validateEntity(e)
      expect(result.created_at).toBeInstanceOf(Date)
      expect(result.updated_at).toBeInstanceOf(Date)
      expect(result.name).toBeUndefined()
      expect(result.blob).toEqual([9, 8, 7])
      expect(result.id).toBe(1)
    })
  })

  describe('validateEntities', () => {
    test('returns the input unchanged when it is not an array', () => {
      const notArray = { foo: 'bar' } as unknown as TestEntity[]
      const result = validateEntities(notArray)
      expect(result).toBe(notArray)
    })

    test('returns an empty array unchanged', () => {
      const arr: TestEntity[] = []
      const result = validateEntities(arr)
      expect(result).toBe(arr)
      expect(result).toEqual([])
    })

    test('validates a single-entity array', () => {
      const arr: TestEntity[] = [makeEntity({ name: null })]
      const result = validateEntities(arr)
      expect(result).toBe(arr)
      expect(result[0].name).toBeUndefined()
      expect(result[0].created_at).toBeInstanceOf(Date)
    })

    test('validates every entity in a multi-entity array', () => {
      const arr: TestEntity[] = [
        { created_at: '2024-01-01T00:00:00.000Z' as unknown as Date, updated_at: '2024-01-01T00:00:00.000Z' as unknown as Date, name: null },
        makeEntity({ blob: new Uint8Array([1, 2, 3]) }),
        makeEntity({ blob: Buffer.from([4, 5, 6]) as unknown as Uint8Array })
      ]
      const result = validateEntities(arr)
      expect(result).toHaveLength(3)
      expect(result[0].created_at).toBeInstanceOf(Date)
      expect(result[0].name).toBeUndefined()
      expect(result[1].blob).toEqual([1, 2, 3])
      expect(result[2].blob).toEqual([4, 5, 6])
      expect(result[2].blob).not.toBeInstanceOf(Uint8Array)
    })

    test('passes dateFields through to each entity', () => {
      const arr: TestEntity[] = [
        makeEntity({ ts: '2024-06-01T00:00:00.000Z' }),
        makeEntity({ ts: '2024-06-02T00:00:00.000Z' })
      ]
      const result = validateEntities(arr, ['ts'])
      expect(result[0].ts).toBeInstanceOf(Date)
      expect(result[1].ts).toBeInstanceOf(Date)
    })
  })

  describe('validateSyncChunkEntities', () => {
    const baseChunk = (): SyncChunk => ({
      fromStorageIdentityKey: 'from-key',
      toStorageIdentityKey: 'to-key',
      userIdentityKey: 'user-key'
    })

    test('returns a chunk with no entity arrays unchanged', () => {
      const chunk = baseChunk()
      const result = validateSyncChunkEntities(chunk)
      expect(result).toBe(chunk)
      expect(result.user).toBeUndefined()
      expect(result.provenTxs).toBeUndefined()
    })

    test('validates the user entity when present', () => {
      const chunk: SyncChunk = {
        ...baseChunk(),
        user: makeEntity({ name: null }) as never
      }
      const result = validateSyncChunkEntities(chunk)
      expect(result.user).toBeDefined()
      // The user object should have been mutated by validateEntity.
      expect((result.user as unknown as TestEntity).name).toBeUndefined()
      expect((result.user as unknown as TestEntity).created_at).toBeInstanceOf(Date)
    })

    test('validates each populated entity-array property in place', () => {
      const chunk: SyncChunk = {
        ...baseChunk(),
        provenTxs: [makeEntity({ blob: new Uint8Array([1, 2]) })] as never,
        provenTxReqs: [makeEntity({ blob: Buffer.from([3, 4]) as unknown as Uint8Array })] as never,
        outputBaskets: [makeEntity({ name: null })] as never,
        txLabels: [makeEntity()] as never,
        outputTags: [makeEntity()] as never,
        transactions: [makeEntity()] as never,
        txLabelMaps: [makeEntity()] as never,
        commissions: [makeEntity()] as never,
        outputs: [makeEntity()] as never,
        outputTagMaps: [makeEntity()] as never,
        certificates: [makeEntity()] as never,
        certificateFields: [makeEntity()] as never,
        user: makeEntity() as never
      }
      const result = validateSyncChunkEntities(chunk)
      expect(result).toBe(chunk)
      expect((result.provenTxs as unknown as TestEntity[])[0].blob).toEqual([1, 2])
      expect((result.provenTxReqs as unknown as TestEntity[])[0].blob).toEqual([3, 4])
      expect((result.outputBaskets as unknown as TestEntity[])[0].name).toBeUndefined()
      // Spot-check that all timestamp fields were processed.
      const everyArrayKey: Array<keyof SyncChunk> = [
        'provenTxs',
        'provenTxReqs',
        'outputBaskets',
        'txLabels',
        'outputTags',
        'transactions',
        'txLabelMaps',
        'commissions',
        'outputs',
        'outputTagMaps',
        'certificates',
        'certificateFields'
      ]
      for (const k of everyArrayKey) {
        const arr = result[k] as unknown as TestEntity[]
        expect(Array.isArray(arr)).toBe(true)
        expect(arr[0].created_at).toBeInstanceOf(Date)
        expect(arr[0].updated_at).toBeInstanceOf(Date)
      }
    })

    test('skips properties that are explicitly undefined', () => {
      const chunk: SyncChunk = {
        ...baseChunk(),
        provenTxs: undefined,
        user: undefined
      }
      const result = validateSyncChunkEntities(chunk)
      expect(result.provenTxs).toBeUndefined()
      expect(result.user).toBeUndefined()
    })

    test('handles empty entity arrays without error', () => {
      const chunk: SyncChunk = {
        ...baseChunk(),
        provenTxs: [],
        certificates: []
      }
      const result = validateSyncChunkEntities(chunk)
      expect(result.provenTxs).toEqual([])
      expect(result.certificates).toEqual([])
    })
  })
})
