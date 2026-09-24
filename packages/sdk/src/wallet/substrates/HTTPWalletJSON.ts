import {
  WalletInterface,
  CreateActionArgs,
  OriginatorDomainNameStringUnder250Bytes,
  CreateActionResult,
  BooleanDefaultTrue,
  AcquireCertificateArgs,
  AcquireCertificateResult,
  Base64String,
  BasketStringUnder300Bytes,
  BooleanDefaultFalse,
  Byte,
  CertificateFieldNameUnder50Bytes,
  DescriptionString5to50Bytes,
  DiscoverCertificatesResult,
  HexString,
  InternalizeActionArgs,
  ISOTimestampString,
  KeyIDStringUnder800Bytes,
  ListActionsArgs,
  ListActionsResult,
  ListCertificatesResult,
  ListOutputsArgs,
  ListOutputsResult,
  OutpointString,
  PositiveInteger,
  PositiveIntegerDefault10Max10000,
  PositiveIntegerOrZero,
  ProtocolString5To400Bytes,
  ProveCertificateArgs,
  ProveCertificateResult,
  PubKeyHex,
  SecurityLevel,
  SignActionArgs,
  SignActionResult,
  VersionString7To30Bytes
} from '../Wallet.interfaces.js'
import { WERR_REVIEW_ACTIONS } from '../WERR_REVIEW_ACTIONS.js'
import { WERR_INVALID_PARAMETER } from '../WERR_INVALID_PARAMETER.js'
import { normalizeWalletHttpBaseUrl, toOriginHeader } from './utils/toOriginHeader.js'
import {
  normalizeBRC100ByteArray,
  normalizeBRC100WalletByteFields,
  stringifyBRC100
} from '../BRC100ByteEncoding.js'
import WERR_INSUFFICIENT_FUNDS from '../WERR_INSUFFICIENT_FUNDS.js'
import { MAXIMUM_SEND_WITH_TRANSACTIONS, validateOriginator } from '../validationHelpers.js'
import { validateWalletArgs } from '../WalletArgumentValidation.js'
import {
  assertSafeWalletJSONValue,
  assertSafeWalletValue,
  snapshotWalletResultRequest,
  validateWalletResult
} from '../WalletResultValidation.js'
import { toArray, toUTF8Strict, toUint8Array } from '../../primitives/utils.js'
import { CallType } from './WalletWireCalls.js'
import Beef from '../../transaction/Beef.js'

const MAX_WALLET_JSON_RESPONSE_BYTES = 256 * 1024 * 1024
const MAX_WALLET_JSON_REQUEST_BYTES = 256 * 1024 * 1024

async function readBoundedJSON(response: Response): Promise<unknown> {
  const declaredLength = response.headers?.get('content-length')
  if (declaredLength != null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw new Error('HTTPWalletJSON response has an invalid Content-Length')
    }
    const length = Number(declaredLength)
    if (!Number.isSafeInteger(length) || length > MAX_WALLET_JSON_RESPONSE_BYTES) {
      throw new Error('HTTPWalletJSON response exceeds the maximum permitted size')
    }
  }

  let encoded: Uint8Array | undefined
  if (response.body != null && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let totalLength = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (value == null) continue
      totalLength += value.byteLength
      if (totalLength > MAX_WALLET_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('HTTPWalletJSON response exceeds the maximum permitted size')
      }
      chunks.push(value)
    }
    encoded = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
      encoded.set(chunk, offset)
      offset += chunk.byteLength
    }
  } else if (typeof response.arrayBuffer === 'function') {
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_WALLET_JSON_RESPONSE_BYTES) {
      throw new Error('HTTPWalletJSON response exceeds the maximum permitted size')
    }
    encoded = new Uint8Array(buffer)
  }

  if (encoded !== undefined) {
    return JSON.parse(toUTF8Strict(encoded))
  }
  // Retain compatibility with Response-like custom fetch adapters. Native
  // Response objects always take one of the bounded byte paths above.
  return await response.json()
}

function requireErrorString(value: unknown, name: string, min = 0, max = 4096): string {
  if (typeof value !== 'string') throw new Error(`Invalid wallet error ${name}`)
  const length = toArray(value, 'utf8').length
  if (length < min || length > max) throw new Error(`Invalid wallet error ${name}`)
  return value
}

function requireErrorSatoshis(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 21e14) {
    throw new Error(`Invalid wallet error ${name}`)
  }
  return value as number
}

function validateReviewActionResults(value: unknown, allowedTxids: Set<string>): void {
  if (!Array.isArray(value)) throw new Error('Invalid wallet error reviewActionResults')
  if (value.length > MAXIMUM_SEND_WITH_TRANSACTIONS + 1) {
    throw new Error('Invalid wallet error reviewActionResults')
  }
  const statuses = new Set(['success', 'doubleSpend', 'serviceError', 'invalidTx'])
  const reviewedTxids = new Set<string>()
  for (const [index, item] of value.entries()) {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Invalid wallet error reviewActionResults[${index}]`)
    }
    const result = item as Record<string, unknown>
    if (typeof result.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(result.txid)) {
      throw new Error(`Invalid wallet error reviewActionResults[${index}].txid`)
    }
    const reviewedTxid = result.txid.toLowerCase()
    if (reviewedTxids.has(reviewedTxid) || !allowedTxids.has(reviewedTxid)) {
      throw new Error(`Invalid wallet error reviewActionResults[${index}].txid`)
    }
    reviewedTxids.add(reviewedTxid)
    if (!statuses.has(result.status as string)) {
      throw new Error(`Invalid wallet error reviewActionResults[${index}].status`)
    }
    if (
      result.status !== 'doubleSpend' &&
      (result.competingTxs !== undefined || result.competingBeef !== undefined)
    ) {
      throw new Error(`Invalid wallet error reviewActionResults[${index}].competingTxs`)
    }
    let competingTxs: string[] | undefined
    if (result.competingTxs !== undefined) {
      if (
        !Array.isArray(result.competingTxs) ||
        result.competingTxs.length > MAXIMUM_SEND_WITH_TRANSACTIONS
      ) {
        throw new Error(`Invalid wallet error reviewActionResults[${index}].competingTxs`)
      }
      competingTxs = []
      const unique = new Set<string>()
      for (const [competingIndex, competing] of result.competingTxs.entries()) {
        if (typeof competing !== 'string' || !/^[0-9a-fA-F]{64}$/.test(competing)) {
          throw new Error(
            `Invalid wallet error reviewActionResults[${index}].competingTxs[${competingIndex}]`
          )
        }
        const normalized = competing.toLowerCase()
        if (normalized === reviewedTxid || unique.has(normalized)) {
          throw new Error(`Invalid wallet error reviewActionResults[${index}].competingTxs`)
        }
        unique.add(normalized)
        competingTxs.push(normalized)
      }
    }
    if (result.competingBeef !== undefined) {
      if (competingTxs == null || competingTxs.length === 0) {
        throw new Error(`Invalid wallet error reviewActionResults[${index}].competingBeef`)
      }
      const competingBeef = normalizeBRC100ByteArray(result.competingBeef)
      if (competingBeef == null) {
        throw new Error(`Invalid wallet error reviewActionResults[${index}].competingBeef`)
      }
      try {
        const parsed = Beef.fromBinaryStrict(competingBeef)
        for (const competingTxid of competingTxs) {
          if (parsed.findTxid(competingTxid) == null) throw new Error()
        }
      } catch {
        throw new Error(`Invalid wallet error reviewActionResults[${index}].competingBeef`)
      }
    }
  }
}

function deserializeWalletError(
  data: Record<string, unknown>,
  call: CallType,
  args: object
): Error | undefined {
  if (data.isError !== true || !Number.isSafeInteger(data.code)) {
    throw new Error('Invalid wallet error envelope')
  }
  if (data.message !== undefined) requireErrorString(data.message, 'message')
  switch (data.code) {
    case 5: {
      if (call !== 'createAction' && call !== 'signAction') {
        throw new Error(`Invalid ${call} wallet error code`)
      }
      if (!Array.isArray(data.sendWithResults)) {
        throw new Error('Invalid wallet error sendWithResults')
      }
      // A review error is not a successful completed-action result. It may
      // identify the rejected transaction without returning its full envelope,
      // while any envelope it does carry must still be parsed and bound.
      const reviewRequest = {
        ...args,
        options: {
          ...(args as { options?: object }).options,
          returnTXIDOnly: true
        }
      }
      validateWalletResult(
        call,
        {
          txid: data.txid,
          tx: data.tx,
          noSendChange: data.noSendChange,
          sendWithResults: data.sendWithResults
        },
        reviewRequest
      )
      const allowedTxids = new Set<string>()
      if (typeof data.txid === 'string') allowedTxids.add(data.txid.toLowerCase())
      const requestOptions = (args as { options?: { sendWith?: unknown } }).options
      if (Array.isArray(requestOptions?.sendWith)) {
        for (const txid of requestOptions.sendWith) allowedTxids.add(String(txid).toLowerCase())
      }
      validateReviewActionResults(data.reviewActionResults, allowedTxids)
      return new WERR_REVIEW_ACTIONS(
        data.reviewActionResults as never,
        data.sendWithResults as never,
        data.txid as never,
        data.tx as never,
        data.noSendChange as never
      )
    }
    case 6: {
      const parameter = requireErrorString(data.parameter, 'parameter', 1, 200)
      const message = requireErrorString(data.message, 'message')
      const error = new WERR_INVALID_PARAMETER(parameter)
      error.message = message
      return error
    }
    case 7: {
      const total = requireErrorSatoshis(data.totalSatoshisNeeded, 'totalSatoshisNeeded')
      const more = requireErrorSatoshis(data.moreSatoshisNeeded, 'moreSatoshisNeeded')
      if (more > total) throw new Error('Invalid wallet error moreSatoshisNeeded')
      return new WERR_INSUFFICIENT_FUNDS(total, more)
    }
    default:
      return undefined
  }
}

export default class HTTPWalletJSON implements WalletInterface {
  baseUrl: string
  httpClient: typeof fetch
  originator: OriginatorDomainNameStringUnder250Bytes | undefined
  api: (call: CallType, args: object) => Promise<unknown> // Fixed `any` types

  constructor(
    originator: OriginatorDomainNameStringUnder250Bytes | undefined,
    baseUrl: string = 'http://localhost:3321',
    httpClient = globalThis.fetch.bind(globalThis)
  ) {
    this.baseUrl = normalizeWalletHttpBaseUrl(baseUrl)
    this.originator = validateOriginator(originator)
    this.httpClient = httpClient

    // Detect if we're in a browser environment
    const isBrowser =
      typeof window !== 'undefined' &&
      typeof document !== 'undefined' &&
      window.origin !== 'file://'

    this.api = async (call: CallType, args: object) => {
      validateWalletArgs(call, args)
      const bindingRequest = snapshotWalletResultRequest(call, args) as object
      const baseUrl = normalizeWalletHttpBaseUrl(this.baseUrl)
      // In browser environments, let the browser handle Origin header automatically
      // In Node.js environments, we need to set it manually if originator is provided
      if (!isBrowser && !this.originator) {
        throw new Error(
          'HTTPWalletJSON: originator is required when using the HTTP substrate in Node.js. ' +
            'Pass an originator (e.g. "example.com") to the constructor.'
        )
      }
      const origin = isBrowser ? undefined : toOriginHeader(this.originator!, 'http')
      const requestBody = stringifyBRC100(args)
      if (toUint8Array(requestBody, 'utf8').length > MAX_WALLET_JSON_REQUEST_BYTES) {
        throw new Error('HTTPWalletJSON request exceeds the maximum permitted size')
      }

      const res = await this.httpClient(`${baseUrl}/${call}`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          ...(origin ? { Origin: origin, Originator: origin } : {})
        },
        body: requestBody
      })

      const rawData = assertSafeWalletJSONValue(
        await readBoundedJSON(res),
        `HTTPWalletJSON ${call} raw response`
      )
      // Response-like compatibility adapters can return arbitrary JavaScript
      // values rather than native JSON.parse output. Reject accessors, exotic
      // prototypes, and oversized graphs before normalization enumerates them.
      const data = assertSafeWalletValue(
        normalizeBRC100WalletByteFields(rawData) as Record<string, unknown>,
        `HTTPWalletJSON ${call} response`
      )
      if (data == null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`Invalid HTTPWalletJSON ${call} response: expected an object`)
      }

      // Check the HTTP status on the original response
      if (!res.ok) {
        if (res.status === 400 && Object.prototype.hasOwnProperty.call(data, 'isError')) {
          const walletError = deserializeWalletError(data, call, bindingRequest)
          if (walletError !== undefined) throw walletError
        }
        throw new Error(`HTTPWalletJSON ${call} failed with HTTP status ${res.status}`)
      }
      return validateWalletResult(call, data, bindingRequest)
    }
  }

  async createAction(args: CreateActionArgs): Promise<CreateActionResult> {
    return (await this.api('createAction', args)) as CreateActionResult
  }

  async signAction(args: SignActionArgs): Promise<SignActionResult> {
    return (await this.api('signAction', args)) as SignActionResult
  }

  async abortAction(args: { reference: Base64String }): Promise<{ aborted: true }> {
    return (await this.api('abortAction', args)) as { aborted: true }
  }

  async listActions(args: ListActionsArgs): Promise<ListActionsResult> {
    return (await this.api('listActions', args)) as ListActionsResult
  }

  async internalizeAction(args: InternalizeActionArgs): Promise<{ accepted: true }> {
    return (await this.api('internalizeAction', args)) as { accepted: true }
  }

  async listOutputs(args: ListOutputsArgs): Promise<ListOutputsResult> {
    return (await this.api('listOutputs', args)) as ListOutputsResult
  }

  async relinquishOutput(args: {
    basket: BasketStringUnder300Bytes
    output: OutpointString
  }): Promise<{ relinquished: true }> {
    return (await this.api('relinquishOutput', args)) as { relinquished: true }
  }

  async getPublicKey(args: {
    seekPermission?: BooleanDefaultTrue
    identityKey?: true
    protocolID?: [SecurityLevel, ProtocolString5To400Bytes]
    keyID?: KeyIDStringUnder800Bytes
    privileged?: BooleanDefaultFalse
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    forSelf?: BooleanDefaultFalse
  }): Promise<{ publicKey: PubKeyHex }> {
    return (await this.api('getPublicKey', args)) as { publicKey: PubKeyHex }
  }

  async revealCounterpartyKeyLinkage(args: {
    counterparty: PubKeyHex
    verifier: PubKeyHex
    privilegedReason?: DescriptionString5to50Bytes
    privileged?: BooleanDefaultFalse
  }): Promise<{
    prover: PubKeyHex
    verifier: PubKeyHex
    counterparty: PubKeyHex
    revelationTime: ISOTimestampString
    encryptedLinkage: Byte[]
    encryptedLinkageProof: number[]
  }> {
    return (await this.api('revealCounterpartyKeyLinkage', args)) as {
      prover: PubKeyHex
      verifier: PubKeyHex
      counterparty: PubKeyHex
      revelationTime: ISOTimestampString
      encryptedLinkage: Byte[]
      encryptedLinkageProof: number[]
    }
  }

  async revealSpecificKeyLinkage(args: {
    counterparty: PubKeyHex
    verifier: PubKeyHex
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    privileged?: BooleanDefaultFalse
  }): Promise<{
    prover: PubKeyHex
    verifier: PubKeyHex
    counterparty: PubKeyHex
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    encryptedLinkage: Byte[]
    encryptedLinkageProof: Byte[]
    proofType: Byte
  }> {
    return (await this.api('revealSpecificKeyLinkage', args)) as {
      prover: PubKeyHex
      verifier: PubKeyHex
      counterparty: PubKeyHex
      protocolID: [SecurityLevel, ProtocolString5To400Bytes]
      keyID: KeyIDStringUnder800Bytes
      encryptedLinkage: Byte[]
      encryptedLinkageProof: Byte[]
      proofType: Byte
    }
  }

  async encrypt(args: {
    seekPermission?: BooleanDefaultTrue
    plaintext: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ ciphertext: Byte[] }> {
    return (await this.api('encrypt', args)) as { ciphertext: Byte[] }
  }

  async decrypt(args: {
    seekPermission?: BooleanDefaultTrue
    ciphertext: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ plaintext: Byte[] }> {
    return (await this.api('decrypt', args)) as { plaintext: Byte[] }
  }

  async createHmac(args: {
    seekPermission?: BooleanDefaultTrue
    data: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ hmac: Byte[] }> {
    return (await this.api('createHmac', args)) as { hmac: Byte[] }
  }

  async verifyHmac(args: {
    seekPermission?: BooleanDefaultTrue
    data: Byte[]
    hmac: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ valid: true }> {
    return (await this.api('verifyHmac', args)) as { valid: true }
  }

  async createSignature(args: {
    seekPermission?: BooleanDefaultTrue
    data?: Byte[]
    hashToDirectlySign?: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    privileged?: BooleanDefaultFalse
  }): Promise<{ signature: Byte[] }> {
    return (await this.api('createSignature', args)) as { signature: Byte[] }
  }

  async verifySignature(args: {
    seekPermission?: BooleanDefaultTrue
    data?: Byte[]
    hashToDirectlyVerify?: Byte[]
    signature: Byte[]
    protocolID: [SecurityLevel, ProtocolString5To400Bytes]
    keyID: KeyIDStringUnder800Bytes
    privilegedReason?: DescriptionString5to50Bytes
    counterparty?: PubKeyHex
    forSelf?: BooleanDefaultFalse
    privileged?: BooleanDefaultFalse
  }): Promise<{ valid: true }> {
    return (await this.api('verifySignature', args)) as { valid: true }
  }

  async acquireCertificate(args: AcquireCertificateArgs): Promise<AcquireCertificateResult> {
    return (await this.api('acquireCertificate', args)) as AcquireCertificateResult
  }

  async listCertificates(args: {
    certifiers: PubKeyHex[]
    types: Base64String[]
    limit?: PositiveIntegerDefault10Max10000
    offset?: PositiveIntegerOrZero
    privileged?: BooleanDefaultFalse
    privilegedReason?: DescriptionString5to50Bytes
  }): Promise<ListCertificatesResult> {
    return (await this.api('listCertificates', args)) as ListCertificatesResult
  }

  async proveCertificate(args: ProveCertificateArgs): Promise<ProveCertificateResult> {
    return (await this.api('proveCertificate', args)) as ProveCertificateResult
  }

  async relinquishCertificate(args: {
    type: Base64String
    serialNumber: Base64String
    certifier: PubKeyHex
  }): Promise<{ relinquished: true }> {
    return (await this.api('relinquishCertificate', args)) as { relinquished: true }
  }

  async discoverByIdentityKey(args: {
    seekPermission?: BooleanDefaultTrue
    identityKey: PubKeyHex
    limit?: PositiveIntegerDefault10Max10000
    offset?: PositiveIntegerOrZero
  }): Promise<DiscoverCertificatesResult> {
    return (await this.api('discoverByIdentityKey', args)) as DiscoverCertificatesResult
  }

  async discoverByAttributes(args: {
    seekPermission?: BooleanDefaultTrue
    attributes: Record<CertificateFieldNameUnder50Bytes, string>
    limit?: PositiveIntegerDefault10Max10000
    offset?: PositiveIntegerOrZero
  }): Promise<DiscoverCertificatesResult> {
    return (await this.api('discoverByAttributes', args)) as DiscoverCertificatesResult
  }

  async isAuthenticated(args: object): Promise<{ authenticated: true }> {
    return (await this.api('isAuthenticated', args)) as { authenticated: true }
  }

  async waitForAuthentication(args: object): Promise<{ authenticated: true }> {
    return (await this.api('waitForAuthentication', args)) as { authenticated: true }
  }

  async getHeight(args: object): Promise<{ height: PositiveInteger }> {
    return (await this.api('getHeight', args)) as { height: PositiveInteger }
  }

  async getHeaderForHeight(args: { height: PositiveInteger }): Promise<{ header: HexString }> {
    return (await this.api('getHeaderForHeight', args)) as { header: HexString }
  }

  async getNetwork(args: object): Promise<{ network: 'mainnet' | 'testnet' }> {
    return (await this.api('getNetwork', args)) as { network: 'mainnet' | 'testnet' }
  }

  async getVersion(args: object): Promise<{ version: VersionString7To30Bytes }> {
    return (await this.api('getVersion', args)) as { version: VersionString7To30Bytes }
  }
}
