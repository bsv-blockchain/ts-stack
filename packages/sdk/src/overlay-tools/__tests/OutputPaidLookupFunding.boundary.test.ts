import { inspectOutputPaidLookupFunding } from '../OutputPaidLookupFunding.js'
import { fundingFixture } from './OutputPaidLookupFunding.fixture.js'
it.each([0, 1, 32, 65536])(
  'classifies %i malformed Atomic BEEF bytes as a definitive representation failure',
  async length => {
    const f = await fundingFixture()
    expect(() =>
      inspectOutputPaidLookupFunding(
        { ...f.payment(), transaction: Buffer.alloc(length).toString('base64') },
        f.challenge,
        f.selected
      )
    ).toThrow(
      expect.objectContaining({
        code: 'invalid',
        message: 'Payment Atomic BEEF is malformed',
        retryable: false
      })
    )
  }
)
it('retains valid exact funding after a malformed representation is rejected', async () => {
  const f = await fundingFixture(),
    payment = f.payment()
  expect(() =>
    inspectOutputPaidLookupFunding({ ...payment, transaction: 'AA==' }, f.challenge, f.selected)
  ).toThrow(expect.objectContaining({ code: 'invalid' }))
  expect(
    inspectOutputPaidLookupFunding(payment, f.challenge, f.selected).operation.funding
  ).toEqual({ chain: f.selected.chain, txid: f.transaction.id('hex'), outputIndex: 1 })
})
