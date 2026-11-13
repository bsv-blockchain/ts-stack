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
import { deriveScalar, proveDleq, proveOr, proveSchnorr } from './sigma.js'
import type {
  ParsedPlaintext,
  SigmaAuthorizationRequest,
  SigmaKeyDeriver,
  SigmaOperation,
  SigmaPermissionModuleOptions
} from './types.js'

const SIGMA_PATTERN = /^p sigma (key|schnorr|dleq|or) ([a-z0-9]+(?: [a-z0-9]+)*)$/
const MAX_PROTOCOL_NAME_LENGTH = 288
const MIN_LOGICAL_PROTOCOL_BYTES = 5
const MAX_LOGICAL_PROTOCOL_BYTES = 272
const MAX_PLAINTEXT_BYTES = 8192
const DEFAULT_AUTHORIZATION_TTL = 5 * 60 * 1000
const MAX_AUTHORIZATION_TTL = 24 * 60 * 60 * 1000
const MAX_CACHED_GRANTS = 1024
const MAX_PENDING_GRANTS = 64
const MAX_ORIGINATOR_BYTES = 1024
// eslint-disable-next-line no-control-regex -- these are the ASCII controls being rejected.
const ASCII_CONTROL = /[\0-\x1f\x7f]/
const UTF8 = new TextEncoder()
const G = new Curve().g
const PROTOCOL_ERROR = 'Sigma: protocol must be p sigma <key|schnorr|dleq|or> <logicalProtocolID>'

interface ParsedSigmaRequest {
  operation: SigmaOperation
  securityLevel: SecurityLevel
  logicalProtocolID: string
  keyID: string
  counterparty: PubKeyHex | 'self' | 'anyone'
  privileged: boolean
  privilegedReason?: string
  seekPermission: boolean
  plaintext: ParsedPlaintext
}

function dataRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(`${label} must not contain symbol properties`)
  }
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) {
    throw new TypeError(`${label} must not contain accessors`)
  }
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.enumerable) result[key] = descriptor.value
  }
  return result
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

/** Implements the `p sigma` semantic permission module (BRC-98 scheme `sigma`). */
export class SigmaPermissionModule implements PermissionsModule {
  readonly #keyDeriver: SigmaKeyDeriver
  readonly #privilegedKeyDeriver: SigmaPermissionModuleOptions['privilegedKeyDeriver']
  readonly #authorize: SigmaPermissionModuleOptions['authorize']
  readonly #authorizationTTL: number
  readonly #grants = new Map<string, number>()
  readonly #pendingGrants = new Map<string, Promise<boolean>>()

  constructor(options: SigmaPermissionModuleOptions) {
    const ownedOptions = dataRecord(options, 'Sigma options')
    const keyDeriver = ownedOptions.keyDeriver as SigmaKeyDeriver | undefined
    if (keyDeriver == null || typeof keyDeriver.derivePrivateKey !== 'function') {
      throw new TypeError('Sigma: keyDeriver with derivePrivateKey is required')
    }
    const authorizationTTL = ownedOptions.authorizationTTL ?? DEFAULT_AUTHORIZATION_TTL
    if (
      typeof authorizationTTL !== 'number' ||
      !Number.isSafeInteger(authorizationTTL) ||
      authorizationTTL <= 0 ||
      authorizationTTL > MAX_AUTHORIZATION_TTL
    ) {
      throw new RangeError('Sigma: authorizationTTL must be between 1 ms and 24 hours')
    }
    const privilegedKeyDeriver = ownedOptions.privilegedKeyDeriver
    if (privilegedKeyDeriver !== undefined && typeof privilegedKeyDeriver !== 'function') {
      throw new TypeError('Sigma: privilegedKeyDeriver must be a function')
    }
    const authorize = ownedOptions.authorize
    if (authorize !== undefined && typeof authorize !== 'function') {
      throw new TypeError('Sigma: authorize must be a function')
    }
    this.#keyDeriver = keyDeriver
    this.#privilegedKeyDeriver =
      privilegedKeyDeriver as SigmaPermissionModuleOptions['privilegedKeyDeriver']
    this.#authorize = authorize as SigmaPermissionModuleOptions['authorize']
    this.#authorizationTTL = authorizationTTL
  }

  /** Clears cached and pending authorization state. */
  dispose(): void {
    this.#grants.clear()
    this.#pendingGrants.clear()
  }

  /** Semantic P-module entry point; Sigma never forwards to the ordinary wallet. */
  async handleRequest(
    request: PermissionsModuleRequest,
    _next: PermissionsModuleNext
  ): Promise<{ ciphertext: number[] }> {
    const ownedRequest = dataRecord(request, 'Sigma request')
    if (ownedRequest.method !== 'encrypt') {
      throw new Error(
        `Sigma: ${String(ownedRequest.method)} is not permitted in the p sigma namespace`
      )
    }
    if (typeof ownedRequest.originator !== 'string' || ownedRequest.originator.length === 0) {
      throw new Error('Sigma: originator is required')
    }
    const originatorBytes = UTF8.encode(ownedRequest.originator).length
    if (originatorBytes > MAX_ORIGINATOR_BYTES || ASCII_CONTROL.test(ownedRequest.originator)) {
      throw new Error('Sigma: originator is invalid or too long')
    }

    const parsed = this.#parseRequest(ownedRequest.args as object)
    await this.#ensureAuthorized(parsed, ownedRequest.originator)
    const keyDeriver = await this.#selectKeyDeriver(parsed)
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
  async onRequest(request: PermissionsModuleRequest): Promise<{ args: object }> {
    throw new Error(`Sigma: ${String(request.method)} is not permitted in the p sigma namespace`)
  }

  async onResponse(
    _result: unknown,
    context?: { method?: string; originator?: string }
  ): Promise<unknown> {
    throw new Error(`Sigma: ${String(context?.method)} is not permitted in the p sigma namespace`)
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

  #parseRequest(rawArgs: object): ParsedSigmaRequest {
    const args = dataRecord(rawArgs, 'Sigma: encrypt arguments')
    if (!Array.isArray(args.protocolID) || args.protocolID.length !== 2) {
      throw new Error('Sigma: protocolID is required')
    }
    const [securityLevel, protocolName] = args.protocolID as unknown[]
    if (
      (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) ||
      typeof protocolName !== 'string'
    ) {
      throw new Error('Sigma: invalid protocolID')
    }
    if (protocolName.length > MAX_PROTOCOL_NAME_LENGTH) throw new Error(PROTOCOL_ERROR)
    const match = SIGMA_PATTERN.exec(protocolName)
    if (match == null) throw new Error(PROTOCOL_ERROR)
    const operation = match[1] as SigmaOperation
    const logicalProtocolID = match[2]
    if (
      logicalProtocolID.length < MIN_LOGICAL_PROTOCOL_BYTES ||
      logicalProtocolID.length > MAX_LOGICAL_PROTOCOL_BYTES
    ) {
      throw new Error('Sigma: logical protocol ID must be between 5 and 272 characters')
    }
    if (logicalProtocolID.endsWith(' protocol'))
      throw new Error('Sigma: invalid logical protocol ID')

    const keyID = args.keyID
    if (typeof keyID !== 'string') throw new Error('Sigma: keyID is required')
    const keyIDBytes = UTF8.encode(keyID).length
    if (keyIDBytes < 1) throw new Error('Sigma: keyID is required')
    if (keyIDBytes > 800) throw new Error('Sigma: keyID exceeds 800 bytes')

    const counterparty = (args.counterparty ?? 'self') as PubKeyHex | 'self' | 'anyone'
    if (counterparty !== 'self' && counterparty !== 'anyone') {
      if (typeof counterparty !== 'string') {
        throw new TypeError('Sigma: counterparty must be self, anyone, or a compressed public key')
      }
      if (!/^0[23][0-9a-f]{64}$/.test(counterparty)) {
        throw new Error('Sigma: expected a lowercase 33-byte compressed secp256k1 point')
      }
      parsePoint33(Utils.toArray(counterparty, 'hex'), 'counterparty')
    }
    if (args.privileged !== undefined && typeof args.privileged !== 'boolean') {
      throw new TypeError('Sigma: privileged must be a boolean')
    }
    const privileged = args.privileged === true
    const privilegedReason = privileged ? (args.privilegedReason as string | undefined) : undefined
    if (privileged) {
      if (typeof privilegedReason !== 'string') {
        throw new TypeError('Sigma: privilegedReason is required for privileged operations')
      }
      const reasonBytes = UTF8.encode(privilegedReason).length
      if (reasonBytes < 5 || reasonBytes > 50) {
        throw new Error('Sigma: privilegedReason must be between 5 and 50 bytes')
      }
    }

    const plaintext = parsePlaintext(operation, copyBytes(args.plaintext))
    return {
      operation,
      securityLevel,
      logicalProtocolID,
      keyID,
      counterparty,
      privileged,
      privilegedReason,
      seekPermission: args.seekPermission !== false,
      plaintext
    }
  }

  async #ensureAuthorized(parsed: ParsedSigmaRequest, originator: string): Promise<void> {
    if (parsed.securityLevel === 0 && !parsed.privileged) return
    const authorization: SigmaAuthorizationRequest = {
      originator,
      securityLevel: parsed.securityLevel,
      logicalProtocolID: parsed.logicalProtocolID,
      keyID: parsed.keyID,
      counterparty: parsed.counterparty,
      privileged: parsed.privileged,
      privilegedReason: parsed.privilegedReason,
      operation: parsed.operation,
      ...('ctx' in parsed.plaintext
        ? { contextSha256: Utils.toHex(Hash.sha256(parsed.plaintext.ctx)) }
        : {})
    }

    const scope = JSON.stringify([
      originator,
      parsed.securityLevel,
      parsed.logicalProtocolID,
      parsed.securityLevel === 2 ? parsed.counterparty : '*',
      parsed.privileged ? 'privileged' : 'primary',
      parsed.privileged ? parsed.privilegedReason : null
    ])
    const now = Date.now()
    for (const [cachedScope, cachedExpiry] of this.#grants) {
      if (cachedExpiry > now) break
      this.#grants.delete(cachedScope)
    }
    const expiry = this.#grants.get(scope)
    if (expiry != null && expiry > now) return
    this.#grants.delete(scope)

    if (!parsed.seekPermission) {
      throw new Error('Sigma: permission is required and seekPermission is false')
    }
    if (this.#authorize == null) {
      throw new Error('Sigma: no authorization handler is configured')
    }

    let pending = this.#pendingGrants.get(scope)
    if (pending == null) {
      if (this.#pendingGrants.size >= MAX_PENDING_GRANTS) {
        throw new Error('Sigma: authorization queue is full')
      }
      pending = Promise.resolve(this.#authorize(authorization))
      this.#pendingGrants.set(scope, pending)
    }
    let approved: boolean
    try {
      approved = await pending
    } finally {
      if (this.#pendingGrants.get(scope) === pending) this.#pendingGrants.delete(scope)
    }
    if (approved !== true) throw new Error('Sigma: user denied permission')
    this.#grants.delete(scope)
    if (this.#grants.size >= MAX_CACHED_GRANTS) {
      this.#grants.delete(this.#grants.keys().next().value!)
    }
    this.#grants.set(scope, Date.now() + this.#authorizationTTL)
  }

  async #selectKeyDeriver(parsed: ParsedSigmaRequest): Promise<SigmaKeyDeriver> {
    if (!parsed.privileged) return this.#keyDeriver
    if (this.#privilegedKeyDeriver == null) {
      throw new Error('Sigma: privileged key derivation is unavailable')
    }
    const deriver = await this.#privilegedKeyDeriver(parsed.privilegedReason!)
    if (deriver == null || typeof deriver.derivePrivateKey !== 'function') {
      throw new Error('Sigma: privileged key provider returned an invalid deriver')
    }
    return deriver
  }
}
