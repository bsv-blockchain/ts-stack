import { WABTransport } from '../WABTransport'

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
}

/**
 * Abstract client-side interactor for an Auth Method.
 *
 * Subclasses only need to set `methodType`; the HTTP calls to
 * `/auth/start` and `/auth/complete` are handled here.
 */
export abstract class AuthMethodInteractor {
  public abstract methodType: string

  protected preparePayload (payload: AuthPayload): AuthPayload {
    return payload
  }

  /**
   * Shared POST helper for auth endpoints.
   */
  private async postAuth<T extends { success: boolean, message?: string }>(
    serverUrl: string,
    endpoint: string,
    presentationKey: string,
    payload: AuthPayload,
    transport?: WABTransport,
    correlationId?: string
  ): Promise<T> {
    const client = transport ?? new WABTransport(serverUrl)
    return await client.request<T>(`/auth/${endpoint}`, {
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
  public async startAuth (
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload,
    transport?: WABTransport,
    correlationId?: string
  ): Promise<StartAuthResponse> {
    return await this.postAuth<StartAuthResponse>(
      serverUrl,
      'start',
      presentationKey,
      payload,
      transport,
      correlationId
    )
  }

  /**
   * Complete the flow (e.g. confirm OTP).
   */
  public async completeAuth (
    serverUrl: string,
    presentationKey: string,
    payload: AuthPayload,
    transport?: WABTransport,
    correlationId?: string
  ): Promise<CompleteAuthResponse> {
    return await this.postAuth<CompleteAuthResponse>(
      serverUrl,
      'complete',
      presentationKey,
      payload,
      transport,
      correlationId
    )
  }
}
