import fc from 'fast-check'
import { bindOutputReleaseEvidence, parseOutputReleaseEvidence } from '../OutputReleaseProtocol.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('release representations retain owned identity and require the selected depth across U64 heights', () => {
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 18446744073709543423n }),
      fc.integer({ min: 1, max: 8192 }),
      (height, confirmations) => {
        const input = {
          chain: { network: 'property-fixture', genesisHash: '11'.repeat(32) },
          txid: '22'.repeat(32),
          policy: { kind: 'mined' as const, confirmations },
          acceptedAt: '1',
          blockEvidence: {
            blockHash: '33'.repeat(32),
            height: String(height),
            tipHash: confirmations === 1 ? '33'.repeat(32) : '44'.repeat(32),
            tipHeight: String(height + BigInt(confirmations) - 1n),
            beef: 'AA==',
            contextId: 'property-view',
            chainPolicyDigest: '55'.repeat(32)
          }
        }
        const binding = { chain: input.chain, txid: input.txid, policy: input.policy }
        const owned = bindOutputReleaseEvidence(JSON.stringify(input), binding)
        expect(owned).toEqual(input)
        expect(() =>
          bindOutputReleaseEvidence(input, { ...binding, txid: '66'.repeat(32) })
        ).toThrow('binding mismatch')
        input.blockEvidence.tipHeight = String(BigInt(input.blockEvidence.tipHeight) - 1n)
        expect(() => parseOutputReleaseEvidence(input)).toThrow('confirmation depth')
        expect(owned.blockEvidence!.tipHeight).toBe(String(height + BigInt(confirmations) - 1n))
      }
    )
  )
})
