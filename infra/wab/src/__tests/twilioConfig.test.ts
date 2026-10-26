import {
  getSupportedAuthMethodTypes,
  validateTwilioAuthConfig
} from '../auth-methods/AuthMethodFactory'

const ENVIRONMENT_NAMES = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID'
] as const

describe('Twilio authentication configuration', () => {
  const original = Object.fromEntries(
    ENVIRONMENT_NAMES.map(name => [name, process.env[name]])
  ) as Record<(typeof ENVIRONMENT_NAMES)[number], string | undefined>

  afterEach(() => {
    for (const name of ENVIRONMENT_NAMES) {
      const value = original[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('does not advertise Twilio when all credentials are absent', () => {
    for (const name of ENVIRONMENT_NAMES) delete process.env[name]
    expect(() => validateTwilioAuthConfig()).not.toThrow()
    expect(getSupportedAuthMethodTypes()).not.toContain('TwilioPhone')
  })

  it('fails closed on partial or noncanonical provider authority', () => {
    process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`
    delete process.env.TWILIO_AUTH_TOKEN
    delete process.env.TWILIO_VERIFY_SERVICE_SID
    expect(() => validateTwilioAuthConfig()).toThrow('TWILIO_AUTH_TOKEN')

    process.env.TWILIO_AUTH_TOKEN = 'synthetic-token'
    process.env.TWILIO_VERIFY_SERVICE_SID = `VE${'2'.repeat(32)}`
    expect(() => validateTwilioAuthConfig()).toThrow('canonical VA')

    process.env.TWILIO_VERIFY_SERVICE_SID = `VA${'2'.repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = 'bad\nvalue'
    expect(() => validateTwilioAuthConfig()).toThrow('control characters')
  })

  it('advertises a completely configured canonical Verify service', () => {
    process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`
    process.env.TWILIO_AUTH_TOKEN = 'synthetic-token'
    process.env.TWILIO_VERIFY_SERVICE_SID = `VA${'2'.repeat(32)}`
    expect(() => validateTwilioAuthConfig()).not.toThrow()
    expect(getSupportedAuthMethodTypes()).toContain('TwilioPhone')
  })
})
