import {
  readBoolean,
  readDate,
  readInteger,
  readPublicKeyArray,
  readSortOrder,
  readString,
  readStringArray,
  readWalletProtocol,
  requireBase64,
  requireBase64_32,
  requireHex,
  requireLookupQuery,
  requireMongoFieldName,
  requireOutpoint,
  requirePublicKey,
  requireTxid
} from '../queryValidation.js'

const txid = 'AB'.repeat(32)
const publicKey = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

describe('lookup query validation trust boundaries', () => {
  it.each([null, undefined, 'question', []])('rejects a non-object question: %p', question => {
    expect(() => requireLookupQuery(question as never, 'ls_test', [])).toThrow(
      'a question object is required'
    )
  })

  it('binds a plain, data-only query to the expected service', () => {
    const nullPrototypeQuery = Object.assign(Object.create(null), { name: 'alice' })
    expect(
      requireLookupQuery({ service: 'ls_test', query: nullPrototypeQuery } as never, 'ls_test', [
        'name'
      ])
    ).toBe(nullPrototypeQuery)
    expect(() =>
      requireLookupQuery({ service: 'ls_other', query: {} } as never, 'ls_test', [])
    ).toThrow('Lookup service not supported')
  })

  it.each([null, 'query', []])('rejects a non-object query: %p', query => {
    expect(() => requireLookupQuery({ service: 'ls_test', query } as never, 'ls_test', [])).toThrow(
      'query must be an object'
    )
  })

  it('rejects symbol, prototype-sensitive, inherited, and accessor query fields', () => {
    const symbolQuery = { [Symbol('hidden')]: true }
    const unsafeQuery = JSON.parse('{"constructor":"pollute"}')
    const inheritedQuery = Object.create({ name: 'inherited' })
    inheritedQuery.name = 'own'
    const accessorQuery: Record<string, unknown> = {}
    Object.defineProperty(accessorQuery, 'name', { enumerable: true, get: () => 'alice' })

    for (const query of [symbolQuery, unsafeQuery, inheritedQuery, accessorQuery]) {
      expect(() =>
        requireLookupQuery({ service: 'ls_test', query } as never, 'ls_test', ['name'])
      ).toThrow(/unexpected field|plain object|must be data/)
    }
  })

  it('enforces UTF-8 byte bounds without accepting type confusion', () => {
    expect(readString({}, 'name')).toBeUndefined()
    expect(readString({ name: 'é' }, 'name', { minBytes: 2, maxBytes: 2 })).toBe('é')
    expect(() => readString({ name: 1 }, 'name')).toThrow('name must be a string')
    expect(() => readString({ name: '' }, 'name')).toThrow('1-1000 UTF-8 bytes')
    expect(() => readString({ name: 'éé' }, 'name', { maxBytes: 3 })).toThrow('1-3 UTF-8 bytes')
  })

  it('accepts only bounded safe integers, booleans, and sort orders', () => {
    expect(readInteger({}, 'limit', 5, 1, 10)).toBe(5)
    expect(readInteger({ limit: 1 }, 'limit', 5, 1, 10)).toBe(1)
    expect(readInteger({ limit: 10 }, 'limit', 5, 1, 10)).toBe(10)
    for (const value of [0, 11, 1.5, Number.MAX_VALUE, '5']) {
      expect(() => readInteger({ limit: value }, 'limit', 5, 1, 10)).toThrow(
        'limit must be an integer from 1 to 10'
      )
    }

    expect(readBoolean({}, 'history')).toBe(false)
    expect(readBoolean({}, 'history', true)).toBe(true)
    expect(readBoolean({ history: true }, 'history')).toBe(true)
    expect(() => readBoolean({ history: 1 }, 'history')).toThrow('history must be a boolean')

    expect(readSortOrder({})).toBe('desc')
    expect(readSortOrder({ sortOrder: 'asc' })).toBe('asc')
    expect(() => readSortOrder({ sortOrder: 1 })).toThrow('sortOrder must be asc or desc')
  })

  it('clones valid dates and rejects ambiguous or unbounded date inputs', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')
    const clone = readDate({ at: date }, 'at')
    expect(clone).toEqual(date)
    expect(clone).not.toBe(date)
    expect(readDate({ at: date.toISOString() }, 'at')).toEqual(date)
    expect(readDate({}, 'at')).toBeUndefined()

    for (const value of [1, '', 'x'.repeat(65), 'not-a-date']) {
      expect(() => readDate({ at: value }, 'at')).toThrow(/ISO date string|bounded|valid date/)
    }
  })

  it('requires dense, unique, bounded string arrays', () => {
    expect(readStringArray({}, 'tags')).toBeUndefined()
    expect(readStringArray({ tags: ['a', 'b'] }, 'tags')).toEqual(['a', 'b'])

    const sparse: unknown[] = []
    sparse.length = 2
    sparse[1] = 'b'
    for (const value of [null, [], ['a', 'b', 'c'], sparse, [''], ['éé'], ['a', 'a']]) {
      expect(() =>
        readStringArray({ tags: value }, 'tags', { maxItems: 2, maxItemBytes: 3 })
      ).toThrow(/array|dense|bounded|string|duplicates/)
    }
  })

  it('validates public-key arrays and wallet protocol tuples structurally', () => {
    expect(readPublicKeyArray({}, 'operators')).toBeUndefined()
    expect(readPublicKeyArray({ operators: [publicKey] }, 'operators')).toEqual([publicKey])
    expect(() => readPublicKeyArray({ operators: ['bad'] }, 'operators')).toThrow(
      'compressed public key'
    )

    expect(readWalletProtocol({}, 'protocol')).toBeUndefined()
    expect(readWalletProtocol({ protocol: [2, 'wallet protocol'] }, 'protocol')).toEqual([
      2,
      'wallet protocol'
    ])
    const sparse = [2, 'wallet protocol']
    delete sparse[1]
    for (const value of [null, [1], sparse, [3, 'wallet protocol'], [1, 5], [1, 'tiny']]) {
      expect(() => readWalletProtocol({ protocol: value }, 'protocol')).toThrow(
        /tuple|security level|protocol name/
      )
    }
    expect(() => readWalletProtocol({ protocol: [1, 'x'.repeat(401)] }, 'protocol')).toThrow(
      '5-400 UTF-8 bytes'
    )
  })

  it('validates canonical cryptographic and outpoint encodings', () => {
    const base64_32 = Buffer.alloc(32, 1).toString('base64')
    expect(requirePublicKey(undefined, 'key')).toBeUndefined()
    expect(requirePublicKey(publicKey, 'key')).toBe(publicKey)
    expect(() => requirePublicKey('02deadbeef', 'key')).toThrow('compressed public key')
    expect(() => requirePublicKey(`02${'11'.repeat(32)}`, 'key')).toThrow(
      'valid compressed public key'
    )

    expect(requireBase64_32(undefined, 'hash')).toBeUndefined()
    expect(requireBase64_32(base64_32, 'hash')).toBe(base64_32)
    expect(() => requireBase64_32('AQ==', 'hash')).toThrow('32-byte base64')
    expect(requireBase64(undefined, 'blob')).toBeUndefined()
    expect(requireBase64('AQ==', 'blob')).toBe('AQ==')
    expect(requireBase64('AQI=', 'blob', 2, 2)).toBe('AQI=')
    expect(() => requireBase64('not base64', 'blob')).toThrow('canonical base64')

    expect(requireOutpoint(undefined)).toBeUndefined()
    expect(requireOutpoint(`${txid}.4294967295`)).toEqual({
      txid: txid.toLowerCase(),
      outputIndex: 0xffffffff
    })
    expect(() => requireOutpoint(`${txid}.4294967296`)).toThrow('output index is out of range')

    expect(requireTxid(undefined)).toBeUndefined()
    expect(requireTxid(txid)).toBe(txid.toLowerCase())
    expect(() => requireTxid('bad')).toThrow('transaction ID')

    expect(requireHex(undefined, 'digest')).toBeUndefined()
    expect(requireHex('AABB', 'digest', 2)).toBe('aabb')
    expect(() => requireHex('abc', 'digest')).toThrow('hexadecimal')
    expect(() => requireHex('aabb', 'digest', 3)).toThrow('exactly 3 bytes')
  })

  it('accepts only safe MongoDB field segments', () => {
    expect(requireMongoFieldName('display_name')).toBe('display_name')
    for (const field of ['', 'a'.repeat(51), 'nested.name', '$where', 'name\0tail', '__proto__']) {
      expect(() => requireMongoFieldName(field)).toThrow('safe MongoDB field segments')
    }
  })
})
