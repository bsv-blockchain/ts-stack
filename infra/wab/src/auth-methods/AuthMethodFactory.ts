import { AuthMethod } from './AuthMethod'
import { DevConsoleAuthMethod } from './DevConsoleAuthMethod'
import { TwilioAuthMethod } from './TwilioAuthMethod'
import { DemoPhoneAuthMethod } from './DemoPhoneAuthMethod'
import { isDemoAuthEnabled } from '../services/DemoAccountService'

export class UnsupportedAuthMethodError extends Error {
  public constructor(methodType: string) {
    super(`Unsupported auth method: ${methodType}`)
    this.name = 'UnsupportedAuthMethodError'
  }
}

const devConsoleAuthMethod = new DevConsoleAuthMethod()

interface TwilioAuthConfig {
  accountSid: string
  authToken: string
  verifyServiceSid: string
}

function readTwilioAuthConfig(): TwilioAuthConfig | undefined {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim() ?? ''
  const authToken = process.env.TWILIO_AUTH_TOKEN ?? ''
  const verifyServiceSid = process.env.TWILIO_VERIFY_SERVICE_SID?.trim() ?? ''
  if (accountSid === '' && authToken === '' && verifyServiceSid === '') return undefined
  if (!/^AC[0-9a-fA-F]{32}$/.test(accountSid)) {
    throw new Error('TWILIO_ACCOUNT_SID must be a canonical AC service account SID.')
  }
  if (
    authToken.length < 1 ||
    new TextEncoder().encode(authToken).byteLength > 1024 ||
    [...authToken].some(character => {
      const codePoint = character.codePointAt(0)!
      return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
    })
  ) {
    throw new Error('TWILIO_AUTH_TOKEN must be bounded text without control characters.')
  }
  if (!/^VA[0-9a-fA-F]{32}$/.test(verifyServiceSid)) {
    throw new Error('TWILIO_VERIFY_SERVICE_SID must be a canonical VA Verify Service SID.')
  }
  return { accountSid, authToken, verifyServiceSid }
}

export function validateTwilioAuthConfig(): void {
  readTwilioAuthConfig()
}

/**
 * The console auth method deliberately discloses an OTP in application logs.
 * It therefore requires both an explicit opt-in and a non-production runtime.
 */
export function isDevConsoleAuthEnabled(): boolean {
  const environment = process.env.NODE_ENV?.trim().toLowerCase()
  const nonProduction = environment === 'development' || environment === 'test'
  return nonProduction && process.env.DEV_CONSOLE_AUTH_METHOD_ENABLED === 'true'
}

export function getSupportedAuthMethodTypes(): string[] {
  return [
    ...(readTwilioAuthConfig() == null ? [] : ['TwilioPhone']),
    ...(isDevConsoleAuthEnabled() ? ['DevConsole'] : []),
    ...(isDemoAuthEnabled() ? ['DemoPhone'] : [])
  ]
}

export function getAuthMethodInstance(methodType: string): AuthMethod {
  switch (methodType) {
    case 'DemoPhone':
      if (isDemoAuthEnabled()) return new DemoPhoneAuthMethod()
      throw new UnsupportedAuthMethodError(methodType)
    case 'TwilioPhone': {
      const config = readTwilioAuthConfig()
      if (config == null) throw new UnsupportedAuthMethodError(methodType)
      return new TwilioAuthMethod(config)
    }
    case 'DevConsole':
      if (isDevConsoleAuthEnabled()) {
        return devConsoleAuthMethod
      }
      throw new UnsupportedAuthMethodError(methodType)
    default:
      throw new UnsupportedAuthMethodError(methodType)
  }
}
