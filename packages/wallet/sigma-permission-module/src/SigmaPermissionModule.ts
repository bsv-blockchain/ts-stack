import type { PubKeyHex, SecurityLevel } from '@bsv/sdk'
import * as Hash from '@bsv/sdk/primitives/Hash'
import * as Utils from '@bsv/sdk/primitives/utils'
import Curve from '@bsv/sdk/primitives/Curve'
import type Point from '@bsv/sdk/primitives/Point'
import type {
  PermissionsModule,
  PermissionsModuleNext,
  PermissionsModuleRequest
} from '@bsv/wallet-toolbox-client'
import { parsePlaintext, parsePoint33, point64 } from './encoding.js'
import { GrantStore } from './grants.js'
import { deriveScalar, proveDleq, proveOr, proveSchnorr } from './sigma.js'
import type {
  ParsedPlaintext,
  SigmaAuthorizationRequest,
  SigmaKeyDeriver,
  SigmaOperation,
  SigmaPermissionModuleOptions,
  SigmaProofAuthorization
} from './types.js'

const SIGMA_PATTERN = /^p sigma (key|schnorr|dleq|or) ([a-z0-9]+(?: [a-z0-9]+)*)$/
const MAX_PROTOCOL_NAME_LENGTH = 288
const MIN_LOGICAL_PROTOCOL_BYTES = 5
const MAX_LOGICAL_PROTOCOL_BYTES = 272
const MAX_PLAINTEXT_BYTES = 8192
const DEFAULT_AUTHORIZATION_TTL = 5 * 60 * 1000
const MAX_AUTHORIZATION_TTL = 24 * 60 * 60 * 1000
const MAX_ORIGINATOR_BYTES = 1024
const MAX_KEY_ID_BYTES = 800
// eslint-disable-next-line no-control-regex -- these are the ASCII controls being rejected.
const ASCII_CONTROL = /[\0-\x1f\x7f]/
const COMPRESSED_KEY_HEX = /^0[23][0-9a-f]{64}$/
const UTF8 = new TextEncoder()
const G = new Curve().g
const DISPOSED_ERROR = 'Sigma: the module has been disposed'
const PROTOCOL_ERROR = 'Sigma: protocol must be p sigma <key|schnorr|dleq|or> <logicalProtocolID>'

type Counterparty = PubKeyHex | 'self' | 'anyone'

interface ParsedProtocol {
  operation: SigmaOperation
  securityLevel: SecurityLevel
  logicalProtocolID: string
}

interface ParsedPrivilege {
  privileged: boolean
  privilegedReason?: string
}

interface ParsedSigmaRequest extends ParsedProtocol, ParsedPrivilege {
  keyID: string
  counterparty: Counterparty
  seekPermission: boolean
  /** The operation input as received, before parsing. */
  input: number[]
  plaintext: ParsedPlaintext
}

const byteLength = (text: string): number => UTF8.encode(text).length

const refusal = (method: unknown): Error =>
  new Error(`Sigma: ${String(method)} is not permitted in the p sigma namespace`)

const isKeyDeriver = (value: unknown): value is SigmaKeyDeriver =>
  value != null && typeof (value as Partial<SigmaKeyDeriver>).derivePrivateKey === 'function'

/**
 * Copies the enumerable own data properties of a plain object into a
 * prototype-free record, refusing anything else: non-objects, arrays, class
 * instances, symbol keys and accessors.
 */
function ownData(value: unknown, label: string): Record<string, unknown> {
  const reject = (reason: string): never => {
    throw new TypeError(`${label} ${reason}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return reject('must be an object')
  }
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) reject('must be a plain data object')
  if (Object.getOwnPropertySymbols(value).length !== 0) {
    reject('must not contain symbol properties')
  }
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value))
  if (descriptors.some(([, descriptor]) => !('value' in descriptor))) {
    reject('must not contain accessors')
  }
  const copy: Record<string, unknown> = Object.create(null)
  for (const [key, descriptor] of descriptors) {
    if (descriptor.enumerable === true) copy[key] = descriptor.value
  }
  return copy
}

function copyBytes(value: unknown): number[] {
  if (!Array.isArray(value)) throw new TypeError('Sigma: plaintext must be an array of bytes')
  const length = value.length
  if (length > MAX_PLAINTEXT_BYTES) throw new Error('Sigma: plaintext is too long')
  const bytes: number[] = []
  for (let i = 0; i < length; i++) {
    const element: unknown = value[i]
    if (typeof element !== 'number' || !Number.isInteger(element) || element < 0 || element > 255) {
      throw new TypeError('Sigma: plaintext must contain only integers from 0 to 255')
    }
    bytes.push(element)
  }
  return bytes
}

function lifetimeOption(lifetime: unknown): number {
  const valid =
    typeof lifetime === 'number' &&
    Number.isSafeInteger(lifetime) &&
    lifetime > 0 &&
    lifetime <= MAX_AUTHORIZATION_TTL
  if (!valid) throw new RangeError('Sigma: authorizationTTL must be between 1 ms and 24 hours')
  return lifetime
}

function proofAuthorizationOption(mode: unknown): SigmaProofAuthorization {
  if (mode === undefined) return 'each'
  if (mode === 'each' || mode === 'grant') return mode
  throw new TypeError("Sigma: proofAuthorization must be 'each' or 'grant'")
}

function functionOption<T>(value: unknown, name: string): T | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'function') throw new TypeError(`Sigma: ${name} must be a function`)
  return value as T
}

/** Checks the request envelope and returns its originator. */
function encryptOriginator(request: Record<string, unknown>): string {
  const { method, originator } = request
  if (method !== 'encrypt') throw refusal(method)
  if (typeof originator !== 'string' || originator === '') {
    throw new Error('Sigma: originator is required')
  }
  if (byteLength(originator) > MAX_ORIGINATOR_BYTES || ASCII_CONTROL.test(originator)) {
    throw new Error('Sigma: originator is invalid or too long')
  }
  return originator
}

function parseProtocol(protocolID: unknown): ParsedProtocol {
  if (!Array.isArray(protocolID) || protocolID.length !== 2) {
    throw new Error('Sigma: protocolID is required')
  }
  const [securityLevel, protocolName] = protocolID as unknown[]
  const levelIsValid = securityLevel === 0 || securityLevel === 1 || securityLevel === 2
  if (!levelIsValid || typeof protocolName !== 'string')
    throw new Error('Sigma: invalid protocolID')
  const match =
    protocolName.length > MAX_PROTOCOL_NAME_LENGTH ? null : SIGMA_PATTERN.exec(protocolName)
  if (match == null) throw new Error(PROTOCOL_ERROR)
  const logicalProtocolID = match[2]
  const length = logicalProtocolID.length
  if (length < MIN_LOGICAL_PROTOCOL_BYTES || length > MAX_LOGICAL_PROTOCOL_BYTES) {
    throw new Error('Sigma: logical protocol ID must be between 5 and 272 characters')
  }
  if (logicalProtocolID.endsWith(' protocol')) throw new Error('Sigma: invalid logical protocol ID')
  return { operation: match[1] as SigmaOperation, securityLevel, logicalProtocolID }
}

function parseKeyID(keyID: unknown): string {
  if (typeof keyID !== 'string' || keyID === '') throw new Error('Sigma: keyID is required')
  if (byteLength(keyID) > MAX_KEY_ID_BYTES) throw new Error('Sigma: keyID exceeds 800 bytes')
  return keyID
}

function parseCounterparty(counterparty: unknown): Counterparty {
  if (counterparty === 'self' || counterparty === 'anyone') return counterparty
  if (typeof counterparty !== 'string') {
    throw new TypeError('Sigma: counterparty must be self, anyone, or a compressed public key')
  }
  if (!COMPRESSED_KEY_HEX.test(counterparty)) {
    throw new Error('Sigma: expected a lowercase 33-byte compressed secp256k1 point')
  }
  parsePoint33(Utils.toArray(counterparty, 'hex'), 'counterparty')
  return counterparty
}

function parsePrivilege(privileged: unknown, reason: unknown): ParsedPrivilege {
  if (privileged !== undefined && typeof privileged !== 'boolean') {
    throw new TypeError('Sigma: privileged must be a boolean')
  }
  if (privileged !== true) return { privileged: false, privilegedReason: undefined }
  if (typeof reason !== 'string') {
    throw new TypeError('Sigma: privilegedReason is required for privileged operations')
  }
  const reasonBytes = byteLength(reason)
  if (reasonBytes < 5 || reasonBytes > 50) {
    throw new Error('Sigma: privilegedReason must be between 5 and 50 bytes')
  }
  return { privileged: true, privilegedReason: reason }
}

function parseRequest(rawArgs: unknown): ParsedSigmaRequest {
  const args = ownData(rawArgs, 'Sigma: encrypt arguments')
  const protocol = parseProtocol(args.protocolID)
  const keyID = parseKeyID(args.keyID)
  const counterparty = parseCounterparty(args.counterparty ?? 'self')
  const privilege = parsePrivilege(args.privileged, args.privilegedReason)
  const input = copyBytes(args.plaintext)
  const plaintext = parsePlaintext(protocol.operation, input)
  return {
    ...protocol,
    keyID,
    counterparty,
    ...privilege,
    seekPermission: args.seekPermission !== false,
    input,
    plaintext
  }
}

/** The grant scope: level 2 adds the counterparty, and a privileged grant is tied to its reason. */
function grantScope(parsed: ParsedSigmaRequest, originator: string): string {
  return JSON.stringify([
    originator,
    parsed.securityLevel,
    parsed.logicalProtocolID,
    parsed.securityLevel === 2 ? parsed.counterparty : '*',
    parsed.privileged ? 'privileged' : 'primary',
    parsed.privileged ? parsed.privilegedReason : null
  ])
}

function authorizationRequest(
  parsed: ParsedSigmaRequest,
  originator: string
): SigmaAuthorizationRequest {
  const context =
    'ctx' in parsed.plaintext
      ? { contextSha256: Utils.toHex(Hash.sha256(parsed.plaintext.ctx)) }
      : {}
  return {
    originator,
    securityLevel: parsed.securityLevel,
    logicalProtocolID: parsed.logicalProtocolID,
    keyID: parsed.keyID,
    counterparty: parsed.counterparty,
    privileged: parsed.privileged,
    privilegedReason: parsed.privilegedReason,
    operation: parsed.operation,
    ...context,
    applicationBase: 'H' in parsed.plaintext,
    inputSha256: Utils.toHex(Hash.sha256(parsed.input))
  }
}

/** Implements the `p sigma` semantic permission module (BRC-98 scheme `sigma`). */
export class SigmaPermissionModule implements PermissionsModule {
  readonly #keyDeriver: SigmaKeyDeriver
  readonly #privilegedKeyDeriver: SigmaPermissionModuleOptions['privilegedKeyDeriver']
  readonly #authorize: SigmaPermissionModuleOptions['authorize']
  readonly #grants: GrantStore
  readonly #proofAuthorization: SigmaProofAuthorization
  #disposed = false

  constructor(options: SigmaPermissionModuleOptions) {
    const owned = ownData(options, 'Sigma options')
    if (!isKeyDeriver(owned.keyDeriver)) {
      throw new TypeError('Sigma: keyDeriver with derivePrivateKey is required')
    }
    const lifetime = lifetimeOption(owned.authorizationTTL ?? DEFAULT_AUTHORIZATION_TTL)
    this.#privilegedKeyDeriver = functionOption(owned.privilegedKeyDeriver, 'privilegedKeyDeriver')
    this.#authorize = functionOption(owned.authorize, 'authorize')
    this.#proofAuthorization = proofAuthorizationOption(owned.proofAuthorization)
    this.#keyDeriver = owned.keyDeriver
    this.#grants = new GrantStore(lifetime)
  }

  /**
   * Clears cached and pending authorization state and refuses every later
   * request, including one whose decision is still pending. Safe to call twice.
   */
  dispose(): void {
    this.#disposed = true
    this.#grants.clear()
  }

  /** Semantic P-module entry point; Sigma never forwards to the ordinary wallet. */
  async handleRequest(
    request: PermissionsModuleRequest,
    _next: PermissionsModuleNext
  ): Promise<{ ciphertext: number[] }> {
    this.#assertLive()
    const owned = ownData(request, 'Sigma request')
    const originator = encryptOriginator(owned)
    const parsed = parseRequest(owned.args)
    await this.#ensureAuthorized(parsed, originator)
    const keyDeriver = await this.#selectKeyDeriver(parsed)
    this.#assertLive()
    const derivedKey = keyDeriver.derivePrivateKey(
      [parsed.securityLevel, `p sigma ${parsed.logicalProtocolID}`],
      parsed.keyID,
      parsed.counterparty
    )
    // The proof scalar is derived from the child key, never the child key itself.
    const x = deriveScalar(derivedKey)
    return { ciphertext: this.#run(parsed.plaintext, x) }
  }

  /** This scheme defines no baskets or labels; refuse rather than skip ordinary checks. */
  onRequest(request: PermissionsModuleRequest): Promise<{ args: object }> {
    return Promise.reject(refusal(request.method))
  }

  onResponse(
    _result: unknown,
    context?: { method?: string; originator?: string }
  ): Promise<unknown> {
    return Promise.reject(refusal(context?.method))
  }

  #run(plaintext: ParsedPlaintext, x: ReturnType<typeof deriveScalar>): number[] {
    switch (plaintext.operation) {
      case 'key': {
        const base = plaintext.H ?? G
        return base.mul(x).encode(true) as number[]
      }
      case 'schnorr':
        return proveSchnorr(x, plaintext.ctx)
      case 'dleq':
        return proveDleq(x, plaintext.H, plaintext.ctx)
      case 'or': {
        const P = G.mul(x)
        const encoded = point64(P)
        if (plaintext.others.some(o => point64(o).every((b, i) => b === encoded[i]))) {
          throw new Error('Sigma: ring already contains the wallet point')
        }
        const ring: Point[] = [...plaintext.others]
        ring.splice(plaintext.index - 1, 0, P)
        return proveOr(x, ring, plaintext.index, plaintext.ctx)
      }
    }
  }

  #assertLive(): void {
    if (this.#disposed) throw new Error(DISPOSED_ERROR)
  }

  /**
   * Under 'grant' every approval is remembered; under 'each' only a plain
   * public-key request (`key` with no base) is.
   */
  #isRemembered(request: SigmaAuthorizationRequest): boolean {
    if (this.#proofAuthorization === 'grant') return true
    return request.operation === 'key' && !request.applicationBase
  }

  /**
   * The key under which concurrent requests share one pending decision: the
   * grant scope under 'grant'; under 'each', the whole authorization request, so
   * only identical requests (grant scope, operation, key ID, counterparty and
   * input included) share an answer.
   */
  #decisionKey(scope: string, request: SigmaAuthorizationRequest): string {
    return this.#proofAuthorization === 'grant' ? scope : JSON.stringify(request)
  }

  async #ensureAuthorized(parsed: ParsedSigmaRequest, originator: string): Promise<void> {
    if (parsed.securityLevel === 0 && !parsed.privileged) return
    const scope = grantScope(parsed, originator)
    const request = authorizationRequest(parsed, originator)
    const remembered = this.#isRemembered(request)
    if (remembered && this.#grants.covers(scope)) return
    if (!parsed.seekPermission) {
      throw new Error('Sigma: permission is required and seekPermission is false')
    }
    const authorize = this.#authorize
    if (authorize == null) throw new Error('Sigma: no authorization handler is configured')
    const approved = await this.#grants.decide(this.#decisionKey(scope, request), () =>
      authorize(request)
    )
    this.#assertLive()
    if (approved !== true) throw new Error('Sigma: user denied permission')
    if (remembered) this.#grants.remember(scope)
  }

  async #selectKeyDeriver(parsed: ParsedSigmaRequest): Promise<SigmaKeyDeriver> {
    if (!parsed.privileged) return this.#keyDeriver
    if (this.#privilegedKeyDeriver == null) {
      throw new Error('Sigma: privileged key derivation is unavailable')
    }
    const deriver = await this.#privilegedKeyDeriver(parsed.privilegedReason!)
    if (!isKeyDeriver(deriver)) {
      throw new Error('Sigma: privileged key provider returned an invalid deriver')
    }
    return deriver
  }
}
