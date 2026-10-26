import { BigNumber } from '@bsv/sdk'
import { fromBase58, toBase58 } from '@bsv/sdk/primitives/utils'
import type { CompleteAuthResponse, StartAuthResponse } from './auth-method-interactors/AuthMethodInteractor'
import { WABClientError } from './WABTransport'

const MAX_MESSAGE_LENGTH = 4096
const MAX_AUTH_METHODS = 256
const MAX_AUTH_CONFIG_LENGTH = 16 * 1024
const MAX_SHARE_LENGTH = 256
const HEX_IDENTIFIER = /^[0-9a-fA-F]{64}$/
const METHOD_TYPE = /^[a-zA-Z0-9_-]{1,64}$/
const BASE58_FIELD = /^[1-9A-HJ-NP-Za-km-z]{1,64}$/
const INTEGRITY_TAG = /^[0-9a-f]{8}$/
const UMP_OUTPOINT = /^([0-9a-fA-F]{64})\.(0|[1-9]\d*)$/

type WABRecord = Record<string, unknown>

function invalidResponse(operation: string): never {
  throw new WABClientError('WAB_INVALID_RESPONSE', 'WAB response did not match the expected schema.', true, undefined, {
    operation
  })
}

function hasOwn(record: WABRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  }
  return false
}

function responseRecord(value: unknown, operation: string): WABRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidResponse(operation)
  return value as WABRecord
}

function validatedMessage(record: WABRecord, operation: string): string | undefined {
  if (!hasOwn(record, 'message') || record.message === undefined) return undefined
  if (
    typeof record.message !== 'string' ||
    record.message.length > MAX_MESSAGE_LENGTH ||
    hasControlCharacter(record.message)
  ) {
    invalidResponse(operation)
  }
  return record.message
}

function validatedOptionalString(
  record: WABRecord,
  key: string,
  operation: string,
  maximumLength: number
): string | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined
  const value = record[key]
  if (typeof value !== 'string' || value.length > maximumLength || hasControlCharacter(value)) {
    invalidResponse(operation)
  }
  return value
}

function validatedOptionalPositiveInteger(record: WABRecord, key: string, operation: string): number | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) invalidResponse(operation)
  return value
}

function validatedOptionalBoolean(record: WABRecord, key: string, operation: string): boolean | undefined {
  if (!hasOwn(record, key) || record[key] === undefined) return undefined
  const value = record[key]
  if (typeof value !== 'boolean') invalidResponse(operation)
  return value
}

function copyRecord(record: WABRecord): WABRecord {
  return { ...record }
}

export interface WABOperationResponse {
  success: boolean
  message?: string
  [key: string]: unknown
}

export interface WABServerInfo {
  supportedAuthMethods?: string[]
  [key: string]: unknown
}

export interface WABLinkedAuthMethod {
  id: number
  userId?: number | null
  methodType: string
  config?: string
  receivedFaucet?: boolean
  createdAt?: string
  updatedAt?: string
  [key: string]: unknown
}

export interface WABLinkedMethodsResponse extends WABOperationResponse {
  authMethods: WABLinkedAuthMethod[]
}

export interface WABFaucetResponse extends WABOperationResponse {
  paymentData?: {
    amount?: number
    outputIndex?: number
    k?: string
    tx?: number[]
    txid?: string
    [key: string]: unknown
  }
}

export function isCanonicalShamirShare(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > MAX_SHARE_LENGTH) return false
  const [x, y, thresholdText, integrity, extra] = value.split('.')
  if (
    extra !== undefined ||
    x === undefined ||
    y === undefined ||
    thresholdText === undefined ||
    integrity === undefined ||
    !isCanonicalBase58Field(x) ||
    !isCanonicalBase58Field(y) ||
    !/^(?:[2-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-5])$/.test(thresholdText) ||
    !INTEGRITY_TAG.test(integrity)
  ) {
    return false
  }
  return true
}

function isCanonicalBase58Field(value: string): boolean {
  if (!BASE58_FIELD.test(value)) return false
  try {
    return toBase58(new BigNumber(fromBase58(value)).toArray()) === value
  } catch {
    return false
  }
}

export function assertCanonicalShamirShare(value: unknown, name: string): asserts value is string {
  if (!isCanonicalShamirShare(value)) {
    throw new TypeError(`${name} must be a canonical bounded Shamir backup share.`)
  }
}

export function validateWABOperationResponse(value: unknown, operation: string): WABOperationResponse {
  const record = responseRecord(value, operation)
  if (!hasOwn(record, 'success') || typeof record.success !== 'boolean') invalidResponse(operation)
  validatedMessage(record, operation)
  return copyRecord(record) as WABOperationResponse
}

export function validateWABServerInfo(value: unknown): WABServerInfo {
  const operation = 'get-info'
  const record = responseRecord(value, operation)
  const result = copyRecord(record)
  if (hasOwn(record, 'supportedAuthMethods') && record.supportedAuthMethods !== undefined) {
    if (!Array.isArray(record.supportedAuthMethods) || record.supportedAuthMethods.length > MAX_AUTH_METHODS) {
      invalidResponse(operation)
    }
    const methods: string[] = []
    for (let index = 0; index < record.supportedAuthMethods.length; index++) {
      if (!hasOwn(record.supportedAuthMethods as unknown as WABRecord, String(index))) invalidResponse(operation)
      const method = record.supportedAuthMethods[index]
      if (typeof method !== 'string' || !METHOD_TYPE.test(method)) invalidResponse(operation)
      methods.push(method)
    }
    result.supportedAuthMethods = methods
  }
  validatedOptionalBoolean(record, 'faucetEnabled', operation)
  if (hasOwn(record, 'faucetAmount') && record.faucetAmount !== undefined) {
    if (
      typeof record.faucetAmount !== 'number' ||
      !Number.isSafeInteger(record.faucetAmount) ||
      record.faucetAmount < 0
    ) {
      invalidResponse(operation)
    }
  }
  return result as WABServerInfo
}

export function validateWABLinkedMethodsResponse(value: unknown): WABLinkedMethodsResponse {
  const operation = 'list-linked-methods'
  const record = responseRecord(value, operation)
  if (
    !hasOwn(record, 'authMethods') ||
    !Array.isArray(record.authMethods) ||
    record.authMethods.length > MAX_AUTH_METHODS
  ) {
    invalidResponse(operation)
  }
  const authMethods: WABLinkedAuthMethod[] = []
  for (let index = 0; index < record.authMethods.length; index++) {
    if (!hasOwn(record.authMethods as unknown as WABRecord, String(index))) invalidResponse(operation)
    const method = responseRecord(record.authMethods[index], operation)
    if (!hasOwn(method, 'id') || typeof method.id !== 'number' || !Number.isSafeInteger(method.id) || method.id <= 0)
      invalidResponse(operation)
    if (!hasOwn(method, 'methodType') || typeof method.methodType !== 'string' || !METHOD_TYPE.test(method.methodType))
      invalidResponse(operation)
    const userId = method.userId
    if (
      userId !== undefined &&
      userId !== null &&
      (typeof userId !== 'number' || !Number.isSafeInteger(userId) || userId <= 0)
    ) {
      invalidResponse(operation)
    }
    validatedOptionalString(method, 'config', operation, MAX_AUTH_CONFIG_LENGTH)
    validatedOptionalBoolean(method, 'receivedFaucet', operation)
    validatedOptionalString(method, 'createdAt', operation, 128)
    validatedOptionalString(method, 'updatedAt', operation, 128)
    authMethods.push(copyRecord(method) as WABLinkedAuthMethod)
  }

  let success = true
  if (hasOwn(record, 'success')) {
    if (typeof record.success !== 'boolean') invalidResponse(operation)
    success = record.success
  }
  validatedMessage(record, operation)
  return { ...record, success, authMethods }
}

export function validateWABFaucetResponse(value: unknown): WABFaucetResponse {
  const operation = 'request-faucet'
  const result = validateWABOperationResponse(value, operation)
  if (result.success !== true && result.paymentData === undefined) return result

  const paymentData = responseRecord(result.paymentData, operation)
  if (!hasOwn(paymentData, 'k') || typeof paymentData.k !== 'string' || !/^[0-9a-fA-F]{1,64}$/.test(paymentData.k))
    invalidResponse(operation)
  if (!hasOwn(paymentData, 'txid') || typeof paymentData.txid !== 'string' || !HEX_IDENTIFIER.test(paymentData.txid))
    invalidResponse(operation)
  if (!hasOwn(paymentData, 'tx') || !Array.isArray(paymentData.tx) || paymentData.tx.length === 0)
    invalidResponse(operation)
  const tx: number[] = []
  for (let index = 0; index < paymentData.tx.length; index++) {
    if (!hasOwn(paymentData.tx as unknown as WABRecord, String(index))) invalidResponse(operation)
    const byte = paymentData.tx[index]
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) invalidResponse(operation)
    tx.push(byte)
  }
  if (paymentData.amount !== undefined) {
    if (
      typeof paymentData.amount !== 'number' ||
      !Number.isSafeInteger(paymentData.amount) ||
      paymentData.amount <= 0
    ) {
      invalidResponse(operation)
    }
  }
  if (paymentData.outputIndex !== undefined) {
    if (
      typeof paymentData.outputIndex !== 'number' ||
      !Number.isSafeInteger(paymentData.outputIndex) ||
      paymentData.outputIndex < 0 ||
      paymentData.outputIndex > 0xffffffff
    ) {
      invalidResponse(operation)
    }
  }
  return { ...result, paymentData: { ...paymentData, tx } }
}

export function validateWABRegistrationResponse(value: unknown): WABOperationResponse {
  const operation = 'finalize-registration'
  const result = validateWABOperationResponse(value, operation)
  if (
    result.registrationStatus !== undefined &&
    result.registrationStatus !== 'pending' &&
    result.registrationStatus !== 'active'
  ) {
    invalidResponse(operation)
  }
  return result
}

export function validateWABStartAuthResponse(value: unknown): StartAuthResponse {
  return validateWABOperationResponse(value, 'auth-start') as StartAuthResponse
}

export function validateWABCompleteAuthResponse(
  value: unknown,
  temporaryPresentationKey: string
): CompleteAuthResponse {
  const operation = 'auth-complete'
  const result = validateWABOperationResponse(value, operation)
  const presentationKey = result.presentationKey
  if (result.success === true && (typeof presentationKey !== 'string' || !HEX_IDENTIFIER.test(presentationKey))) {
    invalidResponse(operation)
  }
  if (presentationKey !== undefined && (typeof presentationKey !== 'string' || !HEX_IDENTIFIER.test(presentationKey))) {
    invalidResponse(operation)
  }

  const accountStatus = result.accountStatus
  if (accountStatus !== undefined && accountStatus !== 'new-user' && accountStatus !== 'existing-user') {
    invalidResponse(operation)
  }
  const existingUser = validatedOptionalBoolean(result, 'existingUser', operation)
  if (
    accountStatus !== undefined &&
    existingUser !== undefined &&
    (accountStatus === 'existing-user') !== existingUser
  ) {
    invalidResponse(operation)
  }
  const registrationStatus = result.registrationStatus
  if (registrationStatus !== undefined && registrationStatus !== 'pending' && registrationStatus !== 'active') {
    invalidResponse(operation)
  }
  if (result.umpTokenOutpoint !== undefined) {
    if (typeof result.umpTokenOutpoint !== 'string') invalidResponse(operation)
    const match = UMP_OUTPOINT.exec(result.umpTokenOutpoint)
    const outputIndex = match === null ? Number.NaN : Number(match[2])
    if (match === null || !Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) invalidResponse(operation)
  }

  const pendingPresentationKey = result.pendingPresentationKey
  const pendingPhoneChangeId = result.pendingPhoneChangeId
  if ((pendingPresentationKey === undefined) !== (pendingPhoneChangeId === undefined)) invalidResponse(operation)
  if (pendingPresentationKey !== undefined && !HEX_IDENTIFIER.test(String(pendingPresentationKey))) {
    invalidResponse(operation)
  }
  if (
    pendingPhoneChangeId !== undefined &&
    (typeof pendingPhoneChangeId !== 'number' ||
      !Number.isSafeInteger(pendingPhoneChangeId) ||
      pendingPhoneChangeId <= 0)
  ) {
    invalidResponse(operation)
  }

  if (result.success === true && typeof presentationKey === 'string') {
    const matchesTemporary = presentationKey.toLowerCase() === temporaryPresentationKey.toLowerCase()
    const effectiveStatus =
      accountStatus ?? (existingUser === undefined ? undefined : existingUser ? 'existing-user' : 'new-user')
    if (
      (effectiveStatus === 'new-user' && !matchesTemporary) ||
      (effectiveStatus === 'existing-user' && matchesTemporary)
    ) {
      invalidResponse(operation)
    }
  }
  return result as CompleteAuthResponse
}

export function validateWABStoreShareResponse(value: unknown): WABOperationResponse {
  const operation = 'store-share'
  const result = validateWABOperationResponse(value, operation)
  validatedOptionalPositiveInteger(result, 'userId', operation)
  return result
}

export function validateWABRetrieveShareResponse(value: unknown): WABOperationResponse & { shareB?: string } {
  const operation = 'retrieve-share'
  const result = validateWABOperationResponse(value, operation)
  if (result.success === true && !isCanonicalShamirShare(result.shareB)) invalidResponse(operation)
  if (result.shareB !== undefined && !isCanonicalShamirShare(result.shareB)) invalidResponse(operation)
  return result as WABOperationResponse & { shareB?: string }
}

export function validateWABUpdateShareResponse(value: unknown): WABOperationResponse {
  const operation = 'update-share'
  const result = validateWABOperationResponse(value, operation)
  if (result.success === true && validatedOptionalPositiveInteger(result, 'shareVersion', operation) === undefined) {
    invalidResponse(operation)
  }
  return result
}
