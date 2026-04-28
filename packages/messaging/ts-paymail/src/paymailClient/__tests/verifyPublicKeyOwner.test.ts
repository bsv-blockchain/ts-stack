import PaymailClient from '../../../dist/cjs/src/paymailClient/paymailClient.js'
import HttpClient from '../../../dist/cjs/src/paymailClient/httpClient.js'

describe('#PaymailClient - Verify Public Key Owner', () => {
  let paymailClient

  beforeAll(() => {
    paymailClient = new PaymailClient(new HttpClient(), undefined, undefined)
  })

  it('should verify the public key owner', async () => {
    const paymail = 'brandonbryant@handcash.io'
    const result = await paymailClient.verifyPublicKey(paymail, 'random key')
    expect(result.match).toBe(false)
  })
})
