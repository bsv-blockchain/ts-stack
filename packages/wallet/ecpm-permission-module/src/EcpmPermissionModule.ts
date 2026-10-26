import type { GetPublicKeyArgs, PubKeyHex } from '@bsv/sdk'
import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import Point from '@bsv/sdk/primitives/Point'
import type {
  PermissionsModule,
  PermissionsModuleNext,
  PermissionsModuleRequest
} from '@bsv/wallet-toolbox-client'
import type {
  EcpmAuthorizationRequest,
  EcpmKeyDeriver,
  EcpmPermissionModuleOptions,
  ParsedEcpmRequest
} from './types.js'

const ECPM_PATTERN = /^p ecpm (apply|remove) (0[23][0-9a-f]{64}) ([a-z0-9]+(?: [a-z0-9]+)*)$/
const MAX_ECPM_PROTOCOL_BYTES = 354
const MAX_LOGICAL_PROTOCOL_BYTES = 273
const DEFAULT_AUTHORIZATION_TTL = 5 * 60 * 1000
const MAX_AUTHORIZATION_TTL = 24 * 60 * 60 * 1000
const MAX_CACHED_GRANTS = 1024
const MAX_PENDING_GRANTS = 64
const MAX_ORIGINATOR_BYTES = 1024
// eslint-disable-next-line no-control-regex -- these are the ASCII controls being rejected.
const ASCII_CONTROL = /[\0-\x1f\x7f]/
const CURVE = new Curve()
const UTF8 = new TextEncoder()

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

/** Implements the BRC-229 `p ecpm` semantic permission module. */
export class EcpmPermissionModule implements PermissionsModule {
  readonly #keyDeriver: EcpmKeyDeriver
  readonly #privilegedKeyDeriver: EcpmPermissionModuleOptions['privilegedKeyDeriver']
  readonly #authorize: EcpmPermissionModuleOptions['authorize']
  readonly #authorizationTTL: number
  readonly #grants = new Map<string, number>()
  readonly #pendingGrants = new Map<string, Promise<boolean>>()

  constructor(options: EcpmPermissionModuleOptions) {
    const ownedOptions = dataRecord(options, 'ECPM options')
    const keyDeriver = ownedOptions.keyDeriver as EcpmKeyDeriver | undefined
    if (keyDeriver == null || typeof keyDeriver.derivePrivateKey !== 'function') {
      throw new TypeError('ECPM: keyDeriver with derivePrivateKey is required')
    }
    const authorizationTTL = ownedOptions.authorizationTTL ?? DEFAULT_AUTHORIZATION_TTL
    if (
      typeof authorizationTTL !== 'number' ||
      !Number.isSafeInteger(authorizationTTL) ||
      authorizationTTL <= 0 ||
      authorizationTTL > MAX_AUTHORIZATION_TTL
    ) {
      throw new RangeError('ECPM: authorizationTTL must be between 1 ms and 24 hours')
    }
    const privilegedKeyDeriver = ownedOptions.privilegedKeyDeriver
    if (privilegedKeyDeriver !== undefined && typeof privilegedKeyDeriver !== 'function') {
      throw new TypeError('ECPM: privilegedKeyDeriver must be a function')
    }
    const authorize = ownedOptions.authorize
    if (authorize !== undefined && typeof authorize !== 'function') {
      throw new TypeError('ECPM: authorize must be a function')
    }
    this.#keyDeriver = keyDeriver
    this.#privilegedKeyDeriver =
      privilegedKeyDeriver as EcpmPermissionModuleOptions['privilegedKeyDeriver']
    this.#authorize = authorize as EcpmPermissionModuleOptions['authorize']
    this.#authorizationTTL = authorizationTTL
  }

  /** Clears cached and pending authorization state. */
  dispose(): void {
    this.#grants.clear()
    this.#pendingGrants.clear()
  }

  /** Semantic P-module entry point; ECPM never forwards to ordinary `getPublicKey`. */
  async handleRequest(
    request: PermissionsModuleRequest,
    _next: PermissionsModuleNext
  ): Promise<{ publicKey: PubKeyHex }> {
    const ownedRequest = dataRecord(request, 'ECPM request')
    if (ownedRequest.method !== 'getPublicKey') {
      throw new Error(
        `ECPM: ${String(ownedRequest.method)} is not permitted in the p ecpm namespace`
      )
    }
    if (typeof ownedRequest.originator !== 'string' || ownedRequest.originator.length === 0) {
      throw new Error('ECPM: originator is required')
    }
    const originatorBytes = UTF8.encode(ownedRequest.originator).length
    if (originatorBytes > MAX_ORIGINATOR_BYTES || ASCII_CONTROL.test(ownedRequest.originator)) {
      throw new Error('ECPM: originator is invalid or too long')
    }

    const parsed = this.#parseRequest(ownedRequest.args as object)
    await this.#ensureAuthorized(parsed, ownedRequest.originator)
    const keyDeriver = await this.#selectKeyDeriver(parsed)
    const derivedKey = keyDeriver.derivePrivateKey(
      parsed.derivationProtocolID,
      parsed.keyID,
      parsed.counterparty
    )
    return {
      publicKey: this.#multiply(parsed.decodedPoint, derivedKey, parsed.operation)
    }
  }

  async onRequest(request: PermissionsModuleRequest): Promise<{ args: object }> {
    return { args: request.args }
  }

  async onResponse(result: unknown): Promise<unknown> {
    return result
  }

  #parseRequest(rawArgs: object): ParsedEcpmRequest & { decodedPoint: Point } {
    const args = dataRecord(rawArgs, 'ECPM: getPublicKey arguments') as GetPublicKeyArgs
    if (args.identityKey === true) {
      throw new Error('ECPM: identityKey is prohibited')
    }
    if (args.forSelf === true) {
      throw new Error('ECPM: forSelf is not defined for this module')
    }
    if (!Array.isArray(args.protocolID) || args.protocolID.length !== 2) {
      throw new Error('ECPM: protocolID is required')
    }
    const [securityLevel, protocolName] = args.protocolID
    if (
      (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) ||
      typeof protocolName !== 'string'
    ) {
      throw new Error('ECPM: invalid protocolID')
    }
    if (UTF8.encode(protocolName).length > MAX_ECPM_PROTOCOL_BYTES) {
      throw new Error('ECPM: outer protocol ID exceeds 354 bytes')
    }
    const match = ECPM_PATTERN.exec(protocolName)
    if (match == null) {
      throw new Error('ECPM: protocol must be p ecpm <apply|remove> <pointHex> <logicalProtocolID>')
    }

    const operation = match[1] as 'apply' | 'remove'
    const point = match[2] as PubKeyHex
    const logicalProtocolID = match[3]
    const logicalProtocolBytes = UTF8.encode(logicalProtocolID).length
    if (logicalProtocolBytes < 5 || logicalProtocolBytes > MAX_LOGICAL_PROTOCOL_BYTES) {
      throw new Error('ECPM: logical protocol ID must be between 5 and 273 bytes')
    }
    if (
      logicalProtocolID.includes('  ') ||
      logicalProtocolID.endsWith(' protocol') ||
      !/^[a-z0-9 ]+$/.test(logicalProtocolID)
    ) {
      throw new Error('ECPM: invalid logical protocol ID')
    }
    const decodedPoint = this.#parseValidPoint(point)

    const keyID = args.keyID
    if (typeof keyID !== 'string') {
      throw new Error('ECPM: keyID is required')
    }
    const keyIDBytes = UTF8.encode(keyID).length
    if (keyIDBytes < 1) throw new Error('ECPM: keyID is required')
    if (keyIDBytes > 800) {
      throw new Error('ECPM: keyID exceeds 800 bytes')
    }

    const counterparty = (args.counterparty ?? 'self') as PubKeyHex | 'self' | 'anyone'
    if (counterparty !== 'self' && counterparty !== 'anyone') {
      if (typeof counterparty !== 'string') {
        throw new TypeError('ECPM: counterparty must be self, anyone, or a compressed public key')
      }
      this.#parseValidPoint(counterparty)
    }
    const privileged = args.privileged === true
    const privilegedReason = args.privilegedReason
    if (privileged) {
      if (typeof privilegedReason !== 'string') {
        throw new TypeError('ECPM: privilegedReason is required for privileged operations')
      }
      const reasonBytes = UTF8.encode(privilegedReason).length
      if (reasonBytes < 5 || reasonBytes > 50) {
        throw new Error('ECPM: privilegedReason must be between 5 and 50 bytes')
      }
    }

    return {
      args,
      decodedPoint,
      operation,
      point,
      logicalProtocolID,
      derivationProtocolID: [securityLevel, `p ecpm ${logicalProtocolID}`],
      keyID,
      counterparty,
      privileged,
      privilegedReason
    }
  }

  #parseValidPoint(pointHex: PubKeyHex): Point {
    if (!/^0[23][0-9a-f]{64}$/.test(pointHex)) {
      throw new Error('ECPM: expected a lowercase 33-byte compressed secp256k1 point')
    }
    if (new BigNumber(pointHex.slice(2), 16).cmp(CURVE.p) >= 0) {
      throw new Error('ECPM: x is not a canonical field element')
    }
    let point: Point
    try {
      point = Point.fromString(pointHex)
    } catch {
      throw new Error('ECPM: point could not be decoded')
    }
    if (point.isInfinity() || !point.validate()) {
      throw new Error('ECPM: point is not a finite secp256k1 point')
    }
    return point
  }

  async #ensureAuthorized(parsed: ParsedEcpmRequest, originator: string): Promise<void> {
    const authorization: EcpmAuthorizationRequest = {
      originator,
      securityLevel: parsed.derivationProtocolID[0],
      logicalProtocolID: parsed.logicalProtocolID,
      keyID: parsed.keyID,
      counterparty: parsed.counterparty,
      privileged: parsed.privileged,
      privilegedReason: parsed.privilegedReason,
      operation: parsed.operation,
      point: parsed.point
    }
    if (authorization.securityLevel === 0 && !authorization.privileged) return

    const scope = JSON.stringify([
      authorization.originator,
      authorization.securityLevel,
      authorization.logicalProtocolID,
      authorization.securityLevel === 2 ? authorization.counterparty : '*',
      authorization.privileged ? 'privileged' : 'primary',
      authorization.privileged ? authorization.privilegedReason : null
    ])
    const now = Date.now()
    for (const [cachedScope, cachedExpiry] of this.#grants) {
      if (cachedExpiry > now) break
      this.#grants.delete(cachedScope)
    }
    const expiry = this.#grants.get(scope)
    if (expiry != null && expiry > now) return
    this.#grants.delete(scope)

    if (parsed.args.seekPermission === false) {
      throw new Error('ECPM: permission is required and seekPermission is false')
    }
    if (this.#authorize == null) {
      throw new Error('ECPM: no authorization handler is configured')
    }

    let pending = this.#pendingGrants.get(scope)
    if (pending == null) {
      if (this.#pendingGrants.size >= MAX_PENDING_GRANTS) {
        throw new Error('ECPM: authorization queue is full')
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
    if (approved !== true) throw new Error('ECPM: user denied permission')
    this.#grants.delete(scope)
    if (this.#grants.size >= MAX_CACHED_GRANTS) {
      this.#grants.delete(this.#grants.keys().next().value!)
    }
    this.#grants.set(scope, Date.now() + this.#authorizationTTL)
  }

  async #selectKeyDeriver(parsed: ParsedEcpmRequest): Promise<EcpmKeyDeriver> {
    if (!parsed.privileged) return this.#keyDeriver
    if (this.#privilegedKeyDeriver == null) {
      throw new Error('ECPM: privileged key derivation is unavailable')
    }
    const deriver = await this.#privilegedKeyDeriver(parsed.privilegedReason!)
    if (deriver == null || typeof deriver.derivePrivateKey !== 'function') {
      throw new Error('ECPM: privileged key provider returned an invalid deriver')
    }
    return deriver
  }

  #multiply(
    point: Point,
    derivedKey: ReturnType<EcpmKeyDeriver['derivePrivateKey']>,
    operation: ParsedEcpmRequest['operation']
  ): PubKeyHex {
    const scalar =
      operation === 'remove' ? derivedKey.invm(CURVE.n) : new BigNumber(derivedKey.toHex(), 16)
    const result = point.mul(scalar)
    if (result.isInfinity()) {
      throw new Error('ECPM: result is the point at infinity')
    }
    return result.encode(true, 'hex') as PubKeyHex
  }
}
