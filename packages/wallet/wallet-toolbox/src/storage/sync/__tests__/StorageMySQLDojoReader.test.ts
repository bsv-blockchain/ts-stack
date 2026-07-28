import { Knex } from 'knex'
import { StorageMySQLDojoReader } from '../StorageMySQLDojoReader'

interface TestEntity {
  created_at: Date
  updated_at: Date
  archivedAt?: Date | string
  enabled?: unknown
  optional?: unknown
  bytes?: Buffer | number[]
  [key: string]: unknown
}

function createReader(): StorageMySQLDojoReader {
  return new StorageMySQLDojoReader({
    chain: 'test',
    knex: {} as Knex
  })
}

describe('StorageMySQLDojoReader entity validation', () => {
  it('normalizes dates, booleans, nulls, and buffers in place', () => {
    const reader = createReader()
    const entity = {
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: 1_767_312_000_000,
      archivedAt: '2026-01-03T00:00:00.000Z',
      enabled: 1,
      optional: null,
      bytes: Buffer.from([1, 2, 3])
    } as unknown as TestEntity

    const result = reader.validateEntity(entity, ['archivedAt'], ['enabled'])

    expect(result).toBe(entity)
    expect(result.created_at).toEqual(new Date('2026-01-01T00:00:00.000Z'))
    expect(result.updated_at).toEqual(new Date(1_767_312_000_000))
    expect(result.archivedAt).toEqual(new Date('2026-01-03T00:00:00.000Z'))
    expect(result.enabled).toBe(true)
    expect(result.optional).toBeUndefined()
    expect(result.bytes).toEqual([1, 2, 3])
  })

  it('leaves undefined optional dates and booleans unchanged', () => {
    const reader = createReader()
    const entity = {
      created_at: new Date('2026-01-01T00:00:00.000Z'),
      updated_at: new Date('2026-01-02T00:00:00.000Z'),
      archivedAt: undefined,
      enabled: undefined
    } as unknown as TestEntity

    const result = reader.validateEntity(entity, ['archivedAt'], ['enabled'])

    expect(result.archivedAt).toBeUndefined()
    expect(result.enabled).toBeUndefined()
  })

  it('normalizes every entity in an array', () => {
    const reader = createReader()
    const entities = [
      {
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        enabled: 0
      },
      {
        created_at: '2026-02-01T00:00:00.000Z',
        updated_at: '2026-02-02T00:00:00.000Z',
        enabled: 'yes'
      }
    ] as unknown as TestEntity[]

    const result = reader.validateEntities(entities, undefined, ['enabled'])

    expect(result).toBe(entities)
    expect(result[0].created_at).toBeInstanceOf(Date)
    expect(result[0].enabled).toBe(false)
    expect(result[1].updated_at).toBeInstanceOf(Date)
    expect(result[1].enabled).toBe(true)
  })
})
