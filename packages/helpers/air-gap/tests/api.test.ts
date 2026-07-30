/**
 * Guards the published surface. `pack:check` asserts the built artifact exports
 * these names; this asserts the source does, so the two cannot drift apart.
 */
import * as airGap from '../src/index'
import { AIR_GAP_PREFIX, DEFAULT_BLOCK_BYTES, MAX_MESSAGE_BYTES } from '../src/constants'
import { AirGapEncoder } from '../src/encoder'
import { AirGapError } from '../src/errors'
import { estimatePartCharLength, isAirGapPart } from '../src/helpers'
import { message } from './helpers'

describe('public surface', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(airGap).sort()).toEqual([
      'AIR_GAP_PREFIX',
      'AirGapDecoder',
      'AirGapEncoder',
      'AirGapError',
      'DEFAULT_BLOCK_BYTES',
      'MAX_MESSAGE_BYTES',
      'crc32',
      'estimatePartCharLength',
      'isAirGapPart'
    ])
  })

  it('pins the wire constants', () => {
    expect(AIR_GAP_PREFIX).toBe('air-gap:')
    expect(DEFAULT_BLOCK_BYTES).toBe(1200)
    expect(MAX_MESSAGE_BYTES).toBe(65536)
  })
})

describe('AirGapError', () => {
  it('is an Error with a stable name', () => {
    const error = new AirGapError('boom')
    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(AirGapError)
    expect(error.name).toBe('AirGapError')
    expect(error.message).toBe('boom')
    expect(String(error)).toBe('AirGapError: boom')
  })
})

describe('isAirGapPart', () => {
  it('recognises the prefix and nothing else', () => {
    expect(isAirGapPart(`${AIR_GAP_PREFIX}AAAA`)).toBe(true)
    expect(isAirGapPart(AIR_GAP_PREFIX)).toBe(true)
    expect(isAirGapPart('bsvpayf2:AAAA')).toBe(false)
    expect(isAirGapPart('tkqr1:AAAA')).toBe(false)
    expect(isAirGapPart(` ${AIR_GAP_PREFIX}AAAA`)).toBe(false)
    expect(isAirGapPart('')).toBe(false)
  })

  it('tolerates a non-string from an untyped scanner callback', () => {
    expect(isAirGapPart(undefined as unknown as string)).toBe(false)
    expect(isAirGapPart(null as unknown as string)).toBe(false)
    expect(isAirGapPart(7 as unknown as string)).toBe(false)
  })

  it('accepts every part a real encoder produces', () => {
    const enc = new AirGapEncoder(message(3700), 1200)
    for (const seq of [0, 1, 2, 3, 4, 99]) expect(isAirGapPart(enc.partAt(seq))).toBe(true)
  })
})

describe('estimatePartCharLength', () => {
  it('matches the real part length exactly', () => {
    for (const blockBytes of [1, 2, 3, 4, 8, 37, 1200, 1500, 4096]) {
      const enc = new AirGapEncoder(message(8192), blockBytes)
      expect(estimatePartCharLength(blockBytes)).toBe(enc.partAt(0).length)
      expect(estimatePartCharLength(blockBytes)).toBe(enc.partAt(enc.blockCount + 3).length)
    }
  })

  it('defaults to the default block size', () => {
    expect(estimatePartCharLength()).toBe(estimatePartCharLength(DEFAULT_BLOCK_BYTES))
    expect(estimatePartCharLength()).toBe(1627)
  })

  it('grows monotonically with the block size', () => {
    let previous = 0
    for (let blockBytes = 1; blockBytes < 64; blockBytes++) {
      const length = estimatePartCharLength(blockBytes)
      expect(length).toBeGreaterThanOrEqual(previous)
      previous = length
    }
  })

  it('refuses a block size that is not a positive integer', () => {
    expect(() => estimatePartCharLength(0)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(-8)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(1.5)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(0)).toThrow(
      'blockBytes must be a positive integer, received 0'
    )
  })
})
