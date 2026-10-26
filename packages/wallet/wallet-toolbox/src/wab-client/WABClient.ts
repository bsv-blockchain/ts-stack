import { PrivateKey } from '@bsv/sdk'
import {
  AuthMethodInteractor,
  AuthPayload,
  CompleteAuthResponse,
  StartAuthResponse
} from './auth-method-interactors/AuthMethodInteractor'
import { WABTransport, WABTransportOptions } from './WABTransport'
import {
  assertCanonicalShamirShare,
  validateWABCompleteAuthResponse,
  validateWABFaucetResponse,
  validateWABLinkedMethodsResponse,
  validateWABOperationResponse,
  validateWABRegistrationResponse,
  validateWABRetrieveShareResponse,
  validateWABServerInfo,
  validateWABStartAuthResponse,
  validateWABStoreShareResponse,
  validateWABUpdateShareResponse,
  WABFaucetResponse,
  WABLinkedMethodsResponse,
  WABOperationResponse,
  WABServerInfo
} from './WABResponseValidation'

export type {
  WABFaucetResponse,
  WABLinkedAuthMethod,
  WABLinkedMethodsResponse,
  WABOperationResponse,
  WABServerInfo
} from './WABResponseValidation'

export interface WABClientOptions extends WABTransportOptions {}

function assertHexIdentifier(value: string, name: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${name} must be a 32-byte hexadecimal string.`)
  }
}

function assertMethodType(methodType: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(methodType)) {
    throw new TypeError('methodType contains unsupported characters.')
  }
}

function normalizeAuthPayload(methodType: string, payload: AuthPayload): AuthPayload {
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

  constructor(serverUrl: string, options: WABClientOptions = {}) {
    this.transport = new WABTransport(serverUrl, options)
  }

  public async getInfo(): Promise<WABServerInfo> {
    const response = await this.transport.request<unknown>('/info', {
      method: 'GET',
      operation: 'get-info'
    })
    return validateWABServerInfo(response)
  }

  public generateRandomPresentationKey(): string {
    return PrivateKey.fromRandom().toHex()
  }

  public async startAuthMethod(
    authMethod: AuthMethodInteractor,
    presentationKey: string,
    payload: AuthPayload,
    correlationId?: string
  ): Promise<StartAuthResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    const response = await authMethod.startAuth(
      this.transport.serverUrl,
      presentationKey,
      payload,
      this.transport,
      correlationId
    )
    return validateWABStartAuthResponse(response)
  }

  public async completeAuthMethod(
    authMethod: AuthMethodInteractor,
    presentationKey: string,
    payload: AuthPayload,
    correlationId?: string
  ): Promise<CompleteAuthResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    const response = await authMethod.completeAuth(
      this.transport.serverUrl,
      presentationKey,
      payload,
      this.transport,
      correlationId
    )
    return validateWABCompleteAuthResponse(response, presentationKey)
  }

  public async listLinkedMethods(presentationKey: string): Promise<WABLinkedMethodsResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    const response = await this.transport.request<unknown>('/user/linkedMethods', {
      operation: 'list-linked-methods',
      body: { presentationKey }
    })
    return validateWABLinkedMethodsResponse(response)
  }

  public async unlinkMethod(presentationKey: string, authMethodId: number): Promise<WABOperationResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    if (!Number.isSafeInteger(authMethodId) || authMethodId <= 0) {
      throw new TypeError('authMethodId must be a positive safe integer.')
    }
    const response = await this.transport.request<unknown>('/user/unlinkMethod', {
      operation: 'unlink-method',
      body: { presentationKey, authMethodId }
    })
    return validateWABOperationResponse(response, 'unlink-method')
  }

  public async requestFaucet(presentationKey: string): Promise<WABFaucetResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    const response = await this.transport.request<unknown>('/faucet/request', {
      operation: 'request-faucet',
      body: { presentationKey }
    })
    return validateWABFaucetResponse(response)
  }

  public async finalizeRegistration(presentationKey: string): Promise<WABOperationResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    const response = await this.transport.request<unknown>('/auth/registration/finalize', {
      operation: 'finalize-registration',
      body: { presentationKey }
    })
    return validateWABRegistrationResponse(response)
  }

  public async deleteUser(presentationKey: string): Promise<WABOperationResponse> {
    assertHexIdentifier(presentationKey, 'presentationKey')
    const response = await this.transport.request<unknown>('/user/delete', {
      operation: 'delete-user',
      body: { presentationKey }
    })
    return validateWABOperationResponse(response, 'delete-user')
  }

  public async startShareAuth(
    methodType: string,
    userIdHash: string,
    payload: AuthPayload
  ): Promise<{ success: boolean; message: string }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    const response = await this.transport.request<unknown>('/auth/start', {
      operation: 'start-share-auth',
      body: {
        methodType,
        presentationKey: userIdHash,
        payload: normalizedPayload
      }
    })
    return validateWABOperationResponse(response, 'start-share-auth') as { success: boolean; message: string }
  }

  public async storeShare(
    methodType: string,
    payload: AuthPayload,
    shareB: string,
    userIdHash: string
  ): Promise<{ success: boolean; message: string; userId?: number }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    assertCanonicalShamirShare(shareB, 'shareB')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    const response = await this.transport.request<unknown>('/share/store', {
      operation: 'store-share',
      body: { methodType, payload: normalizedPayload, shareB, userIdHash }
    })
    return validateWABStoreShareResponse(response) as { success: boolean; message: string; userId?: number }
  }

  public async retrieveShare(
    methodType: string,
    payload: AuthPayload,
    userIdHash: string
  ): Promise<{ success: boolean; shareB?: string; message: string }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    const response = await this.transport.request<unknown>('/share/retrieve', {
      operation: 'retrieve-share',
      body: { methodType, payload: normalizedPayload, userIdHash }
    })
    return validateWABRetrieveShareResponse(response) as { success: boolean; shareB?: string; message: string }
  }

  public async updateShare(
    methodType: string,
    payload: AuthPayload,
    userIdHash: string,
    newShareB: string
  ): Promise<{ success: boolean; message: string; shareVersion?: number }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    assertCanonicalShamirShare(newShareB, 'newShareB')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    const response = await this.transport.request<unknown>('/share/update', {
      operation: 'update-share',
      body: { methodType, payload: normalizedPayload, userIdHash, newShareB }
    })
    return validateWABUpdateShareResponse(response) as {
      success: boolean
      message: string
      shareVersion?: number
    }
  }

  public async deleteShamirUser(
    methodType: string,
    payload: AuthPayload,
    userIdHash: string
  ): Promise<{ success: boolean; message: string }> {
    assertMethodType(methodType)
    assertHexIdentifier(userIdHash, 'userIdHash')
    const normalizedPayload = normalizeAuthPayload(methodType, payload)
    const response = await this.transport.request<unknown>('/share/delete', {
      operation: 'delete-share-user',
      body: { methodType, payload: normalizedPayload, userIdHash }
    })
    return validateWABOperationResponse(response, 'delete-share-user') as { success: boolean; message: string }
  }
}
