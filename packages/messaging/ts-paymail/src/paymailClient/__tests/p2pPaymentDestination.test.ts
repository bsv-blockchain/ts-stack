import PaymailClient from '../../../dist/cjs/src/paymailClient/paymailClient.js'
import HttpClient from '../../../dist/cjs/src/paymailClient/httpClient.js'

describe('#PaymailClient - P2P Payment Destination', () => {
  let paymailClient: PaymailClient

  beforeAll(() => {
    paymailClient = new PaymailClient(new HttpClient(), undefined, undefined)
  })

  it('should get payment destinations with reference', async () => {
    const paymentDestinations = await paymailClient.getP2pPaymentDestination('brandonbryant@handcash.io', 1000)
    expect(paymentDestinations).toHaveProperty('outputs')
    expect(paymentDestinations.outputs[0]).toHaveProperty('script')
    expect(paymentDestinations.outputs[0]).toHaveProperty('satoshis')
    expect(paymentDestinations).toHaveProperty('reference')
    expect(paymentDestinations.outputs.reduce((acc, { satoshis }) => satoshis + acc, 0)).toBe(1000)
  })
})
