import { AuthMethod, type AuthPayload, type AuthResult } from './AuthMethod'
import {
  DemoAccountService,
  demoIdentifier,
  isDemoAuthEnabled
} from '../services/DemoAccountService'

/** Admin-provisioned demonstration identities, separate from verified SMS identities. */
export class DemoPhoneAuthMethod extends AuthMethod {
  public readonly methodType = 'DemoPhone'

  public async startAuth(_presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
    demoIdentifier(payload)
    return {
      success: isDemoAuthEnabled(),
      message: 'Enter the access code supplied by the demo account administrator. No SMS is sent.'
    }
  }

  public async completeAuth(_presentationKey: string, payload: AuthPayload): Promise<AuthResult> {
    const success = await DemoAccountService.verify(demoIdentifier(payload), payload.otp)
    return {
      success,
      message: success ? 'Demo account verified.' : 'Demo access is invalid or unavailable.'
    }
  }

  public buildConfigFromPayload(payload: AuthPayload): string {
    return demoIdentifier(payload)
  }
}
