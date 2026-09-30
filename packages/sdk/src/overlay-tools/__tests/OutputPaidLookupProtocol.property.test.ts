import fc from 'fast-check'
import { PrivateKey } from '../../../mod.js'
import { parseOutputPaidLookupChallenge } from '../OutputPaidLookupProtocol.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('quote bounds use exact integer arithmetic throughout the wallet amount and U64 time ranges', () => {
  const identity = new PrivateKey(83).toPublicKey().toString()
  fc.assert(
    fc.property(
      fc.bigInt({ min: 1n, max: 2100000000000000n }),
      fc.bigInt({ min: 0n, max: 18446744073709465215n }),
      (amount, deadline) => {
        const quote = {
          version: 1,
          acquisitionId: '11'.repeat(32),
          requestDigest: '22'.repeat(32),
          seller: identity,
          buyer: identity,
          assetId: '33'.repeat(32),
          termsDigest: '44'.repeat(32),
          satoshis: String(amount),
          derivationPrefix: 'fixture-hex-1234',
          acceptancePolicy: { kind: 'local-admission' },
          rulesDigest: '55'.repeat(32),
          payableUntil: String(deadline),
          recoveryUntil: String(deadline + 86400n)
        }
        const owned = parseOutputPaidLookupChallenge(quote)
        expect(owned).toEqual(quote)
        quote.recoveryUntil = String(deadline + 86399n)
        expect(() => parseOutputPaidLookupChallenge(quote)).toThrow('less than one day')
        expect(owned.recoveryUntil).toBe(String(deadline + 86400n))
      }
    )
  )
})
