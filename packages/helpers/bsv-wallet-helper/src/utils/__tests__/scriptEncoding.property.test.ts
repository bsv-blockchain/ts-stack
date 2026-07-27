import { LockingScript, OP, Utils } from '@bsv/sdk'
import fc from 'fast-check'

import { addOpReturnData } from '../opreturn'
import { extractOpReturnData, isP2PKH } from '../scriptValidation'

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

function baseScript(): LockingScript {
  return new LockingScript([
    { op: OP.OP_DUP },
    { op: OP.OP_HASH160 },
    { op: 20, data: Array.from({ length: 20 }, () => 0) },
    { op: OP.OP_EQUALVERIFY },
    { op: OP.OP_CHECKSIG }
  ])
}

describe('wallet script encoding properties', () => {
  test('round-trips arbitrary non-empty binary OP_RETURN fields without altering the base script', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 1, maxLength: 128 }), {
          minLength: 1,
          maxLength: 12
        }),
        fields => {
          const original = baseScript()
          const originalHex = original.toHex()
          const encoded = addOpReturnData(
            original,
            fields.map(field => Array.from(field))
          )

          expect(original.toHex()).toBe(originalHex)
          expect(encoded.toHex().startsWith(originalHex)).toBe(true)
          expect(extractOpReturnData(encoded)).toEqual(
            fields.map(field => Utils.toBase64(Array.from(field)))
          )
        }
      )
    )
  })

  test('recognizes exactly the canonical P2PKH byte shape for arbitrary hashes and scripts', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 20, maxLength: 20 }), hash => {
        const hashHex = Utils.toHex(Array.from(hash))
        const canonical = `76a914${hashHex}88ac`

        expect(isP2PKH(canonical)).toBe(true)
        expect(isP2PKH(`75${canonical.slice(2)}`)).toBe(false)
        expect(isP2PKH(`${canonical.slice(0, 4)}13${canonical.slice(6)}`)).toBe(false)
        expect(isP2PKH(`${canonical.slice(0, -2)}ad`)).toBe(false)
      })
    )

    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 256 }), bytes => {
        const hex = Utils.toHex(Array.from(bytes))
        expect(() => isP2PKH(hex)).not.toThrow()
        expect(isP2PKH(hex)).toBe(/^76a914[0-9a-f]{40}88ac$/.test(hex))
      })
    )
  })
})
