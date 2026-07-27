import fc from 'fast-check'

import { actionBatchBlobDigest } from '../actionBatchDigest'
import { actionBatchPackLength, decodeActionBatchPack, encodeActionBatchPack } from '../actionBatchPack'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

const packItems = fc
  .array(fc.uint8Array({ maxLength: 1024 }), {
    minLength: 1,
    maxLength: 8
  })
  .map(values =>
    values.map(bytes => ({
      digest: actionBatchBlobDigest(bytes),
      bytes
    }))
  )

describe('action batch pack property tests', () => {
  test('round-trips arbitrary bounded blob sets without copying item payloads', () => {
    fc.assert(
      fc.property(packItems, items => {
        const maxBytes = actionBatchPackLength(items)
        const encoded = encodeActionBatchPack(items, maxBytes, items.length)
        const decoded = decodeActionBatchPack(encoded, maxBytes, items.length)

        expect(encoded).toHaveLength(maxBytes)
        expect(decoded.map(item => item.digest)).toEqual(items.map(item => item.digest))
        expect(decoded.map(item => Array.from(item.bytes))).toEqual(items.map(item => Array.from(item.bytes)))
        expect(decoded.every(item => item.bytes.buffer === encoded.buffer)).toBe(true)

        const trailing = new Uint8Array(encoded.length + 1)
        trailing.set(encoded)
        expect(() => decodeActionBatchPack(trailing, trailing.length, items.length)).toThrow('no trailing bytes')
      })
    )
  })
})
