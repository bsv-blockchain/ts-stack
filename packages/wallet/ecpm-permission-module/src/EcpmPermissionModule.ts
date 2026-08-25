import {
  BigNumber,
  Curve,
  Point,
  Utils,
  type GetPublicKeyArgs,
  type PubKeyHex,
  type SecurityLevel
} from '@bsv/sdk'
import type {
  PermissionsModule,
  PermissionsModuleNext,
  PermissionsModuleRequest
} from '@bsv/wallet-toolbox-client'
import type {
  EcpmAuthorizationRequest,
  EcpmKeyDeriver,
  EcpmMultiplyInput,
  EcpmPermissionModuleOptions,
  ParsedEcpmRequest
} from './types.js'

const ECPM_PATTERN = /^p ecpm (apply|remove) (0[23][0-9a-f]{64}) ([a-z0-9]+(?: [a-z0-9]+)*)$/
const DEFAULT_AUTHORIZATION_TTL = 5 * 60 * 1000
const MAX_AUTHORIZATION_TTL = 24 * 60 * 60 * 1000

/** Implements the BRC-229 `p ecpm` semantic permission module. */
export class EcpmPermissionModule implements PermissionsModule {
  private readonly keyDeriver: EcpmKeyDeriver
  private readonly privilegedKeyDeriver: EcpmPermissionModuleOptions['privilegedKeyDeriver']
  private readonly authorize: EcpmPermissionModuleOptions['authorize']
  private readonly authorizationTTL: number
  private readonly grants = new Map<string, number>()
  private readonly pendingGrants = new Map<string, Promise<boolean>>()

  constructor(options: EcpmPermissionModuleOptions) {
    if (options?.keyDeriver == null || typeof options.keyDeriver.derivePrivateKey !== 'function') {
      throw new TypeError('ECPM: keyDeriver with derivePrivateKey is required')
    }
    const authorizationTTL = options.authorizationTTL ?? DEFAULT_AUTHORIZATION_TTL
    if (
      !Number.isSafeInteger(authorizationTTL) ||
      authorizationTTL <= 0 ||
      authorizationTTL > MAX_AUTHORIZATION_TTL
    ) {
      throw new RangeError('ECPM: authorizationTTL must be between 1 ms and 24 hours')
    }
    this.keyDeriver = options.keyDeriver
    this.privilegedKeyDeriver = options.privilegedKeyDeriver
    this.authorize = options.authorize
    this.authorizationTTL = authorizationTTL
  }

  /** Clears cached and pending authorization state. */
  dispose(): void {
    this.grants.clear()
    this.pendingGrants.clear()
  }

  /** Semantic P-module entry point; ECPM never forwards to ordinary `getPublicKey`. */
  async handleRequest(
    request: PermissionsModuleRequest,
    _next: PermissionsModuleNext
  ): Promise<{ publicKey: PubKeyHex }> {
    if (request.method !== 'getPublicKey') {
      throw new Error(`ECPM: ${request.method} is not permitted in the p ecpm namespace`)
    }
    if (typeof request.originator !== 'string' || request.originator.length === 0) {
      throw new Error('ECPM: originator is required')
    }

    const parsed = this.parseRequest(request.args)
    await this.ensureAuthorized(parsed, request.originator)
    const keyDeriver = await this.selectKeyDeriver(parsed)
    const derivedKey = keyDeriver.derivePrivateKey(
      parsed.derivationProtocolID,
      parsed.keyID,
      parsed.counterparty
    )
    return {
      publicKey: this.multiply({
        point: parsed.point,
        derivedKey,
        operation: parsed.operation
      })
    }
  }

  async onRequest(request: PermissionsModuleRequest): Promise<{ args: object }> {
    return { args: request.args }
  }

  async onResponse(result: unknown): Promise<unknown> {
    return result
  }

  private parseRequest(rawArgs: object): ParsedEcpmRequest {
    if (rawArgs == null || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
      throw new TypeError('ECPM: getPublicKey arguments must be an object')
    }
    const args = rawArgs as GetPublicKeyArgs
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
    if (!this.isSecurityLevel(securityLevel) || typeof protocolName !== 'string') {
      throw new Error('ECPM: invalid protocolID')
    }
    const match = ECPM_PATTERN.exec(protocolName)
    if (match == null) {
      throw new Error('ECPM: protocol must be p ecpm <apply|remove> <pointHex> <logicalProtocolID>')
    }

    const operation = match[1] as 'apply' | 'remove'
    const point = match[2] as PubKeyHex
    const logicalProtocolID = match[3]
    this.validateLogicalProtocol(logicalProtocolID)
    this.parseValidPoint(point)

    const keyID = args.keyID
    if (typeof keyID !== 'string' || Utils.toArray(keyID, 'utf8').length < 1) {
      throw new Error('ECPM: keyID is required')
    }
    if (Utils.toArray(keyID, 'utf8').length > 800) {
      throw new Error('ECPM: keyID exceeds 800 bytes')
    }

    const counterparty = (args.counterparty ?? 'self') as PubKeyHex | 'self' | 'anyone'
    this.validateCounterparty(counterparty)
    const privileged = args.privileged === true
    const privilegedReason = args.privilegedReason
    if (privileged) this.validatePrivilegedReason(privilegedReason)

    return {
      args,
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

  private validateLogicalProtocol(logicalProtocolID: string): void {
    const bytes = Utils.toArray(logicalProtocolID, 'utf8').length
    if (bytes < 5 || bytes > 273) {
      throw new Error('ECPM: logical protocol ID must be between 5 and 273 bytes')
    }
    if (
      logicalProtocolID.includes('  ') ||
      logicalProtocolID.endsWith(' protocol') ||
      !/^[a-z0-9 ]+$/.test(logicalProtocolID)
    ) {
      throw new Error('ECPM: invalid logical protocol ID')
    }
  }

  private validateCounterparty(counterparty: PubKeyHex | 'self' | 'anyone'): void {
    if (counterparty === 'self' || counterparty === 'anyone') return
    if (typeof counterparty !== 'string') {
      throw new TypeError('ECPM: counterparty must be self, anyone, or a compressed public key')
    }
    this.parseValidPoint(counterparty)
  }

  private validatePrivilegedReason(reason: string | undefined): void {
    if (typeof reason !== 'string') {
      throw new TypeError('ECPM: privilegedReason is required for privileged operations')
    }
    const bytes = Utils.toArray(reason, 'utf8').length
    if (bytes < 5 || bytes > 50) {
      throw new Error('ECPM: privilegedReason must be between 5 and 50 bytes')
    }
  }

  private parseValidPoint(pointHex: PubKeyHex): Point {
    if (!/^0[23][0-9a-f]{64}$/.test(pointHex)) {
      throw new Error('ECPM: expected a lowercase 33-byte compressed secp256k1 point')
    }
    const curve = new Curve()
    if (new BigNumber(pointHex.slice(2), 16).cmp(curve.p) >= 0) {
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

  private async ensureAuthorized(parsed: ParsedEcpmRequest, originator: string): Promise<void> {
    const authorization = this.authorizationRequest(parsed, originator)
    if (authorization.securityLevel === 0 && !authorization.privileged) return

    const scope = this.authorizationScope(authorization)
    const now = Date.now()
    const expiry = this.grants.get(scope)
    if (expiry != null && expiry > now) return
    this.grants.delete(scope)

    if (parsed.args.seekPermission === false) {
      throw new Error('ECPM: permission is required and seekPermission is false')
    }
    if (this.authorize == null) {
      throw new Error('ECPM: no authorization handler is configured')
    }

    let pending = this.pendingGrants.get(scope)
    if (pending == null) {
      pending = Promise.resolve(this.authorize(authorization))
      this.pendingGrants.set(scope, pending)
    }
    let approved: boolean
    try {
      approved = await pending
    } finally {
      if (this.pendingGrants.get(scope) === pending) this.pendingGrants.delete(scope)
    }
    if (approved !== true) throw new Error('ECPM: user denied permission')
    this.grants.set(scope, Date.now() + this.authorizationTTL)
  }

  private authorizationRequest(
    parsed: ParsedEcpmRequest,
    originator: string
  ): EcpmAuthorizationRequest {
    return {
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
  }

  private authorizationScope(request: EcpmAuthorizationRequest): string {
    const counterparty = request.securityLevel === 2 ? request.counterparty : '*'
    return [
      request.originator,
      request.securityLevel,
      request.logicalProtocolID,
      counterparty,
      request.privileged ? 'privileged' : 'primary'
    ].join('\u0000')
  }

  private async selectKeyDeriver(parsed: ParsedEcpmRequest): Promise<EcpmKeyDeriver> {
    if (!parsed.privileged) return this.keyDeriver
    if (this.privilegedKeyDeriver == null) {
      throw new Error('ECPM: privileged key derivation is unavailable')
    }
    const deriver = await this.privilegedKeyDeriver(parsed.privilegedReason!)
    if (deriver == null || typeof deriver.derivePrivateKey !== 'function') {
      throw new Error('ECPM: privileged key provider returned an invalid deriver')
    }
    return deriver
  }

  private multiply(input: EcpmMultiplyInput): PubKeyHex {
    const point = this.parseValidPoint(input.point)
    const curve = new Curve()
    const scalar =
      input.operation === 'remove'
        ? input.derivedKey.invm(curve.n)
        : new BigNumber(input.derivedKey.toHex(), 16)
    const result = point.mul(scalar)
    if (result.isInfinity()) {
      throw new Error('ECPM: result is the point at infinity')
    }
    return result.encode(true, 'hex') as PubKeyHex
  }

  private isSecurityLevel(value: unknown): value is SecurityLevel {
    return value === 0 || value === 1 || value === 2
  }
}
