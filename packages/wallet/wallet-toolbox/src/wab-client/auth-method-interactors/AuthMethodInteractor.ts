import { WABTransport } from '../WABTransport'
import { validateWABCompleteAuthResponse, validateWABStartAuthResponse } from '../WABResponseValidation'

export interface AuthPayload {
  [key: string]: unknown
}

export interface StartAuthResponse {
  success: boolean
  message?: string
  data?: unknown
}

export interface CompleteAuthResponse {
  success: boolean
  message?: string
  presentationKey?: string
  /** Preferred explicit continuity signal for newer WAB servers. */
  accountStatus?: 'new-user' | 'existing-user'
  /** Compatibility signal accepted from WAB deployments using a boolean. */
  existingUser?: boolean
  /** Two-phase WAB lifecycle state. Absent means active for older servers. */
  registrationStatus?: 'pending' | 'active'
  /** Operator-selected UMP ambiguity fallback supplied by newer WAB servers. */
  umpTokenOutpoint?: string
  /** Staged key returned while a verified phone change awaits WAB finalization. */
  pendingPresentationKey?: string
  /** Identifier used to idempotently finalize a staged phone change. */
  pendingPhoneChangeId?: number
}

/**
 * Abstract client-side interactor for an Auth Method.
 *
 * Subclasses only need to set `methodType`; the HTTP calls to
 * `/auth/start` and `/auth/complete` are handled here.
 */
export abstract class AuthMethodInteractor {
  public abstract methodType: string

  protected preparePayload(payload: AuthPayload): AuthPayload {
    return payload
  }

  /**
   * Shared POST helper for auth endpoints.
   */
  private async postAuth(
    serverUrl: string,
    endpoint: string,
    presentationKey: string,
    payload: AuthPayload,
    transport?: WABTransport,
    correlationId?: string
  ): Promise<unknown> {
    const client = transport ?? new WABTransport(serverUrl)
    return await client.request<unknown>(`/auth/${endpoint}`, {
      operation: `auth-${endpoint}`,
      correlationId,
      body: {
        methodType: this.methodType,
        presentationKey,
        payload: this.preparePayload(payload)
      }
    })
  }

  /**
   * Start the flow (e.g. request an OTP or create a session).
   */
  public async startAuth(
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload,
    transport?: WABTransport,
    correlationId?: string
  ): Promise<StartAuthResponse> {
    return validateWABStartAuthResponse(
      await this.postAuth(serverUrl, 'start', presentationKey, payload, transport, correlationId)
    )
  }

  /**
   * Complete the flow (e.g. confirm OTP).
   */
  public async completeAuth(
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload,
    transport?: WABTransport,
    correlationId?: string
  ): Promise<CompleteAuthResponse> {
    return validateWABCompleteAuthResponse(
      await this.postAuth(serverUrl, 'complete', presentationKey, payload, transport, correlationId),
      presentationKey
    )
  }
}
