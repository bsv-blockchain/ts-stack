import type { PubKeyHex, SecurityLevel } from '@bsv/sdk'
import PublicKey from '@bsv/sdk/primitives/PublicKey'
import type {
  PermissionsModule,
  PermissionsModuleNext,
  PermissionsModuleRequest
} from '@bsv/wallet-toolbox-client'
import { hexToBytes, wipe } from './bytes.js'
import {
  decodePushes,
  decodeScriptNumber,
  pushScriptNumber,
  pushesToNumbers
} from './scriptNumber.js'
import { deriveRabinFactors, factorsToBigints, rabinSign, type RabinModulusBits } from './rabin.js'
import type { RabinFactors } from './primes.js'
import type {
  ParsedRabinRequest,
  RabinAuthorizationRequest,
  RabinKeyDeriver,
  RabinOperation,
  RabinPermissionModuleOptions
} from './types.js'

const RABIN_PATTERN = /^p rabin (key|sign) (2048|3072|4096) ([a-z0-9]+(?: [a-z0-9]+)*)$/
const MAX_PROTOCOL_BYTES = 400
const SIGN_PREFIX_BYTES = 18
const MAX_LOGICAL_PROTOCOL_BYTES = MAX_PROTOCOL_BYTES - SIGN_PREFIX_BYTES
const MIN_LOGICAL_PROTOCOL_BYTES = 5
const DEFAULT_AUTHORIZATION_TTL = 5 * 60 * 1000
const MAX_AUTHORIZATION_TTL = 24 * 60 * 60 * 1000
const MAX_CACHED_GRANTS = 1024
const MAX_PENDING_GRANTS = 64
const DEFAULT_CACHED_KEYS = 32
const MAX_CACHED_KEYS_LIMIT = 128
const DEFAULT_INFLIGHT = 4
const MAX_INFLIGHT_LIMIT = 16
const MAX_ORIGINATOR_BYTES = 1024
const MAX_MESSAGE_BYTES = 65_536
const SECP256K1_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn
// eslint-disable-next-line no-control-regex -- these are the ASCII controls being rejected.
const ASCII_CONTROL = /[\0-\x1f\x7f]/
const UTF8 = new TextEncoder()

const LOCKED = 'Rabin: module was locked during key generation'

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

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

function assertCompressedKey(pointHex: string): void {
  if (!/^0[23][0-9a-f]{64}$/.test(pointHex)) {
    throw new Error(
      'Rabin: counterparty must be self, anyone, or a lowercase compressed public key'
    )
  }
  if (BigInt(`0x${pointHex.slice(2)}`) >= SECP256K1_P) {
    throw new Error('Rabin: counterparty x is not a canonical field element')
  }
  try {
    PublicKey.fromString(pointHex)
  } catch {
    throw new Error('Rabin: counterparty is not a valid secp256k1 public key')
  }
}

function readBytes(value: unknown, label: string, maximum: number): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length > maximum) throw new Error(`Rabin: ${label} exceeds ${maximum} bytes`)
    return value.slice()
  }
  if (!Array.isArray(value)) throw new Error(`Rabin: ${label} must be a dense byte array`)
  if (value.length > maximum) throw new Error(`Rabin: ${label} exceeds ${maximum} bytes`)
  const out = new Uint8Array(value.length)
  for (let i = 0; i < value.length; i++) {
    const byte = value[i]
    if (!Object.hasOwn(value, i) || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      throw new Error(`Rabin: ${label} must be a dense array of bytes`)
    }
    out[i] = byte
  }
  return out
}

function rejectProhibitedFields(args: Record<string, unknown>): void {
  if (args.identityKey !== undefined) throw new Error('Rabin: identityKey is prohibited')
  if (args.forSelf !== undefined) throw new Error('Rabin: forSelf is not defined for this module')
}

function readSecurityLevel(value: unknown): SecurityLevel {
  if (value === 0 || value === 1 || value === 2) return value
  throw new Error('Rabin: invalid protocolID')
}

function readProtocolName(protocolID: unknown): {
  securityLevel: SecurityLevel
  protocolName: string
} {
  if (!Array.isArray(protocolID) || protocolID.length !== 2) {
    throw new Error('Rabin: protocolID is required')
  }
  const securityLevel = readSecurityLevel(protocolID[0])
  const protocolName = protocolID[1]
  if (typeof protocolName !== 'string') throw new Error('Rabin: invalid protocolID')
  const protocolBytes = UTF8.encode(protocolName).length
  if (protocolBytes < 5 || protocolBytes > MAX_PROTOCOL_BYTES) {
    throw new Error('Rabin: outer protocol ID must be between 5 and 400 bytes')
  }
  return { securityLevel, protocolName }
}

function readGrammar(protocolName: string): {
  operation: RabinOperation
  modulusBits: RabinModulusBits
  logicalProtocolID: string
} {
  const match = RABIN_PATTERN.exec(protocolName)
  if (match == null) {
    throw new Error(
      'Rabin: protocol must be p rabin <key|sign> <2048|3072|4096> <logicalProtocolID>'
    )
  }
  const logicalProtocolID = match[3] as string
  const logicalBytes = UTF8.encode(logicalProtocolID).length
  if (logicalBytes < MIN_LOGICAL_PROTOCOL_BYTES || logicalBytes > MAX_LOGICAL_PROTOCOL_BYTES) {
    throw new Error(
      `Rabin: logical protocol ID must be between ${MIN_LOGICAL_PROTOCOL_BYTES} and ${MAX_LOGICAL_PROTOCOL_BYTES} bytes`
    )
  }
  if (logicalProtocolID.endsWith(' protocol')) {
    throw new Error('Rabin: invalid logical protocol ID')
  }
  return {
    operation: match[1] as RabinOperation,
    modulusBits: Number(match[2]) as RabinModulusBits,
    logicalProtocolID
  }
}

function readKeyID(value: unknown): string {
  if (typeof value !== 'string' || UTF8.encode(value).length < 1) {
    throw new Error('Rabin: keyID is required')
  }
  if (UTF8.encode(value).length > 800) throw new Error('Rabin: keyID exceeds 800 bytes')
  return value
}

function readCounterparty(value: unknown): PubKeyHex | 'self' | 'anyone' {
  const counterparty = (value ?? 'self') as PubKeyHex | 'self' | 'anyone'
  if (counterparty === 'self' || counterparty === 'anyone') return counterparty
  if (typeof counterparty !== 'string') {
    throw new TypeError('Rabin: counterparty must be self, anyone, or a compressed public key')
  }
  assertCompressedKey(counterparty)
  return counterparty
}

function readPrivilegedReason(reason: unknown): string {
  if (typeof reason !== 'string') {
    throw new TypeError('Rabin: privilegedReason is required for privileged operations')
  }
  const reasonBytes = UTF8.encode(reason).length
  if (reasonBytes < 5 || reasonBytes > 50) {
    throw new Error('Rabin: privilegedReason must be between 5 and 50 bytes')
  }
  return reason
}

function readPrivilege(args: Record<string, unknown>): {
  privileged: boolean
  privilegedReason: string | undefined
} {
  if (args.privileged === true) {
    return { privileged: true, privilegedReason: readPrivilegedReason(args.privilegedReason) }
  }
  const reason = args.privilegedReason
  if (reason !== undefined && typeof reason !== 'string') {
    throw new TypeError('Rabin: privilegedReason must be a string')
  }
  return { privileged: false, privilegedReason: typeof reason === 'string' ? reason : undefined }
}

function assertSeekPermission(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError('Rabin: seekPermission must be a boolean')
  }
}

function readPlaintext(operation: RabinOperation, plaintext: unknown): Uint8Array {
  const message = readBytes(plaintext, 'plaintext', MAX_MESSAGE_BYTES)
  if (operation === 'key' && message.length !== 0) {
    throw new Error('Rabin: key requests require an empty plaintext')
  }
  return message
}

function authorizationScope(authorization: RabinAuthorizationRequest): string {
  const levelTwo = authorization.securityLevel === 2
  const privileged = authorization.privileged
  return JSON.stringify([
    authorization.originator,
    authorization.securityLevel,
    authorization.logicalProtocolID,
    authorization.keyID,
    authorization.modulusBits,
    authorization.operation,
    levelTwo ? authorization.counterparty : '*',
    privileged ? 'privileged' : 'primary',
    privileged ? authorization.privilegedReason : null
  ])
}

/**
 * BRC-206 `p rabin` semantic module.
 *
 * `encrypt` is the only accepted BRC-100 method. `key` returns the modulus and `sign` returns a
 * canonical Rabin signature. `decrypt` is rejected because a square-root oracle would factor `n`.
 */
export class RabinPermissionModule implements PermissionsModule {
  readonly capabilities: Readonly<Record<string, string>> = { 'brc206-rabin': 'encrypt' }
  readonly #keyDeriver: RabinKeyDeriver
  readonly #privilegedKeyDeriver: RabinPermissionModuleOptions['privilegedKeyDeriver']
  readonly #authorize: RabinPermissionModuleOptions['authorize']
  readonly #authorizationTTL: number
  readonly #maxCachedKeys: number
  readonly #maxInflight: number
  readonly #grants = new Map<string, number>()
  readonly #pendingGrants = new Map<string, Promise<boolean>>()
  readonly #keys = new Map<string, RabinFactors>()
  readonly #inflight = new Map<string, Promise<RabinFactors>>()
  #epoch = 0

  constructor(options: RabinPermissionModuleOptions) {
    const owned = dataRecord(options, 'Rabin options')
    const keyDeriver = owned.keyDeriver as RabinKeyDeriver | undefined
    if (keyDeriver == null || typeof keyDeriver.derivePrivateKey !== 'function') {
      throw new TypeError('Rabin: keyDeriver with derivePrivateKey is required')
    }
    const authorizationTTL = owned.authorizationTTL ?? DEFAULT_AUTHORIZATION_TTL
    if (
      typeof authorizationTTL !== 'number' ||
      !Number.isSafeInteger(authorizationTTL) ||
      authorizationTTL <= 0 ||
      authorizationTTL > MAX_AUTHORIZATION_TTL
    ) {
      throw new RangeError('Rabin: authorizationTTL must be between 1 ms and 24 hours')
    }
    const privilegedKeyDeriver = owned.privilegedKeyDeriver
    if (privilegedKeyDeriver !== undefined && typeof privilegedKeyDeriver !== 'function') {
      throw new TypeError('Rabin: privilegedKeyDeriver must be a function')
    }
    const authorize = owned.authorize
    if (authorize !== undefined && typeof authorize !== 'function') {
      throw new TypeError('Rabin: authorize must be a function')
    }
    this.#keyDeriver = keyDeriver
    this.#privilegedKeyDeriver =
      privilegedKeyDeriver as RabinPermissionModuleOptions['privilegedKeyDeriver']
    this.#authorize = authorize as RabinPermissionModuleOptions['authorize']
    this.#authorizationTTL = authorizationTTL
    this.#maxCachedKeys = boundedInteger(
      owned.maxCachedKeys ?? DEFAULT_CACHED_KEYS,
      'Rabin: maxCachedKeys',
      1,
      MAX_CACHED_KEYS_LIMIT
    )
    this.#maxInflight = boundedInteger(
      owned.maxInflightKeygens ?? DEFAULT_INFLIGHT,
      'Rabin: maxInflightKeygens',
      1,
      MAX_INFLIGHT_LIMIT
    )
  }

  /** Drops grants, in-flight work, and every cached factor. Cached secret bytes are overwritten. */
  dispose(): void {
    this.#clearSecrets()
  }

  /** Same secret-clearing path as {@link dispose}. Later requests derive again after authorization. */
  lock(): void {
    this.#clearSecrets()
  }

  async handleRequest(
    request: PermissionsModuleRequest,
    _next: PermissionsModuleNext
  ): Promise<{ ciphertext: number[] }> {
    const ownedRequest = dataRecord(request, 'Rabin request')
    if (ownedRequest.method !== 'encrypt') {
      if (ownedRequest.method === 'decrypt') {
        throw new Error(
          'Rabin: decrypt is rejected because Rabin decryption is a square-root oracle'
        )
      }
      throw new Error(
        `Rabin: ${String(ownedRequest.method)} is not permitted in the p rabin namespace`
      )
    }
    if (typeof ownedRequest.originator !== 'string' || ownedRequest.originator.length === 0) {
      throw new Error('Rabin: originator is required')
    }
    if (
      UTF8.encode(ownedRequest.originator).length > MAX_ORIGINATOR_BYTES ||
      ASCII_CONTROL.test(ownedRequest.originator)
    ) {
      throw new Error('Rabin: originator is invalid or too long')
    }

    const parsed = this.#parseRequest(ownedRequest.args)
    await this.#ensureAuthorized(parsed, ownedRequest.originator)
    const factors = await this.#factors(parsed)
    return { ciphertext: await this.#carry(parsed, factors) }
  }

  onRequest(request: PermissionsModuleRequest): Promise<{ args: object }> {
    return Promise.resolve({ args: request.args })
  }

  onResponse(result: unknown): Promise<unknown> {
    return Promise.resolve(result)
  }

  #clearSecrets(): void {
    this.#epoch++
    for (const factors of this.#keys.values()) factors.wipe()
    this.#keys.clear()
    this.#inflight.clear()
    this.#grants.clear()
    this.#pendingGrants.clear()
  }

  #parseRequest(rawArgs: unknown): ParsedRabinRequest {
    const args = dataRecord(rawArgs, 'Rabin: encrypt arguments')
    rejectProhibitedFields(args)
    const protocol = readProtocolName(args.protocolID)
    const grammar = readGrammar(protocol.protocolName)
    const keyID = readKeyID(args.keyID)
    const counterparty = readCounterparty(args.counterparty)
    const privilege = readPrivilege(args)
    assertSeekPermission(args.seekPermission)
    return {
      args: args as unknown as ParsedRabinRequest['args'],
      operation: grammar.operation,
      modulusBits: grammar.modulusBits,
      logicalProtocolID: grammar.logicalProtocolID,
      derivationProtocolID: [protocol.securityLevel, `p rabin ${grammar.logicalProtocolID}`],
      keyID,
      counterparty,
      privileged: privilege.privileged,
      privilegedReason: privilege.privilegedReason,
      message: readPlaintext(grammar.operation, args.plaintext)
    }
  }

  #dropExpiredGrants(now: number): void {
    for (const [cachedScope, cachedExpiry] of this.#grants) {
      if (cachedExpiry > now) break
      this.#grants.delete(cachedScope)
    }
  }

  #rememberGrant(scope: string): void {
    this.#grants.delete(scope)
    if (this.#grants.size >= MAX_CACHED_GRANTS) {
      this.#grants.delete(this.#grants.keys().next().value as string)
    }
    this.#grants.set(scope, Date.now() + this.#authorizationTTL)
  }

  async #requestApproval(scope: string, authorization: RabinAuthorizationRequest): Promise<void> {
    if (this.#authorize == null) {
      throw new Error('Rabin: no authorization handler is configured')
    }
    let pending = this.#pendingGrants.get(scope)
    if (pending == null) {
      if (this.#pendingGrants.size >= MAX_PENDING_GRANTS) {
        throw new Error('Rabin: authorization queue is full')
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
    if (approved !== true) throw new Error('Rabin: user denied permission')
    this.#rememberGrant(scope)
  }

  async #ensureAuthorized(parsed: ParsedRabinRequest, originator: string): Promise<void> {
    const authorization: RabinAuthorizationRequest = {
      originator,
      securityLevel: parsed.derivationProtocolID[0],
      logicalProtocolID: parsed.logicalProtocolID,
      keyID: parsed.keyID,
      counterparty: parsed.counterparty,
      privileged: parsed.privileged,
      privilegedReason: parsed.privilegedReason,
      operation: parsed.operation,
      modulusBits: parsed.modulusBits
    }
    if (authorization.securityLevel === 0 && !authorization.privileged) return
    const scope = authorizationScope(authorization)
    const now = Date.now()
    this.#dropExpiredGrants(now)
    const expiry = this.#grants.get(scope)
    if (expiry != null && expiry > now) return
    this.#grants.delete(scope)
    if (parsed.args.seekPermission === false) {
      throw new Error('Rabin: permission is required and seekPermission is false')
    }
    await this.#requestApproval(scope, authorization)
  }

  async #selectKeyDeriver(parsed: ParsedRabinRequest): Promise<RabinKeyDeriver> {
    if (!parsed.privileged) return this.#keyDeriver
    if (this.#privilegedKeyDeriver == null) {
      throw new Error('Rabin: privileged key derivation is unavailable')
    }
    const deriver = await this.#privilegedKeyDeriver(parsed.privilegedReason as string)
    if (deriver == null || typeof deriver.derivePrivateKey !== 'function') {
      throw new Error('Rabin: privileged key provider returned an invalid deriver')
    }
    return deriver
  }

  #materialScope(parsed: ParsedRabinRequest): string {
    return JSON.stringify([
      parsed.derivationProtocolID[0],
      parsed.logicalProtocolID,
      parsed.keyID,
      parsed.counterparty,
      parsed.privileged ? 'privileged' : 'primary',
      parsed.privileged ? parsed.privilegedReason : null,
      parsed.modulusBits
    ])
  }

  #remember(scope: string, factors: RabinFactors): void {
    while (this.#keys.size >= this.#maxCachedKeys) {
      const oldest = this.#keys.keys().next().value as string
      const evicted = this.#keys.get(oldest) as RabinFactors
      evicted.wipe()
      this.#keys.delete(oldest)
    }
    this.#keys.set(scope, factors)
  }

  #factors(parsed: ParsedRabinRequest): Promise<RabinFactors> {
    const scope = this.#materialScope(parsed)
    const cached = this.#keys.get(scope)
    if (cached != null) {
      this.#keys.delete(scope)
      this.#keys.set(scope, cached)
      return Promise.resolve(cached)
    }
    const existing = this.#inflight.get(scope)
    if (existing != null) return existing
    if (this.#inflight.size >= this.#maxInflight) {
      return Promise.reject(new Error('Rabin: key generation queue is full'))
    }

    const epoch = this.#epoch
    let resolveFactors!: (factors: RabinFactors) => void
    let rejectFactors!: (error: unknown) => void
    const pending = new Promise<RabinFactors>((resolve, reject) => {
      resolveFactors = resolve
      rejectFactors = reject
    })
    this.#inflight.set(scope, pending)
    void this.#generate(parsed, epoch).then(
      factors => {
        if (epoch !== this.#epoch) {
          factors.wipe()
          rejectFactors(new Error(LOCKED))
          return
        }
        this.#remember(scope, factors)
        resolveFactors(factors)
      },
      error => {
        rejectFactors(error instanceof Error ? error : new Error('Rabin: key generation failed'))
      }
    )
    void pending.then(
      () => undefined,
      () => undefined
    )
    void pending
      .finally(() => {
        if (this.#inflight.get(scope) === pending) this.#inflight.delete(scope)
      })
      .then(
        () => undefined,
        () => undefined
      )
    return pending
  }

  async #generate(parsed: ParsedRabinRequest, epoch: number): Promise<RabinFactors> {
    const deriver = await this.#selectKeyDeriver(parsed)
    if (epoch !== this.#epoch) throw new Error(LOCKED)
    const derived = deriver.derivePrivateKey(
      parsed.derivationProtocolID,
      parsed.keyID,
      parsed.counterparty
    )
    const seedHex = derived.toHex().toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(seedHex)) {
      throw new Error('Rabin: key deriver returned a non-canonical scalar')
    }
    const seed = hexToBytes(seedHex)
    try {
      if (epoch !== this.#epoch) throw new Error(LOCKED)
      return await deriveRabinFactors(seed, parsed.modulusBits)
    } finally {
      wipe(seed)
    }
  }

  async #carry(parsed: ParsedRabinRequest, factors: RabinFactors): Promise<number[]> {
    const { p, q, n } = factorsToBigints(factors)
    if (parsed.operation === 'key') return pushesToNumbers(pushScriptNumber(n))
    const signed = await rabinSign(parsed.message, p, q)
    return pushesToNumbers(
      concatPushes(pushScriptNumber(signed.signature), pushScriptNumber(signed.padding))
    )
  }
}

function concatPushes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length)
  out.set(left, 0)
  out.set(right, left.length)
  return out
}

export function decodeRabinKey(ciphertext: number[]): bigint {
  const pushes = decodePushes(Uint8Array.from(ciphertext))
  if (pushes.length !== 1) throw new Error('Rabin: key ciphertext must contain one script push')
  return decodeScriptNumber(pushes[0] as Uint8Array)
}

export function decodeRabinSignature(ciphertext: number[]): { signature: bigint; padding: bigint } {
  const pushes = decodePushes(Uint8Array.from(ciphertext))
  if (pushes.length !== 2) throw new Error('Rabin: sign ciphertext must contain two script pushes')
  return {
    signature: decodeScriptNumber(pushes[0] as Uint8Array),
    padding: decodeScriptNumber(pushes[1] as Uint8Array)
  }
}

export type { RabinModulusBits }
