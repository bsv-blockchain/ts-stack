import { PrivateKey } from '@bsv/sdk'
import {
  AuthMethodInteractor,
  AuthPayload,
  CompleteAuthResponse,
  StartAuthResponse
} from './auth-method-interactors/AuthMethodInteractor'
import { WABTransport, WABTransportOptions } from './WABTransport'

export interface WABClientOptions extends WABTransportOptions {}

export interface WABServerInfo {
  supportedAuthMethods?: string[]
  [key: string]: unknown
}

export interface WABOperationResponse {
  success: boolean
  message?: string
  [key: string]: unknown
}

export interface WABFaucetResponse extends WABOperationResponse {
  paymentData?: {
    k?: string
    tx?: number[]
    txid?: string
  }
}

function assertHexIdentifier (value: string, name: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a 32-byte hexadecimal string.`)
  }
}

function assertMethodType (methodType: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(methodType)) {
    throw new TypeError('methodType contains unsupported characters.')
  }
}

function normalizeAuthPayload (methodType: string, payload: AuthPayload): AuthPayload {
  if (methodType !== 'TwilioPhone') return payload
  const phoneNumber = payload.phoneNumber
  if (typeof phoneNumber !== 'string') {
    throw new TypeError('TwilioPhone authentication requires phoneNumber.')
  }
  const normalized = phoneNumber.trim()
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) {
    throw new TypeError('phoneNumber must use canonical E.164 format.')
  }
  return {
    ...payload,
    phoneNumber: normalized
  }
}

/**
 * Production-oriented WAB client with one security and observability boundary
 * for every endpoint.
 */
export class WABClient {
  readonly transport: WABTransport

  constructor (serverUrl: string, options: WABClientOptions = {}) {
    this.transport = new WABTransport(serverUrl, options)
  }

  public async getInfo (): Promise<WABServerInfo> {
    return await this.transport.request<WABServerInfo>('/info', {
      method: 'GET',
      operation: 'get-info'
    })
  }

  public generateRandomPresentationKey (): string {
    return PrivateKey.fromRandom().toHex()
  }

  public async startAuthMethod (
    authMethod: AuthMethodInteractor,
    presentationKey: string,
    payload: AuthPayload,
    correlationId?: string
  ): Promise<StartAuthResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    return await authMethod.startAuth(
      this.transport.serverUrl,
      presentationKey,
      payload,
      this.transport,
      correlationId
    )
  }

  public async completeAuthMethod (
    authMethod: AuthMethodInteractor,
    presentationKey: string,
    payload: AuthPayload,
    correlationId?: string
  ): Promise<CompleteAuthResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    return await authMethod.completeAuth(
      this.transport.serverUrl,
      presentationKey,
      payload,
      this.transport,
      correlationId
    )
  }

  public async listLinkedMethods (presentationKey: string): Promise<WABOperationResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    return await this.transport.request<WABOperationResponse>('/user/linkedMethods', {
      operation: 'list-linked-methods',
      body: { presentationKey }
    })
  }

  public async unlinkMethod (
    presentationKey: string,
    authMethodId: number
  ): Promise<WABOperationResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    if (!Number.isSafeInteger(authMethodId) || authMethodId <= 0) {
      throw new TypeError('authMethodId must be a positive safe integer.')
    }
    return await this.transport.request<WABOperationResponse>('/user/unlinkMethod', {
      operation: 'unlink-method',
      body: { presentationKey, authMethodId }
    })
  }

  public async requestFaucet (presentationKey: string): Promise<WABFaucetResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    return await this.transport.request<WABFaucetResponse>('/faucet/request', {
      operation: 'request-faucet',
      body: { presentationKey }
    })
  }

  public async deleteUser (presentationKey: string): Promise<WABOperationResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    return await this.transport.request<WABOperationResponse>('/user/delete', {
      operation: 'delete-user',
      body: { presentationKey }
    })
  }

  public async startShareAuth (
    methodType: string,
    userIdHash: string,
    payload: AuthPayload
  ): Promise<{ success: boolean, message: string }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    return await this.transport.request('/auth/start', {
      operation: 'start-share-auth',
      body: {
        methodType,
        presentationKey: userIdHash,
        payload: normalizedPayload
      }
    })
  }

  public async storeShare (
    methodType: string,
    payload: AuthPayload,
    shareB: string,
    userIdHash: string
  ): Promise<{ success: boolean, message: string, userId?: number }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    return await this.transport.request('/share/store', {
      operation: 'store-share',
      body: { methodType, payload: normalizedPayload, shareB, userIdHash }
    })
  }

  public async retrieveShare (
    methodType: string,
    payload: AuthPayload,
    userIdHash: string
  ): Promise<{ success: boolean, shareB?: string, message: string }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    return await this.transport.request('/share/retrieve', {
      operation: 'retrieve-share',
      body: { methodType, payload: normalizedPayload, userIdHash }
    })
  }

  public async updateShare (
    methodType: string,
    payload: AuthPayload,
    userIdHash: string,
    newShareB: string
  ): Promise<{ success: boolean, message: string, shareVersion?: number }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    return await this.transport.request('/share/update', {
      operation: 'update-share',
      body: { methodType, payload: normalizedPayload, userIdHash, newShareB }
    })
  }

  public async deleteShamirUser (
    methodType: string,
    payload: AuthPayload,
    userIdHash: string
  ): Promise<{ success: boolean, message: string }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    return await this.transport.request('/share/delete', {
      operation: 'delete-share-user',
      body: { methodType, payload: normalizedPayload, userIdHash }
    })
  }
}
