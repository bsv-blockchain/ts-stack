import { PublicKey, Random } from '@bsv/sdk/primitives'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import {
  decodeCanonicalDIDToken,
  DID_TOKEN_PROTOCOL,
  normalizeDIDSerialNumber
} from '@bsv/sdk/identity/DIDTokenValidation'
import {
  LookupResolver,
  TopicBroadcaster,
  type LookupAnswer,
  type LookupNetworkPreset
} from '@bsv/sdk/overlay-tools'
import { PushDrop } from '@bsv/sdk/script/templates'
import type { BroadcastFailure, BroadcastResponse } from '@bsv/sdk/transaction/Broadcaster'
import { Transaction } from '@bsv/sdk/transaction'
import { WalletClient } from '@bsv/sdk/wallet'
import type {
  Base64String,
  ListOutputsResult,
  PubKeyHex,
  WalletInterface,
  WalletOutput
} from '@bsv/sdk/wallet/Wallet.interfaces'
import { completeBoundAction } from '@bsv/sdk/wallet/completeBoundAction'
import { validateBase64String } from '@bsv/sdk/wallet/validationHelpers'
import type { DIDRecord, DIDQuery } from './types/index.js'

const DEFAULT_OVERLAY_TOPIC = 'tm_did'
const DEFAULT_LOOKUP_SERVICE = 'ls_did'
const MAX_DID_BEEF_BYTES = 16 * 1024 * 1024
const MAX_DID_LOOKUP_RESULTS = 100
const MAX_DID_WALLET_SCAN = 10_000

export interface DIDClientOptions {
  overlayTopic?: string
  overlayService?: string
  wallet?: WalletInterface
  networkPreset?: LookupNetworkPreset
  acceptDelayedBroadcast?: boolean
}

interface ParsedOutpoint {
  txid: string
  outputIndex: number
  canonical: string
}

interface VerifiedWalletDID {
  output: WalletOutput
  sourceTransaction: Transaction
  sourceOutputIndex: number
  serialNumber: Base64String
  subject: PubKeyHex
  keyID: string
}

function canonicalOutpoint(value: unknown): ParsedOutpoint {
  if (typeof value !== 'string') throw new Error('DID outpoint must be canonical')
  const match = /^([0-9a-f]{64})\.(0|[1-9]\d*)$/i.exec(value)
  if (match == null) throw new Error('DID outpoint must be canonical')
  const outputIndex = Number(match[2])
  if (!Number.isSafeInteger(outputIndex) || outputIndex > 0xffffffff) {
    throw new Error('DID outpoint must be canonical')
  }
  const txid = match[1].toLowerCase()
  return { txid, outputIndex, canonical: `${txid}.${outputIndex}` }
}

function boundedBEEF(value: unknown): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_DID_BEEF_BYTES) {
    throw new Error('DID BEEF must be a bounded byte array')
  }
  for (let index = 0; index < value.length; index++) {
    if (
      !Object.prototype.hasOwnProperty.call(value, index) ||
      !Number.isInteger(value[index]) ||
      value[index] < 0 ||
      value[index] > 255
    ) {
      throw new Error('DID BEEF must be a bounded byte array')
    }
  }
  return value as number[]
}

function exactlyOneTag(tags: unknown, prefix: string): string {
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > 64) {
    throw new Error('DID wallet tags are missing or malformed')
  }
  const matches: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < tags.length; index++) {
    const tag = tags[index]
    if (
      !Object.prototype.hasOwnProperty.call(tags, index) ||
      typeof tag !== 'string' ||
      new TextEncoder().encode(tag).length > 300 ||
      seen.has(tag)
    ) {
      throw new Error('DID wallet tags are missing or malformed')
    }
    seen.add(tag)
    if (tag.startsWith(prefix)) matches.push(tag.slice(prefix.length))
  }
  if (matches.length !== 1 || matches[0].length === 0) {
    throw new Error('DID wallet tags are ambiguous')
  }
  return matches[0]
}

function parseDerivationInstructions(value: unknown): {
  derivationPrefix: Base64String
  derivationSuffix: Base64String
  keyID: string
} {
  if (typeof value !== 'string' || value.length < 2 || value.length > 2048) {
    throw new Error('DID token derivation parameters are missing')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('DID token derivation parameters are malformed')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DID token derivation parameters are malformed')
  }
  const keys = Reflect.ownKeys(parsed)
  if (
    keys.length !== 2 ||
    !keys.includes('derivationPrefix') ||
    !keys.includes('derivationSuffix') ||
    keys.some(key => typeof key !== 'string')
  ) {
    throw new Error('DID token derivation parameters are malformed')
  }
  const record = parsed as Record<string, unknown>
  const derivationPrefix = validateBase64String(
    record.derivationPrefix as string,
    'derivationPrefix',
    1,
    256
  ) as Base64String
  const derivationSuffix = validateBase64String(
    record.derivationSuffix as string,
    'derivationSuffix',
    1,
    256
  ) as Base64String
  if (
    derivationPrefix !== record.derivationPrefix ||
    derivationSuffix !== record.derivationSuffix
  ) {
    throw new Error('DID token derivation parameters must be canonical Base64')
  }
  return {
    derivationPrefix,
    derivationSuffix,
    keyID: `${derivationPrefix} ${derivationSuffix}`
  }
}

function validateSubject(value: unknown): PubKeyHex {
  if (typeof value !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/i.test(value)) {
    throw new Error('DID subject must be a compressed public key')
  }
  PublicKey.fromString(value)
  return value.toLowerCase() as PubKeyHex
}

function validateDate(value: unknown, field: string, endOfDay: boolean): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError(`${field} must be an ISO calendar date`)
  }
  const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'
  const parsed = new Date(`${value}${suffix}`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`${field} must be an ISO calendar date`)
  }
  return parsed.toISOString()
}

function validateWalletResult(result: ListOutputsResult): void {
  if (
    result == null ||
    !Array.isArray(result.outputs) ||
    result.outputs.length > MAX_DID_WALLET_SCAN ||
    !Number.isSafeInteger(result.totalOutputs) ||
    result.totalOutputs < result.outputs.length
  ) {
    throw new Error('Wallet returned a malformed DID output list')
  }
}

async function verifyWalletDID(
  wallet: WalletInterface,
  listed: WalletOutput,
  beef: number[],
  requestedSerial?: Base64String,
  requestedOutpoint?: string
): Promise<VerifiedWalletDID> {
  const outpoint = canonicalOutpoint(listed.outpoint)
  if (listed.outpoint.toLowerCase() !== outpoint.canonical) {
    throw new Error('Wallet returned a non-canonical DID outpoint')
  }
  if (requestedOutpoint !== undefined && outpoint.canonical !== requestedOutpoint) {
    throw new Error('Wallet returned a different DID outpoint')
  }
  if (listed.spendable !== true) throw new Error('Wallet returned an unspendable DID output')

  const sourceTransaction = Transaction.fromBEEF(beef, outpoint.txid)
  if (sourceTransaction.id('hex').toLowerCase() !== outpoint.txid) {
    throw new Error('DID BEEF does not contain the requested transaction')
  }
  const sourceOutput = sourceTransaction.outputs[outpoint.outputIndex]
  if (sourceOutput == null || sourceOutput.satoshis !== listed.satoshis) {
    throw new Error('DID wallet metadata does not match its source transaction')
  }
  if (
    listed.lockingScript !== undefined &&
    listed.lockingScript.toLowerCase() !== sourceOutput.lockingScript.toHex().toLowerCase()
  ) {
    throw new Error('DID wallet locking script does not match its source transaction')
  }

  const token = decodeCanonicalDIDToken(sourceOutput.lockingScript)
  if (requestedSerial !== undefined && token.serialNumber !== requestedSerial) {
    throw new Error('DID token serial number does not match the request')
  }
  const taggedSerial = normalizeDIDSerialNumber(
    exactlyOneTag(listed.tags, 'did-token-serialNumber-')
  )
  if (taggedSerial !== token.serialNumber) {
    throw new Error('DID wallet serial tag does not match the token')
  }
  const subject = validateSubject(exactlyOneTag(listed.tags, 'did-token-subject-'))
  const { keyID } = parseDerivationInstructions(listed.customInstructions)
  const expectedLockingKey = await wallet.getPublicKey({
    protocolID: DID_TOKEN_PROTOCOL,
    keyID,
    counterparty: subject,
    forSelf: true
  })
  if (
    expectedLockingKey.publicKey.toLowerCase() !== token.lockingPublicKey.toString().toLowerCase()
  ) {
    throw new Error('DID token locking key is not owned by this wallet')
  }
  const verified = await wallet.verifySignature({
    data: token.serialBytes,
    signature: token.signature,
    protocolID: DID_TOKEN_PROTOCOL,
    keyID,
    counterparty: subject,
    forSelf: true
  })
  if (verified.valid !== true) throw new Error('DID token field signature is invalid')
  return {
    output: listed,
    sourceTransaction,
    sourceOutputIndex: outpoint.outputIndex,
    serialNumber: token.serialNumber,
    subject,
    keyID
  }
}

/** Client for the legacy DID token overlay. See the package trust-model documentation. */
export class DIDClient {
  private readonly overlayTopic: string
  private readonly overlayService: string
  private readonly wallet: WalletInterface
  private readonly networkPreset: LookupNetworkPreset | undefined
  private readonly acceptDelayedBroadcast: boolean

  constructor(opts: DIDClientOptions = {}) {
    this.overlayTopic = opts.overlayTopic ?? DEFAULT_OVERLAY_TOPIC
    this.overlayService = opts.overlayService ?? DEFAULT_LOOKUP_SERVICE
    this.wallet = opts.wallet ?? new WalletClient()
    this.networkPreset = opts.networkPreset
    this.acceptDelayedBroadcast = opts.acceptDelayedBroadcast ?? false
  }

  /** Create an issuer-owned legacy DID token naming the supplied subject. */
  async createDID(
    serialNumber: string,
    subject: PubKeyHex,
    opts: {
      wallet?: WalletInterface
      derivationPrefix?: Base64String
      derivationSuffix?: Base64String
    } = {}
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const wallet = opts.wallet ?? this.wallet
    const normalizedSerial = normalizeDIDSerialNumber(serialNumber)
    const serialBytes = toArray(normalizedSerial, 'base64')
    const validatedSubject = validateSubject(subject)

    let derivationPrefix: Base64String
    let derivationSuffix: Base64String
    if (opts.derivationPrefix === undefined && opts.derivationSuffix === undefined) {
      derivationPrefix = toBase64(Random(10))
      derivationSuffix = toBase64(Random(10))
    } else if (opts.derivationPrefix !== undefined && opts.derivationSuffix !== undefined) {
      derivationPrefix = validateBase64String(
        opts.derivationPrefix,
        'derivationPrefix',
        1,
        256
      ) as Base64String
      derivationSuffix = validateBase64String(
        opts.derivationSuffix,
        'derivationSuffix',
        1,
        256
      ) as Base64String
    } else {
      throw new Error('Both DID derivation parameters must be provided together')
    }
    const keyID = `${derivationPrefix} ${derivationSuffix}`
    const lockingScript = await new PushDrop(wallet).lock(
      [serialBytes],
      DID_TOKEN_PROTOCOL,
      keyID,
      validatedSubject,
      true
    )
    const createdToken = decodeCanonicalDIDToken(lockingScript)
    const expectedLockingKey = await wallet.getPublicKey({
      protocolID: DID_TOKEN_PROTOCOL,
      keyID,
      counterparty: validatedSubject,
      forSelf: true
    })
    if (
      expectedLockingKey.publicKey.toLowerCase() !==
      createdToken.lockingPublicKey.toString().toLowerCase()
    ) {
      throw new Error('Wallet created a DID token with a substituted locking key')
    }
    const verified = await wallet.verifySignature({
      data: createdToken.serialBytes,
      signature: createdToken.signature,
      protocolID: DID_TOKEN_PROTOCOL,
      keyID,
      counterparty: validatedSubject,
      forSelf: true
    })
    if (verified.valid !== true) throw new Error('Wallet created an invalid DID token signature')

    const transaction = await completeBoundAction(wallet, {
      description: 'Create new DID token',
      outputs: [
        {
          lockingScript: lockingScript.toHex(),
          satoshis: 1,
          outputDescription: 'DID token',
          basket: 'did',
          tags: [
            `did-token-subject-${validatedSubject}`,
            `did-token-serialNumber-${normalizedSerial}`
          ],
          customInstructions: JSON.stringify({ derivationPrefix, derivationSuffix })
        }
      ],
      options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
    })
    return await this.broadcast(wallet, transaction)
  }

  /** Revoke one exact, wallet-owned DID token. Ambiguous serial matches fail closed. */
  async revokeDID(opts: {
    serialNumber?: string
    outpoint?: string
  }): Promise<BroadcastResponse | BroadcastFailure> {
    const { serialNumber, outpoint } = opts
    if (serialNumber === undefined && outpoint === undefined) {
      return {
        status: 'error',
        code: 'ERR_MISSING_IDENTIFIER',
        description: 'Either serialNumber or outpoint must be provided'
      }
    }

    let normalizedSerial: Base64String | undefined
    let normalizedOutpoint: string | undefined
    try {
      normalizedSerial =
        serialNumber === undefined ? undefined : normalizeDIDSerialNumber(serialNumber)
      normalizedOutpoint =
        outpoint === undefined ? undefined : canonicalOutpoint(outpoint).canonical
    } catch {
      return {
        status: 'error',
        code: 'ERR_INVALID_IDENTIFIER',
        description: 'The DID identifier is malformed'
      }
    }

    let walletOutputs: ListOutputsResult
    if (serialNumber !== undefined) {
      const serialTags = Array.from(
        new Set([
          `did-token-serialNumber-${serialNumber}`,
          `did-token-serialNumber-${normalizedSerial}`
        ])
      )
      walletOutputs = await this.wallet.listOutputs({
        basket: 'did',
        tags: serialTags,
        tagQueryMode: 'any',
        includeTags: true,
        includeCustomInstructions: true,
        include: 'entire transactions',
        limit: 2
      })
    } else {
      walletOutputs = await this.wallet.listOutputs({
        basket: 'did',
        tags: [],
        includeTags: true,
        includeCustomInstructions: true,
        include: 'entire transactions',
        limit: MAX_DID_WALLET_SCAN
      })
      walletOutputs.outputs = walletOutputs.outputs.filter(output => {
        try {
          return canonicalOutpoint(output.outpoint).canonical === normalizedOutpoint
        } catch {
          return false
        }
      })
    }

    try {
      validateWalletResult(walletOutputs)
    } catch {
      return {
        status: 'error',
        code: 'ERR_INVALID_WALLET_RESULT',
        description: 'Wallet returned malformed DID metadata'
      }
    }
    if (walletOutputs.outputs.length === 0) {
      return {
        status: 'error',
        code: 'ERR_DID_NOT_FOUND',
        description: 'DID token not found in wallet'
      }
    }
    if (
      walletOutputs.outputs.length !== 1 ||
      (serialNumber !== undefined && walletOutputs.totalOutputs !== 1)
    ) {
      return {
        status: 'error',
        code: 'ERR_AMBIGUOUS_DID',
        description: 'DID identifier matches more than one wallet output'
      }
    }
    const selected = walletOutputs.outputs[0]
    if (selected.customInstructions === undefined) {
      return {
        status: 'error',
        code: 'ERR_MISSING_INSTRUCTIONS',
        description: 'DID token missing derivation parameters'
      }
    }
    try {
      JSON.parse(selected.customInstructions)
    } catch {
      return {
        status: 'error',
        code: 'ERR_INVALID_INSTRUCTIONS',
        description: 'Unable to parse DID derivation parameters'
      }
    }
    if (!selected.tags?.some(tag => tag.startsWith('did-token-subject-'))) {
      return {
        status: 'error',
        code: 'ERR_MISSING_SUBJECT',
        description: 'DID token missing subject public key'
      }
    }
    if (walletOutputs.BEEF === undefined) {
      return {
        status: 'error',
        code: 'ERR_NO_BEEF',
        description: 'DID token BEEF data not available from wallet'
      }
    }

    let source: VerifiedWalletDID
    let beef: number[]
    try {
      beef = boundedBEEF(walletOutputs.BEEF)
      source = await verifyWalletDID(
        this.wallet,
        selected,
        beef,
        normalizedSerial,
        normalizedOutpoint
      )
    } catch {
      return {
        status: 'error',
        code: 'ERR_INVALID_DID_TOKEN',
        description: 'Wallet metadata does not authenticate an owned DID token'
      }
    }

    const sourceOutput = source.sourceTransaction.outputs[source.sourceOutputIndex]
    const sourceOutpoint = canonicalOutpoint(source.output.outpoint).canonical
    const pushdrop = new PushDrop(this.wallet)
    const transaction = await completeBoundAction(
      this.wallet,
      {
        description: 'Revoke DID',
        inputBEEF: beef,
        inputs: [
          {
            outpoint: sourceOutpoint,
            unlockingScriptLength: 74,
            inputDescription: 'Redeem DID token'
          }
        ],
        options: { acceptDelayedBroadcast: this.acceptDelayedBroadcast, randomizeOutputs: false }
      },
      {
        inputSigners: {
          [sourceOutpoint]: async (transactionToSign, inputIndex) =>
            await pushdrop
              .unlock(
                DID_TOKEN_PROTOCOL,
                source.keyID,
                source.subject,
                'all',
                false,
                sourceOutput.satoshis,
                sourceOutput.lockingScript
              )
              .sign(transactionToSign, inputIndex)
        }
      }
    )
    return await this.broadcast(this.wallet, transaction)
  }

  /** Query bounded canonical DID records; authority must be established out of band. */
  async findDID(
    query: DIDQuery & {
      limit?: number
      skip?: number
      sortOrder?: 'asc' | 'desc'
      startDate?: string
      endDate?: string
    } = {},
    opts: { resolver?: LookupResolver; wallet?: WalletInterface; includeBeef?: boolean } = {}
  ): Promise<Array<DIDRecord & { beef?: number[] }>> {
    if (query == null || typeof query !== 'object' || Array.isArray(query)) {
      throw new TypeError('DID query must be a plain object')
    }
    const prototype = Object.getPrototypeOf(query)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('DID query must be a plain object')
    }
    const allowed = new Set([
      'serialNumber',
      'outpoint',
      'limit',
      'skip',
      'sortOrder',
      'startDate',
      'endDate'
    ])
    for (const key of Reflect.ownKeys(query)) {
      if (typeof key !== 'string' || !allowed.has(key)) {
        throw new TypeError(`Unexpected DID query field ${String(key)}`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(query, key)
      if (descriptor == null || !('value' in descriptor)) {
        throw new TypeError(`DID query field ${key} must be a data property`)
      }
    }

    const normalizedSerial =
      query.serialNumber === undefined ? undefined : normalizeDIDSerialNumber(query.serialNumber)
    const normalizedOutpoint =
      query.outpoint === undefined ? undefined : canonicalOutpoint(query.outpoint).canonical
    const limit = query.limit ?? 50
    const skip = query.skip ?? 0
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DID_LOOKUP_RESULTS) {
      throw new RangeError(`DID query limit must be from 1 to ${MAX_DID_LOOKUP_RESULTS}`)
    }
    if (!Number.isSafeInteger(skip) || skip < 0 || skip > 100_000) {
      throw new RangeError('DID query skip must be from 0 to 100000')
    }
    if (query.sortOrder !== undefined && query.sortOrder !== 'asc' && query.sortOrder !== 'desc') {
      throw new RangeError('DID query sortOrder must be asc or desc')
    }
    const startDate = validateDate(query.startDate, 'startDate', false)
    const endDate = validateDate(query.endDate, 'endDate', true)
    if (startDate !== undefined && endDate !== undefined && startDate > endDate) {
      throw new RangeError('DID query startDate must not follow endDate')
    }

    const lookupQuery: Record<string, unknown> = { limit, skip }
    if (normalizedSerial !== undefined) lookupQuery.serialNumber = normalizedSerial
    if (normalizedOutpoint !== undefined) lookupQuery.outpoint = normalizedOutpoint
    if (query.sortOrder !== undefined) lookupQuery.sortOrder = query.sortOrder
    if (startDate !== undefined) lookupQuery.startDate = startDate
    if (endDate !== undefined) lookupQuery.endDate = endDate

    const { includeBeef = true, ...restOpts } = opts
    const wallet = restOpts.wallet ?? this.wallet
    const resolver =
      restOpts.resolver ??
      new LookupResolver({
        networkPreset: this.networkPreset ?? (await wallet.getNetwork({})).network
      })
    const answer = await resolver.query({ service: this.overlayService, query: lookupQuery })
    return this.parseLookupAnswer(answer, includeBeef, normalizedSerial, normalizedOutpoint, limit)
  }

  private parseLookupAnswer(
    answer: LookupAnswer,
    includeBeef: boolean,
    requestedSerial: Base64String | undefined,
    requestedOutpoint: string | undefined,
    limit: number
  ): Array<DIDRecord & { beef?: number[] }> {
    if (answer.type !== 'output-list') return []
    if (!Array.isArray(answer.outputs) || answer.outputs.length > limit) {
      throw new Error('DID lookup returned too many outputs')
    }
    const seen = new Set<string>()
    return answer.outputs.map((output, resultIndex) => {
      if (
        output == null ||
        typeof output !== 'object' ||
        !Number.isSafeInteger(output.outputIndex) ||
        output.outputIndex < 0 ||
        output.outputIndex > 0xffffffff
      ) {
        throw new Error(`DID lookup output ${resultIndex} is malformed`)
      }
      const beef = boundedBEEF(output.beef)
      const transaction = Transaction.fromAtomicBEEF(beef)
      const txid = transaction.id('hex').toLowerCase()
      if (output.txid !== undefined && canonicalOutpoint(`${output.txid}.0`).txid !== txid) {
        throw new Error('DID lookup transaction ID hint does not match its BEEF')
      }
      const transactionOutput = transaction.outputs[output.outputIndex]
      if (transactionOutput == null) throw new Error('DID lookup output index is out of range')
      const token = decodeCanonicalDIDToken(transactionOutput.lockingScript)
      const outpointValue = `${txid}.${output.outputIndex}`
      if (requestedSerial !== undefined && token.serialNumber !== requestedSerial) {
        throw new Error('DID lookup returned a different serial number')
      }
      if (requestedOutpoint !== undefined && outpointValue !== requestedOutpoint) {
        throw new Error('DID lookup returned a different outpoint')
      }
      if (seen.has(outpointValue)) throw new Error('DID lookup returned a duplicate outpoint')
      seen.add(outpointValue)
      return {
        txid,
        outputIndex: output.outputIndex,
        serialNumber: token.serialNumber,
        ...(includeBeef ? { beef } : {})
      }
    })
  }

  private async broadcast(
    wallet: WalletInterface,
    transaction: Transaction
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const broadcaster = new TopicBroadcaster([this.overlayTopic], {
      networkPreset: this.networkPreset ?? (await wallet.getNetwork({})).network
    })
    const result = await broadcaster.broadcast(transaction)
    if (
      result.status === 'success' &&
      result.txid.toLowerCase() !== transaction.id('hex').toLowerCase()
    ) {
      throw new Error('DID overlay acknowledged a different transaction ID')
    }
    return result
  }
}
