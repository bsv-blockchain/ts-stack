import { Beef, Utils, outputPacketDigest } from '@bsv/sdk'
import { _tu, type TestWalletNoSetup } from '../../../../test/utils/TestUtilsWalletStorage'
import { fundingRecoverySemantic, parseFundingRecoveryOperation } from '../FundingRecoveryProtocol'
import { fundingFixture } from '../__tests__/fundingFixture'

describe('closed funding recovery operations', () => {
  let context: TestWalletNoSetup
  beforeAll(async () => { context = await _tu.createLegacyWalletSQLiteCopy('funding-protocol', 'legacy') })
  afterAll(async () => { await context?.wallet.destroy() })

  test('owns every field, binds the digest and permits only proof encoding variation', () => {
    const input = fundingFixture(context).operation()
    const owned = parseFundingRecoveryOperation(input)
    expect(owned).toEqual(input)
    input.funding.chain.network = 'mutated'
    expect(owned.funding.chain.network).toBe(context.chain)
    const beef = Beef.fromBinaryStrict(Utils.toArray(owned.beef, 'base64'))
    beef.version = 0xefbe0001
    const other = { ...owned, beef: Utils.toBase64(beef.toBinaryAtomic(owned.funding.txid)) }
    expect(parseFundingRecoveryOperation(other)).toEqual(other)
    expect(fundingRecoverySemantic(other)).toBe(fundingRecoverySemantic(owned))
    for (const key of ['buyer', 'seller', 'acquisitionId', 'satoshis', 'derivationPrefix', 'derivationSuffix'] as const)
      expect(fundingRecoverySemantic({ ...owned, [key]: 'changed' })).not.toBe(fundingRecoverySemantic(owned))
  })

  test('rejects missing, extra, inherited and coercible fields before use', () => {
    const input = fundingFixture(context).operation()
    for (const key of Object.keys(input)) {
      const value: Record<string, unknown> = { ...input }
      delete value[key]
      expect(() => parseFundingRecoveryOperation(value)).toThrow()
    }
    for (const key of Object.keys(input.funding)) {
      const funding: Record<string, unknown> = { ...input.funding }
      delete funding[key]
      expect(() => parseFundingRecoveryOperation({ ...input, funding })).toThrow()
    }
    for (const bad of [null, [], 1, Object.create(input), { ...input, extra: true }, { ...input, funding: { ...input.funding, extra: true } }, { ...input, satoshis: 100 }, { ...input, beef: [0] }, { ...input, id: input.id.toUpperCase() }])
      expect(() => parseFundingRecoveryOperation(bad)).toThrow()
    const get = jest.fn(() => input.beef)
    expect(() => parseFundingRecoveryOperation(Object.defineProperty({ ...input }, 'beef', { get }))).toThrow()
    expect(get).not.toHaveBeenCalled()
  })

  test('bounds money and requires the raw target and exact selected output', () => {
    const fixture = fundingFixture(context), input = fixture.operation()
    for (const satoshis of ['0', '2100000000000001'])
      expect(() => parseFundingRecoveryOperation({ ...input, satoshis })).toThrow('money range')
    expect(() => parseFundingRecoveryOperation({ ...input, id: '00'.repeat(32) })).toThrow('operation ID')
    expect(() => parseFundingRecoveryOperation({ ...input, satoshis: '99' })).toThrow('output amount differs')
    const wrong = { ...input, funding: { ...input.funding, outputIndex: 8 } }
    wrong.id = outputPacketDigest('wallet-funding', { seller: wrong.seller, acquisitionId: wrong.acquisitionId, funding: wrong.funding })
    expect(() => parseFundingRecoveryOperation(wrong)).toThrow('output amount differs')
    const beef = new Beef()
    beef.mergeTransaction(fixture.tx)
    expect(() => parseFundingRecoveryOperation({ ...input, beef: Utils.toBase64(beef.toBinary()) })).toThrow('Atomic BEEF target')
    const missing = new Beef()
    missing.mergeTxidOnly(input.funding.txid)
    expect(() => parseFundingRecoveryOperation({ ...input, beef: Utils.toBase64(missing.toBinaryAtomic(input.funding.txid)) })).toThrow('Atomic BEEF target')
  })

  test('accepts the exact money ceiling and rejects a predecessor or missing transaction as the payment target', () => {
    const fixture = fundingFixture(context), input = fixture.operation()
    for (const txid of [fixture.source.id('hex'), '00'.repeat(32)]) {
      const wrong = { ...input, satoshis: '1000', funding: { ...input.funding, txid, outputIndex: 0 } }
      wrong.id = outputPacketDigest('wallet-funding', { seller: wrong.seller, acquisitionId: wrong.acquisitionId, funding: wrong.funding })
      expect(() => parseFundingRecoveryOperation(wrong)).toThrow('Funding operation requires exact Atomic BEEF target bytes')
    }
    fixture.tx.outputs[1].satoshis = 2100000000000000
    const ceiling = { ...fixture.operation(), satoshis: '2100000000000000' }
    // Representation only; the resulting synthetic transaction is not funded.
    expect(parseFundingRecoveryOperation(ceiling).satoshis).toBe('2100000000000000')
  })
})
