import PaymailClient from '../../../dist/cjs/src/paymailClient/paymailClient.js'
import HttpClient from '../../../dist/cjs/src/paymailClient/httpClient.js'

describe('#PaymailClient - Public Profile', () => {
  let paymailClient: PaymailClient

  beforeAll(() => {
    paymailClient = new PaymailClient(new HttpClient(), undefined, undefined)
  })

  it('should get Public profile for paymail', async () => {
    const publicProfile = await paymailClient.getPublicProfile('brandonbryant@handcash.io')
    expect(publicProfile).toHaveProperty('name')
    expect(publicProfile).toHaveProperty('avatar')
  })
})
