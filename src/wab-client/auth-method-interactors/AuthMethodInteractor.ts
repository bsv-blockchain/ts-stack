/**
 * AuthMethodInteractor
 *
 * A base interface/class for client-side logic to interact with a server
 * for a specific Auth Method's flow (start, complete).
 */

export interface AuthPayload {
  [key: string]: any
}

export interface StartAuthResponse {
  success: boolean
  message?: string
  data?: any
}

export interface CompleteAuthResponse {
  success: boolean
  message?: string
  presentationKey?: string
}

/**
 * Abstract client-side interactor for an Auth Method.
 *
 * Subclasses only need to set `methodType`; the HTTP calls to
 * `/auth/start` and `/auth/complete` are handled here.
 */
export abstract class AuthMethodInteractor {
  public abstract methodType: string

  /**
   * Shared POST helper for auth endpoints.
   */
  private async postAuth<T extends { success: boolean; message?: string }>(
    serverUrl: string,
    endpoint: string,
    presentationKey: string,
    payload: AuthPayload
  ): Promise<T> {
    const res = await fetch(`${serverUrl}/auth/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        methodType: this.methodType,
        presentationKey,
        payload
      })
    })

    if (!res.ok) {
      return { success: false, message: `HTTP error ${res.status}` } as T
    }

    return res.json()
  }

  /**
   * Start the flow (e.g. request an OTP or create a session).
   */
  public async startAuth(serverUrl: string, presentationKey: string, payload: AuthPayload): Promise<StartAuthResponse> {
    return this.postAuth<StartAuthResponse>(serverUrl, 'start', presentationKey, payload)
  }

  /**
   * Complete the flow (e.g. confirm OTP).
   */
  public async completeAuth(serverUrl: string, presentationKey: string, payload: AuthPayload): Promise<CompleteAuthResponse> {
    return this.postAuth<CompleteAuthResponse>(serverUrl, 'complete', presentationKey, payload)
  }
}
