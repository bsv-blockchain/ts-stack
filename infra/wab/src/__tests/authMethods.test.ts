jest.mock('twilio', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    verify: {
      v2: {
        services: jest.fn(() => ({
          verifications: {
            create: jest.fn().mockResolvedValue({ status: 'pending' })
          },
          verificationChecks: {
            create: jest.fn(({ code }: { code: string }) =>
              Promise.resolve({
                status: code === '654321' || code === 'provider-approved' ? 'approved' : 'pending'
              })
            )
          }
        }))
      }
    },
    lookups: {
      v2: {
        phoneNumbers: jest.fn(() => ({
          fetch: jest.fn().mockResolvedValue({
            lineTypeIntelligence: { lineType: 'mobile' }
          })
        }))
      }
    }
  }))
}))

import { TwilioAuthMethod } from '../auth-methods/TwilioAuthMethod'

describe('AuthMethods', () => {
  describe('TwilioAuthMethod', () => {
    let method: TwilioAuthMethod

    beforeEach(() => {
      method = new TwilioAuthMethod({
        accountSid: process.env.TWILIO_ACCOUNT_SID || `AC${'1'.repeat(32)}`,
        authToken: process.env.TWILIO_AUTH_TOKEN || 'test_auth_token',
        verifyServiceSid: process.env.TWILIO_VERIFY_SERVICE_SID || `VA${'2'.repeat(32)}`
      })
    })

    it('should authenticate only when Twilio Verify approves the code', async () => {
      const completeResult = await method.completeAuth('someKey', {
        phoneNumber: '+14155550100',
        otp: '654321'
      })
      expect(completeResult.success).toBe(true)
      expect(completeResult.message).toContain('verified successfully')
    })

    it('does not contain a hard-coded production OTP bypass', async () => {
      const completeResult = await method.completeAuth('someKey', {
        phoneNumber: '+18006382638',
        otp: '123456'
      })
      expect(completeResult.success).toBe(false)
    })

    it('should reject a non-approved verification without network access', async () => {
      const completeResult = await method.completeAuth('someKey', {
        phoneNumber: '+1234567890',
        otp: '123456'
      })
      expect(completeResult.success).toBe(false)
      expect(completeResult.message).toContain('invalid or expired')
    })

    it('should require phoneNumber in payload', async () => {
      const completeResult = await method.completeAuth('someKey', {
        otp: '123456'
      })
      expect(completeResult.success).toBe(false)
      expect(completeResult.message).toContain('phoneNumber is required')
    })

    it('should require otp in payload', async () => {
      const completeResult = await method.completeAuth('someKey', {
        phoneNumber: '+1234567890'
      })
      expect(completeResult.success).toBe(false)
      expect(completeResult.message).toContain('4-10 digit otp')
    })

    it('should build config from payload', () => {
      const config = method.buildConfigFromPayload({ phoneNumber: ' +14155550100 ' })
      expect(config).toBe('+14155550100')
    })

    it('should reject non-canonical phone numbers', async () => {
      const completeResult = await method.completeAuth('someKey', {
        phoneNumber: '415-555-0100',
        otp: '654321'
      })
      expect(completeResult.success).toBe(false)
      expect(completeResult.message).toContain('E.164')
    })

    it('rejects non-canonical verification codes before provider approval', async () => {
      const completeResult = await method.completeAuth('someKey', {
        phoneNumber: '+14155550100',
        otp: 'provider-approved'
      })
      expect(completeResult.success).toBe(false)
      expect(completeResult.message).toContain('4-10 digit otp')
    })

    it('should check if already linked', () => {
      const isLinked = method.isAlreadyLinked({ phoneNumber: '+1234567890' } as any, {
        phoneNumber: '+1234567890'
      })
      expect(isLinked).toBe(true)

      const notLinked = method.isAlreadyLinked({ phoneNumber: '+1111111111' } as any, {
        phoneNumber: '+1234567890'
      })
      expect(notLinked).toBe(false)
    })
  })
})
