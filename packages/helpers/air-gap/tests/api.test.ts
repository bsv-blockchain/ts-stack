/**
 * Guards the published surface. `pack:check` asserts the built artifact exports
 * these names; this asserts the source does, so the two cannot drift apart.
 */
import * as airGap from '../src/index'
import {
  AIR_GAP_PREFIX,
  AIR_GAP_WIRE_VERSION,
  DEFAULT_BLOCK_BYTES,
  MAX_BLOCK_BYTES,
  MAX_MESSAGE_BYTES,
  SESSION_ID_BYTES,
  SESSION_SWITCH_PARTS
} from '../src/constants'
import { AirGapError } from '../src/errors'
import { estimatePartCharLength, isAirGapPart } from '../src/helpers'
import { message, SESSION_A } from './helpers'
import { AirGapEncoder } from '../src/encoder'

describe('public surface', () => {
  it('exports exactly the documented names', () => {
    expect(Object.keys(airGap).sort()).toEqual([
      'AIR_GAP_PREFIX',
      'AIR_GAP_WIRE_VERSION',
      'AirGapDecoder',
      'AirGapEncoder',
      'AirGapError',
      'DEFAULT_BLOCK_BYTES',
      'MAX_BLOCK_BYTES',
      'MAX_MESSAGE_BYTES',
      'SESSION_ID_BYTES',
      'SESSION_SWITCH_PARTS',
      'crc32',
      'estimatePartCharLength',
      'isAirGapPart'
    ])
  })

  it('pins the wire constants', () => {
    expect(AIR_GAP_PREFIX).toBe('air-gap:')
    expect(AIR_GAP_WIRE_VERSION).toBe(1)
    expect(SESSION_ID_BYTES).toBe(8)
    expect(DEFAULT_BLOCK_BYTES).toBe(1200)
    expect(MAX_BLOCK_BYTES).toBe(2048)
    expect(MAX_MESSAGE_BYTES).toBe(65536)
    expect(SESSION_SWITCH_PARTS).toBe(3)
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
    const enc = new AirGapEncoder(message(3700), { blockBytes: 1200, sessionId: SESSION_A })
    for (const seq of [0, 1, 2, 3, 4, 99]) expect(isAirGapPart(enc.partAt(seq))).toBe(true)
  })
})

describe('estimatePartCharLength', () => {
  it('matches the real part length exactly', () => {
    for (const blockBytes of [1, 2, 3, 4, 8, 37, 1200, 1500, MAX_BLOCK_BYTES]) {
      const enc = new AirGapEncoder(message(8192), { blockBytes, sessionId: SESSION_A })
      expect(estimatePartCharLength(blockBytes)).toBe(enc.partAt(0).length)
      expect(estimatePartCharLength(blockBytes)).toBe(enc.partAt(enc.blockCount + 3).length)
    }
  })

  it('defaults to the default block size', () => {
    expect(estimatePartCharLength()).toBe(estimatePartCharLength(DEFAULT_BLOCK_BYTES))
    expect(estimatePartCharLength()).toBe(1639)
  })

  it('stays inside a version-40 QR symbol in byte mode at the default', () => {
    // base64url renders in QR byte mode (one byte per character); version 40
    // at error-correction L holds 2,953 bytes. Both the default and the
    // absolute block ceiling must fit, or the documented sizing story is wrong.
    expect(estimatePartCharLength(DEFAULT_BLOCK_BYTES)).toBeLessThanOrEqual(1663) // v40-Q
    expect(estimatePartCharLength(MAX_BLOCK_BYTES)).toBeLessThanOrEqual(2953) // v40-L
  })

  it('grows monotonically with the block size', () => {
    let previous = 0
    for (let blockBytes = 1; blockBytes < 64; blockBytes++) {
      const length = estimatePartCharLength(blockBytes)
      expect(length).toBeGreaterThanOrEqual(previous)
      previous = length
    }
  })

  it('refuses a block size outside the encoder bounds', () => {
    expect(() => estimatePartCharLength(0)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(-8)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(1.5)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(MAX_BLOCK_BYTES + 1)).toThrow(AirGapError)
    expect(() => estimatePartCharLength(0)).toThrow(
      `blockBytes must be an integer between 1 and ${MAX_BLOCK_BYTES}, received 0`
    )
  })
})
