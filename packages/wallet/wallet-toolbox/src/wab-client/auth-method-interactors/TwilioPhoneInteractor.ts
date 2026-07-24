import { AuthMethodInteractor, AuthPayload } from './AuthMethodInteractor'

/**
 * TwilioPhoneInteractor
 *
 * A client-side class that knows how to call the WAB server for Twilio-based phone verification.
 */
export class TwilioPhoneInteractor extends AuthMethodInteractor {
  public methodType = 'TwilioPhone'

  protected override preparePayload (payload: AuthPayload): AuthPayload {
    const phoneNumber = payload.phoneNumber
    if (typeof phoneNumber !== 'string') {
      throw new TypeError('TwilioPhone authentication requires phoneNumber.')
    }
    const normalized = phoneNumber.trim()
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
      throw new TypeError('phoneNumber must use canonical E.164 format.')
    }
    return {
      ...payload,
      phoneNumber: normalized
    }
  }
}
