import { Hash, Utils } from '@bsv/sdk'
import { describe, expect, it } from 'vitest'

import {
  DEFAULTS,
  ECONOMIC_PATHS,
  computeQueryId,
  validateQuery,
  type EconomicQuery
} from './query.js'

const client = `02${'ab'.repeat(32)}`
const nonce = '11'.repeat(32)

function baseQuery(): EconomicQuery {
  return {
    type: 'overlay-lookup',
    client,
    params: { service: 'ls_example', query: { key: 'value' } },
    maxFeeSats: 2000,
    floorFeeSats: 1000,
    threshold: 3,
    topK: 5,
    raceMs: 400,
    expires: '2026-09-18T19:05:00.000Z',
    nonce
  }
}

describe('constants', () => {
  it('pins the approved paths and defaults', () => {
    expect(ECONOMIC_PATHS).toEqual({
      params: '/economic/params',
      query: '/economic/query',
      collect: '/economic/collect'
    })
    expect(DEFAULTS).toMatchObject({
      threshold: 3,
      topK: 5,
      raceMs: 400,
      floorFeeSats: 1000,
      maxFeeSats: 2000,
      queryTtlMs: 30_000,
      hostTimeoutMs: 5000,
      hostsTtlMs: 300_000,
      paramsTtlMs: 300_000,
      maxHosts: 16
    })
  })
})

describe('computeQueryId', () => {
  it('hashes the canonical JSON of the query', () => {
    const canonical =
      `{"client":"${client}","expires":"2026-09-18T19:05:00.000Z","floorFeeSats":1000,` +
      `"maxFeeSats":2000,"nonce":"${nonce}","params":{"query":{"key":"value"},` +
      `"service":"ls_example"},"raceMs":400,"threshold":3,"topK":5,"type":"overlay-lookup"}`
    expect(computeQueryId(baseQuery())).toBe(
      Utils.toHex(Hash.sha256(Utils.toArray(canonical, 'utf8')))
    )
  })

  it('ignores key order and reacts to the nonce', () => {
    const reordered = Object.fromEntries(Object.entries(baseQuery()).reverse()) as EconomicQuery
    expect(computeQueryId(reordered)).toBe(computeQueryId(baseQuery()))
    expect(computeQueryId({ ...baseQuery(), nonce: '22'.repeat(32) })).not.toBe(
      computeQueryId(baseQuery())
    )
  })
})

describe('validateQuery', () => {
  it('returns a normalized copy of a valid query', () => {
    const input = { ...baseQuery(), hostSetHint: [client], strictHosts: false }
    const result = validateQuery(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
  })

  it.each([
    ['unknown field', { ...baseQuery(), extra: 1 }],
    ['bad client key', { ...baseQuery(), client: 'ab' }],
    ['array params', { ...baseQuery(), params: [] }],
    ['float in params', { ...baseQuery(), params: { price: 1.5 } }],
    ['zero floor', { ...baseQuery(), floorFeeSats: 0 }],
    ['max below floor', { ...baseQuery(), maxFeeSats: 999 }],
    ['topK below threshold', { ...baseQuery(), topK: 2 }],
    ['negative raceMs', { ...baseQuery(), raceMs: -1 }],
    ['non-canonical expires', { ...baseQuery(), expires: '2026-09-18 19:05' }],
    ['short nonce', { ...baseQuery(), nonce: 'ff' }],
    ['bad host hint', { ...baseQuery(), hostSetHint: ['zz'] }],
    ['non-boolean strictHosts', { ...baseQuery(), strictHosts: 'yes' }],
    ['not an object', 'query']
  ])('rejects %s', (_label, value) => {
    expect(() => validateQuery(value)).toThrow(TypeError)
  })

  it('allows topK below threshold only in single-host mode', () => {
    expect(validateQuery({ ...baseQuery(), threshold: 1, topK: 1 }).topK).toBe(1)
  })

  it('rejects params larger than 65536 characters', () => {
    expect(() => validateQuery({ ...baseQuery(), params: { blob: 'x'.repeat(70_000) } })).toThrow(
      TypeError
    )
  })
})
