import fc from 'fast-check'

import BTMSTopicManager from '../BTMSTopicManager.js'

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

type ManagerInternals = {
  canonicalAssetId(assetIdField: string, txid: string, outputIndex: number): string
  parseTokenAmount(raw: string): number | undefined
}

function internals(): ManagerInternals {
  return new BTMSTopicManager() as unknown as ManagerInternals
}

describe('BTMS topic parser properties', () => {
  test('accepts exactly canonical positive safe-integer token amounts', () => {
    const amountText = fc.oneof(
      fc.string({ maxLength: 200 }),
      fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }).map(value => value.toString()),
      fc.constant((Number.MAX_SAFE_INTEGER + 1).toString()),
      fc.constant('01'),
      fc.constant('1e3')
    )
    fc.assert(
      fc.property(amountText, raw => {
        const expected = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN
        const parsed = internals().parseTokenAmount(raw)

        if (Number.isSafeInteger(expected)) {
          expect(parsed).toBe(expected)
        } else {
          expect(parsed).toBeUndefined()
        }
      })
    )
  })

  test('derives issuance asset IDs without changing arbitrary existing IDs', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }),
        fc.stringMatching(/^[0-9a-f]{64}$/),
        fc.integer({ min: 0, max: 0xffffffff }),
        (assetId, txid, outputIndex) => {
          const manager = internals()
          expect(manager.canonicalAssetId('ISSUE', txid, outputIndex)).toBe(
            `${txid}.${outputIndex}`
          )
          if (assetId !== 'ISSUE') {
            expect(manager.canonicalAssetId(assetId, txid, outputIndex)).toBe(assetId)
          }
        }
      )
    )
  })
})
