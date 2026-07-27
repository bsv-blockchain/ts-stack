import {
  decodeResults,
  flagsForInputCount,
  packArrays
} from '../../packages/verifast/dist/src/BdkBatch.js'
import { deepEqual, equalBytes, invariant } from '../lib.mjs'

export function fuzz(data) {
  const arrays = []
  let offset = 0
  while (offset < data.length && arrays.length < 64) {
    const length = Math.min(data[offset] ?? 0, data.length - offset - 1)
    arrays.push(Uint8Array.from(data.subarray(offset + 1, offset + 1 + length)))
    offset += length + 1
  }
  const packed = packArrays(arrays, length => new Uint8Array(length))
  for (let index = 0; index < arrays.length; index++) {
    equalBytes(
      Array.from(packed.values.slice(packed.offsets[index], packed.offsets[index + 1])),
      Array.from(arrays[index]),
      'VeriFast batch offset framing'
    )
  }

  const pairCount = Math.min(128, Math.floor(data.length / 8))
  const flat = new Int32Array(pairCount * 2)
  for (let index = 0; index < flat.length; index++) {
    flat[index] = data.readInt32LE(index * 4)
  }
  const decoded = decodeResults(flat, pairCount)
  deepEqual(
    decoded,
    Array.from({ length: pairCount }, (_, index) => ({
      domain: flat[index * 2],
      code: flat[index * 2 + 1]
    })),
    'VeriFast result-pair decoding'
  )

  const flags = Uint32Array.from(data.subarray(0, Math.min(data.length, 128)))
  const copied = flagsForInputCount(flags.length, undefined, flags)
  invariant(copied.length === flags.length, 'VeriFast custom flag count')
  equalBytes(Array.from(copied), Array.from(flags), 'VeriFast custom flag values')
}
