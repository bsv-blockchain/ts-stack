import AbstractResolver from './resolver/abstractResolver.js'
import DNSResolver, { DNSResolverOptions } from './resolver/dnsResolver.js'
import HttpClient from './httpClient.js'
import Capability from '../capability/capability.js'
import Joi from 'joi'
import { PaymailServerResponseError } from '../errors/index.js'
import { PrivateKey } from '@bsv/sdk/primitives'
import PublicProfileCapability from '../capability/publicProfileCapability.js'
import PublicKeyInfrastructureCapability from '../capability/pkiCapability.js'
import P2pPaymentDestinationCapability from '../capability/p2pPaymentDestinationCapability.js'
import ReceiveTransactionCapability from '../capability/p2pReceiveTransactionCapability.js'
import VerifyPublicKeyOwnerCapability from '../capability/verifyPublicKeyOwnerCapability.js'
import ReceiveBeefTransactionCapability from '../capability/p2pReceiveBeefTransactionCapability.js'
import NegotiationCapability from '../capability/negotiationCapabilities.js'
import TransactionNegotiationCapabilities, {
  TransactionNegotiationBody
} from '../capability/transactionNegotiationCapability.js'
import SimpleP2pOrdinalDestinationsCapability from '../capability/simpleP2pOrdinalDestinationsCapability.js'
import SimpleP2pOrdinalReceiveCapability from '../capability/simpleP2pOrdinalReceiveCapability.js'
import { createP2PSignature, isCanonicalCompressedPublicKey } from '../p2pSignature.js'
import { parsePaymail } from '../paymailAddress.js'
import { transactionIdFromHex } from '../transactionEncoding.js'

export type DomainCapabilities = Record<string, string | boolean>

export interface PublicProfile {
  name: string
  /** Untrusted public HTTPS image location; referenced bytes are not authenticated by Paymail. */
  avatar: string
}

export interface PublicKeyInformation {
  bsvalias?: string
  handle: string
  pubkey: string
}

export interface P2PDestination {
  script: string
  satoshis: number
}

export interface P2PPaymentDestination {
  outputs: P2PDestination[]
  reference: string
}

export interface P2POrdinalDestination {
  script: string
}

export interface P2POrdinalDestinations {
  outputs: P2POrdinalDestination[]
  reference: string
}

export interface P2PTransactionMetadata {
  sender: string
  pubkey: string
  signature: string
  note: string
}

export interface P2PTransactionResponse {
  txid: string
  note?: string | null
}

export interface PublicKeyVerification extends PublicKeyInformation {
  match: boolean
}

export const MAX_CAPABILITY_CACHE_ENTRIES = 256
export const CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000
const MAX_CAPABILITY_DOCUMENT_ENTRIES = 256
const MAX_CAPABILITY_CODE_CHARS = 256
const MAX_CAPABILITY_VALUE_CHARS = 8192
const MAX_SCRIPT_HEX_CHARS = 1024 * 1024
const COMPRESSED_PUBLIC_KEY = /^(?:02|03)[0-9a-fA-F]{64}$/
const UNSAFE_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

interface CachedCapabilities {
  value: DomainCapabilities
  expiresAt: number
}

function copyCapabilities(value: DomainCapabilities): DomainCapabilities {
  return Object.fromEntries(Object.entries(value))
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validatedCapabilityDocument(value: unknown): DomainCapabilities {
  try {
    if (!isPlainRecord(value)) throw new Error('document must be a plain object')
    const documentDescriptors = Object.getOwnPropertyDescriptors(value)
    const version = documentDescriptors.bsvalias
    const capabilityProperty = documentDescriptors.capabilities
    if (version?.get != null || version?.set != null || version?.value !== '1.0') {
      throw new Error('bsvalias must be exactly "1.0"')
    }
    if (
      capabilityProperty?.get != null ||
      capabilityProperty?.set != null ||
      !isPlainRecord(capabilityProperty?.value)
    ) {
      throw new Error('capabilities must be a plain own-data object')
    }

    const descriptors = Object.getOwnPropertyDescriptors(capabilityProperty.value)
    const keys = Reflect.ownKeys(descriptors)
    if (keys.length > MAX_CAPABILITY_DOCUMENT_ENTRIES) {
      throw new Error('capabilities contains too many entries')
    }
    const capabilities: DomainCapabilities = Object.create(null) as DomainCapabilities
    for (const key of keys) {
      if (
        typeof key !== 'string' ||
        key.length < 1 ||
        key.length > MAX_CAPABILITY_CODE_CHARS ||
        UNSAFE_RECORD_KEYS.has(key)
      ) {
        throw new Error('capabilities contains an unsafe code')
      }
      const descriptor = descriptors[key]
      if (
        descriptor == null ||
        descriptor.get != null ||
        descriptor.set != null ||
        descriptor.enumerable !== true
      ) {
        throw new Error('capabilities must contain enumerable own-data values')
      }
      const capability = descriptor.value
      if (
        (typeof capability !== 'string' && typeof capability !== 'boolean') ||
        (typeof capability === 'string' && capability.length > MAX_CAPABILITY_VALUE_CHARS)
      ) {
        throw new Error('capability values must be bounded strings or booleans')
      }
      capabilities[key] = capability
    }
    return capabilities
  } catch (error) {
    throw new PaymailServerResponseError(
      `Validation error: ${error instanceof Error ? error.message : 'invalid capability document'}`
    )
  }
}

function normalizedServiceHostname(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

function isIpLiteral(hostname: string): boolean {
  const normalized = normalizedServiceHostname(hostname)
  if (normalized.includes(':')) return true
  return /^\d+\.\d+\.\d+\.\d+$/.test(normalized)
}

function requirePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new PaymailServerResponseError(`${name} must be a positive safe integer`)
  }
}

function validateTransactionResponse(
  response: unknown,
  expectedTransactionId: string
): P2PTransactionResponse {
  const schema = Joi.object({
    txid: Joi.string().hex().length(64).required(),
    note: Joi.string().optional().allow('', null)
  }).options({ stripUnknown: true, convert: false })
  const { error, value } = schema.validate(response)
  if (error) {
    throw new PaymailServerResponseError(`Validation error: ${error.message}`)
  }
  const result = value as P2PTransactionResponse
  if (result.txid.toLowerCase() !== expectedTransactionId) {
    throw new PaymailServerResponseError('Paymail receiver acknowledged a different transaction')
  }
  return { ...result, txid: expectedTransactionId }
}

/**
 * PaymailClient provides functionality to interact with BSV Paymail services.
 * It offers methods to retrieve public profiles, verify public keys, send transactions, etc.
 */
export default class PaymailClient {
  // Cache for storing domain capabilities.
  private readonly _domainCapabilityCache: Map<string, CachedCapabilities>
  private readonly pendingCapabilities = new Map<string, Promise<DomainCapabilities>>()

  // Resolver for handling DNS queries.
  private readonly _resolver: AbstractResolver

  // Local port for development purposes. Defaults to 3000.
  private readonly _localHostPort: number

  // HTTP client for making network requests.
  private readonly httpClient: HttpClient

  /**
   * Constructs a new PaymailClient.
   * @param httpClient - HTTP client for making network requests. If not provided, a default HttpClient is used.
   * @param dnsOptions - Configuration options for DNS resolution.
   * @param localhostPort - The port number for localhost development. Defaults to 3000 if not specified.
   */
  constructor(httpClient?: HttpClient, dnsOptions?: DNSResolverOptions, localhostPort?: number) {
    const validatedLocalhostPort = localhostPort ?? 3000
    if (
      !Number.isInteger(validatedLocalhostPort) ||
      validatedLocalhostPort < 1 ||
      validatedLocalhostPort > 65_535
    ) {
      throw new RangeError('localhostPort must be an integer from 1 through 65535')
    }
    this.httpClient = httpClient ?? new HttpClient()
    this._domainCapabilityCache = new Map()
    this._resolver = new DNSResolver(this.httpClient, dnsOptions)
    this._localHostPort = validatedLocalhostPort
  }

  /**
   * Fetches the well-known configuration for a Paymail domain.
   * @param aDomain - The domain to fetch the configuration for.
   * @returns The well-known configuration as a JSON object.
   */
  private readonly fetchWellKnown = async (aDomain: string): Promise<DomainCapabilities> => {
    const isLocalHost = this.isDomainLocalHost(aDomain)
    const protocol = isLocalHost ? 'http://' : 'https://'
    let domain = aDomain
    let port = isLocalHost ? this._localHostPort : null

    if (!isLocalHost) {
      ;({ domain, port } = await this._resolver.queryBsvaliasDomain(aDomain))
    }

    const url = `${protocol}${domain}:${port}/.well-known/bsvalias`
    this.validateServiceUrl(url, aDomain)
    const response = await this.httpClient.request(url)
    const json = await response.json()
    return validatedCapabilityDocument(json)
  }

  private isDomainLocalHost(aDomain: string): boolean {
    return aDomain === 'localhost'
  }

  private validateDomain(aDomain: string): string {
    const parsed = parsePaymail(`paymail@${aDomain}`)
    if (parsed == null) {
      throw new PaymailServerResponseError(`Invalid Paymail domain: "${aDomain}"`)
    }
    const domain = parsed.domain.toLowerCase()
    if (domain === 'localhost') return domain
    let normalized: string
    try {
      normalized = normalizedServiceHostname(new URL(`https://${domain}`).hostname)
    } catch {
      throw new PaymailServerResponseError(`Invalid Paymail domain: "${aDomain}"`)
    }
    if (
      normalized !== domain ||
      !normalized.includes('.') ||
      normalized.endsWith('.local') ||
      normalized.endsWith('.localhost') ||
      isIpLiteral(normalized)
    ) {
      throw new PaymailServerResponseError(`Invalid Paymail domain: "${aDomain}"`)
    }
    return normalized
  }

  private validateServiceUrl(value: string, paymailDomain: string): string {
    let endpoint: URL
    try {
      endpoint = new URL(value)
    } catch {
      throw new PaymailServerResponseError('Paymail capability endpoint is not a valid URL')
    }
    const hostname = normalizedServiceHostname(endpoint.hostname)
    const isLocalDevelopment = paymailDomain === 'localhost' && hostname === 'localhost'
    if (endpoint.username !== '' || endpoint.password !== '' || endpoint.hash !== '') {
      throw new PaymailServerResponseError('Paymail capability endpoint is unsafe')
    }
    if (endpoint.protocol !== 'https:' && !(isLocalDevelopment && endpoint.protocol === 'http:')) {
      throw new PaymailServerResponseError('Paymail capability endpoints require HTTPS')
    }
    if (
      (!isLocalDevelopment &&
        (hostname === 'localhost' ||
          hostname.endsWith('.localhost') ||
          hostname.endsWith('.local') ||
          !hostname.includes('.') ||
          isIpLiteral(hostname))) ||
      hostname.length === 0
    ) {
      throw new PaymailServerResponseError('Paymail capability endpoint host is unsafe')
    }
    return value
  }

  public readonly getDomainCapabilities = async (aDomain: string): Promise<DomainCapabilities> => {
    const domain = this.validateDomain(aDomain)
    const cached = this._domainCapabilityCache.get(domain)
    if (cached !== undefined && cached.expiresAt > Date.now()) {
      this._domainCapabilityCache.delete(domain)
      this._domainCapabilityCache.set(domain, cached)
      return copyCapabilities(cached.value)
    }
    if (cached !== undefined) this._domainCapabilityCache.delete(domain)

    const pending = this.pendingCapabilities.get(domain)
    if (pending != null) return copyCapabilities(await pending)
    const discovery = this.fetchWellKnown(domain)
    this.pendingCapabilities.set(domain, discovery)
    try {
      const capabilities = copyCapabilities(await discovery)
      this._domainCapabilityCache.set(domain, {
        value: capabilities,
        expiresAt: Date.now() + CAPABILITY_CACHE_TTL_MS
      })
      while (this._domainCapabilityCache.size > MAX_CAPABILITY_CACHE_ENTRIES) {
        const oldest = this._domainCapabilityCache.keys().next().value
        if (oldest == null) break
        this._domainCapabilityCache.delete(oldest)
      }
      return copyCapabilities(capabilities)
    } finally {
      this.pendingCapabilities.delete(domain)
    }
  }

  public readonly getCapabilities = this.getDomainCapabilities

  /**
   * Ensures that a specified domain supports a given capability.
   * @param aDomain - The domain to check for the capability.
   * @param aCapability - The capability to check for.
   * @returns The URL endpoint for the specified capability.
   * @throws PaymailServerResponseError - Thrown if the domain does not support the requested capability.
   */
  public ensureCapabilityFor = async (aDomain: string, aCapability: string): Promise<string> => {
    const domain = this.validateDomain(aDomain)
    const capabilities = await this.getDomainCapabilities(domain)
    const endpoint = capabilities[aCapability]
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new PaymailServerResponseError(
        `Domain "${aDomain}" does not support capability "${aCapability}"`
      )
    }
    return this.validateServiceUrl(endpoint, domain)
  }

  /**
   * Makes a generic request to a Paymail service.
   * @param aDomain - The domain of the Paymail service.
   * @param capability - The capability being requested.
   * @param body - Optional request body.
   * @returns The response from the Paymail service.
   */
  public request = async (
    aDomain: string,
    capability: Capability,
    body?: unknown
  ): Promise<unknown> => {
    const parsed = parsePaymail(aDomain)
    if (!parsed) {
      throw new PaymailServerResponseError(`Invalid Paymail address: "${aDomain}"`)
    }
    const { name } = parsed
    const domain = this.validateDomain(parsed.domain)
    const url = await this.ensureCapabilityFor(domain, capability.getCode())
    const requestUrl = url
      .replaceAll('{alias}', encodeURIComponent(name))
      .replaceAll('{domain.tld}', encodeURIComponent(domain))
    this.validateServiceUrl(requestUrl, domain)
    const response = await this.httpClient.request(requestUrl, {
      method: capability.getMethod(),
      body
    })
    const responseBody = await response.json()
    return responseBody
  }

  /**
   * Retrieves the public profile associated with a Paymail address.
   * @param paymail - The Paymail address to fetch the profile for.
   * @returns The public profile including name and avatar.
   * @throws PaymailServerResponseError - Thrown if there is a validation error in the response.
   */
  public getPublicProfile = async (paymail: string): Promise<PublicProfile> => {
    const parsedPaymail = parsePaymail(paymail)
    if (parsedPaymail == null) {
      throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`)
    }
    const response = await this.request(paymail, PublicProfileCapability)
    const schema = Joi.object({
      name: Joi.string().required(),
      avatar: Joi.string()
        .uri({ scheme: ['https'] })
        .custom((value: string, helpers) => {
          const url = new URL(value)
          return url.username !== '' || url.password !== '' || url.hash !== ''
            ? helpers.error('string.uri')
            : value
        })
        .required()
    }).options({ stripUnknown: true, convert: false })

    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    const profile = value as PublicProfile
    this.validateServiceUrl(profile.avatar, this.validateDomain(parsedPaymail.domain))
    return { name: profile.name, avatar: profile.avatar }
  }

  /**
   * Retrieves the public key infrastructure (PKI) data for a given Paymail address.
   * @param paymail - The Paymail address to fetch the PKI data for.
   * @returns PKI data including bsvalias, handle, and pubkey.
   * @throws PaymailServerResponseError - Thrown if there is a validation error in the response.
   */
  public getPki = async (paymail: string): Promise<PublicKeyInformation> => {
    const parsedPaymail = parsePaymail(paymail)
    if (parsedPaymail == null) {
      throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`)
    }
    const response = await this.request(paymail, PublicKeyInfrastructureCapability)
    const schema = Joi.object({
      bsvalias: Joi.string().valid('1.0').optional(),
      handle: Joi.string().required(),
      pubkey: Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required()
    }).options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    const information = value as PublicKeyInformation
    if (
      information.handle.toLowerCase() !== paymail.toLowerCase() ||
      !isCanonicalCompressedPublicKey(information.pubkey)
    ) {
      throw new PaymailServerResponseError('Paymail PKI response identified a different handle')
    }
    return information
  }

  /**
   * Requests a P2P payment destination for a given Paymail.
   * @param paymail - The Paymail address to request the payment destination for.
   * @param satoshis - The amount of satoshis for the transaction.
   * @returns An object containing the payment destination details.
   */
  public getP2pPaymentDestination = async (
    paymail: string,
    satoshis: number
  ): Promise<P2PPaymentDestination> => {
    requirePositiveSafeInteger(satoshis, 'satoshis')
    const response = await this.request(paymail, P2pPaymentDestinationCapability, {
      satoshis
    })

    const schema = Joi.object({
      outputs: Joi.array()
        .items(
          Joi.object({
            script: Joi.string()
              .pattern(/^(?:[0-9a-fA-F]{2})+$/)
              .max(MAX_SCRIPT_HEX_CHARS)
              .required(),
            satoshis: Joi.number().integer().min(0).max(Number.MAX_SAFE_INTEGER).required()
          }).required()
        )
        .min(1)
        .required(),
      reference: Joi.string().required()
    }).options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }

    const destination = value as P2PPaymentDestination
    let total = 0
    for (const output of destination.outputs) {
      total += output.satoshis
      if (!Number.isSafeInteger(total)) {
        throw new PaymailServerResponseError('The server returned an invalid satoshi total')
      }
    }
    if (satoshis !== total) {
      throw new PaymailServerResponseError(
        'The server did not return the expected amount of satoshis'
      )
    }
    return destination
  }

  /**
   * Requests a P2P ordinal destination for a given Paymail.
   * @param paymail - The Paymail address to request the payment destination for.
   * @param ordinals - The amount of ordinals to be sent in transaction
   * @returns Exactly one validated destination for each requested ordinal.
   */
  public getP2pOrdinalDestinations = async (
    paymail: string,
    ordinals: number
  ): Promise<P2POrdinalDestinations> => {
    requirePositiveSafeInteger(ordinals, 'ordinals')
    const response = await this.request(paymail, SimpleP2pOrdinalDestinationsCapability, {
      ordinals
    })

    const schema = Joi.object({
      outputs: Joi.array()
        .items(
          Joi.object({
            script: Joi.string()
              .pattern(/^(?:[0-9a-fA-F]{2})+$/)
              .max(MAX_SCRIPT_HEX_CHARS)
              .required()
          }).required()
        )
        .min(1)
        .required(),
      reference: Joi.string().required()
    }).options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    const destinations = value as P2POrdinalDestinations
    if (destinations.outputs.length !== ordinals) {
      throw new PaymailServerResponseError(
        'The server did not return the requested count of ordinal destinations'
      )
    }
    return destinations
  }

  /**
   * Sends a transaction using the Pay-to-Peer (P2P) protocol.
   * This method is used to send a transaction to a Paymail address.
   *
   * @param paymail - The Paymail address to send the transaction to.
   * @param hex - The transaction in hexadecimal format.
   * @param reference - A reference identifier for the transaction.
   * @param metadata - Optional metadata for the transaction including sender, public key, signature, and note.
   * @returns A Promise that resolves to an object containing the transaction ID and an optional note.
   * @throws PaymailServerResponseError - Thrown if there is a validation error in the response.
   */
  public sendTransactionP2P = async (
    paymail: string,
    hex: string,
    reference: string,
    metadata?: P2PTransactionMetadata
  ): Promise<P2PTransactionResponse> => {
    const expectedTransactionId = transactionIdFromHex(hex)
    const response = await this.request(paymail, ReceiveTransactionCapability, {
      hex,
      reference,
      metadata
    })

    return validateTransactionResponse(response, expectedTransactionId)
  }

  /**
   * Sends a transaction using the Pay-to-Peer (P2P) protocol.
   * This method is used to send a transaction to a Paymail address.
   *
   * @param paymail - The Paymail address to send the transaction to.
   * @param hex - The transaction in hexadecimal format.
   * @param reference - A reference identifier for the transaction.
   * @param metadata - Optional metadata for the transaction including sender, public key, signature, and note.
   * @returns A Promise that resolves to an object containing the transaction ID and an optional note.
   * @throws PaymailServerResponseError - Thrown if there is a validation error in the response.
   */
  public sendOrdinalTransactionP2P = async (
    paymail: string,
    hex: string,
    reference: string,
    metadata?: P2PTransactionMetadata
  ): Promise<P2PTransactionResponse> => {
    const expectedTransactionId = transactionIdFromHex(hex)
    const response = await this.request(paymail, SimpleP2pOrdinalReceiveCapability, {
      hex,
      reference,
      metadata
    })

    return validateTransactionResponse(response, expectedTransactionId)
  }

  /**
   * Creates a digital signature for a P2P transaction using a given private key.
   * @param txid - The transaction ID to be signed.
   * @param privKey - The private key used for signing the transaction.
   * @returns A Base64-encoded compact Bitcoin Signed Message signature.
   */
  public createP2PSignature = (txid: string, privKey: PrivateKey): string =>
    createP2PSignature(txid, privKey)

  /**
   * Verifies the ownership of a public key for a given Paymail address.
   * @param paymail - The Paymail address to verify the public key for.
   * @param pubkey - The public key to verify.
   * @returns An object containing verification results.
   * @throws PaymailServerResponseError - Thrown if there is an error in the verification process.
   */
  public verifyPublicKey = async (
    paymail: string,
    pubkey: string
  ): Promise<PublicKeyVerification> => {
    const parsed = parsePaymail(paymail)
    if (!parsed) {
      throw new PaymailServerResponseError(`Invalid Paymail address: "${paymail}"`)
    }
    const { name } = parsed
    if (!isCanonicalCompressedPublicKey(pubkey)) {
      throw new PaymailServerResponseError('Invalid compressed public key')
    }
    const domain = this.validateDomain(parsed.domain)
    const url = await this.ensureCapabilityFor(domain, VerifyPublicKeyOwnerCapability.getCode())
    const requestUrl = url
      .replaceAll('{alias}', encodeURIComponent(name))
      .replaceAll('{domain.tld}', encodeURIComponent(domain))
      .replaceAll('{pubkey}', encodeURIComponent(pubkey))
    this.validateServiceUrl(requestUrl, domain)
    const response = await this.httpClient.request(requestUrl)
    const responseBody = await response.json()

    const schema = Joi.object({
      bsvalias: Joi.string().valid('1.0').optional(),
      handle: Joi.string().required(),
      pubkey: Joi.string().pattern(COMPRESSED_PUBLIC_KEY).required(),
      match: Joi.boolean().required()
    }).options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(responseBody)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    const verification = value as PublicKeyVerification
    if (
      verification.handle.toLowerCase() !== paymail.toLowerCase() ||
      verification.pubkey.toLowerCase() !== pubkey.toLowerCase() ||
      !isCanonicalCompressedPublicKey(verification.pubkey)
    ) {
      throw new PaymailServerResponseError(
        'Paymail ownership response did not match the requested handle and public key'
      )
    }
    return verification
  }

  /**
   * Sends a beef transaction using the Pay-to-Peer (P2P) protocol.
   * @param paymail - The Paymail address to which the transaction is sent.
   * @param beef - The transaction content in beef format.
   * @param reference - A reference identifier for the transaction.
   * @param metadata - Optional metadata including sender, public key, signature, and a note.
   * @returns The transaction ID and an optional note in the response.
   * @throws PaymailServerResponseError - Thrown if there is a validation error in the response.
   */
  public sendBeefTransactionP2P = async (
    paymail: string,
    beef: string,
    reference: string,
    metadata?: P2PTransactionMetadata
  ): Promise<P2PTransactionResponse> => {
    const expectedTransactionId = transactionIdFromHex(beef, true)
    const response = await this.request(paymail, ReceiveBeefTransactionCapability, {
      beef,
      reference,
      metadata
    })
    return validateTransactionResponse(response, expectedTransactionId)
  }

  /**
   * Retrieves the transaction negotiation capabilities for a given Paymail.
   * @param paymail - The Paymail address to query for negotiation capabilities.
   * @returns An object representing the negotiation capabilities.
   * @throws PaymailServerResponseError - Thrown if there is a validation error in the response.
   */
  public getTransactionNegotiationCapabilities = async (
    paymail: string
  ): Promise<Record<string, boolean>> => {
    const response = await this.request(paymail, NegotiationCapability)
    const schema = Joi.object({
      send_disabled: Joi.boolean().default(false),
      auto_send_response: Joi.boolean().default(false),
      receive: Joi.boolean().default(false),
      three_step_exchange: Joi.boolean().default(false),
      four_step_exchange: Joi.boolean().default(false),
      auto_exchange_response: Joi.boolean().default(false)
    }).options({ stripUnknown: true, convert: false })
    const { error, value } = schema.validate(response)
    if (error) {
      throw new PaymailServerResponseError(`Validation error: ${error.message}`)
    }
    return value as Record<string, boolean>
  }

  /**
   * Sends a transaction negotiation request to a Paymail address.
   * @param paymail - The Paymail address to send the negotiation request to.
   * @param body - The transaction negotiation request body.
   * @returns The response from the Paymail service.
   */
  public sendTransactionNegotiation = async (
    paymail: string,
    body: TransactionNegotiationBody
  ): Promise<unknown> => {
    const response = await this.request(paymail, TransactionNegotiationCapabilities, body)
    return response
  }
}
