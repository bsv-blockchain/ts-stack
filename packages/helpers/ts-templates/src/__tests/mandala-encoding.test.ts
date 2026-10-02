import { BigNumber } from '@bsv/sdk'

import {
  createMinimallyEncodedScriptChunk,
  decodeScriptNum,
  decodeScriptNumChunk
} from '../mandala-encoding.js'

// The SDK's BigNumber is an independent oracle for Bitcoin script numbers.
const scriptNum = (n: number): number[] => new BigNumber(n).toScriptNum()

describe('createMinimallyEncodedScriptChunk', () => {
  it('collapses zero to OP_0, whether given as no bytes or a single 0x00', () => {
    expect(createMinimallyEncodedScriptChunk([])).toEqual({ op: 0 })
    expect(createMinimallyEncodedScriptChunk([0])).toEqual({ op: 0 })
  })

  it('collapses 1..16 to OP_1..OP_16', () => {
    for (let n = 1; n <= 16; n++) {
      expect(createMinimallyEncodedScriptChunk([n])).toEqual({ op: 0x50 + n })
    }
  })

  it('collapses -1 to OP_1NEGATE', () => {
    expect(createMinimallyEncodedScriptChunk(scriptNum(-1))).toEqual({ op: 0x4f })
  })

  it('pushes 17 and 0x80 as direct data pushes', () => {
    expect(createMinimallyEncodedScriptChunk([17])).toEqual({ op: 1, data: [17] })
    // 0x80 as a script number is [0x80, 0x00]: the zero byte is the sign pad.
    expect(createMinimallyEncodedScriptChunk(scriptNum(0x80))).toEqual({
      op: 2,
      data: [0x80, 0x00]
    })
    expect(createMinimallyEncodedScriptChunk([0x80])).toEqual({ op: 1, data: [0x80] })
  })

  it('selects the exact push opcode at every length boundary', () => {
    for (const [length, op] of [
      [2, 2],
      [75, 75],
      [76, 0x4c],
      [255, 0x4c],
      [256, 0x4d],
      [65535, 0x4d],
      [65536, 0x4e]
    ] as const) {
      const data = Array.from({ length }, () => 0x42)
      expect(createMinimallyEncodedScriptChunk(data)).toEqual({ op, data })
    }
  })
})

describe('decodeScriptNum', () => {
  it('reads the empty array as zero and applies the sign bit', () => {
    expect(decodeScriptNum([])).toBe(0)
    expect(decodeScriptNum([0x81])).toBe(-1)
    expect(decodeScriptNum([0x80, 0x80])).toBe(-128)
    expect(decodeScriptNum([0x80, 0x00])).toBe(128)
  })
})

describe('decodeScriptNumChunk', () => {
  it('round-trips through the minimal chunk, including the opcode-only values', () => {
    // -1, 0 and 1..16 collapse to opcodes with no data; the decoder must recover
    // them as well as the larger data-push values.
    for (const n of [-255, -128, -17, -1, 0, 1, 2, 15, 16, 17, 100, 127, 128, 1000, 0x7fffffff]) {
      expect(decodeScriptNumChunk(createMinimallyEncodedScriptChunk(scriptNum(n)))).toBe(n)
    }
  })

  it('reads each OP_N opcode without looking at data', () => {
    expect(decodeScriptNumChunk({ op: 0 })).toBe(0)
    expect(decodeScriptNumChunk({ op: 0x4f })).toBe(-1)
    expect(decodeScriptNumChunk({ op: 0x51 })).toBe(1)
    expect(decodeScriptNumChunk({ op: 0x60 })).toBe(16)
  })

  it('reads a push opcode that carries no data as zero rather than throwing', () => {
    expect(decodeScriptNumChunk({ op: 0x4c })).toBe(0)
    expect(decodeScriptNumChunk({ op: 1 })).toBe(0)
  })
})
