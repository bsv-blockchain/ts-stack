import { existingCertificateTypeBytes } from './CertificateType.js'
/* eslint-disable @typescript-eslint/strict-boolean-expressions */
import {
  AbortActionArgs,
  AcquireCertificateArgs,
  AcquisitionProtocol,
  AtomicBEEF,
  Base64String,
  BasketInsertion,
  BasketStringUnder300Bytes,
  BEEF,
  BooleanDefaultFalse,
  BooleanDefaultTrue,
  CertificateFieldNameUnder50Bytes,
  CreateHmacArgs,
  CreateActionArgs,
  CreateActionInput,
  CreateActionOptions,
  CreateActionOutput,
  DescriptionString5to50Bytes,
  GetHeaderArgs,
  GetPublicKeyArgs,
  DiscoverByAttributesArgs,
  DiscoverByIdentityKeyArgs,
  HexString,
  InternalizeActionArgs,
  InternalizeOutput,
  KeyringRevealer,
  LabelStringUnder300Bytes,
  ListActionsArgs,
  ListCertificatesArgs,
  ListOutputsArgs,
  OutpointString,
  OutputTagStringUnder300Bytes,
  PositiveInteger,
  PositiveIntegerDefault10Max10000,
  PositiveIntegerOrZero,
  ProveCertificateArgs,
  PubKeyHex,
  RevealCounterpartyKeyLinkageArgs,
  RevealSpecificKeyLinkageArgs,
  RelinquishCertificateArgs,
  RelinquishOutputArgs,
  SatoshiValue,
  SignActionArgs,
  SignActionOptions,
  SignActionSpend,
  TrustSelf,
  TXIDHexString,
  VerifyHmacArgs,
  VerifySignatureArgs,
  WalletDecryptArgs,
  WalletEncryptArgs,
  WalletPayment,
  WalletProtocol,
  CreateSignatureArgs
} from './Wallet.interfaces.js'
import WERR_INVALID_PARAMETER from './WERR_INVALID_PARAMETER.js'
import { WalletLoggerInterface } from './WalletLoggerInterface.js'
import { MAX_WALLET_WIRE_FRAME_BYTES } from './substrates/WalletWire.js'
import ExactByteCache from './ExactByteCache.js'
import { parseWalletResultAtomicBEEF, parseWalletResultBEEF } from './WalletResultBEEF.js'
import { isCanonicalDERSignature, isValidCompressedPublicKey } from './Secp256k1Validation.js'
import { hexToBytes, utf8Bytes } from './WalletByteEncoding.js'
import { isUnsafeRecordKey } from '../primitives/SafeRecord.js'

const MAX_UINT32 = 0xffffffff
const MAXIMUM_WALLET_COLLECTION_ITEMS = 100_000
/** Maximum number of transaction IDs that may be submitted as one atomic broadcast set. */
export const MAXIMUM_SEND_WITH_TRANSACTIONS = 1000
export const MAXIMUM_CERTIFICATE_REVEAL_FIELDS = 100
export const MAXIMUM_DISCOVERY_ATTRIBUTES = 32
const validatedBeef = new ExactByteCache<true>()
const validatedAtomicBeef = new ExactByteCache<true>()

type UnknownRecord = Record<string, unknown>

function invalid(name: string, expectation: string): never {
  throw new WERR_INVALID_PARAMETER(name, expectation)
}

function validateRecord(value: unknown, name: string): UnknownRecord {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(name, 'a plain object')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    return invalid(name, 'a plain object')
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length > MAXIMUM_WALLET_COLLECTION_ITEMS) {
    return invalid(name, `an object with at most ${MAXIMUM_WALLET_COLLECTION_ITEMS} properties`)
  }
  for (const key of keys) {
    if (typeof key !== 'string' || isUnsafeRecordKey(key)) {
      return invalid(name, 'an object with safe string keys')
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor == null || !('value' in descriptor)) {
      return invalid(`${name}.${key}`, 'a data property')
    }
  }
  return value as UnknownRecord
}

function validateArray<T>(
  value: T[] | undefined,
  name: string,
  maximum = MAXIMUM_WALLET_COLLECTION_ITEMS
): T[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return invalid(name, 'an array')
  if (maximum !== undefined && value.length > maximum) {
    return invalid(name, `an array of at most ${maximum} items`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const expectedKeys = new Set([
    'length',
    ...Array.from({ length: value.length }, (_, index) => String(index))
  ])
  if (
    Object.getOwnPropertySymbols(value).length !== 0 ||
    Object.keys(descriptors).length !== expectedKeys.size ||
    Object.keys(descriptors).some(key => !expectedKeys.has(key)) ||
    Object.values(descriptors).some(descriptor => descriptor.get != null || descriptor.set != null)
  ) {
    return invalid(name, 'an accessor-free dense array without extra properties')
  }
  for (let i = 0; i < value.length; i++) {
    if (!Object.prototype.hasOwnProperty.call(value, i)) {
      return invalid(name, 'a dense array')
    }
  }
  return value
}

function validateSendWith(value: TXIDHexString[] | undefined): TXIDHexString[] {
  const sendWith = validateArray(value, 'sendWith', MAXIMUM_SEND_WITH_TRANSACTIONS).map(
    (txid, index) => validateHexString(txid, `sendWith[${index}]`, 64, 64)
  )
  if (new Set(sendWith).size !== sendWith.length) {
    return invalid('sendWith', 'unique transaction IDs')
  }
  return sendWith
}

function validateByteArray(
  value: unknown,
  name: string,
  exactLength?: number,
  maximumLength = MAX_WALLET_WIRE_FRAME_BYTES
): number[] | Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length > maximumLength) {
      return invalid(name, `at most ${maximumLength} bytes`)
    }
    if (exactLength !== undefined && value.length !== exactLength) {
      return invalid(name, `exactly ${exactLength} bytes`)
    }
    return value
  }
  if (!Array.isArray(value)) return invalid(name, 'an array of bytes')
  if (value.length > maximumLength) return invalid(name, `at most ${maximumLength} bytes`)
  for (let i = 0; i < value.length; i++) {
    if (
      !Object.prototype.hasOwnProperty.call(value, i) ||
      !Number.isInteger(value[i]) ||
      value[i] < 0 ||
      value[i] > 255
    ) {
      return invalid(name, 'a dense array of bytes')
    }
  }
  if (exactLength !== undefined && value.length !== exactLength) {
    return invalid(name, `exactly ${exactLength} bytes`)
  }
  return value
}

function validateBoolean(value: unknown, name: string, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') return invalid(name, 'a boolean')
  return value
}

function validatePublicKey(value: unknown, name: string): PubKeyHex {
  const encoded = validateHexString(value as string, name, 66, 66)
  if (!isValidCompressedPublicKey(encoded)) {
    return invalid(name, 'a valid compressed secp256k1 public key')
  }
  return encoded
}

function validateCounterparty(value: unknown, name: string): PubKeyHex {
  if (value === 'self' || value === 'anyone') return value
  return validatePublicKey(value, name)
}

function validateProtocol(value: unknown, name = 'protocolID'): WalletProtocol {
  if (!Array.isArray(value) || value.length !== 2) {
    return invalid(name, 'a [securityLevel, protocolName] tuple')
  }
  const securityLevel = validateInteger(value[0], `${name}[0]`, undefined, 0, 2)
  const protocolName = validateStringLength(value[1], `${name}[1]`, 5, 400)
  return [securityLevel as 0 | 1 | 2, protocolName]
}

function validatePrivilege(
  value: { privileged?: unknown; privilegedReason?: unknown; seekPermission?: unknown },
  includeSeekPermission = true
): void {
  const privileged = validateBoolean(value.privileged, 'privileged', false)
  const reason = validateOptionalStringLength(
    value.privilegedReason as string | undefined,
    'privilegedReason',
    5,
    50
  )
  if (privileged && reason === undefined) {
    invalid('privilegedReason', "a value when 'privileged' is true")
  }
  if (includeSeekPermission) validateBoolean(value.seekPermission, 'seekPermission', true)
}

function validateEncryptionArgs(args: unknown, name = 'args'): void {
  const value = validateRecord(args, name)
  validateProtocol(value.protocolID)
  validateStringLength(value.keyID as string, 'keyID', 1, 800)
  if (value.counterparty !== undefined) validateCounterparty(value.counterparty, 'counterparty')
  validatePrivilege(value)
}

export function parseWalletOutpoint(outpoint: string): {
  txid: string
  vout: number
} {
  const normalized = validateOutpointString(outpoint, 'outpoint')
  const [txid, vout] = normalized.split('.')
  return { txid, vout: Number(vout) }
}

function defaultTrue(v?: boolean, name = 'value'): boolean {
  return validateBoolean(v, name, true)
}
function defaultFalse(v?: boolean, name = 'value'): boolean {
  return validateBoolean(v, name, false)
}
function validateOptionalStringLength(
  s: string | undefined,
  name: string,
  min?: number,
  max?: number
): string | undefined {
  if (s === undefined) return undefined
  return validateStringLength(s, name, min, max)
}

/**
 * Validate a satoshi amount.
 *
 * @param v - value to validate (integer number of satoshis)
 * @param name - parameter name used in error messages
 * @param min - optional minimum allowed satoshi value
 * @returns validated satoshi number
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateSatoshis(v: number | undefined, name: string, min?: number): number {
  if (v === undefined || !Number.isSafeInteger(v) || v < 0 || v > 21e14) {
    throw new WERR_INVALID_PARAMETER(name, 'a valid number of satoshis')
  }
  if (min !== undefined && v < min)
    throw new WERR_INVALID_PARAMETER(name, `at least ${min} satoshis.`)
  return v
}

/**
 * Validate an optional integer. Returns undefined or the validated integer.
 *
 * @param v - value to validate (may be undefined)
 * @param name - parameter name used in error messages
 * @param min - optional minimum value
 * @param max - optional maximum value
 * @returns validated integer or undefined
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateOptionalInteger(
  v: number | undefined,
  name: string,
  min?: number,
  max?: number
): number | undefined {
  if (v === undefined) return undefined
  return validateInteger(v, name, undefined, min, max)
}

/**
 * Validate an integer, applying an optional default.
 *
 * @param v - value to validate (may be undefined)
 * @param name - parameter name used in error messages
 * @param defaultValue - value to return when v is undefined
 * @param min - optional minimum allowed value
 * @param max - optional maximum allowed value
 * @returns validated integer
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateInteger(
  v: number | undefined,
  name: string,
  defaultValue?: number,
  min?: number,
  max?: number
): number {
  if (v === undefined) {
    if (defaultValue !== undefined) return defaultValue
    throw new WERR_INVALID_PARAMETER(name, 'a valid integer')
  }
  if (!Number.isSafeInteger(v)) throw new WERR_INVALID_PARAMETER(name, 'a safe integer')
  v = Number(v)
  if (min !== undefined && v < min)
    throw new WERR_INVALID_PARAMETER(name, `at least ${min} length.`)
  if (max !== undefined && v > max)
    throw new WERR_INVALID_PARAMETER(name, `no more than ${max} length.`)
  return v
}

/**
 * Validate a non-negative integer (zero allowed).
 *
 * @param v - value to validate
 * @param name - parameter name used in error messages
 * @returns validated integer
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validatePositiveIntegerOrZero(v: number, name: string): number {
  return validateInteger(v, name, 0, 0)
}

/**
 * Validate string length in bytes for UTF-8 encoded string.
 *
 * @param s - string to validate
 * @param name - parameter name used in error messages
 * @param min - optional minimum byte length
 * @param max - optional maximum byte length
 * @returns the original string when valid
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateStringLength(s: string, name: string, min?: number, max?: number): string {
  if (typeof s !== 'string') throw new WERR_INVALID_PARAMETER(name, 'a string')
  const bytes = utf8Bytes(s).length
  if (min !== undefined && bytes < min)
    throw new WERR_INVALID_PARAMETER(name, `at least ${min} length.`)
  if (max !== undefined && bytes > max)
    throw new WERR_INVALID_PARAMETER(name, `no more than ${max} length.`)
  return s
}

/**
 * Validate an optional basket string (1..300 bytes).
 *
 * @param s - basket string or undefined
 * @returns validated basket string or undefined
 */
function validateOptionalBasket(s?: string): string | undefined {
  if (s === undefined) return undefined
  return validateBasket(s)
}

/**
 * Validate basket identifier (1..300 bytes).
 *
 * @param s - basket string
 * @returns validated basket string
 */
function validateBasket(s: string): string {
  return validateIdentifier(s, 'basket', 1, 300)
}

/**
 * Validate label identifier (1..300 bytes).
 *
 * @param s - label string
 * @returns validated label string
 */
function validateLabel(s: string): string {
  return validateIdentifier(s, 'label', 1, 300)
}

/**
 * Validate tag identifier (1..300 bytes).
 *
 * @param s - tag string
 * @returns validated tag string
 */
function validateTag(s: string): string {
  return validateIdentifier(s, 'tag', 1, 300)
}

/**
 * Normalize and validate an identifier (trim, lowercase, byte length).
 *
 * @param s - input string
 * @param name - name used in errors
 * @param min - optional minimum byte length
 * @param max - optional maximum byte length
 * @returns normalized identifier
 * @throws WERR_INVALID_PARAMETER when invalid
 */
function validateIdentifier(s: string, name: string, min?: number, max?: number): string {
  if (typeof s !== 'string') throw new WERR_INVALID_PARAMETER(name, 'a string')
  s = s.trim().toLowerCase()
  const bytes = utf8Bytes(s).length
  if (min !== undefined && bytes < min)
    throw new WERR_INVALID_PARAMETER(name, `at least ${min} length.`)
  if (max !== undefined && bytes > max)
    throw new WERR_INVALID_PARAMETER(name, `no more than ${max} length.`)
  return s
}

/**
 * Validate an optional Base64 encoded string.
 *
 * @param s - base64 string or undefined
 * @param name - parameter name used in error messages
 * @param min - optional minimum decoded byte length
 * @param max - optional maximum decoded byte length
 * @returns validated base64 string or undefined
 */
function validateOptionalBase64String(
  s: string | undefined,
  name: string,
  min?: number,
  max?: number
): string | undefined {
  if (s === undefined) return undefined
  return validateBase64String(s, name, min, max)
}

function invalidBase64(name: string): never {
  throw new WERR_INVALID_PARAMETER(name, 'valid base64 string')
}

function countBase64Padding(value: string, name: string): number {
  let paddingCount = 0
  for (let i = 0; i < value.length; i++) {
    const char = value.codePointAt(i) ?? 0
    const isLetter = (char >= 65 && char <= 90) || (char >= 97 && char <= 122)
    const isDigit = char >= 48 && char <= 57
    if (isLetter || isDigit || char === 43 || char === 47) continue
    if (char !== 61 || i < value.length - 2) invalidBase64(name)
    paddingCount++
  }
  return paddingCount
}

function validateBase64Padding(value: string, paddingCount: number, name: string): void {
  if (paddingCount > 2) invalidBase64(name)
  if (paddingCount > 0 && value.length % 4 !== 0) invalidBase64(name)

  const mod = value.length % 4
  if (mod !== 0 && mod !== 4 - paddingCount) invalidBase64(name)
}

function validateDecodedBase64Length(
  bytes: number,
  name: string,
  min?: number,
  max?: number
): void {
  if (min !== undefined && bytes < min) {
    throw new WERR_INVALID_PARAMETER(name, `at least ${min} bytes`)
  }
  if (max !== undefined && bytes > max) {
    throw new WERR_INVALID_PARAMETER(name, `no more than ${max} bytes`)
  }
}

/** Validate an existing certificate reference without weakening new issuance. */
export function validateExistingCertificateType(value: string, name: string): string {
  try {
    // Preserve reference-argument normalization without rewriting signed types.
    if (typeof value === 'string') value = value.trim()
    existingCertificateTypeBytes(value)
    return value
  } catch {
    throw new WERR_INVALID_PARAMETER(name, 'canonical base64 encoding 1 to 128 bytes')
  }
}

/**
 * Validate a Base64 string (structure and decoded size).
 *
 * @param s - base64 string
 * @param name - parameter name used in error messages
 * @param min - optional minimum decoded byte length
 * @param max - optional maximum decoded byte length
 * @returns validated base64 string
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateBase64String(s: string, name: string, min?: number, max?: number): string {
  if (typeof s !== 'string') invalidBase64(name)
  s = s.trim()
  if (s.length === 0) invalidBase64(name)
  const paddingCount = countBase64Padding(s, name)
  validateBase64Padding(s, paddingCount, name)
  const encodedLength = s.length - paddingCount
  const bytes = Math.floor((encodedLength * 3) / 4)
  validateDecodedBase64Length(bytes, name, min, max)
  return s
}

function validateOptionalHexString(
  s: string | undefined,
  name: string,
  min?: number,
  max?: number
): string | undefined {
  if (s === undefined) return undefined
  return validateHexString(s, name, min, max)
}

const normalizedHexRegex = /^[0-9a-f]+$/
const hexRegex = /^[0-9A-Fa-f]+$/

/**
 * Validate a hex string (even length, hex chars) and optional length bounds (character count).
 *
 * @param s - hex string
 * @param name - parameter name used in error messages
 * @param min if valid, string length minimum (not bytes)
 * @param max if valid, string length maximum (not bytes)
 * @returns
 */
function validateHexString(s: string, name: string, min?: number, max?: number): string {
  if (typeof s !== 'string') throw new WERR_INVALID_PARAMETER(name, 'a hexadecimal string')
  s = s.trim()
  if (s.length % 2 === 1) throw new WERR_INVALID_PARAMETER(name, `even length, not ${s.length}.`)
  const isNormalized = normalizedHexRegex.test(s)
  if (!isNormalized && !hexRegex.test(s))
    throw new WERR_INVALID_PARAMETER(name, 'hexadecimal string.')
  if (min !== undefined && s.length < min)
    throw new WERR_INVALID_PARAMETER(name, `at least ${min} length.`)
  if (max !== undefined && s.length > max)
    throw new WERR_INVALID_PARAMETER(name, `no more than ${max} length.`)
  return isNormalized ? s : s.toLowerCase()
}

function validateSignatureHex(s: string, name: string): HexString {
  const encoded = validateHexString(s, name)
  if (!isCanonicalDERSignature(hexToBytes(encoded))) {
    return invalid(name, 'a canonical DER-encoded ECDSA signature')
  }
  return encoded
}

/**
 * Check whether a string is a valid hex string (even length and hex characters).
 *
 * @param s - input string
 * @returns true when s is a valid hex string
 */
export function isHexString(s: string): boolean {
  if (typeof s !== 'string') return false
  s = s.trim()
  if (s.length % 2 === 1) return false
  if (!hexRegex.test(s)) return false
  return true
}

/**
 * DescriptionString5to2000Bytes alias type (documented).
 */
// Validation result vocabulary mirrors the public BRC-100 constraints.
export type DescriptionString5to2000Bytes = string // NOSONAR

export interface ValidWalletSignerArgs {
  // Optional logger instance for this request
  logger?: WalletLoggerInterface
}

export interface ValidCreateActionInput {
  outpoint: OutPoint
  inputDescription: DescriptionString5to2000Bytes
  sequenceNumber: PositiveIntegerOrZero
  unlockingScript?: HexString
  unlockingScriptLength: PositiveInteger
}

/**
 * Validate a CreateActionInput structure.
 *
 * Ensures either unlockingScript or unlockingScriptLength is provided and consistent,
 * validates outpoint, description length, and sequence number.
 *
 * @param i - CreateActionInput to validate
 * @returns ValidCreateActionInput
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateCreateActionInput(i: CreateActionInput): ValidCreateActionInput {
  validateRecord(i, 'input')
  if (i.unlockingScript === undefined && i.unlockingScriptLength === undefined) {
    throw new WERR_INVALID_PARAMETER(
      'unlockingScript, unlockingScriptLength',
      'at least one valid value.'
    )
  }
  const unlockingScript = validateOptionalHexString(i.unlockingScript, 'unlockingScript')
  const unlockingScriptLength =
    i.unlockingScriptLength ?? (unlockingScript == null ? 0 : unlockingScript.length / 2)
  validateInteger(unlockingScriptLength, 'unlockingScriptLength', undefined, 0)
  if (unlockingScript && unlockingScriptLength !== unlockingScript.length / 2) {
    throw new WERR_INVALID_PARAMETER(
      'unlockingScriptLength',
      'length unlockingScript if both valid.'
    )
  }
  const vi: ValidCreateActionInput = {
    outpoint: parseWalletOutpoint(i.outpoint),
    inputDescription: validateStringLength(i.inputDescription, 'inputDescription', 5, 2000),
    unlockingScript,
    unlockingScriptLength,
    sequenceNumber: validateInteger(i.sequenceNumber, 'sequenceNumber', MAX_UINT32, 0, MAX_UINT32)
  }
  return vi
}

export interface ValidCreateActionOutput {
  lockingScript: HexString
  satoshis: SatoshiValue
  outputDescription: DescriptionString5to2000Bytes
  basket?: BasketStringUnder300Bytes
  customInstructions?: string
  tags: BasketStringUnder300Bytes[]
}

/**
 * Validate CreateActionOutput fields: locking script, satoshis, description, basket, tags.
 *
 * @param o - CreateActionOutput to validate
 * @returns ValidCreateActionOutput
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateCreateActionOutput(o: CreateActionOutput): ValidCreateActionOutput {
  validateRecord(o, 'output')
  const vo: ValidCreateActionOutput = {
    lockingScript: validateHexString(o.lockingScript, 'lockingScript'),
    satoshis: validateSatoshis(o.satoshis, 'satoshis'),
    outputDescription: validateStringLength(o.outputDescription, 'outputDescription', 5, 2000),
    basket: validateOptionalBasket(o.basket),
    customInstructions: validateOptionalStringLength(o.customInstructions, 'customInstructions'),
    tags: validateArray(o.tags, 'tags').map(t => validateTag(t))
  }
  return vo
}

/**
 * Normalize and validate CreateActionOptions, applying defaults for booleans/numbers/arrays.
 *
 * @param options - CreateActionOptions or undefined
 * @returns ValidCreateActionOptions with defaults applied
 */
export function validateCreateActionOptions(
  options?: CreateActionOptions
): ValidCreateActionOptions {
  if (options !== undefined) validateRecord(options, 'options')
  const o = options ?? {}
  if (o.trustSelf !== undefined && o.trustSelf !== 'known') {
    invalid('trustSelf', "undefined or 'known'")
  }
  const vo: ValidCreateActionOptions = {
    signAndProcess: defaultTrue(o.signAndProcess, 'signAndProcess'),
    acceptDelayedBroadcast: defaultTrue(o.acceptDelayedBroadcast, 'acceptDelayedBroadcast'),
    trustSelf: o.trustSelf,
    knownTxids: validateArray(o.knownTxids, 'knownTxids').map(txid =>
      validateHexString(txid, 'knownTxids', 64, 64)
    ),
    returnTXIDOnly: defaultFalse(o.returnTXIDOnly, 'returnTXIDOnly'),
    noSend: defaultFalse(o.noSend, 'noSend'),
    noSendChange: validateArray(o.noSendChange, 'noSendChange').map(nsc =>
      parseWalletOutpoint(nsc)
    ),
    sendWith: validateSendWith(o.sendWith),
    randomizeOutputs: defaultTrue(o.randomizeOutputs, 'randomizeOutputs')
  }
  return vo
}

export interface ValidProcessActionOptions {
  acceptDelayedBroadcast: BooleanDefaultTrue
  returnTXIDOnly: BooleanDefaultFalse
  noSend: BooleanDefaultFalse
  sendWith: TXIDHexString[]
}

export interface ValidCreateActionOptions extends ValidProcessActionOptions {
  signAndProcess: boolean
  trustSelf?: TrustSelf
  knownTxids: TXIDHexString[]
  noSendChange: OutPoint[]
  randomizeOutputs: boolean
}

export interface ValidSignActionOptions extends ValidProcessActionOptions {
  acceptDelayedBroadcast: boolean
  returnTXIDOnly: boolean
  noSend: boolean
  sendWith: TXIDHexString[]
}

export interface ValidProcessActionArgs extends ValidWalletSignerArgs {
  options: ValidProcessActionOptions
  // true if a batch of transactions is included for processing.
  isSendWith: boolean
  // true if there is a new transaction (not no inputs and no outputs)
  isNewTx: boolean
  // true if this is a request to remix change, `isNewTx` will also be true and `isSendWith` must be false
  isRemixChange: boolean
  // true if any new transaction should NOT be sent to the network
  isNoSend: boolean
  // true if options.acceptDelayedBroadcast is true
  isDelayed: boolean
  // true if WERR_REVIEW_ACTIONS should be thrown to test review actions handling
  isTestWerrReviewActions: boolean
}

export interface ValidCreateActionArgs extends ValidProcessActionArgs {
  description: DescriptionString5to2000Bytes
  inputBEEF?: BEEF
  inputs: ValidCreateActionInput[]
  outputs: ValidCreateActionOutput[]
  lockTime: number
  version: number
  labels: string[]

  options: ValidCreateActionOptions
  // true if transaction creation completion will require a `signAction` call.
  isSignAction: boolean
  randomVals?: number[]
  /**
   * If true, signableTransactions will include sourceTransaction for each input,
   * including those that do not require signature and those that were also contained
   * in the inputBEEF.
   */
  includeAllSourceTransactions: boolean
}

export interface ValidSignActionArgs extends ValidProcessActionArgs {
  spends: Record<PositiveIntegerOrZero, SignActionSpend>
  reference: Base64String

  options: ValidSignActionOptions
}

/**
 * Validate the arguments for creating a new action.
 *
 * @param args
 * @returns validated arguments
 * @throws primarily WERR_INVALID_PARAMETER if args are invalid.
 */
export function validateCreateActionArgs(
  args: CreateActionArgs,
  logger?: WalletLoggerInterface
): ValidCreateActionArgs {
  validateRecord(args, 'args')
  const vargs: ValidCreateActionArgs = {
    description: validateStringLength(args.description, 'description', 5, 2000),
    inputBEEF:
      args.inputBEEF === undefined ? undefined : validateByteArray(args.inputBEEF, 'inputBEEF'),
    inputs: validateArray(args.inputs, 'inputs').map(i => validateCreateActionInput(i)),
    outputs: validateArray(args.outputs, 'outputs').map(o => validateCreateActionOutput(o)),
    lockTime: validateInteger(args.lockTime, 'lockTime', 0, 0, MAX_UINT32),
    version: validateInteger(args.version, 'version', 1, 0, MAX_UINT32),
    labels: validateArray(args.labels, 'labels').map(l => validateLabel(l)),
    options: validateCreateActionOptions(args.options),
    logger,
    isSendWith: false,
    isDelayed: false,
    isNoSend: false,
    isNewTx: false,
    isRemixChange: false,
    isSignAction: false,
    randomVals: undefined,
    includeAllSourceTransactions: false,
    isTestWerrReviewActions: false
  }
  if (vargs.inputBEEF !== undefined && validatedBeef.get(vargs.inputBEEF) !== true) {
    try {
      parseWalletResultBEEF(vargs.inputBEEF)
      validatedBeef.set(vargs.inputBEEF, true)
    } catch {
      throw new WERR_INVALID_PARAMETER('inputBEEF', 'a complete, exactly framed BEEF envelope')
    }
  }
  const requestedInputOutpoints = new Set<string>()
  for (const input of vargs.inputs) {
    const outpoint = `${input.outpoint.txid.toLowerCase()}.${input.outpoint.vout}`
    if (requestedInputOutpoints.has(outpoint)) {
      invalid('inputs', 'unique input outpoints')
    }
    requestedInputOutpoints.add(outpoint)
  }
  vargs.isTestWerrReviewActions = vargs.labels.includes(specOpThrowReviewActions)
  vargs.isSendWith = vargs.options.sendWith.length > 0
  vargs.isRemixChange = !vargs.isSendWith && vargs.inputs.length === 0 && vargs.outputs.length === 0
  vargs.isNewTx = vargs.isRemixChange || vargs.inputs.length > 0 || vargs.outputs.length > 0
  if (vargs.isNewTx && vargs.options.sendWith.length >= MAXIMUM_SEND_WITH_TRANSACTIONS) {
    invalid(
      'sendWith',
      `at most ${MAXIMUM_SEND_WITH_TRANSACTIONS - 1} transaction IDs when the new transaction joins the broadcast set`
    )
  }
  vargs.isSignAction =
    vargs.isNewTx &&
    (!vargs.options.signAndProcess || vargs.inputs.some(i => i.unlockingScript === undefined))
  vargs.isDelayed = vargs.options.acceptDelayedBroadcast
  vargs.isNoSend = vargs.options.noSend

  return vargs
}

/**
 * Set all default true/false booleans to true or false if undefined.
 * Set all possibly undefined numbers to their default values.
 * Set all possibly undefined arrays to empty arrays.
 * Convert string outpoints to `{ txid: string, vout: number }`
 */
export function validateSignActionOptions(options?: SignActionOptions): ValidSignActionOptions {
  if (options !== undefined) validateRecord(options, 'options')
  const o = options ?? {}
  const vo: ValidSignActionOptions = {
    acceptDelayedBroadcast: defaultTrue(o.acceptDelayedBroadcast, 'acceptDelayedBroadcast'),
    returnTXIDOnly: defaultFalse(o.returnTXIDOnly, 'returnTXIDOnly'),
    noSend: defaultFalse(o.noSend, 'noSend'),
    sendWith: validateSendWith(o.sendWith)
  }
  return vo
}

/**
 * Validate SignActionArgs and apply defaults/flags.
 *
 * @param args - SignActionArgs to validate
 * @returns ValidSignActionArgs
 */
export function validateSignActionArgs(args: SignActionArgs): ValidSignActionArgs {
  validateRecord(args, 'args')
  const spends = validateRecord(args.spends, 'spends')
  const validSpends: Record<number, SignActionSpend> = Object.create(null)
  for (const [index, value] of Object.entries(spends)) {
    if (!/^(?:0|[1-9]\d*)$/.test(index)) invalid('spends key', 'a canonical input index')
    const inputIndex = validateInteger(Number(index), 'spends key', undefined, 0, MAX_UINT32)
    const spend = validateRecord(value, `spends.${index}`)
    validSpends[inputIndex] = {
      unlockingScript: validateHexString(
        spend.unlockingScript as string,
        `spends.${index}.unlockingScript`
      ),
      sequenceNumber:
        spend.sequenceNumber === undefined
          ? undefined
          : validateInteger(
              spend.sequenceNumber as number,
              `spends.${index}.sequenceNumber`,
              undefined,
              0,
              MAX_UINT32
            )
    }
  }
  const vargs: ValidSignActionArgs = {
    spends: validSpends,
    reference: validateBase64String(args.reference, 'reference'),
    options: validateSignActionOptions(args.options),
    isSendWith: false,
    isDelayed: false,
    isNoSend: false,
    isNewTx: true,
    isRemixChange: false,
    isTestWerrReviewActions: false
  }
  vargs.isSendWith = vargs.options.sendWith.length > 0
  if (vargs.options.sendWith.length >= MAXIMUM_SEND_WITH_TRANSACTIONS) {
    invalid(
      'sendWith',
      `at most ${MAXIMUM_SEND_WITH_TRANSACTIONS - 1} transaction IDs when the signed transaction joins the broadcast set`
    )
  }
  vargs.isDelayed = vargs.options.acceptDelayedBroadcast
  vargs.isNoSend = vargs.options.noSend

  return vargs
}

export interface ValidAbortActionArgs extends ValidWalletSignerArgs {
  reference: Base64String
}

/**
 * Validate AbortActionArgs (ensures reference is a valid base64 string).
 *
 * @param args - AbortActionArgs
 * @returns ValidAbortActionArgs
 */
export function validateAbortActionArgs(args: AbortActionArgs): ValidAbortActionArgs {
  validateRecord(args, 'args')
  const vargs: ValidAbortActionArgs = {
    reference: validateBase64String(args.reference, 'reference')
  }

  return vargs
}

export interface ValidWalletPayment {
  derivationPrefix: Base64String
  derivationSuffix: Base64String
  senderIdentityKey: PubKeyHex
}

/**
 * Validate wallet payment remittance structure.
 *
 * @param args - WalletPayment or undefined
 * @returns ValidWalletPayment or undefined
 */
export function validateWalletPayment(args?: WalletPayment): ValidWalletPayment | undefined {
  if (args === undefined) return undefined
  validateRecord(args, 'paymentRemittance')
  const v: ValidWalletPayment = {
    derivationPrefix: validateBase64String(args.derivationPrefix, 'derivationPrefix'),
    derivationSuffix: validateBase64String(args.derivationSuffix, 'derivationSuffix'),
    senderIdentityKey: validatePublicKey(args.senderIdentityKey, 'senderIdentityKey')
  }
  return v
}

export interface ValidBasketInsertion {
  basket: BasketStringUnder300Bytes
  customInstructions?: string
  tags: BasketStringUnder300Bytes[]
}

/**
 * Validate a BasketInsertion structure (basket, custom instructions, tags).
 *
 * @param args - BasketInsertion or undefined
 * @returns ValidBasketInsertion or undefined
 */
export function validateBasketInsertion(args?: BasketInsertion): ValidBasketInsertion | undefined {
  if (args === undefined) return undefined
  validateRecord(args, 'insertionRemittance')
  const v: ValidBasketInsertion = {
    basket: validateBasket(args.basket),
    customInstructions: validateOptionalStringLength(
      args.customInstructions,
      'customInstructions',
      0,
      1000
    ),
    tags: validateArray(args.tags, 'tags').map(t => validateTag(t))
  }
  return v
}

export interface ValidInternalizeOutput {
  outputIndex: PositiveIntegerOrZero
  protocol: 'wallet payment' | 'basket insertion'
  paymentRemittance?: ValidWalletPayment
  insertionRemittance?: ValidBasketInsertion
}

/**
 * Validate an InternalizeOutput entry.
 *
 * @param args - InternalizeOutput to validate
 * @returns ValidInternalizeOutput
 */
export function validateInternalizeOutput(args: InternalizeOutput): ValidInternalizeOutput {
  validateRecord(args, 'output')
  if (args.protocol !== 'basket insertion' && args.protocol !== 'wallet payment') {
    throw new WERR_INVALID_PARAMETER('protocol', "'basket insertion' or 'wallet payment'")
  }
  if (args.protocol === 'wallet payment') {
    if (args.paymentRemittance === undefined || args.insertionRemittance !== undefined) {
      invalid('output remittance', 'only paymentRemittance for wallet payment')
    }
  } else if (args.insertionRemittance === undefined || args.paymentRemittance !== undefined) {
    invalid('output remittance', 'only insertionRemittance for basket insertion')
  }
  const v: ValidInternalizeOutput = {
    outputIndex: validatePositiveIntegerOrZero(args.outputIndex, 'outputIndex'),
    protocol: args.protocol,
    paymentRemittance: validateWalletPayment(args.paymentRemittance),
    insertionRemittance: validateBasketInsertion(args.insertionRemittance)
  }
  return v
}

export interface ValidInternalizeActionArgs extends ValidWalletSignerArgs {
  tx: AtomicBEEF
  outputs: InternalizeOutput[]
  description: DescriptionString5to2000Bytes
  labels: LabelStringUnder300Bytes[]
  seekPermission: BooleanDefaultTrue
}

/**
 * Validate an originator hostname with an optional port. Ports are accepted
 * for compatibility but omitted from the normalized result: BRC-100 wallet
 * permissions are scoped to the hostname, not to an individual TCP port.
 *
 * @param s - originator string or undefined
 * @returns normalized originator or undefined
 */
export function validateOriginator(s?: string): string | undefined {
  if (s === undefined) return undefined
  s = s.trim().toLowerCase()
  validateStringLength(s, 'originator', 1, 250)
  const separator = s.lastIndexOf(':')
  let hostname = s
  if (separator !== -1) {
    if (s.indexOf(':') !== separator) {
      throw new WERR_INVALID_PARAMETER(
        'originator',
        'a canonical DNS hostname with an optional port'
      )
    }
    const port = s.slice(separator + 1)
    if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) {
      throw new WERR_INVALID_PARAMETER(
        'originator',
        'a canonical DNS hostname with an optional port'
      )
    }
    hostname = s.slice(0, separator)
  }
  validateStringLength(hostname, 'originator hostname', 1, 250)
  const sps = hostname.split('.')
  for (const sp of sps) {
    validateStringLength(sp, 'originator part', 1, 63)
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(sp)) {
      throw new WERR_INVALID_PARAMETER(
        'originator',
        'a canonical DNS hostname with an optional port'
      )
    }
  }
  return hostname
}

/**
 * Validate InternalizeActionArgs: tx, outputs, description, labels, permission flag.
 *
 * @param args - InternalizeActionArgs to validate
 * @returns ValidInternalizeActionArgs
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateInternalizeActionArgs(
  args: InternalizeActionArgs
): ValidInternalizeActionArgs {
  validateRecord(args, 'args')
  const vargs: ValidInternalizeActionArgs = {
    tx: validateByteArray(args.tx, 'tx'),
    outputs: validateArray(args.outputs, 'outputs').map(o => validateInternalizeOutput(o)),
    description: validateStringLength(args.description, 'description', 5, 2000),
    labels: validateArray(args.labels, 'labels').map(t => validateLabel(t)),
    seekPermission: defaultTrue(args.seekPermission, 'seekPermission')
  }

  if (validatedAtomicBeef.get(vargs.tx) !== true) {
    try {
      parseWalletResultAtomicBEEF(vargs.tx)
      validatedAtomicBeef.set(vargs.tx, true)
    } catch {
      throw new WERR_INVALID_PARAMETER('tx', 'a complete, exactly framed Atomic BEEF transaction')
    }
  }
  if (vargs.outputs.length < 1) {
    throw new WERR_INVALID_PARAMETER(
      'outputs',
      'at least one output to internalize from the transaction'
    )
  }

  return vargs
}

/**
 * Validate an optional outpoint string (txid.vout).
 *
 * @param outpoint - outpoint string or undefined
 * @param name - parameter name used in error messages
 * @returns validated outpoint string or undefined
 */
export function validateOptionalOutpointString(
  outpoint: string | undefined,
  name: string
): string | undefined {
  if (outpoint === undefined) return undefined
  return validateOutpointString(outpoint, name)
}

/**
 * Validate an outpoint string of the form txid.vout.
 *
 * @param outpoint - outpoint string
 * @param name - parameter name used in error messages
 * @returns normalized outpoint string (validated txid and vout)
 * @throws WERR_INVALID_PARAMETER when invalid
 */
export function validateOutpointString(outpoint: string, name: string): string {
  if (typeof outpoint !== 'string') {
    throw new WERR_INVALID_PARAMETER(
      name,
      "txid as hex string and numeric output index joined with '.'"
    )
  }
  const match = /^([0-9A-Fa-f]{64})\.(0|[1-9]\d*)$/.exec(outpoint)
  if (match === null) {
    throw new WERR_INVALID_PARAMETER(
      name,
      "a 32-byte txid and canonical numeric output index joined with '.'"
    )
  }
  const txid = validateHexString(match[1], `${name} txid`, 64, 64)
  const vout = validateInteger(Number(match[2]), `${name} vout`, undefined, 0, MAX_UINT32)
  return `${txid}.${vout}`
}

export interface ValidRelinquishOutputArgs extends ValidWalletSignerArgs {
  basket: BasketStringUnder300Bytes
  output: OutpointString
}

/**
 * Validate RelinquishOutputArgs (basket and output).
 *
 * @param args - RelinquishOutputArgs
 * @returns ValidRelinquishOutputArgs
 */
export function validateRelinquishOutputArgs(
  args: RelinquishOutputArgs
): ValidRelinquishOutputArgs {
  validateRecord(args, 'args')
  const vargs: ValidRelinquishOutputArgs = {
    basket: validateBasket(args.basket),
    output: validateOutpointString(args.output, 'output')
  }

  return vargs
}

export interface ValidRelinquishCertificateArgs extends ValidWalletSignerArgs {
  type: Base64String
  serialNumber: Base64String
  certifier: PubKeyHex
}

/**
 * Validate RelinquishCertificateArgs (type, serialNumber, certifier).
 *
 * @param args - RelinquishCertificateArgs
 * @returns ValidRelinquishCertificateArgs
 */
export function validateRelinquishCertificateArgs(
  args: RelinquishCertificateArgs
): ValidRelinquishCertificateArgs {
  validateRecord(args, 'args')
  const vargs: ValidRelinquishCertificateArgs = {
    type: validateExistingCertificateType(args.type, 'type'),
    serialNumber: validateBase64String(args.serialNumber, 'serialNumber', 32, 32),
    certifier: validatePublicKey(args.certifier, 'certifier')
  }

  return vargs
}

export interface ValidListCertificatesArgs extends ValidWalletSignerArgs {
  partial?: {
    type?: Base64String
    serialNumber?: Base64String
    certifier?: PubKeyHex
    subject?: PubKeyHex
    revocationOutpoint?: OutpointString
    signature?: HexString
  }
  certifiers: PubKeyHex[]
  types: Base64String[]
  limit: PositiveIntegerDefault10Max10000
  offset: PositiveIntegerOrZero
  privileged: BooleanDefaultFalse
  privilegedReason?: DescriptionString5to50Bytes
}

/**
 * Validate ListCertificatesArgs: certifiers, types, paging, and optional privileged reason.
 *
 * @param args - ListCertificatesArgs
 * @returns ValidListCertificatesArgs
 */
export function validateListCertificatesArgs(
  args: ListCertificatesArgs
): ValidListCertificatesArgs {
  validateRecord(args, 'args')
  validatePrivilege(args, false)
  const vargs: ValidListCertificatesArgs = {
    certifiers: validateArray(args.certifiers, 'certifiers').map(c =>
      validatePublicKey(c, 'certifiers')
    ),
    types: validateArray(args.types, 'types').map(t => validateExistingCertificateType(t, 'types')),
    limit: validateInteger(args.limit, 'limit', 10, 1, 10000),
    offset: validateInteger(args.offset, 'offset', 0, 0),
    privileged: defaultFalse(args.privileged, 'privileged'),
    privilegedReason: validateOptionalStringLength(
      args.privilegedReason,
      'privilegedReason',
      5,
      50
    ),
    partial: undefined
  }
  return vargs
}

export interface ValidAcquireCertificateArgs extends ValidWalletSignerArgs {
  acquisitionProtocol: AcquisitionProtocol

  type: Base64String
  serialNumber?: Base64String
  certifier: PubKeyHex
  revocationOutpoint?: OutpointString
  fields: Record<CertificateFieldNameUnder50Bytes, string>
  signature?: HexString

  certifierUrl?: string

  keyringRevealer?: KeyringRevealer
  keyringForSubject?: Record<CertificateFieldNameUnder50Bytes, Base64String>

  privileged: boolean
  privilegedReason?: DescriptionString5to50Bytes
}

function validateCertificateFields(
  fields: Record<CertificateFieldNameUnder50Bytes, string>
): Record<CertificateFieldNameUnder50Bytes, string> {
  const values = validateRecord(fields, 'fields')
  for (const fieldName of Object.keys(values)) {
    validateStringLength(fieldName, 'field name', 1, 50)
    validateStringLength(values[fieldName] as string, `fields.${fieldName}`)
  }
  return fields
}

function validateKeyringRevealer(kr: KeyringRevealer, name: string): KeyringRevealer {
  if (kr === 'certifier') return kr
  return validatePublicKey(kr, name)
}

function validateKeyringForSubject(
  kr: Record<CertificateFieldNameUnder50Bytes, Base64String>,
  name: string
): Record<CertificateFieldNameUnder50Bytes, Base64String> {
  const values = validateRecord(kr, name)
  for (const fn of Object.keys(values)) {
    validateStringLength(fn, `${name} field name`, 1, 50)
    validateBase64String(values[fn] as string, `${name} field value`)
  }
  return kr
}

export interface ValidAcquireDirectCertificateArgs extends ValidWalletSignerArgs {
  type: Base64String
  serialNumber: Base64String
  certifier: PubKeyHex
  revocationOutpoint: OutpointString
  fields: Record<CertificateFieldNameUnder50Bytes, string>
  signature: HexString

  /**
   * validated to an empty string, must be provided by wallet and must
   * match expectations of keyringForSubject
   */
  subject: PubKeyHex

  keyringRevealer: KeyringRevealer
  keyringForSubject: Record<CertificateFieldNameUnder50Bytes, Base64String>

  privileged: boolean
  privilegedReason?: DescriptionString5to50Bytes
}

export interface ValidAcquireIssuanceCertificateArgs extends ValidWalletSignerArgs {
  type: Base64String
  certifier: PubKeyHex
  certifierUrl: string
  fields: Record<CertificateFieldNameUnder50Bytes, string>

  /**
   * validated to an empty string, must be provided by wallet and must
   * match expectations of keyringForSubject
   */
  subject: PubKeyHex

  privileged: boolean
  privilegedReason?: DescriptionString5to50Bytes
}

/**
 * Validate issuance-specific acquire certificate args.
 *
 * @param args - AcquireCertificateArgs with acquisitionProtocol === 'issuance'
 * @returns ValidAcquireIssuanceCertificateArgs
 * @throws when args contain fields invalid for issuance
 */
export function validateAcquireIssuanceCertificateArgs(
  args: AcquireCertificateArgs
): ValidAcquireIssuanceCertificateArgs {
  validateRecord(args, 'args')
  validatePrivilege(args, false)
  if (args.acquisitionProtocol !== 'issuance') {
    throw new Error('Only acquire certificate via issuance requests allowed here.')
  }
  if (args.serialNumber)
    throw new WERR_INVALID_PARAMETER('serialNumber', 'valid when acquisitionProtocol is "direct"')
  if (args.signature)
    throw new WERR_INVALID_PARAMETER('signature', 'valid when acquisitionProtocol is "direct"')
  if (args.revocationOutpoint) {
    throw new WERR_INVALID_PARAMETER(
      'revocationOutpoint',
      'valid when acquisitionProtocol is "direct"'
    )
  }
  if (args.keyringRevealer) {
    throw new WERR_INVALID_PARAMETER(
      'keyringRevealer',
      'valid when acquisitionProtocol is "direct"'
    )
  }
  if (args.keyringForSubject != null) {
    throw new WERR_INVALID_PARAMETER(
      'keyringForSubject',
      'valid when acquisitionProtocol is "direct"'
    )
  }
  if (!args.certifierUrl) {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'valid when acquisitionProtocol is "issuance"')
  }
  const vargs: ValidAcquireIssuanceCertificateArgs = {
    type: validateBase64String(args.type, 'type', 32, 32),
    certifier: validatePublicKey(args.certifier, 'certifier'),
    certifierUrl: validateCertificateIssuerUrl(args.certifierUrl),
    fields: validateCertificateFields(args.fields),
    privileged: defaultFalse(args.privileged, 'privileged'),
    privilegedReason: validateOptionalStringLength(
      args.privilegedReason,
      'privilegedReason',
      5,
      50
    ),
    subject: ''
  }
  return vargs
}

function validateCertificateIssuerUrl(value: string): string {
  const encoded = validateStringLength(value, 'certifierUrl', 1, 2048)
  if (encoded !== encoded.trim()) {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'an exact HTTPS URL without whitespace')
  }
  let target: URL
  try {
    target = new URL(encoded)
  } catch {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'an absolute HTTPS URL')
  }
  if (target.protocol !== 'https:') {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'an HTTPS URL')
  }
  if (target.username !== '' || target.password !== '') {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'a URL without credentials')
  }
  if (target.search !== '' || target.hash !== '') {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'a URL without a query or fragment')
  }
  const hostname = target.hostname.toLowerCase()
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^\d+(?:\.\d+){0,3}$/.test(hostname) ||
    hostname.includes(':')
  ) {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'a public DNS hostname')
  }
  const labels = hostname.split('.')
  if (
    labels.length < 2 ||
    labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
  ) {
    throw new WERR_INVALID_PARAMETER('certifierUrl', 'a public DNS hostname')
  }
  return encoded.replace(/\/+$/, '')
}

/**
 * Validate direct-acquisition-specific acquire certificate args.
 *
 * @param args - AcquireCertificateArgs with acquisitionProtocol === 'direct'
 * @returns ValidAcquireDirectCertificateArgs
 * @throws when args contain fields invalid for direct acquisition
 */
export function validateAcquireDirectCertificateArgs(
  args: AcquireCertificateArgs
): ValidAcquireDirectCertificateArgs {
  validateRecord(args, 'args')
  validatePrivilege(args, false)
  if (args.acquisitionProtocol !== 'direct') {
    throw new Error('Only acquire direct certificate requests allowed here.')
  }
  if (!args.serialNumber)
    throw new WERR_INVALID_PARAMETER('serialNumber', 'valid when acquisitionProtocol is "direct"')
  if (!args.signature)
    throw new WERR_INVALID_PARAMETER('signature', 'valid when acquisitionProtocol is "direct"')
  if (!args.revocationOutpoint) {
    throw new WERR_INVALID_PARAMETER(
      'revocationOutpoint',
      'valid when acquisitionProtocol is "direct"'
    )
  }
  if (!args.keyringRevealer) {
    throw new WERR_INVALID_PARAMETER(
      'keyringRevealer',
      'valid when acquisitionProtocol is "direct"'
    )
  }
  if (args.keyringForSubject == null) {
    throw new WERR_INVALID_PARAMETER(
      'keyringForSubject',
      'valid when acquisitionProtocol is "direct"'
    )
  }
  const vargs: ValidAcquireDirectCertificateArgs = {
    type: validateBase64String(args.type, 'type', 32, 32),
    serialNumber: validateBase64String(args.serialNumber, 'serialNumber', 32, 32),
    certifier: validatePublicKey(args.certifier, 'certifier'),
    revocationOutpoint: validateOutpointString(args.revocationOutpoint, 'revocationOutpoint'),
    fields: validateCertificateFields(args.fields),
    signature: validateSignatureHex(args.signature, 'signature'),
    keyringRevealer: validateKeyringRevealer(args.keyringRevealer, 'keyringRevealer'),
    keyringForSubject: validateKeyringForSubject(args.keyringForSubject, 'keyringForSubject'),
    privileged: defaultFalse(args.privileged, 'privileged'),
    privilegedReason: validateOptionalStringLength(
      args.privilegedReason,
      'privilegedReason',
      5,
      50
    ),
    subject: ''
  }
  return vargs
}

export interface ValidProveCertificateArgs extends ValidWalletSignerArgs {
  type?: Base64String
  serialNumber?: Base64String
  certifier?: PubKeyHex
  subject?: PubKeyHex
  revocationOutpoint?: OutpointString
  signature?: HexString

  fieldsToReveal: CertificateFieldNameUnder50Bytes[]
  verifier: PubKeyHex
  privileged: boolean
  privilegedReason?: DescriptionString5to50Bytes
}

/**
 * Validate ProveCertificateArgs including optional certificate fields and reveal list.
 *
 * @param args - ProveCertificateArgs
 * @returns ValidProveCertificateArgs
 */
export function validateProveCertificateArgs(
  args: ProveCertificateArgs
): ValidProveCertificateArgs {
  validateRecord(args, 'args')
  validateRecord(args.certificate, 'certificate')
  validatePrivilege(args, false)
  if (args.certificate.fields !== undefined) {
    validateCertificateFields(args.certificate.fields)
  }

  const vargs: ValidProveCertificateArgs = {
    type:
      args.certificate.type === undefined
        ? undefined
        : validateExistingCertificateType(args.certificate.type, 'certificate.type'),
    serialNumber: validateOptionalBase64String(
      args.certificate.serialNumber,
      'certificate.serialNumber',
      32,
      32
    ),
    certifier:
      args.certificate.certifier === undefined
        ? undefined
        : validatePublicKey(args.certificate.certifier, 'certificate.certifier'),
    subject:
      args.certificate.subject === undefined
        ? undefined
        : validatePublicKey(args.certificate.subject, 'certificate.subject'),
    revocationOutpoint: validateOptionalOutpointString(
      args.certificate.revocationOutpoint,
      'certificate.revocationOutpoint'
    ),
    signature:
      args.certificate.signature === undefined
        ? undefined
        : validateSignatureHex(args.certificate.signature, 'certificate.signature'),
    fieldsToReveal: validateArray(args.fieldsToReveal, 'fieldsToReveal').map(fieldName =>
      validateStringLength(fieldName, `fieldsToReveal ${fieldName}`, 1, 50)
    ),
    verifier: validatePublicKey(args.verifier, 'verifier'),
    privileged: defaultFalse(args.privileged, 'privileged'),
    privilegedReason: validateOptionalStringLength(args.privilegedReason, 'privilegedReason', 5, 50)
  }
  if (vargs.fieldsToReveal.length > MAXIMUM_CERTIFICATE_REVEAL_FIELDS) {
    invalid('fieldsToReveal', `at most ${MAXIMUM_CERTIFICATE_REVEAL_FIELDS} fields`)
  }
  if (new Set(vargs.fieldsToReveal).size !== vargs.fieldsToReveal.length) {
    invalid('fieldsToReveal', 'unique field names')
  }
  return vargs
}

export interface ValidDiscoverByIdentityKeyArgs extends ValidWalletSignerArgs {
  identityKey: PubKeyHex
  limit: PositiveIntegerDefault10Max10000
  offset: PositiveIntegerOrZero
  seekPermission: boolean
}

/**
 * Validate DiscoverByIdentityKeyArgs, enforcing identity key length and defaults.
 *
 * @param args - DiscoverByIdentityKeyArgs
 * @returns ValidDiscoverByIdentityKeyArgs
 */
export function validateDiscoverByIdentityKeyArgs(
  args: DiscoverByIdentityKeyArgs
): ValidDiscoverByIdentityKeyArgs {
  validateRecord(args, 'args')
  const vargs: ValidDiscoverByIdentityKeyArgs = {
    identityKey: validatePublicKey(args.identityKey, 'identityKey'),
    limit: validateInteger(args.limit, 'limit', 10, 1, 10000),
    offset: validateInteger(args.offset, 'offset', 0, 0),
    seekPermission: defaultTrue(args.seekPermission, 'seekPermission')
  }
  return vargs
}

export interface ValidDiscoverByAttributesArgs extends ValidWalletSignerArgs {
  attributes: Record<CertificateFieldNameUnder50Bytes, string>
  limit: PositiveIntegerDefault10Max10000
  offset: PositiveIntegerOrZero
  seekPermission: boolean
}

function validateAttributes(
  attributes: Record<CertificateFieldNameUnder50Bytes, string>
): Record<CertificateFieldNameUnder50Bytes, string> {
  const values = validateRecord(attributes, 'attributes')
  const fieldNames = Object.keys(values)
  if (fieldNames.length < 1 || fieldNames.length > MAXIMUM_DISCOVERY_ATTRIBUTES) {
    invalid('attributes', `an object containing 1-${MAXIMUM_DISCOVERY_ATTRIBUTES} fields`)
  }
  for (const fieldName of fieldNames) {
    validateStringLength(fieldName, `field name ${fieldName}`, 1, 50)
    validateStringLength(values[fieldName] as string, `attributes.${fieldName}`, 1, 500)
  }
  return attributes
}

/**
 * Validate DiscoverByAttributesArgs: attributes, limit, offset, and permission flag.
 *
 * @param args - DiscoverByAttributesArgs
 * @returns ValidDiscoverByAttributesArgs
 */
export function validateDiscoverByAttributesArgs(
  args: DiscoverByAttributesArgs
): ValidDiscoverByAttributesArgs {
  validateRecord(args, 'args')
  const vargs: ValidDiscoverByAttributesArgs = {
    attributes: validateAttributes(args.attributes),
    limit: validateInteger(args.limit, 'limit', 10, 1, 10000),
    offset: validateInteger(args.offset, 'offset', 0, 0),
    seekPermission: defaultTrue(args.seekPermission, 'seekPermission')
  }
  return vargs
}

export interface ValidListOutputsArgs extends ValidWalletSignerArgs {
  basket: BasketStringUnder300Bytes
  tags: OutputTagStringUnder300Bytes[]
  tagQueryMode: 'all' | 'any'
  includeLockingScripts: boolean
  includeTransactions: boolean
  includeCustomInstructions: BooleanDefaultFalse
  includeTags: BooleanDefaultFalse
  includeLabels: BooleanDefaultFalse
  limit: PositiveIntegerDefault10Max10000
  offset: number
  seekPermission: BooleanDefaultTrue
  knownTxids: string[]
}

/**
 * @param {BasketStringUnder300Bytes} args.basket - Required. The associated basket name whose outputs should be listed.
 * @param {OutputTagStringUnder300Bytes[]} [args.tags] - Optional. Filter outputs based on these tags.
 * @param {'all' | 'any'} [args.tagQueryMode] - Optional. Filter mode, defining whether all or any of the tags must match. By default, any tag can match.
 * @param {'locking scripts' | 'entire transactions'} [args.include] - Optional. Whether to include locking scripts (with each output) or entire transactions (as aggregated BEEF, at the top level) in the result. By default, unless specified, neither are returned.
 * @param {BooleanDefaultFalse} [args.includeEntireTransactions] - Optional. Whether to include the entire transaction(s) in the result.
 * @param {BooleanDefaultFalse} [args.includeCustomInstructions] - Optional. Whether custom instructions should be returned in the result.
 * @param {BooleanDefaultFalse} [args.includeTags] - Optional. Whether the tags associated with the output should be returned.
 * @param {BooleanDefaultFalse} [args.includeLabels] - Optional. Whether the labels associated with the transaction containing the output should be returned.
 * @param {PositiveIntegerDefault10Max10000} [args.limit] - Optional limit on the number of outputs to return.
 * @param {number} [args.offset] - If positive or zero: Number of outputs to skip before starting to return results, oldest first.
 * If negative: Outputs are returned newest first and offset of -1 is the newest output.
 * When using negative offsets, caution is required as new outputs may be added between calls,
 * potentially causing outputs to be duplicated across calls.
 * @param {BooleanDefaultTrue} [args.seekPermission] — Optional. Whether to seek permission from the user for this operation if required. Default true, will return an error rather than proceed if set to false.
 */
export function validateListOutputsArgs(args: ListOutputsArgs): ValidListOutputsArgs {
  validateRecord(args, 'args')
  let tagQueryMode: 'any' | 'all'
  if (args.tagQueryMode === undefined || args.tagQueryMode === 'any') tagQueryMode = 'any'
  else if (args.tagQueryMode === 'all') tagQueryMode = 'all'
  else throw new WERR_INVALID_PARAMETER('tagQueryMode', "undefined, 'any', or 'all'")

  if (
    args.include !== undefined &&
    args.include !== 'locking scripts' &&
    args.include !== 'entire transactions'
  ) {
    invalid('include', "undefined, 'locking scripts', or 'entire transactions'")
  }

  const vargs: ValidListOutputsArgs = {
    basket: validateBasket(args.basket),
    tags: validateArray(args.tags, 'tags').map(t => validateTag(t)),
    tagQueryMode,
    includeLockingScripts: args.include === 'locking scripts',
    includeTransactions: args.include === 'entire transactions',
    includeCustomInstructions: defaultFalse(
      args.includeCustomInstructions,
      'includeCustomInstructions'
    ),
    includeTags: defaultFalse(args.includeTags, 'includeTags'),
    includeLabels: defaultFalse(args.includeLabels, 'includeLabels'),
    limit: validateInteger(args.limit, 'limit', 10, 1, 10000),
    offset: validateInteger(args.offset, 'offset', 0),
    seekPermission: defaultTrue(args.seekPermission, 'seekPermission'),
    knownTxids: []
  }

  return vargs
}

export interface ValidListActionsArgs extends ValidWalletSignerArgs {
  labels: LabelStringUnder300Bytes[]
  labelQueryMode: 'any' | 'all'
  includeLabels: BooleanDefaultFalse
  includeInputs: BooleanDefaultFalse
  includeInputSourceLockingScripts: BooleanDefaultFalse
  includeInputUnlockingScripts: BooleanDefaultFalse
  includeOutputs: BooleanDefaultFalse
  includeOutputLockingScripts: BooleanDefaultFalse
  limit: PositiveIntegerDefault10Max10000
  offset: PositiveIntegerOrZero
  seekPermission: BooleanDefaultTrue
}

/**
 * @param {LabelStringUnder300Bytes[]} args.labels - An array of labels used to filter actions.
 * @param {'any' | 'all'} [args.labelQueryMode] - Optional. Specifies how to match labels (default is any which matches any of the labels).
 * @param {BooleanDefaultFalse} [args.includeLabels] - Optional. Whether to include transaction labels in the result set.
 * @param {BooleanDefaultFalse} [args.includeInputs] - Optional. Whether to include input details in the result set.
 * @param {BooleanDefaultFalse} [args.includeInputSourceLockingScripts] - Optional. Whether to include input source locking scripts in the result set.
 * @param {BooleanDefaultFalse} [args.includeInputUnlockingScripts] - Optional. Whether to include input unlocking scripts in the result set.
 * @param {BooleanDefaultFalse} [args.includeOutputs] - Optional. Whether to include output details in the result set.
 * @param {BooleanDefaultFalse} [args.includeOutputLockingScripts] - Optional. Whether to include output locking scripts in the result set.
 * @param {PositiveIntegerDefault10Max10000} [args.limit] - Optional. The maximum number of transactions to retrieve.
 * @param {PositiveIntegerOrZero} [args.offset] - Optional. Number of transactions to skip before starting to return the results.
 * @param {BooleanDefaultTrue} [args.seekPermission] — Optional. Whether to seek permission from the user for this operation if required. Default true, will return an error rather than proceed if set to false.
 */
export function validateListActionsArgs(args: ListActionsArgs): ValidListActionsArgs {
  validateRecord(args, 'args')
  let labelQueryMode: 'any' | 'all'
  if (args.labelQueryMode === undefined || args.labelQueryMode === 'any') labelQueryMode = 'any'
  else if (args.labelQueryMode === 'all') labelQueryMode = 'all'
  else throw new WERR_INVALID_PARAMETER('labelQueryMode', "undefined, 'any', or 'all'")

  const vargs: ValidListActionsArgs = {
    labels: validateArray(args.labels, 'labels').map(t => validateLabel(t)),
    labelQueryMode,
    includeLabels: defaultFalse(args.includeLabels, 'includeLabels'),
    includeInputs: defaultFalse(args.includeInputs, 'includeInputs'),
    includeInputSourceLockingScripts: defaultFalse(
      args.includeInputSourceLockingScripts,
      'includeInputSourceLockingScripts'
    ),
    includeInputUnlockingScripts: defaultFalse(
      args.includeInputUnlockingScripts,
      'includeInputUnlockingScripts'
    ),
    includeOutputs: defaultFalse(args.includeOutputs, 'includeOutputs'),
    includeOutputLockingScripts: defaultFalse(
      args.includeOutputLockingScripts,
      'includeOutputLockingScripts'
    ),
    limit: validateInteger(args.limit, 'limit', 10, 1, 10000),
    offset: validateInteger(args.offset, 'offset', 0, 0),
    seekPermission: defaultTrue(args.seekPermission, 'seekPermission')
  }

  return vargs
}

/** Validate arguments shared by key-derivation and symmetric-crypto calls. */
export function validateGetPublicKeyArgs(args: GetPublicKeyArgs): void {
  const value = validateRecord(args, 'args')
  if (value.identityKey !== undefined && value.identityKey !== true) {
    invalid('identityKey', 'true or undefined')
  }
  if (value.forSelf !== undefined) validateBoolean(value.forSelf, 'forSelf', false)

  if (value.identityKey === true) {
    if (value.protocolID !== undefined) validateProtocol(value.protocolID)
    if (value.keyID !== undefined) validateStringLength(value.keyID as string, 'keyID', 1, 800)
    if (value.counterparty !== undefined) validateCounterparty(value.counterparty, 'counterparty')
    validatePrivilege(value)
    return
  }
  validateEncryptionArgs(args, 'args')
}

export function validateRevealCounterpartyKeyLinkageArgs(
  args: RevealCounterpartyKeyLinkageArgs
): void {
  const value = validateRecord(args, 'args')
  validatePublicKey(value.counterparty, 'counterparty')
  validatePublicKey(value.verifier, 'verifier')
  validatePrivilege(value, false)
}

export function validateRevealSpecificKeyLinkageArgs(args: RevealSpecificKeyLinkageArgs): void {
  const value = validateRecord(args, 'args')
  validateCounterparty(value.counterparty, 'counterparty')
  validatePublicKey(value.verifier, 'verifier')
  validateProtocol(value.protocolID)
  validateStringLength(value.keyID as string, 'keyID', 1, 800)
  validatePrivilege(value, false)
}

export function validateWalletEncryptArgs(args: WalletEncryptArgs): void {
  const value = validateRecord(args, 'args')
  validateEncryptionArgs(args)
  validateByteArray(value.plaintext, 'plaintext')
}

export function validateWalletDecryptArgs(args: WalletDecryptArgs): void {
  const value = validateRecord(args, 'args')
  validateEncryptionArgs(args)
  validateByteArray(value.ciphertext, 'ciphertext')
}

export function validateCreateHmacArgs(args: CreateHmacArgs): void {
  const value = validateRecord(args, 'args')
  validateEncryptionArgs(args)
  validateByteArray(value.data, 'data')
}

export function validateVerifyHmacArgs(args: VerifyHmacArgs): void {
  const value = validateRecord(args, 'args')
  validateEncryptionArgs(args)
  validateByteArray(value.data, 'data')
  validateByteArray(value.hmac, 'hmac', 32)
}

function validateExclusiveDataAndHash(
  value: UnknownRecord,
  dataField: 'data',
  hashField: 'hashToDirectlySign' | 'hashToDirectlyVerify'
): void {
  const hasData = value[dataField] !== undefined
  const hasHash = value[hashField] !== undefined
  if (hasData === hasHash) invalid(`${dataField}, ${hashField}`, 'exactly one value')
  if (hasData) validateByteArray(value[dataField], dataField)
  if (hasHash) validateByteArray(value[hashField], hashField, 32)
}

export function validateCreateSignatureArgs(args: CreateSignatureArgs): void {
  const value = validateRecord(args, 'args')
  validateEncryptionArgs(args)
  validateExclusiveDataAndHash(value, 'data', 'hashToDirectlySign')
}

export function validateVerifySignatureArgs(args: VerifySignatureArgs): void {
  const value = validateRecord(args, 'args')
  validateEncryptionArgs(args)
  validateExclusiveDataAndHash(value, 'data', 'hashToDirectlyVerify')
  const signature = validateByteArray(value.signature, 'signature', undefined, 72)
  if (!isCanonicalDERSignature(signature)) {
    invalid('signature', 'a canonical DER-encoded ECDSA signature')
  }
  if (value.forSelf !== undefined) validateBoolean(value.forSelf, 'forSelf', false)
}

export function validateGetHeaderArgs(args: GetHeaderArgs): void {
  const value = validateRecord(args, 'args')
  validateInteger(value.height as number, 'height', undefined, 1, MAX_UINT32)
}

export function validateNoArgs(args: object, name = 'args'): void {
  validateRecord(args, name)
}

/**
 * Identifies a unique transaction output by its `txid` and index `vout`
 */
export interface OutPoint {
  /**
   * Transaction double sha256 hash as big endian hex string
   */
  txid: string
  /**
   * zero based output index within the transaction
   */
  vout: number
}

/**
 * `createAction` special operation label name value.
 *
 * Causes WERR_REVIEW_ACTIONS throw with dummy properties.
 *
 */
export const specOpThrowReviewActions =
  'a496e747fc3ad5fabdd4ae8f91184e71f87539bd3d962aa2548942faaaf0047a'
