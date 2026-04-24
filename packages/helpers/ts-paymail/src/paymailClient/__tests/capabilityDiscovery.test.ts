import PaymailClient from '../../../dist/cjs/src/paymailClient/paymailClient.js'
import HttpClient from '../../../dist/cjs/src/paymailClient/httpClient.js'

describe('#PaymailClient - Capability Discovery', () => {
  let paymailClient: PaymailClient

  beforeAll(() => {
    paymailClient = new PaymailClient(new HttpClient(), undefined, undefined)
  })

  it('should get capabilities for paymail', async () => {
    const capabilities = await paymailClient.getDomainCapabilities('handcash.io')
    expect(capabilities).toHaveProperty('pki')
  })

  it('should get capabilities for paymail', async () => {
    const capabilities = await paymailClient.getDomainCapabilities('handcash.io')
    expect(capabilities).toHaveProperty('pki')
  })
})
