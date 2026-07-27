import fc from 'fast-check'

import {
  createMinimallyEncodedScriptChunk,
  decodeAssetId,
  decodeScriptNum,
  decodeScriptNumChunk,
  encodeAssetId,
  encodeScriptNum
} from '../mandala-encoding.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const hashHex = fc
  .uint8Array({ minLength: 32, maxLength: 32 })
  .map(bytes => Buffer.from(bytes).toString('hex'))

describe('Mandala encoding properties', () => {
  test('selects exact minimal push opcodes at every length boundary', () => {
    for (const [length, op] of [
      [0, 0],
      [75, 75],
      [76, 0x4c],
      [255, 0x4c],
      [256, 0x4d],
      [65535, 0x4d],
      [65536, 0x4e]
    ] as const) {
      expect(createMinimallyEncodedScriptChunk(Array.from({ length }, () => 0x42)).op).toBe(op)
    }
    const scriptNumberVectors: Array<
      [value: number, encoded: number[], chunk: { op: number; data?: number[] }]
    > = [
      [0, [], { op: 0 }],
      [-1, [0x81], { op: 0x4f }],
      [1, [0x01], { op: 0x51 }],
      [16, [0x10], { op: 0x60 }],
      [17, [0x11], { op: 1, data: [0x11] }],
      [-17, [0x91], { op: 1, data: [0x91] }],
      [127, [0x7f], { op: 1, data: [0x7f] }],
      [128, [0x80, 0x00], { op: 2, data: [0x80, 0x00] }]
    ]
    for (const [value, encoded, chunk] of scriptNumberVectors) {
      expect(encodeScriptNum(value)).toEqual(encoded)
      expect(createMinimallyEncodedScriptChunk([...encoded])).toEqual(chunk)
      expect(decodeScriptNumChunk(chunk)).toBe(value)
    }
    expect(createMinimallyEncodedScriptChunk([0])).toEqual({ op: 0 })
    expect(decodeScriptNumChunk({ op: 0x4c })).toBe(0)
  })

  test('round-trips every arbitrary safe script number through bytes and minimal chunks', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
        value => {
          const encoded = encodeScriptNum(value)
          expect(decodeScriptNum(encoded)).toBe(value)
          expect(decodeScriptNumChunk(createMinimallyEncodedScriptChunk(encoded))).toBe(value)
        }
      )
    )
  })

  test('round-trips arbitrary outpoints across the full uint32 output-index range', () => {
    fc.assert(
      fc.property(hashHex, fc.integer({ min: 0, max: 0xffffffff }), (txid, vout) => {
        const assetId = `${txid}.${vout}`
        const encoded = encodeAssetId(assetId)

        expect(encoded).toHaveLength(36)
        expect(decodeAssetId(encoded)).toBe(assetId)
      })
    )
  })

  test('rejects non-hex transaction IDs and output-index overflow instead of truncating', () => {
    fc.assert(
      fc.property(
        fc
          .string({ minLength: 64, maxLength: 64 })
          .filter(value => !/^[0-9a-fA-F]{64}$/.test(value)),
        invalidTxid => {
          expect(() => encodeAssetId(`${invalidTxid}.0`)).toThrow('64 hex chars')
        }
      )
    )
    expect(() => encodeAssetId('missing-separator')).toThrow('"<txid>.<vout>"')
    expect(() => encodeAssetId(`${'00'.repeat(32)}.4294967296`)).toThrow('unsigned 32-bit')
    expect(() => decodeAssetId(Array.from({ length: 35 }, () => 0))).toThrow('exactly 36 bytes')
  })
})
