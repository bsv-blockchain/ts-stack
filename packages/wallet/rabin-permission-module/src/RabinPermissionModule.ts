import type { SecurityLevel } from '@bsv/sdk'
import BigNumber from '@bsv/sdk/primitives/BigNumber'
import Curve from '@bsv/sdk/primitives/Curve'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import Point from '@bsv/sdk/primitives/Point'
import type {
  PermissionsModule,
  PermissionsModuleNext,
  PermissionsModuleRequest
} from '@bsv/wallet-toolbox-client'
import { encodeKeyResult, encodeSignResult } from './encoding.js'
import { GenerationRateLimiter, GenerationScheduler } from './generation.js'
import { forgetKey, KeyCache } from './keyCache.js'
import { generateKeySteps, signSteps, type RabinKey } from './rabin.js'
import { drivers } from './scheduling.js'
import type {
  ParsedRabinRequest,
  RabinAuthorizationRequest,
  RabinBits,
  RabinCounterparty,
  RabinKeyDeriver,
  RabinOperation,
  RabinPermissionModuleOptions
} from './types.js'

const PROTOCOL_PREFIX = 'p rabin '
const UNSUPPORTED_BASKETS_AND_LABELS = 'RABIN: p rabin baskets and labels are not supported'
const PROTOCOL_SHAPE = /^p rabin ([^ ]*) ([^ ]*) (.*)$/
const LOGICAL_PROTOCOL_PATTERN = /^[a-z0-9]+(?: [a-z0-9]+)*$/
const MAX_RABIN_PROTOCOL_BYTES = 290
const MIN_LOGICAL_PROTOCOL_BYTES = 5
const MAX_LOGICAL_PROTOCOL_BYTES = 272
const MAX_KEY_ID_BYTES = 800
const BITS_BY_TOKEN: Readonly<Record<string, RabinBits>> = Object.freeze({
  2048: 2048,
  3072: 3072,
  4096: 4096
})
const DEFAULT_AUTHORIZATION_TTL = 5 * 60 * 1000
const MAX_AUTHORIZATION_TTL = 24 * 60 * 60 * 1000
const DEFAULT_MAX_CACHED_KEYS = 32
const MAX_MAX_CACHED_KEYS = 1024
const DEFAULT_MAX_CACHED_KEYS_PER_ORIGINATOR = 8
const DEFAULT_MAX_PENDING_GENERATIONS = 8
const MAX_MAX_PENDING_GENERATIONS = 64
const DEFAULT_GENERATION_QUEUE_TIMEOUT = 60 * 1000
const MAX_GENERATION_QUEUE_TIMEOUT = 10 * 60 * 1000
const DEFAULT_ORIGINATOR_GENERATION_BURST = 4
const DEFAULT_ORIGINATOR_GENERATION_INTERVAL = 15 * 1000
const DEFAULT_GLOBAL_GENERATION_BURST = 10
const DEFAULT_GLOBAL_GENERATION_INTERVAL = 6 * 1000
const MAX_GENERATION_BURST = 1000
const MAX_GENERATION_INTERVAL = 24 * 60 * 60 * 1000
const BUSY = 'RABIN: key generation is busy'
const RATE_LIMITED = 'RABIN: key generation rate limit exceeded'
const RESET = 'RABIN: the module was reset during key generation'
const MIN_MESSAGE_BYTES = 1024 * 1024
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024
const MAX_CACHED_GRANTS = 1024
const MAX_PENDING_GRANTS = 64
const MAX_PENDING_GRANTS_PER_ORIGINATOR = 4
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

function integerOption(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  message: string
): number {
  const resolved = value ?? fallback
  if (
    typeof resolved !== 'number' ||
    !Number.isSafeInteger(resolved) ||
    resolved < min ||
    resolved > max
  ) {
    throw new RangeError(message)
  }
  return resolved
}

function isUint8Array(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]'
  )
}

function toHex(bytes: ArrayLike<number>): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/**
 * Implements the BRC-206 `p rabin` semantic permission module: wallet-held Rabin keys and
 * signatures carried over BRC-100 `encrypt`.
 */
export class RabinPermissionModule implements PermissionsModule {
  readonly #keyDeriver: RabinKeyDeriver
  readonly #privilegedKeyDeriver: RabinPermissionModuleOptions['privilegedKeyDeriver']
  readonly #authorize: RabinPermissionModuleOptions['authorize']
  readonly #authorizationTTL: number
  readonly #maxMessageBytes: number
  readonly #grants = new Map<string, number>()
  readonly #pendingGrants = new Map<string, Promise<boolean>>()
  readonly #pendingByOriginator = new Map<string, number>()
  readonly #keys: KeyCache
  readonly #generations: GenerationScheduler<RabinKey>
  readonly #rateLimiter: GenerationRateLimiter
  #epoch = 0

  constructor(options: RabinPermissionModuleOptions) {
    const ownedOptions = dataRecord(options, 'RABIN: options')
    const keyDeriver = ownedOptions.keyDeriver as RabinKeyDeriver | undefined
    if (keyDeriver == null || typeof keyDeriver.derivePrivateKey !== 'function') {
      throw new TypeError('RABIN: keyDeriver with derivePrivateKey is required')
    }
    const privilegedKeyDeriver = ownedOptions.privilegedKeyDeriver
    if (privilegedKeyDeriver !== undefined && typeof privilegedKeyDeriver !== 'function') {
      throw new TypeError('RABIN: privilegedKeyDeriver must be a function')
    }
    const authorize = ownedOptions.authorize
    if (authorize !== undefined && typeof authorize !== 'function') {
      throw new TypeError('RABIN: authorize must be a function')
    }
    this.#authorizationTTL = integerOption(
      ownedOptions.authorizationTTL,
      DEFAULT_AUTHORIZATION_TTL,
      1,
      MAX_AUTHORIZATION_TTL,
      'RABIN: authorizationTTL must be between 1 ms and 24 hours'
    )
    const maxCachedKeys = integerOption(
      ownedOptions.maxCachedKeys,
      DEFAULT_MAX_CACHED_KEYS,
      1,
      MAX_MAX_CACHED_KEYS,
      'RABIN: maxCachedKeys must be between 1 and 1024'
    )
    const maxCachedKeysPerOriginator = integerOption(
      ownedOptions.maxCachedKeysPerOriginator,
      Math.min(DEFAULT_MAX_CACHED_KEYS_PER_ORIGINATOR, maxCachedKeys),
      1,
      maxCachedKeys,
      'RABIN: maxCachedKeysPerOriginator must be between 1 and maxCachedKeys'
    )
    const maxPendingGenerations = integerOption(
      ownedOptions.maxPendingGenerations,
      DEFAULT_MAX_PENDING_GENERATIONS,
      1,
      MAX_MAX_PENDING_GENERATIONS,
      'RABIN: maxPendingGenerations must be between 1 and 64'
    )
    const generationQueueTimeout = integerOption(
      ownedOptions.generationQueueTimeout,
      DEFAULT_GENERATION_QUEUE_TIMEOUT,
      1,
      MAX_GENERATION_QUEUE_TIMEOUT,
      'RABIN: generationQueueTimeout must be between 1 ms and 10 minutes'
    )
    const burst = (value: unknown, fallback: number, name: string) =>
      integerOption(
        value,
        fallback,
        1,
        MAX_GENERATION_BURST,
        `RABIN: ${name} must be between 1 and 1000`
      )
    const interval = (value: unknown, fallback: number, name: string) =>
      integerOption(
        value,
        fallback,
        1,
        MAX_GENERATION_INTERVAL,
        `RABIN: ${name} must be between 1 ms and 24 hours`
      )
    const limits = {
      originatorBurst: burst(
        ownedOptions.originatorGenerationBurst,
        DEFAULT_ORIGINATOR_GENERATION_BURST,
        'originatorGenerationBurst'
      ),
      originatorInterval: interval(
        ownedOptions.originatorGenerationInterval,
        DEFAULT_ORIGINATOR_GENERATION_INTERVAL,
        'originatorGenerationInterval'
      ),
      globalBurst: burst(
        ownedOptions.globalGenerationBurst,
        DEFAULT_GLOBAL_GENERATION_BURST,
        'globalGenerationBurst'
      ),
      globalInterval: interval(
        ownedOptions.globalGenerationInterval,
        DEFAULT_GLOBAL_GENERATION_INTERVAL,
        'globalGenerationInterval'
      )
    }
    this.#keys = new KeyCache(maxCachedKeys, maxCachedKeysPerOriginator)
    this.#generations = new GenerationScheduler<RabinKey>(
      maxPendingGenerations,
      generationQueueTimeout,
      () => new Error(BUSY)
    )
    this.#rateLimiter = new GenerationRateLimiter(limits, Date.now())
    this.#maxMessageBytes = integerOption(
      ownedOptions.maxMessageBytes,
      MIN_MESSAGE_BYTES,
      MIN_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES,
      'RABIN: maxMessageBytes must be between 1 MiB and 256 MiB'
    )
    this.#keyDeriver = keyDeriver
    this.#privilegedKeyDeriver =
      privilegedKeyDeriver as RabinPermissionModuleOptions['privilegedKeyDeriver']
    this.#authorize = authorize as RabinPermissionModuleOptions['authorize']
  }

  /**
   * Clears grants, pending prompts, queued generations and every cached key; a running generation
   * stops at its next slice.
   */
  dispose(): void {
    this.#epoch++
    this.#grants.clear()
    this.#pendingGrants.clear()
    this.#pendingByOriginator.clear()
    this.#generations.clear(() => new Error(RESET))
    this.#keys.clear()
  }

  /** Semantic P-module entry point; never forwards to ordinary `encrypt`. */
  async handleRequest(
    request: PermissionsModuleRequest,
    _next: PermissionsModuleNext
  ): Promise<{ ciphertext: number[] }> {
    const ownedRequest = dataRecord(request, 'RABIN: request')
    if (ownedRequest.method !== 'encrypt') {
      throw new Error(
        `RABIN: ${String(ownedRequest.method)} is not permitted in the p rabin namespace; only encrypt is`
      )
    }
    const originator = ownedRequest.originator
    if (typeof originator !== 'string' || originator.length === 0) {
      throw new Error('RABIN: originator is required')
    }
    if (UTF8.encode(originator).length > MAX_ORIGINATOR_BYTES || ASCII_CONTROL.test(originator)) {
      throw new Error('RABIN: originator is invalid or too long')
    }

    const parsed = this.#parseRequest(ownedRequest.args)
    // Do not ask the user to approve a request that cannot be served.
    if (parsed.privileged && this.#privilegedKeyDeriver == null) {
      throw new Error('RABIN: privileged key derivation is unavailable')
    }
    await this.#ensureAuthorized(parsed, originator)
    const keyDeriver = await this.#selectKeyDeriver(parsed)
    const epoch = this.#epoch
    const key = await this.#getKey(parsed, keyDeriver, originator)
    if (parsed.operation === 'key') return { ciphertext: encodeKeyResult(key.n) }
    const { sig, padding } = await drivers.runCooperatively(signSteps(parsed.message, key), {
      isCancelled: () => epoch !== this.#epoch,
      cancelledError: () => new Error('RABIN: the module was reset during signing')
    })
    return { ciphertext: encodeSignResult(sig, padding) }
  }

  /**
   * Basket and label hook. BRC-98 dispatch skips the wallet's basket and label permission checks
   * for `p rabin` baskets and labels and calls this hook instead. The scheme defines none, so
   * every such request is refused rather than passed through unchecked.
   */
  async onRequest(_request: PermissionsModuleRequest): Promise<{ args: object }> {
    throw new Error(UNSUPPORTED_BASKETS_AND_LABELS)
  }

  /** See `onRequest`; never reached because `onRequest` refuses every request. */
  async onResponse(_result: unknown): Promise<unknown> {
    throw new Error(UNSUPPORTED_BASKETS_AND_LABELS)
  }

  #parseRequest(rawArgs: unknown): ParsedRabinRequest {
    const args = dataRecord(rawArgs, 'RABIN: encrypt arguments')
    const protocolID = args.protocolID
    if (!Array.isArray(protocolID) || protocolID.length !== 2) {
      throw new Error('RABIN: protocolID is required')
    }
    const [securityLevel, protocolName] = protocolID as [unknown, unknown]
    if (
      (securityLevel !== 0 && securityLevel !== 1 && securityLevel !== 2) ||
      typeof protocolName !== 'string'
    ) {
      throw new Error('RABIN: invalid protocolID')
    }
    if (UTF8.encode(protocolName).length > MAX_RABIN_PROTOCOL_BYTES) {
      throw new Error('RABIN: outer protocol ID exceeds 290 bytes')
    }
    const match = protocolName.startsWith(PROTOCOL_PREFIX)
      ? PROTOCOL_SHAPE.exec(protocolName)
      : null
    if (match == null) {
      throw new Error('RABIN: protocol must be p rabin <key|sign> <bits> <logicalProtocolID>')
    }
    const [, operationToken, bitsToken, logicalProtocolID] = match
    if (operationToken !== 'key' && operationToken !== 'sign') {
      throw new Error('RABIN: unknown operation; expected key or sign')
    }
    const operation: RabinOperation = operationToken
    const bits = Object.prototype.hasOwnProperty.call(BITS_BY_TOKEN, bitsToken)
      ? BITS_BY_TOKEN[bitsToken]
      : undefined
    if (bits === undefined || String(bits) !== bitsToken) {
      throw new Error('RABIN: unsupported key size; bits must be 2048, 3072, or 4096')
    }
    const logicalProtocolBytes = UTF8.encode(logicalProtocolID).length
    if (
      logicalProtocolBytes < MIN_LOGICAL_PROTOCOL_BYTES ||
      logicalProtocolBytes > MAX_LOGICAL_PROTOCOL_BYTES
    ) {
      throw new Error('RABIN: logical protocol ID must be between 5 and 272 bytes')
    }
    if (
      !LOGICAL_PROTOCOL_PATTERN.test(logicalProtocolID) ||
      logicalProtocolID.endsWith(' protocol')
    ) {
      throw new Error('RABIN: invalid logical protocol ID')
    }

    const keyID = args.keyID
    if (typeof keyID !== 'string') throw new Error('RABIN: keyID is required')
    const keyIDBytes = UTF8.encode(keyID).length
    if (keyIDBytes < 1) throw new Error('RABIN: keyID is required')
    if (keyIDBytes > MAX_KEY_ID_BYTES) throw new Error('RABIN: keyID exceeds 800 bytes')

    const counterparty = (args.counterparty ?? 'self') as RabinCounterparty
    if (counterparty !== 'self' && counterparty !== 'anyone') {
      if (typeof counterparty !== 'string') {
        throw new TypeError('RABIN: counterparty must be self, anyone, or a compressed public key')
      }
      this.#assertValidPoint(counterparty)
    }

    if (args.privileged !== undefined && typeof args.privileged !== 'boolean') {
      throw new TypeError('RABIN: privileged must be a boolean')
    }
    const privileged = args.privileged === true
    const privilegedReason = args.privilegedReason
    if (privileged) {
      if (typeof privilegedReason !== 'string') {
        throw new TypeError('RABIN: privilegedReason is required for privileged operations')
      }
      const reasonBytes = UTF8.encode(privilegedReason).length
      if (reasonBytes < 5 || reasonBytes > 50) {
        throw new Error('RABIN: privilegedReason must be between 5 and 50 bytes')
      }
    }
    if (args.seekPermission !== undefined && typeof args.seekPermission !== 'boolean') {
      throw new TypeError('RABIN: seekPermission must be a boolean')
    }

    return {
      operation,
      bits,
      logicalProtocolID,
      derivationProtocolID: [securityLevel, `p rabin ${logicalProtocolID}`],
      keyID,
      counterparty,
      privileged,
      privilegedReason: privileged ? (privilegedReason as string) : undefined,
      seekPermission: args.seekPermission !== false,
      message: this.#parsePlaintext(args.plaintext, operation)
    }
  }

  #parsePlaintext(plaintext: unknown, operation: RabinOperation): Uint8Array {
    let length: number
    if (isUint8Array(plaintext)) length = plaintext.length
    else if (Array.isArray(plaintext)) length = plaintext.length
    else throw new TypeError('RABIN: plaintext must be a byte array')
    if (operation === 'key' && length !== 0) {
      throw new Error('RABIN: plaintext must be empty for key')
    }
    if (length > this.#maxMessageBytes) {
      throw new Error(`RABIN: plaintext exceeds ${this.#maxMessageBytes} bytes`)
    }
    if (isUint8Array(plaintext)) return Uint8Array.from(plaintext)
    const message = new Uint8Array(length)
    const values = plaintext as unknown[]
    for (let i = 0; i < length; i++) {
      const byte = values[i]
      if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new TypeError('RABIN: plaintext must be a byte array')
      }
      message[i] = byte
    }
    return message
  }

  #assertValidPoint(pointHex: string): void {
    if (!/^0[23][0-9a-f]{64}$/.test(pointHex)) {
      throw new Error('RABIN: expected a lowercase 33-byte compressed secp256k1 point')
    }
    if (new BigNumber(pointHex.slice(2), 16).cmp(CURVE.p) >= 0) {
      throw new Error('RABIN: x is not a canonical field element')
    }
    let point: Point
    try {
      point = Point.fromString(pointHex)
    } catch {
      throw new Error('RABIN: point could not be decoded')
    }
    if (point.isInfinity() || !point.validate()) {
      throw new Error('RABIN: point is not a finite secp256k1 point')
    }
  }

  async #ensureAuthorized(parsed: ParsedRabinRequest, originator: string): Promise<void> {
    const securityLevel = parsed.derivationProtocolID[0] as SecurityLevel
    if (securityLevel === 0 && !parsed.privileged) return

    const scope = JSON.stringify([
      originator,
      securityLevel,
      parsed.logicalProtocolID,
      securityLevel === 2 ? parsed.counterparty : '*',
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
      throw new Error('RABIN: permission is required and seekPermission is false')
    }
    if (this.#authorize == null) {
      throw new Error('RABIN: no authorization handler is configured')
    }

    let pending = this.#pendingGrants.get(scope)
    if (pending == null) {
      if (this.#pendingGrants.size >= MAX_PENDING_GRANTS) {
        throw new Error('RABIN: authorization queue is full')
      }
      const originatorPending = this.#pendingByOriginator.get(originator) ?? 0
      if (originatorPending >= MAX_PENDING_GRANTS_PER_ORIGINATOR) {
        throw new Error('RABIN: too many pending authorizations for this app')
      }
      const authorization: RabinAuthorizationRequest = {
        originator,
        securityLevel,
        logicalProtocolID: parsed.logicalProtocolID,
        keyID: parsed.keyID,
        counterparty: parsed.counterparty,
        privileged: parsed.privileged,
        privilegedReason: parsed.privilegedReason,
        operation: parsed.operation,
        bits: parsed.bits
      }
      if (parsed.operation === 'sign') {
        authorization.messageLength = parsed.message.length
        authorization.messageSha256 = toHex(sha256(parsed.message))
      }
      try {
        pending = Promise.resolve(this.#authorize(authorization))
      } catch (error) {
        pending = Promise.reject(error)
      }
      this.#pendingGrants.set(scope, pending)
      this.#pendingByOriginator.set(originator, originatorPending + 1)
      const counted = this.#pendingByOriginator
      const release = (): void => {
        const remaining = (counted.get(originator) ?? 1) - 1
        if (remaining > 0) counted.set(originator, remaining)
        else counted.delete(originator)
      }
      pending.then(release, release)
    }
    const epoch = this.#epoch
    let approved: boolean
    try {
      approved = await pending
    } finally {
      if (this.#pendingGrants.get(scope) === pending) this.#pendingGrants.delete(scope)
    }
    if (approved !== true) throw new Error('RABIN: user denied permission')
    if (epoch !== this.#epoch) throw new Error('RABIN: the module was reset during authorization')
    this.#grants.delete(scope)
    if (this.#grants.size >= MAX_CACHED_GRANTS) {
      this.#grants.delete(this.#grants.keys().next().value!)
    }
    this.#grants.set(scope, Date.now() + this.#authorizationTTL)
  }

  async #selectKeyDeriver(parsed: ParsedRabinRequest): Promise<RabinKeyDeriver> {
    if (!parsed.privileged) return this.#keyDeriver
    const deriver = await this.#privilegedKeyDeriver!(parsed.privilegedReason!)
    if (deriver == null || typeof deriver.derivePrivateKey !== 'function') {
      throw new Error('RABIN: privileged key provider returned an invalid deriver')
    }
    return deriver
  }

  /**
   * A copy of the key for the request: from the cache, by joining a generation that is running or
   * queued for the same key, or by admitting a new generation. A new generation must fit the
   * queue and the rate limits; both are checked after authorization and before derivation.
   * Privileged keys are never cached or joined.
   */
  async #getKey(
    parsed: ParsedRabinRequest,
    keyDeriver: RabinKeyDeriver,
    originator: string
  ): Promise<RabinKey> {
    const epoch = this.#epoch
    const identity = parsed.privileged
      ? undefined
      : JSON.stringify([
          'primary',
          parsed.derivationProtocolID[0],
          parsed.logicalProtocolID,
          parsed.keyID,
          parsed.counterparty,
          parsed.bits
        ])
    let pending: Promise<RabinKey> | undefined
    if (identity !== undefined) {
      const cached = this.#keys.get(identity)
      if (cached !== undefined) return cached
      pending = this.#generations.joinable(identity)
    }
    if (pending === undefined) {
      if (!this.#generations.hasCapacity()) throw new Error(BUSY)
      if (!this.#rateLimiter.tryAcquire(originator, Date.now())) throw new Error(RATE_LIMITED)
      pending = this.#generations.submit(identity, async () => {
        const key = await this.#generate(parsed, keyDeriver, epoch)
        // The cache owns its own copy; the generation's result object is never zeroed by it.
        if (identity !== undefined) this.#keys.set(identity, { ...key }, originator)
        return key
      })
    }
    const key = await pending
    if (epoch !== this.#epoch) throw new Error(RESET)
    return { ...key }
  }

  async #generate(
    parsed: ParsedRabinRequest,
    keyDeriver: RabinKeyDeriver,
    epoch: number
  ): Promise<RabinKey> {
    if (epoch !== this.#epoch) throw new Error(RESET)
    const derived = keyDeriver.derivePrivateKey(
      parsed.derivationProtocolID,
      parsed.keyID,
      parsed.counterparty
    )
    const seed = derived.toArray('be', 32)
    let key: RabinKey
    try {
      key = await drivers.runCooperatively(generateKeySteps(seed, parsed.bits), {
        isCancelled: () => epoch !== this.#epoch,
        cancelledError: () => new Error(RESET)
      })
    } finally {
      seed.fill(0)
    }
    if (epoch !== this.#epoch) {
      forgetKey(key)
      throw new Error(RESET)
    }
    return key
  }
}
