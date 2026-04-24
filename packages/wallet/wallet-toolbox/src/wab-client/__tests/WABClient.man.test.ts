import { _tu } from '../../../test/utils/TestUtilsWalletStorage'
import { WABClient } from '../WABClient'
import { TwilioPhoneInteractor } from '../auth-method-interactors/TwilioPhoneInteractor'

// This test suite requires the WAB server to be running on localhost:3000 or you can
// spin up a test environment or mock server. For demonstration, we'll keep it simple.

describe('WABClient', () => {
  let client: WABClient
  const serverUrl = 'http://localhost:3000' // Adjust if your server is different
  const testPresentationKey = 'clientTestKey' + Date.now()

  beforeAll(() => {
    client = new WABClient(serverUrl)
  })

  it('00', () => {})
  // Don't run any of these tests whe
  if (_tu.noEnv('main')) return

  it('should get server info', async () => {
    const info = await client.getInfo()
    expect(info.supportedAuthMethods).toContain('TwilioPhone')
  })

  it('should do Twilio phone flow', async () => {
    const twilio = new TwilioPhoneInteractor()

    const startRes = await client.startAuthMethod(twilio, testPresentationKey, {
      phoneNumber: '+12223334444'
    })
    expect(startRes.success).toBe(true)

    const completeRes = await client.completeAuthMethod(twilio, testPresentationKey, {
      otp: '123456',
      phoneNumber: '+12223334444'
    })
    expect(completeRes.success).toBe(true)
    expect(completeRes.presentationKey).toBe(testPresentationKey)
  })

  it('should request faucet', async () => {
    const faucetRes = await client.requestFaucet(testPresentationKey)
    expect(faucetRes.success).toBe(true)
    expect(faucetRes.paymentData).toBeDefined()
    expect(faucetRes.paymentData.amount).toBe(1000)
  })

  it('should list linked methods', async () => {
    const linked = await client.listLinkedMethods(testPresentationKey)
    expect(linked.authMethods).toHaveLength(1)
    expect(linked.authMethods[0].methodType).toBe('TwilioPhone')
  })

  it('can delete user', async () => {
    const del = await client.deleteUser(testPresentationKey)
    expect(del.success).toBe(true)
  })
})
