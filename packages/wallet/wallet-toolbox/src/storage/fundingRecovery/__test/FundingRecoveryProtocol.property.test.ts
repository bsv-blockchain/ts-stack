import fc from 'fast-check'
import { _tu } from '../../../../test/utils/TestUtilsWalletStorage'
import { parseFundingRecoveryOperation, fundingRecoverySemantic } from '../FundingRecoveryProtocol'
import { fundingFixture } from '../__tests__/fundingFixture'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH

fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns) ? Math.max(MIN_PROPERTY_RUNS, requestedRuns) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})

test('generated amounts and exact outpoints retain stable operation bindings without caller aliases', async () => {
  const context = await _tu.createLegacyWalletSQLiteCopy('funding-protocol-property', 'legacy')
  try {
    const fixture = fundingFixture(context)
    fc.assert(fc.property(fc.integer({ min: 1, max: 999 }), amount => {
      fixture.tx.outputs[0].satoshis = 1000 - amount
      fixture.tx.outputs[1].satoshis = amount
      const operation = { ...fixture.operation(), satoshis: String(amount) }
      const owned = parseFundingRecoveryOperation(operation), semantic = fundingRecoverySemantic(owned)
      expect(owned).toEqual(operation)
      operation.funding.outputIndex = 2
      expect(owned.funding.outputIndex).toBe(1)
      expect(fundingRecoverySemantic(owned)).toBe(semantic)
      expect(() => parseFundingRecoveryOperation(operation)).toThrow('operation ID')
      expect(() => parseFundingRecoveryOperation({ ...owned, satoshis: String(amount + 1) })).toThrow('output amount differs')
    }))
  } finally { await context.wallet.destroy() }
})
