import {
  Hash,
  Utils,
  Random,
  SymmetricKey,
  AbortActionArgs,
  AbortActionResult,
  AcquireCertificateArgs,
  AcquireCertificateResult,
  AuthenticatedResult,
  CreateActionArgs,
  CreateActionResult,
  CreateHmacArgs,
  CreateHmacResult,
  CreateSignatureArgs,
  CreateSignatureResult,
  DiscoverByAttributesArgs,
  DiscoverByIdentityKeyArgs,
  DiscoverCertificatesResult,
  GetHeaderArgs,
  GetHeaderResult,
  GetHeightResult,
  GetNetworkResult,
  GetPublicKeyArgs,
  GetPublicKeyResult,
  GetVersionResult,
  InternalizeActionArgs,
  InternalizeActionResult,
  ListActionsArgs,
  ListActionsResult,
  ListCertificatesArgs,
  ListCertificatesResult,
  ListOutputsArgs,
  ListOutputsResult,
  OriginatorDomainNameStringUnder250Bytes,
  ProveCertificateArgs,
  ProveCertificateResult,
  RelinquishCertificateArgs,
  RelinquishCertificateResult,
  RelinquishOutputArgs,
  RelinquishOutputResult,
  RevealCounterpartyKeyLinkageArgs,
  RevealCounterpartyKeyLinkageResult,
  RevealSpecificKeyLinkageArgs,
  RevealSpecificKeyLinkageResult,
  SignActionArgs,
  SignActionResult,
  VerifyHmacArgs,
  VerifyHmacResult,
  VerifySignatureArgs,
  VerifySignatureResult,
  WalletDecryptArgs,
  WalletDecryptResult,
  WalletEncryptArgs,
  WalletEncryptResult,
  WalletInterface,
  OutpointString,
  PrivateKey,
  Signature,
  LookupResolver,
  LookupAnswer,
  LookupResolution,
  Transaction,
  PushDrop,
  CreateActionInput,
  SHIPBroadcaster,
  Telemetry,
  TelemetryConfig
} from '@bsv/sdk'
import { argon2id, pbkdf2, createSHA256, createSHA512 } from 'hash-wasm'
import { PrivilegedKeyManager } from './sdk/PrivilegedKeyManager'

/**
 * Number of rounds used in PBKDF2 for deriving password keys.
 */
export const PBKDF2_NUM_ROUNDS = 7777

/**
 * Default Argon2id parameters for password-key derivation (UMP v3).
 */
export const ARGON2ID_DEFAULT_ITERATIONS = 7
export const ARGON2ID_DEFAULT_MEMORY_KIB = 131072
export const ARGON2ID_DEFAULT_PARALLELISM = 1
export const ARGON2ID_DEFAULT_HASH_LENGTH = 32
export const ARGON2ID_MAX_ITERATIONS = 20
export const ARGON2ID_MAX_MEMORY_KIB = 262144
export const ARGON2ID_MAX_PARALLELISM = 16
export const KDF_MAX_HASH_LENGTH = 64
export const PBKDF2_MAX_ITERATIONS = 10_000_000
export const MAX_STATE_SNAPSHOT_BYTES = 16 * 1024 * 1024

function isPositiveIntegerInRange(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= maximum
}

function isValidKdfConfig(kdf: UMPToken['passwordKdf']): boolean {
  if (kdf == null) return false
  if (
    !isPositiveIntegerInRange(
      kdf.iterations,
      kdf.algorithm === 'argon2id' ? ARGON2ID_MAX_ITERATIONS : PBKDF2_MAX_ITERATIONS
    )
  ) {
    return false
  }
  if (kdf.algorithm === 'pbkdf2-sha512') {
    return kdf.hashLength === undefined || isPositiveIntegerInRange(kdf.hashLength, KDF_MAX_HASH_LENGTH)
  }
  if (kdf.algorithm !== 'argon2id') return false
  return (
    isPositiveIntegerInRange(kdf.memoryKiB, ARGON2ID_MAX_MEMORY_KIB) &&
    isPositiveIntegerInRange(kdf.parallelism, ARGON2ID_MAX_PARALLELISM) &&
    isPositiveIntegerInRange(kdf.hashLength, KDF_MAX_HASH_LENGTH)
  )
}

function isLikelyDerSignatureField(field: number[]): boolean {
  if (!field || field.length < 8 || field.length > 80) {
    return false
  }

  if (field[0] !== 0x30) {
    return false
  }

  const declaredLen = field[1]
  return declaredLen === field.length - 2
}

function stripVerifiedPushDropSignature(fields: number[][], lockingPublicKey: any): number[][] {
  if (fields.length <= 11) {
    return fields
  }

  const protocolFieldCount = fields.length - 1
  const trailingField = fields[protocolFieldCount]
  if (!trailingField || !isLikelyDerSignatureField(trailingField)) {
    return fields
  }

  try {
    let dataLength = 0
    for (let i = 0; i < protocolFieldCount; i++) {
      dataLength += fields[i].length
    }

    const dataToVerify = Array.from({ length: dataLength }, () => 0)
    let writeOffset = 0
    for (let i = 0; i < protocolFieldCount; i++) {
      const field = fields[i]
      for (const byte of field) {
        dataToVerify[writeOffset++] = byte
      }
    }

    const signature = Signature.fromDER(trailingField)

    if (signature.verify(dataToVerify, lockingPublicKey)) {
      return fields.slice(0, protocolFieldCount)
    }
  } catch {
    return fields
  }

  return fields
}

/**
 * PBKDF-2 that prefers WebCrypto and falls back to hash-wasm.
 *
 * @param passwordBytes   Raw password bytes.
 * @param salt            Salt bytes.
 * @param iterations      Number of rounds.
 * @param keyLen          Desired key length in bytes.
 * @param hash            Digest algorithm (default "sha512").
 * @returns               Derived key bytes.
 */
async function pbkdf2NativeOrWasm(
  passwordBytes: number[],
  salt: number[],
  iterations: number,
  keyLen: number,
  hash: 'sha256' | 'sha512' = 'sha512'
): Promise<number[]> {
  // ----- fast-path: WebCrypto (both browser & recent Node expose globalThis.crypto.subtle)
  const subtle = (globalThis as any)?.crypto?.subtle as SubtleCrypto | undefined
  if (subtle != null) {
    try {
      const baseKey = await subtle.importKey(
        'raw',
        new Uint8Array(passwordBytes),
        { name: 'PBKDF2' },
        /* extractable */ false,
        ['deriveBits']
      )

      const bits = await subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: new Uint8Array(salt),
          iterations,
          hash: hash.toUpperCase() as AlgorithmIdentifier
        },
        baseKey,
        keyLen * 8
      )
      return Array.from(new Uint8Array(bits))
    } catch {
      // WebCrypto is unavailable or refused the algorithm (e.g. non-secure context, old
      // Safari).  Fall through to the pure-JS hash-wasm implementation below.
    }
  }

  const hashFunction = hash === 'sha256' ? createSHA256() : createSHA512()
  const derived = await pbkdf2({
    password: new Uint8Array(passwordBytes),
    salt: new Uint8Array(salt),
    iterations,
    hashLength: keyLen,
    hashFunction,
    outputType: 'binary'
  })

  return Array.from(derived)
}

/**
 * Derives the password key from a password using the KDF specified in the UMP token.
 * For legacy tokens (no KDF metadata), uses PBKDF2 with fixed rounds (7777).
 * For v3 tokens, uses the algorithm specified in passwordKdf metadata.
 *
 * @param token          The UMP token containing KDF metadata and salt.
 * @param passwordBytes  Raw password bytes.
 * @param overrideKdf    Optional KDF config to override token/default settings.
 * @returns              Derived password key bytes.
 */
async function derivePasswordKey(
  token: Pick<UMPToken, 'passwordSalt' | 'passwordKdf'>,
  passwordBytes: number[],
  overrideKdf?: {
    algorithm?: 'pbkdf2-sha512' | 'argon2id'
    iterations?: number
    memoryKiB?: number
    parallelism?: number
    hashLength?: number
  }
): Promise<number[]> {
  const kdf = overrideKdf || token.passwordKdf
  if (kdf != null && !isValidKdfConfig(kdf as UMPToken['passwordKdf'])) {
    throw new Error('UMP token contains unsupported or unsafe KDF parameters.')
  }

  // Legacy token or explicit PBKDF2 request
  if (kdf == null || kdf.algorithm === 'pbkdf2-sha512') {
    return await pbkdf2NativeOrWasm(
      passwordBytes,
      token.passwordSalt,
      kdf?.iterations ?? PBKDF2_NUM_ROUNDS,
      32,
      'sha512'
    )
  }

  // Argon2id path (UMP v3)
  if (kdf.algorithm === 'argon2id') {
    const iterations = kdf.iterations ?? ARGON2ID_DEFAULT_ITERATIONS
    const memorySize = kdf.memoryKiB ?? ARGON2ID_DEFAULT_MEMORY_KIB
    const parallelism = kdf.parallelism ?? ARGON2ID_DEFAULT_PARALLELISM
    const hashLength = kdf.hashLength ?? ARGON2ID_DEFAULT_HASH_LENGTH

    const hash = await argon2id({
      password: new Uint8Array(passwordBytes),
      salt: new Uint8Array(token.passwordSalt),
      iterations,
      memorySize,
      parallelism,
      hashLength,
      outputType: 'binary'
    })

    return Array.from(hash)
  }

  throw new Error(`Unsupported KDF algorithm: ${(kdf as any).algorithm}`)
}

/**
 * Unique Identifier for the default profile (16 zero bytes).
 */
export const DEFAULT_PROFILE_ID = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]

/**
 * Describes the structure of a user profile within the wallet.
 */
export interface Profile {
  /**
   * User-defined name for the profile.
   */
  name: string

  /**
   * Unique 16-byte identifier for the profile.
   */
  id: number[]

  /**
   * 32-byte random pad XOR'd with the root primary key to derive the profile's primary key.
   */
  primaryPad: number[]

  /**
   * 32-byte random pad XOR'd with the root privileged key to derive the profile's privileged key.
   */
  privilegedPad: number[]

  /**
   * Timestamp (seconds since epoch) when the profile was created.
   */
  createdAt: number
}

function isByteArrayOfLength(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)
  )
}

function isValidProfile(value: unknown): value is Profile {
  if (value == null || typeof value !== 'object') return false
  const profile = value as Partial<Profile>
  return (
    typeof profile.name === 'string' &&
    profile.name.length > 0 &&
    profile.name.length <= 250 &&
    isByteArrayOfLength(profile.id, 16) &&
    isByteArrayOfLength(profile.primaryPad, 32) &&
    isByteArrayOfLength(profile.privilegedPad, 32) &&
    typeof profile.createdAt === 'number' &&
    Number.isFinite(profile.createdAt) &&
    profile.createdAt >= 0
  )
}

/**
 * Describes the structure of a User Management Protocol (UMP) token.
 */
export interface UMPToken {
  /**
   * Root Primary key encrypted by the XOR of the password and presentation keys.
   */
  passwordPresentationPrimary: number[]

  /**
   * Root Primary key encrypted by the XOR of the password and recovery keys.
   */
  passwordRecoveryPrimary: number[]

  /**
   * Root Primary key encrypted by the XOR of the presentation and recovery keys.
   */
  presentationRecoveryPrimary: number[]

  /**
   * Root Privileged key encrypted by the XOR of the password and primary keys.
   */
  passwordPrimaryPrivileged: number[]

  /**
   * Root Privileged key encrypted by the XOR of the presentation and recovery keys.
   */
  presentationRecoveryPrivileged: number[]

  /**
   * Hash of the presentation key.
   */
  presentationHash: number[]

  /**
   * PBKDF2 salt used in conjunction with the password to derive the password key.
   */
  passwordSalt: number[]

  /**
   * Hash of the recovery key.
   */
  recoveryHash: number[]

  /**
   * A copy of the presentation key encrypted with the root privileged key.
   */
  presentationKeyEncrypted: number[]

  /**
   * A copy of the recovery key encrypted with the root privileged key.
   */
  recoveryKeyEncrypted: number[]

  /**
   * A copy of the password key encrypted with the root privileged key.
   */
  passwordKeyEncrypted: number[]

  /**
   * Optional field containing the encrypted profile data.
   * JSON string -> Encrypted Bytes using root privileged key.
   */
  profilesEncrypted?: number[]

  /**
   * On-chain UMP protocol version (3 for tokens with KDF metadata).
   */
  umpVersion?: number

  /**
   * Password-based key derivation function metadata.
   * Present for UMP v3 tokens; absent for legacy tokens.
   */
  passwordKdf?: {
    algorithm: 'pbkdf2-sha512' | 'argon2id'
    iterations: number
    memoryKiB?: number
    parallelism?: number
    hashLength?: number
  }

  /**
   * Describes the token's location on-chain, if it's already been published.
   */
  currentOutpoint?: OutpointString
}

/**
 * Configuration options for KDF (Key Derivation Function) used in UMP tokens.
 */
export interface KdfConfig {
  /**
   * Algorithm to use for new UMP tokens.
   */
  algorithm?: 'pbkdf2-sha512' | 'argon2id'

  /**
   * Number of iterations/rounds.
   */
  iterations?: number

  /**
   * Memory size in KiB (Argon2id only).
   */
  memoryKiB?: number

  /**
   * Degree of parallelism (Argon2id only).
   */
  parallelism?: number

  /**
   * Hash output length in bytes.
   */
  hashLength?: number
}

/**
 * Describes a system capable of finding and updating UMP tokens on the blockchain.
 */
export interface UMPTokenInteractor {
  /**
   * Locates the latest valid copy of a UMP token (including its outpoint)
   * based on the presentation key hash.
   *
   * @param hash The hash of the presentation key.
   * @returns The UMP token if found; otherwise, undefined.
   * @throws Implementations should throw when absence cannot be established authoritatively.
   */
  findByPresentationKeyHash: (hash: number[]) => Promise<UMPToken | undefined>

  /**
   * Locates the latest valid copy of a UMP token (including its outpoint)
   * based on the recovery key hash.
   *
   * @param hash The hash of the recovery key.
   * @returns The UMP token if found; otherwise, undefined.
   * @throws Implementations should throw when absence cannot be established authoritatively.
   */
  findByRecoveryKeyHash: (hash: number[]) => Promise<UMPToken | undefined>

  /**
   * Creates (and optionally consumes the previous version of) a UMP token on-chain.
   *
   * @param wallet            The wallet that might be used to create a new token (MUST be operating under the DEFAULT profile).
   * @param adminOriginator   The domain name of the administrative originator.
   * @param token             The new UMP token to create.
   * @param oldTokenToConsume If provided, the old token that must be consumed in the same transaction.
   * @returns                 The newly created outpoint.
   */
  buildAndSend: (
    wallet: WalletInterface, // This wallet MUST be the one built for the default profile
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    token: UMPToken,
    oldTokenToConsume?: UMPToken
  ) => Promise<OutpointString>
}

export interface UMPTokenLookupDiagnostics {
  hostCount: number
  completedHosts: number
  successfulHosts: number
  emptyHosts: number
  failedHosts: number
  rejectedHosts: number
  freeformHosts: number
  outputCount: number
  correlationId?: string
}

export type UMPTokenLookupFailureReason =
  'lookup-unavailable' | 'lookup-incomplete' | 'token-malformed' | 'token-ambiguous'

/**
 * Raised when UMP absence cannot be established authoritatively.
 *
 * Callers must offer retry/recovery rather than treating this error as a new
 * account. Diagnostics contain counts only and never hashes, keys, or tokens.
 */
export class UMPTokenLookupError extends Error {
  readonly code = 'WERR_UMP_LOOKUP_INDETERMINATE'

  constructor(
    public readonly reason: UMPTokenLookupFailureReason,
    public readonly diagnostics: UMPTokenLookupDiagnostics,
    options?: { cause?: unknown }
  ) {
    super('Unable to determine whether the wallet account already exists. Retry or use account recovery.', options)
    this.name = 'UMPTokenLookupError'
  }
}

/**
 * @class OverlayUMPTokenInteractor
 *
 * A concrete implementation of the UMPTokenInteractor interface that interacts
 * with Overlay Services and the UMP (User Management Protocol) topic. This class
 * is responsible for:
 *
 * 1) Locating UMP tokens via overlay lookups (ls_users).
 * 2) Creating and publishing new or updated UMP token outputs on-chain under
 *    the "tm_users" topic.
 * 3) Consuming (spending) an old token if provided.
 */
export class OverlayUMPTokenInteractor implements UMPTokenInteractor {
  /**
   * A `LookupResolver` instance used to query overlay networks.
   */
  private readonly resolver: LookupResolver

  /**
   * A SHIP broadcaster that can be used to publish updated UMP tokens
   * under the `tm_users` topic to overlay service peers.
   */
  private readonly broadcaster: SHIPBroadcaster
  private readonly telemetry: Telemetry

  /**
   * Construct a new OverlayUMPTokenInteractor.
   *
   * @param resolver     A LookupResolver instance for performing overlay queries (ls_users).
   * @param broadcaster  A SHIPBroadcaster instance for sharing new or updated tokens across the `tm_users` overlay.
   */
  constructor(
    resolver: LookupResolver = new LookupResolver(),
    broadcaster: SHIPBroadcaster = new SHIPBroadcaster(['tm_users']),
    telemetry?: TelemetryConfig
  ) {
    this.resolver = resolver
    this.broadcaster = broadcaster
    this.telemetry = new Telemetry(telemetry)
  }

  /**
   * Finds a UMP token on-chain by the given presentation key hash, if it exists.
   * Uses the ls_users overlay service to perform the lookup.
   *
   * @param hash The 32-byte SHA-256 hash of the presentation key.
   * @returns A UMPToken object (including currentOutpoint) if found, otherwise undefined.
   */
  public async findByPresentationKeyHash(hash: number[]): Promise<UMPToken | undefined> {
    return await this.findToken(
      {
        service: 'ls_users',
        query: { presentationHash: Utils.toHex(hash) }
      },
      'presentation'
    )
  }

  /**
   * Finds a UMP token on-chain by the given recovery key hash, if it exists.
   * Uses the ls_users overlay service to perform the lookup.
   *
   * @param hash The 32-byte SHA-256 hash of the recovery key.
   * @returns A UMPToken object (including currentOutpoint) if found, otherwise undefined.
   */
  public async findByRecoveryKeyHash(hash: number[]): Promise<UMPToken | undefined> {
    return await this.findToken(
      {
        service: 'ls_users',
        query: { recoveryHash: Utils.toHex(hash) }
      },
      'recovery'
    )
  }

  private async findToken(
    question: { service: string; query: Record<string, string> },
    lookupKind: 'presentation' | 'recovery'
  ): Promise<UMPToken | undefined> {
    const correlationId = this.telemetry.enabled === true ? this.telemetry.createCorrelationId() : undefined
    const startedAt = Date.now()
    this.telemetry.capture({
      name: 'wallet-toolbox.ump.lookup.started',
      component: 'wallet-toolbox.ump',
      severity: 'debug',
      correlationId,
      attributes: { lookupKind }
    })

    let resolution: LookupResolution
    try {
      resolution = await this.resolver.queryDetailed(question, undefined, {
        waitForAllHosts: true,
        correlationId
      })
    } catch (error) {
      const diagnostics = this.emptyLookupDiagnostics(correlationId)
      this.captureLookupFailure(lookupKind, 'lookup-unavailable', diagnostics, startedAt, error)
      throw new UMPTokenLookupError('lookup-unavailable', diagnostics, { cause: error })
    }

    const diagnostics = this.toLookupDiagnostics(resolution)
    if (resolution.answer.outputs.length === 0) {
      const authoritative =
        resolution.progress.isFinal &&
        resolution.progress.hostCount > 0 &&
        resolution.progress.completedHosts === resolution.progress.hostCount &&
        resolution.progress.successfulHosts === resolution.progress.hostCount &&
        resolution.progress.emptyHosts === resolution.progress.hostCount &&
        resolution.progress.failedHosts === 0 &&
        resolution.progress.rejectedHosts === 0 &&
        resolution.progress.freeformHosts === 0

      if (!authoritative) {
        this.captureLookupFailure(lookupKind, 'lookup-incomplete', diagnostics, startedAt)
        throw new UMPTokenLookupError('lookup-incomplete', diagnostics)
      }

      this.telemetry.capture({
        name: 'wallet-toolbox.ump.lookup.completed',
        component: 'wallet-toolbox.ump',
        severity: 'info',
        correlationId: diagnostics.correlationId,
        attributes: {
          lookupKind,
          result: 'not-found',
          durationMs: Date.now() - startedAt,
          ...this.lookupDiagnosticAttributes(diagnostics)
        }
      })
      return undefined
    }

    const tokens = this.parseLookupAnswers(resolution.answer)
    const expectedHash =
      question.query[lookupKind === 'presentation' ? 'presentationHash' : 'recoveryHash'].toLowerCase()
    const everyOutputValidAndMatching =
      tokens.length === resolution.answer.outputs.length &&
      tokens.every(
        token =>
          Utils.toHex(lookupKind === 'presentation' ? token.presentationHash : token.recoveryHash).toLowerCase() ===
          expectedHash
      )
    if (!everyOutputValidAndMatching || tokens.length === 0) {
      this.captureLookupFailure(lookupKind, 'token-malformed', diagnostics, startedAt)
      throw new UMPTokenLookupError('token-malformed', diagnostics)
    }
    if (tokens.length !== 1) {
      const reason = 'token-ambiguous'
      this.captureLookupFailure(lookupKind, reason, diagnostics, startedAt)
      throw new UMPTokenLookupError(reason, diagnostics)
    }

    this.telemetry.capture({
      name: 'wallet-toolbox.ump.lookup.completed',
      component: 'wallet-toolbox.ump',
      severity: 'info',
      correlationId: diagnostics.correlationId,
      attributes: {
        lookupKind,
        result: 'found',
        durationMs: Date.now() - startedAt,
        ...this.lookupDiagnosticAttributes(diagnostics)
      }
    })
    return tokens[0]
  }

  private emptyLookupDiagnostics(correlationId?: string): UMPTokenLookupDiagnostics {
    return {
      hostCount: 0,
      completedHosts: 0,
      successfulHosts: 0,
      emptyHosts: 0,
      failedHosts: 0,
      rejectedHosts: 0,
      freeformHosts: 0,
      outputCount: 0,
      ...(correlationId !== undefined ? { correlationId } : {})
    }
  }

  private toLookupDiagnostics(resolution: LookupResolution): UMPTokenLookupDiagnostics {
    const progress = resolution.progress
    return {
      hostCount: progress.hostCount,
      completedHosts: progress.completedHosts,
      successfulHosts: progress.successfulHosts,
      emptyHosts: progress.emptyHosts,
      failedHosts: progress.failedHosts,
      rejectedHosts: progress.rejectedHosts,
      freeformHosts: progress.freeformHosts,
      outputCount: resolution.answer.outputs.length,
      ...(progress.correlationId !== undefined ? { correlationId: progress.correlationId } : {})
    }
  }

  private lookupDiagnosticAttributes(diagnostics: UMPTokenLookupDiagnostics): Record<string, number> {
    return {
      hostCount: diagnostics.hostCount,
      completedHosts: diagnostics.completedHosts,
      successfulHosts: diagnostics.successfulHosts,
      emptyHosts: diagnostics.emptyHosts,
      failedHosts: diagnostics.failedHosts,
      rejectedHosts: diagnostics.rejectedHosts,
      freeformHosts: diagnostics.freeformHosts,
      outputCount: diagnostics.outputCount
    }
  }

  private captureLookupFailure(
    lookupKind: 'presentation' | 'recovery' | 'outpoint',
    reason: UMPTokenLookupFailureReason,
    diagnostics: UMPTokenLookupDiagnostics,
    startedAt: number,
    error?: unknown
  ): void {
    this.telemetry.capture({
      name: 'wallet-toolbox.ump.lookup.indeterminate',
      component: 'wallet-toolbox.ump',
      severity: 'warn',
      correlationId: diagnostics.correlationId,
      attributes: {
        lookupKind,
        reason,
        durationMs: Date.now() - startedAt,
        ...this.lookupDiagnosticAttributes(diagnostics)
      },
      error
    })
  }

  /**
   * Creates or updates (replaces) a UMP token on-chain. If `oldTokenToConsume` is provided,
   * it is spent in the same transaction that creates the new token output. The new token is
   * then broadcast and published under the `tm_users` topic using a SHIP broadcast, ensuring
   * overlay participants see the updated token.
   *
   * @param wallet            The wallet used to build and sign the transaction (MUST be operating under the DEFAULT profile).
   * @param adminOriginator   The domain/FQDN of the administrative originator (wallet operator).
   * @param token             The new UMPToken to create on-chain.
   * @param oldTokenToConsume Optionally, an existing token to consume/spend in the same transaction.
   * @returns The outpoint of the newly created UMP token (e.g. "abcd1234...ef.0").
   */
  public async buildAndSend(
    wallet: WalletInterface, // This wallet MUST be the one built for the default profile
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    token: UMPToken,
    oldTokenToConsume?: UMPToken
  ): Promise<OutpointString> {
    // 1) Construct the data fields and PushDrop locking script for the new UMP token.
    const fields = this.buildUMPTokenFields(token)
    const script = await new PushDrop(wallet, adminOriginator).lock(
      fields,
      [2, 'admin user management token'],
      '1',
      'self',
      /* forSelf= */ true,
      /* includeSignature= */ true
    )
    const tokenOutput = [{ lockingScript: script.toHex(), satoshis: 1, outputDescription: 'New UMP token output' }]

    // 2) Resolve the old-token input (if provided) and create the action.
    const { resolvedOldToken, inputToken } = await this.resolveOldTokenInput(oldTokenToConsume)
    const inputs: CreateActionInput[] = resolvedOldToken?.currentOutpoint
      ? [
          {
            outpoint: resolvedOldToken.currentOutpoint,
            unlockingScriptLength: 73,
            inputDescription: 'Consume old UMP token'
          }
        ]
      : []

    const createResult = await this.createUMPAction(
      wallet,
      adminOriginator,
      inputs,
      tokenOutput,
      inputToken,
      resolvedOldToken
    )

    // 3) If the wallet fully processed it (no signable tx), broadcast and return.
    if (!createResult.signableTransaction) {
      return await this.broadcastFinishedUMPAction(createResult)
    }

    // 4) Sign and broadcast: with old token input or without.
    const reference = createResult.signableTransaction.reference
    const partialTx = Transaction.fromBEEF(createResult.signableTransaction.tx)
    if (resolvedOldToken?.currentOutpoint) {
      return await this.signAndBroadcastWithOldToken(wallet, adminOriginator, reference, partialTx)
    }
    return await this.signAndBroadcastNewToken(wallet, adminOriginator, reference)
  }

  /** Assembles the ordered number[][] fields array from a UMPToken. */
  private buildUMPTokenFields(token: UMPToken): number[][] {
    const fields: number[][] = []
    fields[0] = token.passwordSalt
    fields[1] = token.passwordPresentationPrimary
    fields[2] = token.passwordRecoveryPrimary
    fields[3] = token.presentationRecoveryPrimary
    fields[4] = token.passwordPrimaryPrivileged
    fields[5] = token.presentationRecoveryPrivileged
    fields[6] = token.presentationHash
    fields[7] = token.recoveryHash
    fields[8] = token.presentationKeyEncrypted
    fields[9] = token.passwordKeyEncrypted
    fields[10] = token.recoveryKeyEncrypted
    if (token.profilesEncrypted != null) fields[11] = token.profilesEncrypted
    if (token.umpVersion === 3 && token.passwordKdf != null) {
      const vi = token.profilesEncrypted == null ? 11 : 12
      fields[vi] = [token.umpVersion]
      fields[vi + 1] = Utils.toArray(token.passwordKdf.algorithm, 'utf8')
      const kdfParams: Record<string, number> = { iterations: token.passwordKdf.iterations }
      if (token.passwordKdf.memoryKiB !== undefined) kdfParams.memoryKiB = token.passwordKdf.memoryKiB
      if (token.passwordKdf.parallelism !== undefined) kdfParams.parallelism = token.passwordKdf.parallelism
      if (token.passwordKdf.hashLength !== undefined) kdfParams.hashLength = token.passwordKdf.hashLength
      fields[vi + 2] = Utils.toArray(JSON.stringify(kdfParams), 'utf8')
    }
    return fields
  }

  /** Looks up the old token on the overlay; returns undefined resolved token if not found. */
  private async resolveOldTokenInput(
    oldTokenToConsume?: UMPToken
  ): Promise<{ resolvedOldToken?: UMPToken; inputToken?: { beef: number[]; outputIndex: number } }> {
    if (!oldTokenToConsume?.currentOutpoint) return { resolvedOldToken: undefined, inputToken: undefined }
    const inputToken = await this.findByOutpoint(oldTokenToConsume.currentOutpoint)
    if (inputToken == null) {
      throw new Error('The previous UMP token could not be resolved; refusing to publish a duplicate token.')
    }
    return { resolvedOldToken: oldTokenToConsume, inputToken }
  }

  /** Creates the UMP action without dropping a required old-token input on failure. */
  private async createUMPAction(
    wallet: WalletInterface,
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    inputs: CreateActionInput[],
    outputs: Array<{ lockingScript: string; satoshis: number; outputDescription: string }>,
    inputToken: { beef: number[]; outputIndex: number } | undefined,
    resolvedOldToken: UMPToken | undefined
  ): Promise<Awaited<ReturnType<WalletInterface['createAction']>>> {
    try {
      return await wallet.createAction(
        {
          description: resolvedOldToken == null ? 'Create new UMP token' : 'Renew UMP token (consume old, create new)',
          inputs,
          outputs,
          inputBEEF: inputToken?.beef,
          options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
        },
        adminOriginator
      )
    } catch (error) {
      this.telemetry.capture({
        name: 'wallet-toolbox.ump.action.failed',
        component: 'wallet-toolbox.ump',
        severity: 'error',
        attributes: {
          operation: resolvedOldToken == null ? 'create' : 'renew',
          oldTokenInputRequired: resolvedOldToken != null
        },
        error
      })
      throw error
    }
  }

  /** Handles a fully-finalized (no signable tx) createAction result — broadcasts and returns outpoint. */
  private async broadcastFinishedUMPAction(
    createResult: Awaited<ReturnType<WalletInterface['createAction']>>
  ): Promise<OutpointString> {
    const finalTxid =
      createResult.txid || (createResult.tx != null ? Transaction.fromAtomicBEEF(createResult.tx).id('hex') : undefined)
    if (!finalTxid) throw new Error('No signableTransaction and no final TX found.')
    if (createResult.tx == null) throw new Error('No final TX data to broadcast.')
    const broadcastTx = Transaction.fromAtomicBEEF(createResult.tx)
    const result = await this.broadcaster.broadcast(broadcastTx)
    this.assertSuccessfulBroadcast(result, 'create-finalized')
    return `${finalTxid}.0`
  }

  /** Signs the old-token input and broadcasts — used during UMP token renewal. */
  private async signAndBroadcastWithOldToken(
    wallet: WalletInterface,
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    reference: string,
    partialTx: Transaction
  ): Promise<OutpointString> {
    const unlocker = new PushDrop(wallet, adminOriginator).unlock([2, 'admin user management token'], '1', 'self')
    const unlockingScript = await unlocker.sign(partialTx, 0)
    const signResult = await wallet.signAction(
      { reference, spends: { 0: { unlockingScript: unlockingScript.toHex() } } },
      adminOriginator
    )
    const finalTxid =
      signResult.txid || (signResult.tx == null ? '' : Transaction.fromAtomicBEEF(signResult.tx).id('hex'))
    if (!finalTxid) throw new Error('Could not finalize transaction for renewed UMP token.')
    if (signResult.tx == null) throw new Error('Final transaction data missing after signing renewed UMP token.')
    const result = await this.broadcaster.broadcast(Transaction.fromAtomicBEEF(signResult.tx))
    this.assertSuccessfulBroadcast(result, 'renew')
    return `${finalTxid}.0`
  }

  /** Signs without input spending and broadcasts — used when creating a brand-new UMP token. */
  private async signAndBroadcastNewToken(
    wallet: WalletInterface,
    adminOriginator: OriginatorDomainNameStringUnder250Bytes,
    reference: string
  ): Promise<OutpointString> {
    const signResult = await wallet.signAction({ reference, spends: {} }, adminOriginator)
    const finalTxid =
      signResult.txid || (signResult.tx == null ? '' : Transaction.fromAtomicBEEF(signResult.tx).id('hex'))
    if (!finalTxid) throw new Error('Failed to finalize new UMP token transaction.')
    if (signResult.tx == null) throw new Error('Final transaction data missing after signing new UMP token.')
    const result = await this.broadcaster.broadcast(Transaction.fromAtomicBEEF(signResult.tx))
    this.assertSuccessfulBroadcast(result, 'create')
    return `${finalTxid}.0`
  }

  private assertSuccessfulBroadcast(
    result: Awaited<ReturnType<SHIPBroadcaster['broadcast']>>,
    operation: 'create-finalized' | 'renew' | 'create'
  ): void {
    const succeeded = result.status === 'success'
    this.telemetry.capture({
      name: succeeded ? 'wallet-toolbox.ump.broadcast.completed' : 'wallet-toolbox.ump.broadcast.failed',
      component: 'wallet-toolbox.ump',
      severity: succeeded ? 'info' : 'error',
      attributes: {
        operation,
        outcome: result.status,
        ...(result.status === 'error' ? { code: result.code } : {})
      }
    })
    if (!succeeded) {
      throw new Error(`UMP token broadcast failed (${result.code}).`)
    }
  }

  /**
   * Attempts to parse a LookupAnswer from the UMP lookup service. If successful,
   * extracts the token fields from the resulting transaction and constructs
   * a UMPToken object.
   *
   * @param answer The LookupAnswer returned by a query to ls_users.
   * @returns The parsed UMPToken or `undefined` if none found/decodable.
   */
  private parseLookupAnswer(answer: LookupAnswer): UMPToken | undefined {
    return this.parseLookupAnswers(answer)[0]
  }

  private parseLookupAnswers(answer: LookupAnswer): UMPToken[] {
    if (answer.type !== 'output-list' || answer.outputs.length === 0) return []
    const tokens: UMPToken[] = []
    for (const output of answer.outputs) {
      const token = this.parseLookupOutput(output)
      if (token != null) tokens.push(token)
    }
    return tokens
  }

  private parseLookupOutput(output: LookupAnswer['outputs'][number]): UMPToken | undefined {
    try {
      const tx = Transaction.fromBEEF(output.beef)
      const txOutput = tx.outputs[output.outputIndex]
      if (txOutput == null) return undefined
      const decoded = PushDrop.decode(txOutput.lockingScript)
      if (decoded.fields == null || decoded.fields.length < 11 || decoded.fields.length > 16) {
        return undefined
      }

      const protocolFields = stripVerifiedPushDropSignature(decoded.fields, decoded.lockingPublicKey)
      if (
        protocolFields.length < 11 ||
        protocolFields.slice(0, 11).some(field => field.length === 0 || field.length > MAX_STATE_SNAPSHOT_BYTES)
      ) {
        return undefined
      }

      const hasV3MetadataWithProfiles =
        protocolFields.length >= 15 && protocolFields[12]?.length === 1 && protocolFields[12][0] === 3
      const hasV3MetadataWithoutProfiles =
        protocolFields.length >= 14 && protocolFields[11]?.length === 1 && protocolFields[11][0] === 3
      let kdfVersionFieldIndex = -1
      if (hasV3MetadataWithProfiles) {
        kdfVersionFieldIndex = 12
      } else if (hasV3MetadataWithoutProfiles) {
        kdfVersionFieldIndex = 11
      }

      const token: UMPToken = {
        passwordSalt: protocolFields[0],
        passwordPresentationPrimary: protocolFields[1],
        passwordRecoveryPrimary: protocolFields[2],
        presentationRecoveryPrimary: protocolFields[3],
        passwordPrimaryPrivileged: protocolFields[4],
        presentationRecoveryPrivileged: protocolFields[5],
        presentationHash: protocolFields[6],
        recoveryHash: protocolFields[7],
        presentationKeyEncrypted: protocolFields[8],
        passwordKeyEncrypted: protocolFields[9],
        recoveryKeyEncrypted: protocolFields[10],
        currentOutpoint: `${tx.id('hex')}.${output.outputIndex}`
      }
      if (token.presentationHash.length !== 32 || token.recoveryHash.length !== 32) return undefined

      const hasProfilesField =
        hasV3MetadataWithProfiles || (!hasV3MetadataWithoutProfiles && protocolFields[11] != null)
      if (hasProfilesField && protocolFields[11].length > 0) {
        if (protocolFields[11].length > MAX_STATE_SNAPSHOT_BYTES) return undefined
        token.profilesEncrypted = protocolFields[11]
      }

      if (kdfVersionFieldIndex !== -1) {
        const kdfAlgorithmField = protocolFields[kdfVersionFieldIndex + 1]
        const kdfParamsField = protocolFields[kdfVersionFieldIndex + 2]
        if (kdfAlgorithmField == null || kdfParamsField == null || kdfParamsField.length > 1024) {
          return undefined
        }
        const kdfParams = JSON.parse(Utils.toUTF8(kdfParamsField)) as Record<string, unknown>
        const passwordKdf: UMPToken['passwordKdf'] = {
          algorithm: Utils.toUTF8(kdfAlgorithmField) as 'pbkdf2-sha512' | 'argon2id',
          iterations: kdfParams.iterations as number,
          memoryKiB: kdfParams.memoryKiB as number | undefined,
          parallelism: kdfParams.parallelism as number | undefined,
          hashLength: kdfParams.hashLength as number | undefined
        }
        if (!isValidKdfConfig(passwordKdf)) return undefined
        token.umpVersion = 3
        token.passwordKdf = passwordKdf
      }

      return token
    } catch {
      return undefined
    }
  }

  /**
   * Finds by outpoint for unlocking / spending previous tokens.
   * @param outpoint The outpoint we are searching by
   * @returns The result so that we can use it to unlock the transaction
   */
  private async findByOutpoint(outpoint: string): Promise<{ beef: number[]; outputIndex: number } | undefined> {
    const correlationId = this.telemetry.enabled === true ? this.telemetry.createCorrelationId() : undefined
    const startedAt = Date.now()
    let resolution: LookupResolution
    try {
      resolution = await this.resolver.queryDetailed(
        {
          service: 'ls_users',
          query: {
            outpoint
          }
        },
        undefined,
        {
          waitForAllHosts: true,
          correlationId
        }
      )
    } catch (error) {
      const diagnostics = this.emptyLookupDiagnostics(correlationId)
      this.captureLookupFailure('outpoint', 'lookup-unavailable', diagnostics, startedAt, error)
      throw new UMPTokenLookupError('lookup-unavailable', diagnostics, { cause: error })
    }
    if (resolution.answer.outputs.length === 0) {
      const p = resolution.progress
      const authoritative =
        p.isFinal &&
        p.hostCount > 0 &&
        p.completedHosts === p.hostCount &&
        p.successfulHosts === p.hostCount &&
        p.emptyHosts === p.hostCount &&
        p.failedHosts === 0 &&
        p.rejectedHosts === 0 &&
        p.freeformHosts === 0
      if (!authoritative) {
        const diagnostics = this.toLookupDiagnostics(resolution)
        this.captureLookupFailure('outpoint', 'lookup-incomplete', diagnostics, startedAt)
        throw new UMPTokenLookupError('lookup-incomplete', diagnostics)
      }
      return undefined
    }
    return resolution.answer.outputs[0]
  }
}

/**
 * Manages a "CWI-style" wallet that uses a UMP token and a
 * multi-key authentication scheme (password, presentation key, and recovery key),
 * supporting multiple user profiles under a single account.
 */
export class CWIStyleWalletManager implements WalletInterface {
  /**
   * Whether the user is currently authenticated (i.e., root keys are available).
   */
  authenticated: boolean

  /**
   * Resolves once the optional snapshot (if provided to the constructor) has been
   * fully loaded and the wallet is ready to accept calls.
   * When no snapshot is provided this resolves immediately.
   * Await `ready` before calling wallet methods after constructing with a snapshot.
   */
  get ready(): Promise<void> {
    this._readyInit ??= this._init()
    return this._readyInit
  }

  private _readyInit?: Promise<void>

  private readonly _initSnapshot?: number[]

  /**
   * The domain name of the administrative originator (wallet operator / vendor, or your own).
   */
  private readonly adminOriginator: OriginatorDomainNameStringUnder250Bytes

  /**
   * The system that locates and publishes UMP tokens on-chain.
   */
  private readonly UMPTokenInteractor: UMPTokenInteractor

  /**
   * Privacy-bounded diagnostic channel for wallet state transitions.
   */
  protected readonly telemetry: Telemetry

  /**
   * A function called to persist the newly generated recovery key.
   * It should generally trigger a UI prompt where the user is asked to write it down.
   */
  private readonly recoveryKeySaver: (key: number[]) => Promise<true>

  /**
   * Asks the user to enter their password, for a given reason.
   * The test function can be used to see if the password is correct before resolving.
   * Only resolve with the correct password or reject with an error.
   * Resolving with an incorrect password will throw an error.
   */
  private readonly passwordRetriever: (
    reason: string,
    test: (passwordCandidate: string) => boolean | Promise<boolean>
  ) => Promise<string>

  /**
   * Optional function to fund a new Wallet after the new-user flow.
   */
  private readonly newWalletFunder?: (
    presentationKey: number[],
    wallet: WalletInterface, // The default profile wallet
    adminOriginator: OriginatorDomainNameStringUnder250Bytes
  ) => Promise<void>

  /**
   * Builds the underlying wallet for a specific profile.
   */
  private readonly walletBuilder: (
    profilePrimaryKey: number[],
    profilePrivilegedKeyManager: PrivilegedKeyManager,
    profileId: number[]
  ) => Promise<WalletInterface>

  /**
   * Current mode of authentication.
   */
  authenticationMode:
    'presentation-key-and-password' | 'presentation-key-and-recovery-key' | 'recovery-key-and-password' =
    'presentation-key-and-password'

  /**
   * Indicates new user or existing user flow.
   */
  authenticationFlow: 'unknown' | 'new-user' | 'existing-user' = 'unknown'

  /**
   * The current UMP token in use.
   */
  private currentUMPToken?: UMPToken

  /**
   * Temporarily retained presentation key.
   */
  private presentationKey?: number[]

  /**
   * Temporarily retained recovery key.
   */
  private recoveryKey?: number[]

  /**
   * The user's *root* primary key, derived from authentication factors.
   */
  private rootPrimaryKey?: number[]

  /**
   * The currently active profile ID (null or DEFAULT_PROFILE_ID means default profile).
   */
  private activeProfileId: number[] = DEFAULT_PROFILE_ID

  /**
   * List of loaded non-default profiles.
   */
  private profiles: Profile[] = []

  /**
   * The underlying wallet instance for the *active* profile.
   */
  private underlying?: WalletInterface

  /**
   * Privileged key manager associated with the *root* keys, aware of the active profile.
   */
  private rootPrivilegedKeyManager?: PrivilegedKeyManager

  /**
   * KDF configuration for new UMP tokens. Defaults to Argon2id for v3 tokens.
   */
  private readonly kdfConfig: Required<KdfConfig>

  /**
   * Constructs a new CWIStyleWalletManager.
   *
   * @param adminOriginator   The domain name of the administrative originator.
   * @param walletBuilder     A function that can build an underlying wallet instance for a profile.
   * @param interactor        An instance of UMPTokenInteractor.
   * @param recoveryKeySaver  A function to persist a new recovery key.
   * @param passwordRetriever A function to request the user's password.
   * @param newWalletFunder   Optional function to fund a new wallet.
   * @param stateSnapshot     Optional previously saved state snapshot.
   * @param kdfConfig         Optional KDF configuration for new UMP tokens.
   */
  constructor(
    ...[
      adminOriginator,
      walletBuilder,
      interactor,
      recoveryKeySaver,
      passwordRetriever,
      newWalletFunder,
      stateSnapshot,
      kdfConfig,
      telemetry
    ]: [
      adminOriginator: OriginatorDomainNameStringUnder250Bytes,
      walletBuilder: (
        profilePrimaryKey: number[],
        profilePrivilegedKeyManager: PrivilegedKeyManager,
        profileId: number[]
      ) => Promise<WalletInterface>,
      interactor: UMPTokenInteractor | undefined,
      recoveryKeySaver: (key: number[]) => Promise<true>,
      passwordRetriever: (
        reason: string,
        test: (passwordCandidate: string) => boolean | Promise<boolean>
      ) => Promise<string>,
      newWalletFunder?: (
        presentationKey: number[],
        wallet: WalletInterface,
        adminOriginator: OriginatorDomainNameStringUnder250Bytes
      ) => Promise<void>,
      stateSnapshot?: number[],
      kdfConfig?: KdfConfig,
      telemetry?: TelemetryConfig
    ]
  ) {
    this.adminOriginator = adminOriginator
    this.walletBuilder = walletBuilder
    this.telemetry = new Telemetry(telemetry)
    this.UMPTokenInteractor = interactor ?? new OverlayUMPTokenInteractor(undefined, undefined, telemetry)
    this.recoveryKeySaver = recoveryKeySaver
    this.passwordRetriever = passwordRetriever
    this.authenticated = false
    this.newWalletFunder = newWalletFunder

    // Initialize KDF config with Argon2id defaults for v3 tokens
    const kdfAlgorithm = kdfConfig?.algorithm ?? 'argon2id'
    this.kdfConfig = {
      algorithm: kdfAlgorithm,
      iterations:
        kdfConfig?.iterations ?? (kdfAlgorithm === 'argon2id' ? ARGON2ID_DEFAULT_ITERATIONS : PBKDF2_NUM_ROUNDS),
      memoryKiB: kdfConfig?.memoryKiB ?? ARGON2ID_DEFAULT_MEMORY_KIB,
      parallelism: kdfConfig?.parallelism ?? ARGON2ID_DEFAULT_PARALLELISM,
      hashLength: kdfConfig?.hashLength ?? ARGON2ID_DEFAULT_HASH_LENGTH
    }
    if (!isValidKdfConfig(this.kdfConfig)) {
      throw new Error('Unsupported or unsafe KDF configuration.')
    }

    // Store snapshot for lazy init; callers await ready before calling wallet methods.
    this._initSnapshot = stateSnapshot
  }

  private async _init(): Promise<void> {
    if (this._initSnapshot !== undefined) {
      this.telemetry.capture({
        name: 'wallet-toolbox.snapshot.initialization.started',
        component: 'wallet-toolbox.cwi-manager',
        severity: 'debug'
      })
      try {
        await this.loadSnapshot(this._initSnapshot)
        this.telemetry.capture({
          name: 'wallet-toolbox.snapshot.initialization.completed',
          component: 'wallet-toolbox.cwi-manager',
          severity: 'info'
        })
      } catch (error) {
        this.telemetry.capture({
          name: 'wallet-toolbox.snapshot.initialization.failed',
          component: 'wallet-toolbox.cwi-manager',
          severity: 'error',
          error
        })
        throw error
      }
    }
  }

  // --- Authentication Methods ---

  /**
   * Provides the presentation key.
   */
  async providePresentationKey(key: number[]): Promise<void> {
    if (this.authenticated) {
      throw new Error('User is already authenticated')
    }
    if (this.authenticationMode === 'recovery-key-and-password') {
      throw new Error('Presentation key is not needed in this mode')
    }
    if (key.length !== 32 || key.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new TypeError('Presentation key must contain exactly 32 bytes.')
    }

    this.authenticationFlow = 'unknown'
    const hash = Hash.sha256(key)
    const startedAt = Date.now()
    this.telemetry.capture({
      name: 'wallet-toolbox.authentication.account-lookup.started',
      component: 'wallet-toolbox.cwi-manager',
      severity: 'debug',
      attributes: { lookupKind: 'presentation' }
    })
    let token: UMPToken | undefined
    try {
      token = await this.UMPTokenInteractor.findByPresentationKeyHash(hash)
    } catch (error) {
      this.telemetry.capture({
        name: 'wallet-toolbox.authentication.account-lookup.failed',
        component: 'wallet-toolbox.cwi-manager',
        severity: 'warn',
        attributes: {
          lookupKind: 'presentation',
          durationMs: Date.now() - startedAt
        },
        error
      })
      throw error
    }

    if (token == null) {
      // No token found -> New user
      this.authenticationFlow = 'new-user'
      this.presentationKey = key
    } else {
      // Found token -> existing user
      this.authenticationFlow = 'existing-user'
      this.presentationKey = key
      this.currentUMPToken = token
    }
    this.telemetry.capture({
      name: 'wallet-toolbox.authentication.account-lookup.completed',
      component: 'wallet-toolbox.cwi-manager',
      severity: 'info',
      attributes: {
        lookupKind: 'presentation',
        accountStatus: this.authenticationFlow,
        durationMs: Date.now() - startedAt
      }
    })
  }

  /**
   * Provides the password.
   */
  async providePassword(password: string): Promise<void> {
    if (this.authenticated) throw new Error('User is already authenticated')
    if (this.authenticationMode === 'presentation-key-and-recovery-key') {
      throw new Error('Password is not needed in this mode')
    }
    if (this.authenticationFlow === 'unknown') {
      throw new Error('Determine account status with a presentation or recovery key before providing a password.')
    }
    if (this.authenticationFlow === 'existing-user') {
      await this.handleExistingUserPassword(password)
    } else {
      await this.handleNewUserPassword(password)
    }
  }

  /** Handles the password step for an existing user — derives keys, sets up infrastructure. */
  private async handleExistingUserPassword(password: string): Promise<void> {
    if (this.currentUMPToken == null) throw new Error('Provide presentation or recovery key first.')
    const derivedPasswordKey = await derivePasswordKey(this.currentUMPToken, Utils.toArray(password, 'utf8'))
    let rootPrimaryKey: number[]
    let rootPrivilegedKey: number[] | undefined

    if (this.authenticationMode === 'presentation-key-and-password') {
      if (this.presentationKey == null) throw new Error('No presentation key found!')
      rootPrimaryKey = new SymmetricKey(this.XOR(this.presentationKey, derivedPasswordKey)).decrypt(
        this.currentUMPToken.passwordPresentationPrimary
      ) as number[]
    } else {
      // 'recovery-key-and-password'
      if (this.recoveryKey == null) throw new Error('No recovery key found!')
      const primaryDecryptionKey = this.XOR(this.recoveryKey, derivedPasswordKey)
      rootPrimaryKey = new SymmetricKey(primaryDecryptionKey).decrypt(
        this.currentUMPToken.passwordRecoveryPrimary
      ) as number[]
      rootPrivilegedKey = new SymmetricKey(this.XOR(rootPrimaryKey, derivedPasswordKey)).decrypt(
        this.currentUMPToken.passwordPrimaryPrivileged
      ) as number[]
    }
    await this.setupRootInfrastructure(rootPrimaryKey, rootPrivilegedKey)
    await this.switchProfile(this.activeProfileId)
  }

  /** Handles the password step for a new user — generates keys, builds UMP token, publishes on-chain. */
  private async handleNewUserPassword(password: string): Promise<void> {
    if (this.authenticationMode !== 'presentation-key-and-password') {
      throw new Error('New-user flow requires presentation key and password mode.')
    }
    if (this.presentationKey == null) throw new Error('No presentation key provided for new-user flow.')

    // Generate new keys/salt
    const recoveryKey = Random(32)
    await this.recoveryKeySaver(recoveryKey)
    const passwordSalt = Random(32)
    const passwordKey = await derivePasswordKey(
      { passwordSalt, passwordKdf: this.kdfConfig },
      Utils.toArray(password, 'utf8')
    )
    const rootPrimaryKey = Random(32)
    const rootPrivilegedKey = Random(32)

    // Build XOR-combined symmetric keys
    const presentationPassword = new SymmetricKey(this.XOR(this.presentationKey, passwordKey))
    const presentationRecovery = new SymmetricKey(this.XOR(this.presentationKey, recoveryKey))
    const recoveryPassword = new SymmetricKey(this.XOR(recoveryKey, passwordKey))
    const primaryPassword = new SymmetricKey(this.XOR(rootPrimaryKey, passwordKey))

    const tempPrivilegedKeyManager = new PrivilegedKeyManager(async () => new PrivateKey(rootPrivilegedKey))
    const wrapKey = async (plaintext: number[]): Promise<number[]> =>
      (await tempPrivilegedKeyManager.encrypt({ plaintext, protocolID: [2, 'admin key wrapping'], keyID: '1' }))
        .ciphertext

    // Build new UMP token (v3 with KDF metadata, no profiles initially)
    const newToken: UMPToken = {
      passwordSalt,
      passwordPresentationPrimary: presentationPassword.encrypt(rootPrimaryKey) as number[],
      passwordRecoveryPrimary: recoveryPassword.encrypt(rootPrimaryKey) as number[],
      presentationRecoveryPrimary: presentationRecovery.encrypt(rootPrimaryKey) as number[],
      passwordPrimaryPrivileged: primaryPassword.encrypt(rootPrivilegedKey) as number[],
      presentationRecoveryPrivileged: presentationRecovery.encrypt(rootPrivilegedKey) as number[],
      presentationHash: Hash.sha256(this.presentationKey),
      recoveryHash: Hash.sha256(recoveryKey),
      presentationKeyEncrypted: await wrapKey(this.presentationKey),
      passwordKeyEncrypted: await wrapKey(passwordKey),
      recoveryKeyEncrypted: await wrapKey(recoveryKey),
      profilesEncrypted: undefined,
      umpVersion: 3,
      passwordKdf: this.kdfConfig
    }
    this.currentUMPToken = newToken

    await this.setupRootInfrastructure(rootPrimaryKey)
    await this.switchProfile(DEFAULT_PROFILE_ID)

    // Fund the *default* wallet if funder provided
    if (this.newWalletFunder != null && this.underlying != null) {
      try {
        await this.newWalletFunder(this.presentationKey, this.underlying, this.adminOriginator)
      } catch (error) {
        this.telemetry.capture({
          name: 'wallet-toolbox.authentication.new-wallet-funding.failed',
          component: 'wallet-toolbox.cwi-manager',
          severity: 'error',
          error: new Error('New wallet funding failed.')
        })
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`Failed to fund new wallet before publishing UMP token: ${message}`, { cause: error })
      }
    }

    if (this.underlying == null)
      throw new Error('Default profile wallet not built before attempting to publish UMP token.')
    this.currentUMPToken.currentOutpoint = await this.UMPTokenInteractor.buildAndSend(
      this.underlying,
      this.adminOriginator,
      newToken
    )
  }

  /**
   * Provides the recovery key.
   */
  async provideRecoveryKey(recoveryKey: number[]): Promise<void> {
    if (this.authenticated) {
      throw new Error('Already authenticated')
    }
    if (this.authenticationFlow === 'new-user' && this.authenticationMode !== 'recovery-key-and-password') {
      throw new Error('Do not submit recovery key in new-user flow')
    }
    if (this.authenticationMode === 'presentation-key-and-password') {
      throw new Error('No recovery key required in this mode')
    }
    if (recoveryKey.length !== 32 || recoveryKey.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new TypeError('Recovery key must contain exactly 32 bytes.')
    }

    if (this.authenticationMode === 'recovery-key-and-password') {
      // Wait for password
      const hash = Hash.sha256(recoveryKey)
      const token = await this.UMPTokenInteractor.findByRecoveryKeyHash(hash)
      if (token == null) throw new Error('No user found with this recovery key')
      this.authenticationFlow = 'existing-user'
      this.recoveryKey = recoveryKey
      this.currentUMPToken = token
    } else {
      // 'presentation-key-and-recovery-key'
      if (this.presentationKey == null) throw new Error('Provide the presentation key first')
      if (this.currentUMPToken == null) throw new Error('Current UMP token not found')

      const xorKey = this.XOR(this.presentationKey, recoveryKey)
      const rootPrimaryKey = new SymmetricKey(xorKey).decrypt(
        this.currentUMPToken.presentationRecoveryPrimary
      ) as number[]
      const rootPrivilegedKey = new SymmetricKey(xorKey).decrypt(
        this.currentUMPToken.presentationRecoveryPrivileged
      ) as number[]

      // Build root infrastructure, load profiles, switch to default
      await this.setupRootInfrastructure(rootPrimaryKey, rootPrivilegedKey)
      await this.switchProfile(this.activeProfileId)
    }
  }

  // --- State Management Methods ---

  /**
   * Saves the current wallet state (root key, UMP token, active profile) into an encrypted snapshot.
   * Version 2 format: [1 byte version=2] + [32 byte snapshot key] + [16 byte activeProfileId] + [encrypted payload]
   * Encrypted Payload: [32 byte rootPrimaryKey] + [varint token length + serialized UMP token]
   *
   * @returns Encrypted snapshot bytes.
   */
  saveSnapshot(): number[] {
    if (this.rootPrimaryKey == null || this.currentUMPToken == null) {
      throw new Error('No root primary key or current UMP token set')
    }

    const snapshotKey = Random(32)
    const snapshotPreimageWriter = new Utils.Writer()

    // Write root primary key
    snapshotPreimageWriter.write(this.rootPrimaryKey)

    // Write serialized UMP token (must have outpoint)
    if (!this.currentUMPToken.currentOutpoint) {
      throw new Error('UMP token cannot be saved without a current outpoint.')
    }
    const serializedToken = this.serializeUMPToken(this.currentUMPToken)
    snapshotPreimageWriter.writeVarIntNum(serializedToken.length)
    snapshotPreimageWriter.write(serializedToken)

    // Encrypt the payload
    const snapshotPreimage = snapshotPreimageWriter.toArray()
    const snapshotPayload = new SymmetricKey(snapshotKey).encrypt(snapshotPreimage) as number[]

    // Build final snapshot (Version 2)
    const snapshotWriter = new Utils.Writer()
    snapshotWriter.writeUInt8(2) // Version
    snapshotWriter.write(snapshotKey)
    snapshotWriter.write(this.activeProfileId) // Active profile ID
    snapshotWriter.write(snapshotPayload) // Encrypted data

    const snapshot = snapshotWriter.toArray()
    if (snapshot.length > MAX_STATE_SNAPSHOT_BYTES) {
      throw new Error('Snapshot exceeds the maximum supported size.')
    }
    this.telemetry.capture({
      name: 'wallet-toolbox.snapshot.saved',
      component: 'wallet-toolbox.cwi-manager',
      severity: 'info',
      attributes: {
        formatVersion: 2,
        profileCount: this.profiles.length
      }
    })
    return snapshot
  }

  /**
   * Loads a previously saved state snapshot. Restores root key, UMP token, profiles, and active profile.
   * Handles Version 1 (legacy) and Version 2 formats.
   *
   * @param snapshot Encrypted snapshot bytes.
   */
  async loadSnapshot(snapshot: number[]): Promise<void> {
    try {
      if (
        snapshot.length === 0 ||
        snapshot.length > MAX_STATE_SNAPSHOT_BYTES ||
        snapshot.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)
      ) {
        throw new Error('Snapshot is empty, oversized, or contains invalid bytes.')
      }
      const reader = new Utils.Reader(snapshot)
      const version = reader.readUInt8()

      let snapshotKey: number[]
      let encryptedPayload: number[]
      let activeProfileId = DEFAULT_PROFILE_ID // Default for V1

      if (version === 1) {
        snapshotKey = reader.read(32)
        encryptedPayload = reader.read()
      } else if (version === 2) {
        snapshotKey = reader.read(32)
        activeProfileId = reader.read(16) // Read active profile ID
        encryptedPayload = reader.read()
      } else {
        throw new Error(`Unsupported snapshot version: ${version}`)
      }

      // Decrypt payload
      const decryptedPayload = new SymmetricKey(snapshotKey).decrypt(encryptedPayload) as number[]
      const payloadReader = new Utils.Reader(decryptedPayload)

      // Read root primary key
      const rootPrimaryKey = payloadReader.read(32)

      // Read serialized UMP token
      const tokenLen = payloadReader.readVarIntNum()
      const tokenBytes = payloadReader.read(tokenLen)
      const token = this.deserializeUMPToken(tokenBytes)

      // Assign loaded data
      this.currentUMPToken = token

      // Setup root infrastructure, load profiles, and switch to the loaded active profile
      await this.setupRootInfrastructure(rootPrimaryKey) // Will automatically load profiles
      await this.switchProfile(activeProfileId) // Switch to the profile saved in the snapshot

      this.authenticationFlow = 'existing-user' // Loading implies existing user
      this.telemetry.capture({
        name: 'wallet-toolbox.snapshot.loaded',
        component: 'wallet-toolbox.cwi-manager',
        severity: 'info',
        attributes: {
          formatVersion: version,
          profileCount: this.profiles.length
        }
      })
    } catch (error) {
      this.destroy() // Clear state on error
      this.telemetry.capture({
        name: 'wallet-toolbox.snapshot.load-failed',
        component: 'wallet-toolbox.cwi-manager',
        severity: 'error',
        error
      })
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to load snapshot: ${message}`, { cause: error })
    }
  }

  async syncUMPToken(): Promise<boolean> {
    if (!this.authenticated || this.currentUMPToken == null || this.rootPrimaryKey == null) {
      throw new Error('Wallet not authenticated or missing UMP token.')
    }

    const currentToken = this.currentUMPToken
    let refreshed: UMPToken | undefined

    if (currentToken.presentationHash && currentToken.presentationHash.length > 0) {
      refreshed = await this.UMPTokenInteractor.findByPresentationKeyHash(currentToken.presentationHash)
    }

    if (refreshed == null && currentToken.recoveryHash && currentToken.recoveryHash.length > 0) {
      refreshed = await this.UMPTokenInteractor.findByRecoveryKeyHash(currentToken.recoveryHash)
    }

    if (refreshed == null) {
      return false
    }

    if (
      refreshed.currentOutpoint &&
      currentToken.currentOutpoint &&
      refreshed.currentOutpoint === currentToken.currentOutpoint
    ) {
      return false
    }

    this.currentUMPToken = refreshed
    await this.setupRootInfrastructure(this.rootPrimaryKey)
    this.saveSnapshot()
    return true
  }

  /**
   * Destroys the wallet state, clearing keys, tokens, and profiles.
   */
  destroy(): void {
    this.underlying = undefined
    this.rootPrivilegedKeyManager = undefined
    this.authenticated = false
    this.rootPrimaryKey = undefined
    this.currentUMPToken = undefined
    this.presentationKey = undefined
    this.recoveryKey = undefined
    this.profiles = []
    this.activeProfileId = DEFAULT_PROFILE_ID
    this.authenticationMode = 'presentation-key-and-password'
    this.authenticationFlow = 'unknown'
  }

  // --- Profile Management Methods ---

  /**
   * Lists all available profiles, including the default profile.
   * @returns Array of profile info objects, including an 'active' flag.
   */
  listProfiles(): Array<{
    id: number[]
    name: string
    createdAt: number | null
    active: boolean
    identityKey: string
  }> {
    if (!this.authenticated) {
      throw new Error('Not authenticated.')
    }
    const profileList = [
      // Default profile
      {
        id: DEFAULT_PROFILE_ID,
        name: 'default',
        createdAt: null, // Default profile doesn't have a creation timestamp in the same way
        active: this.activeProfileId.every(x => x === 0),
        identityKey: new PrivateKey(this.rootPrimaryKey).toPublicKey().toString()
      },
      // Other profiles
      ...this.profiles.map(p => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        active: this.activeProfileId.every((x, i) => x === p.id[i]),
        identityKey: new PrivateKey(this.XOR(this.rootPrimaryKey as number[], p.primaryPad)).toPublicKey().toString()
      }))
    ]
    return profileList
  }

  /**
   * Adds a new profile with the given name.
   * Generates necessary pads and updates the UMP token.
   * Does not switch to the new profile automatically.
   *
   * @param name The desired name for the new profile.
   * @returns The ID of the newly created profile.
   */
  async addProfile(name: string): Promise<number[]> {
    if (
      !this.authenticated ||
      this.rootPrimaryKey == null ||
      this.currentUMPToken == null ||
      this.rootPrivilegedKeyManager == null
    ) {
      throw new Error('Wallet not fully initialized or authenticated.')
    }

    // Ensure name is unique (including 'default')
    if (name === 'default' || this.profiles.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Profile name "${name}" is already in use.`)
    }

    const newProfile: Profile = {
      name,
      id: Random(16),
      primaryPad: Random(32),
      privilegedPad: Random(32),
      createdAt: Math.floor(Date.now() / 1000)
    }

    this.profiles.push(newProfile)

    // Update the UMP token with the new profile list
    await this.updateAuthFactors(
      this.currentUMPToken.passwordSalt,
      // Need to re-derive/decrypt factors needed for re-encryption
      await this.getFactor('passwordKey'),
      await this.getFactor('presentationKey'),
      await this.getFactor('recoveryKey'),
      this.rootPrimaryKey,
      await this.getFactor('privilegedKey'), // Get ROOT privileged key
      this.profiles // Pass the updated profile list
    )

    return newProfile.id
  }

  /**
   * Deletes a profile by its ID.
   * Cannot delete the default profile. If the active profile is deleted,
   * it switches back to the default profile.
   *
   * @param profileId The 16-byte ID of the profile to delete.
   */
  async deleteProfile(profileId: number[]): Promise<void> {
    if (
      !this.authenticated ||
      this.rootPrimaryKey == null ||
      this.currentUMPToken == null ||
      this.rootPrivilegedKeyManager == null
    ) {
      throw new Error('Wallet not fully initialized or authenticated.')
    }
    if (profileId.every(x => x === 0)) {
      throw new Error('Cannot delete the default profile.')
    }

    const profileIndex = this.profiles.findIndex(p => p.id.every((x, i) => x === profileId[i]))
    if (profileIndex === -1) {
      throw new Error('Profile not found.')
    }

    // Remove the profile
    this.profiles.splice(profileIndex, 1)

    // If the deleted profile was active, switch to default
    if (this.activeProfileId.every((x, i) => x === profileId[i])) {
      await this.switchProfile(DEFAULT_PROFILE_ID) // This rebuilds the wallet
    }

    // Update the UMP token
    await this.updateAuthFactors(
      this.currentUMPToken.passwordSalt,
      await this.getFactor('passwordKey'),
      await this.getFactor('presentationKey'),
      await this.getFactor('recoveryKey'),
      this.rootPrimaryKey,
      await this.getFactor('privilegedKey'), // Get ROOT privileged key
      this.profiles // Pass updated list
    )
  }

  /**
   * Switches the active profile. This re-derives keys and rebuilds the underlying wallet.
   *
   * @param profileId The 16-byte ID of the profile to switch to (use DEFAULT_PROFILE_ID for default).
   */
  async switchProfile(profileId: number[]): Promise<void> {
    if (!this.authenticated || this.rootPrimaryKey == null || this.rootPrivilegedKeyManager == null) {
      throw new Error('Cannot switch profile: Wallet not authenticated or root keys missing.')
    }

    let profilePrimaryKey: number[]
    let profilePrivilegedPad: number[] | undefined // Pad for the target profile

    if (profileId.every(x => x === 0)) {
      // Switching to default profile
      profilePrimaryKey = this.rootPrimaryKey
      profilePrivilegedPad = undefined // No pad for default
      this.activeProfileId = DEFAULT_PROFILE_ID
    } else {
      // Switching to a non-default profile
      const profile = this.profiles.find(p => p.id.every((x, i) => x === profileId[i]))
      if (profile == null) {
        throw new Error('Profile not found.')
      }
      profilePrimaryKey = this.XOR(this.rootPrimaryKey, profile.primaryPad)
      profilePrivilegedPad = profile.privilegedPad
      this.activeProfileId = profileId
    }

    // Create a *profile-specific* PrivilegedKeyManager.
    // It uses the ROOT manager internally but applies the profile's pad.
    const profilePrivilegedKeyManager = new PrivilegedKeyManager(async (reason: string) => {
      // Request the ROOT privileged key using the root manager
      const rootPrivileged: PrivateKey = await (this.rootPrivilegedKeyManager as any).getPrivilegedKey(reason)
      const rootPrivilegedBytes = rootPrivileged.toArray()

      // Apply the profile's pad if applicable
      const profilePrivilegedBytes =
        profilePrivilegedPad == null ? rootPrivilegedBytes : this.XOR(rootPrivilegedBytes, profilePrivilegedPad)

      return new PrivateKey(profilePrivilegedBytes)
    })

    // Build the underlying wallet for the specific profile
    this.underlying = await this.walletBuilder(
      profilePrimaryKey,
      profilePrivilegedKeyManager, // Pass the profile-specific manager
      this.activeProfileId // Pass the ID of the profile being activated
    )
  }

  // --- Key Management Methods ---

  /**
   * Changes the user's password. Re-wraps keys and updates the UMP token.
   */
  async changePassword(newPassword: string): Promise<void> {
    if (
      !this.authenticated ||
      this.currentUMPToken == null ||
      this.rootPrimaryKey == null ||
      this.rootPrivilegedKeyManager == null
    ) {
      throw new Error('Not authenticated or missing required data.')
    }

    const passwordSalt = Random(32)
    // Preserve current token's KDF metadata (or use manager's kdfConfig for legacy tokens)
    const kdfToUse = this.currentUMPToken.passwordKdf ?? this.kdfConfig
    const tempTokenForKdf = {
      passwordSalt,
      passwordKdf: kdfToUse
    }
    const newPasswordKey = await derivePasswordKey(tempTokenForKdf, Utils.toArray(newPassword, 'utf8'))

    // Decrypt existing factors needed for re-encryption, using the *root* privileged key manager
    const recoveryKey = await this.getFactor('recoveryKey')
    const presentationKey = await this.getFactor('presentationKey')
    const rootPrivilegedKey = await this.getFactor('privilegedKey') // Get ROOT privileged key

    await this.updateAuthFactors(
      passwordSalt,
      newPasswordKey,
      presentationKey,
      recoveryKey,
      this.rootPrimaryKey,
      rootPrivilegedKey, // Pass the explicitly fetched root key
      this.profiles // Preserve existing profiles
    )
  }

  /**
   * Retrieves the current recovery key. Requires privileged access.
   */
  async getRecoveryKey(): Promise<number[]> {
    if (!this.authenticated || this.currentUMPToken == null || this.rootPrivilegedKeyManager == null) {
      throw new Error('Not authenticated or missing required data.')
    }
    return await this.getFactor('recoveryKey')
  }

  /**
   * Changes the user's recovery key. Prompts user to save the new key.
   */
  async changeRecoveryKey(): Promise<void> {
    if (
      !this.authenticated ||
      this.currentUMPToken == null ||
      this.rootPrimaryKey == null ||
      this.rootPrivilegedKeyManager == null
    ) {
      throw new Error('Not authenticated or missing required data.')
    }

    // Decrypt existing factors needed
    const passwordKey = await this.getFactor('passwordKey')
    const presentationKey = await this.getFactor('presentationKey')
    const rootPrivilegedKey = await this.getFactor('privilegedKey') // Get ROOT privileged key

    // Generate and save new recovery key
    const newRecoveryKey = Random(32)
    await this.recoveryKeySaver(newRecoveryKey)

    await this.updateAuthFactors(
      this.currentUMPToken.passwordSalt,
      passwordKey,
      presentationKey,
      newRecoveryKey, // Use the new key
      this.rootPrimaryKey,
      rootPrivilegedKey,
      this.profiles // Preserve profiles
    )
  }

  /**
   * Changes the user's presentation key.
   */
  async changePresentationKey(newPresentationKey: number[]): Promise<void> {
    if (
      !this.authenticated ||
      this.currentUMPToken == null ||
      this.rootPrimaryKey == null ||
      this.rootPrivilegedKeyManager == null
    ) {
      throw new Error('Not authenticated or missing required data.')
    }
    if (newPresentationKey.length !== 32) {
      throw new Error('Presentation key must be 32 bytes.')
    }

    // Decrypt existing factors
    const recoveryKey = await this.getFactor('recoveryKey')
    const passwordKey = await this.getFactor('passwordKey')
    const rootPrivilegedKey = await this.getFactor('privilegedKey') // Get ROOT privileged key

    await this.updateAuthFactors(
      this.currentUMPToken.passwordSalt,
      passwordKey,
      newPresentationKey, // Use the new key
      recoveryKey,
      this.rootPrimaryKey,
      rootPrivilegedKey,
      this.profiles // Preserve profiles
    )
    // Update the temporarily stored key if it was set
    if (this.presentationKey != null) {
      this.presentationKey = newPresentationKey
    }
  }

  // --- Internal Helper Methods ---

  /**
   * Performs XOR operation on two byte arrays.
   */
  private XOR(n1: number[], n2: number[]): number[] {
    if (n1.length !== n2.length) {
      // Provide more context in error
      throw new Error(`XOR length mismatch: ${n1.length} vs ${n2.length}`)
    }
    const r = Array.from({ length: n1.length }, () => 0)
    for (let i = 0; i < n1.length; i++) {
      r[i] = n1[i] ^ n2[i]
    }
    return r
  }

  /**
   * Helper to decrypt a specific factor (key) stored encrypted in the UMP token.
   * Requires the root privileged key manager.
   * @param factorName Name of the factor to decrypt ('passwordKey', 'presentationKey', 'recoveryKey', 'privilegedKey').
   * @param getRoot If true and factorName is 'privilegedKey', returns the root privileged key bytes directly.
   * @returns The decrypted key bytes.
   */
  private async getFactor(
    factorName: 'passwordKey' | 'presentationKey' | 'recoveryKey' | 'privilegedKey'
  ): Promise<number[]> {
    if (!this.authenticated || this.currentUMPToken == null || this.rootPrivilegedKeyManager == null) {
      throw new Error(`Cannot get factor "${factorName}": Wallet not ready.`)
    }

    const protocolID: [0 | 1 | 2, string] = [2, 'admin key wrapping'] // Protocol used for encrypting factors
    const keyID = '1' // Key ID used

    try {
      switch (factorName) {
        case 'passwordKey':
          return (
            await this.rootPrivilegedKeyManager.decrypt({
              ciphertext: this.currentUMPToken.passwordKeyEncrypted,
              protocolID,
              keyID
            })
          ).plaintext
        case 'presentationKey':
          return (
            await this.rootPrivilegedKeyManager.decrypt({
              ciphertext: this.currentUMPToken.presentationKeyEncrypted,
              protocolID,
              keyID
            })
          ).plaintext
        case 'recoveryKey':
          return (
            await this.rootPrivilegedKeyManager.decrypt({
              ciphertext: this.currentUMPToken.recoveryKeyEncrypted,
              protocolID,
              keyID
            })
          ).plaintext
        case 'privilegedKey': {
          // This needs careful handling based on whether the ROOT or PROFILE key is needed.
          // This helper is mostly used for UMP updates, which need the ROOT key.
          // We retrieve the PrivateKey object first.
          const pk = await (this.rootPrivilegedKeyManager as any).getPrivilegedKey('UMP token update', true) // Force retrieval of root key
          return pk.toArray() // Return bytes
        }
        default:
          throw new Error(`Unknown factor name: ${factorName}`)
      }
    } catch (error) {
      this.telemetry.capture({
        name: 'wallet-toolbox.authentication.factor-decryption.failed',
        component: 'wallet-toolbox.cwi-manager',
        severity: 'error',
        attributes: { factor: factorName },
        error
      })
      const message = error instanceof Error ? error.message : 'Unknown error'
      throw new Error(`Failed to decrypt factor "${factorName}": ${message}`, { cause: error })
    }
  }

  /**
   * Recomputes UMP token fields with updated factors and profiles, then publishes the update.
   * This operation requires the *root* privileged key and the *default* profile wallet.
   */
  private async updateAuthFactors(
    passwordSalt: number[],
    passwordKey: number[],
    presentationKey: number[],
    recoveryKey: number[],
    rootPrimaryKey: number[],
    rootPrivilegedKey: number[], // Explicitly pass the root key bytes
    profiles?: Profile[] // Pass current/new profiles list
  ): Promise<void> {
    if (!this.authenticated || this.rootPrimaryKey == null || this.currentUMPToken == null) {
      throw new Error('Wallet is not properly authenticated or missing data for update.')
    }
    // Ensure we have the OLD token to consume
    const oldTokenToConsume = { ...this.currentUMPToken }
    if (!oldTokenToConsume.currentOutpoint) {
      throw new Error('Cannot update UMP token: Old token has no outpoint.')
    }

    // Derive symmetrical encryption keys using XOR for the *root* keys
    const presentationPassword = new SymmetricKey(this.XOR(presentationKey, passwordKey))
    const presentationRecovery = new SymmetricKey(this.XOR(presentationKey, recoveryKey))
    const recoveryPassword = new SymmetricKey(this.XOR(recoveryKey, passwordKey))
    const primaryPassword = new SymmetricKey(this.XOR(rootPrimaryKey, passwordKey)) // Use rootPrimaryKey

    // Build a temporary privileged key manager using the explicit ROOT privileged key
    const tempRootPrivilegedKeyManager = new PrivilegedKeyManager(async () => new PrivateKey(rootPrivilegedKey))

    // Encrypt profiles if provided
    let profilesEncrypted: number[] | undefined
    if (profiles != null && profiles.length > 0) {
      const profilesJson = JSON.stringify(profiles)
      const profilesBytes = Utils.toArray(profilesJson, 'utf8')
      profilesEncrypted = new SymmetricKey(rootPrimaryKey).encrypt(profilesBytes) as number[]
    }

    // Construct the new UMP token data.
    // IMPORTANT: For non-password updates (e.g. add/remove profile), preserve legacy
    // KDF layout exactly. Upgrading legacy tokens to v3 here would require re-deriving
    // passwordKey from plaintext password, which we do not have in this code path.
    const kdfMetadata = this.currentUMPToken.passwordKdf
    const newTokenData: UMPToken = {
      passwordSalt,
      passwordPresentationPrimary: presentationPassword.encrypt(rootPrimaryKey) as number[],
      passwordRecoveryPrimary: recoveryPassword.encrypt(rootPrimaryKey) as number[],
      presentationRecoveryPrimary: presentationRecovery.encrypt(rootPrimaryKey) as number[],
      passwordPrimaryPrivileged: primaryPassword.encrypt(rootPrivilegedKey) as number[],
      presentationRecoveryPrivileged: presentationRecovery.encrypt(rootPrivilegedKey) as number[],
      presentationHash: Hash.sha256(presentationKey),
      recoveryHash: Hash.sha256(recoveryKey),
      presentationKeyEncrypted: (
        await tempRootPrivilegedKeyManager.encrypt({
          plaintext: presentationKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      passwordKeyEncrypted: (
        await tempRootPrivilegedKeyManager.encrypt({
          plaintext: passwordKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      recoveryKeyEncrypted: (
        await tempRootPrivilegedKeyManager.encrypt({
          plaintext: recoveryKey,
          protocolID: [2, 'admin key wrapping'],
          keyID: '1'
        })
      ).ciphertext,
      profilesEncrypted, // Add encrypted profiles
      ...(kdfMetadata == null
        ? {}
        : {
            umpVersion: 3,
            passwordKdf: kdfMetadata
          })
      // currentOutpoint will be set after publishing
    }

    // We need the wallet built for the DEFAULT profile to publish the UMP token.
    // If the current active profile is not default, temporarily switch, publish, then switch back.
    const currentActiveId = this.activeProfileId
    let walletToUse: WalletInterface | undefined = this.underlying

    if (!currentActiveId.every(x => x === 0)) {
      this.telemetry.capture({
        name: 'wallet-toolbox.ump.profile-switch.started',
        component: 'wallet-toolbox.cwi-manager',
        severity: 'debug',
        attributes: { reason: 'token-update' }
      })
      await this.switchProfile(DEFAULT_PROFILE_ID) // This rebuilds this.underlying
      walletToUse = this.underlying
    }

    if (walletToUse == null) {
      throw new Error('Default profile wallet could not be activated for UMP token update.')
    }

    // Publish the new token on-chain, consuming the old one
    try {
      newTokenData.currentOutpoint = await this.UMPTokenInteractor.buildAndSend(
        walletToUse,
        this.adminOriginator,
        newTokenData,
        oldTokenToConsume // Consume the previous token
      )
      // Update the manager's state
      this.currentUMPToken = newTokenData
      // Profiles are already updated in this.profiles if they were passed in
    } finally {
      // Switch back if we temporarily switched
      if (!currentActiveId.every(x => x === 0)) {
        await this.switchProfile(currentActiveId)
        this.telemetry.capture({
          name: 'wallet-toolbox.ump.profile-switch.completed',
          component: 'wallet-toolbox.cwi-manager',
          severity: 'debug',
          attributes: { reason: 'token-update' }
        })
      }
    }
  }

  /**
   * Serializes a UMP token to binary format (Version 3 with KDF metadata, Version 2 with profiles).
   * V3 Layout: [1 byte version=3] + [11 * (varint len + bytes) for standard fields] + [1 byte profile_flag] + [IF flag=1 THEN varint len + profile bytes] + [1 byte kdf_flag] + [IF flag=1 THEN kdf metadata] + [varint len + outpoint bytes]
   */
  private serializeUMPToken(token: UMPToken): number[] {
    if (!token.currentOutpoint) {
      throw new Error('Token must have outpoint for serialization')
    }

    const writer = new Utils.Writer()
    const hasKdfMetadata = token.umpVersion === 3 && token.passwordKdf
    writer.writeUInt8(hasKdfMetadata ? 3 : 2) // Version 3 for KDF, 2 for legacy

    const writeArray = (arr: number[]) => {
      writer.writeVarIntNum(arr.length)
      writer.write(arr)
    }

    // Write standard fields in specific order
    writeArray(token.passwordSalt) // 0
    writeArray(token.passwordPresentationPrimary) // 1
    writeArray(token.passwordRecoveryPrimary) // 2
    writeArray(token.presentationRecoveryPrimary) // 3
    writeArray(token.passwordPrimaryPrivileged) // 4
    writeArray(token.presentationRecoveryPrivileged) // 5
    writeArray(token.presentationHash) // 6
    writeArray(token.recoveryHash) // 7
    writeArray(token.presentationKeyEncrypted) // 8
    writeArray(token.passwordKeyEncrypted) // 9
    writeArray(token.recoveryKeyEncrypted) // 10

    // Write optional profiles field
    if (token.profilesEncrypted != null && token.profilesEncrypted.length > 0) {
      writer.writeUInt8(1) // Flag indicating profiles present
      writeArray(token.profilesEncrypted)
    } else {
      writer.writeUInt8(0) // Flag indicating no profiles
    }

    // V3: Write KDF metadata
    if (hasKdfMetadata) {
      writer.writeUInt8(1) // Flag indicating KDF metadata present
      writer.writeUInt8(token.umpVersion!) // On-chain UMP version
      const algorithmBytes = Utils.toArray(token.passwordKdf!.algorithm, 'utf8')
      writeArray(algorithmBytes)

      // Serialize KDF params as JSON
      const kdfParams: Record<string, number> = {
        iterations: token.passwordKdf!.iterations
      }
      if (token.passwordKdf!.memoryKiB !== undefined) {
        kdfParams.memoryKiB = token.passwordKdf!.memoryKiB
      }
      if (token.passwordKdf!.parallelism !== undefined) {
        kdfParams.parallelism = token.passwordKdf!.parallelism
      }
      if (token.passwordKdf!.hashLength !== undefined) {
        kdfParams.hashLength = token.passwordKdf!.hashLength
      }
      const kdfParamsBytes = Utils.toArray(JSON.stringify(kdfParams), 'utf8')
      writeArray(kdfParamsBytes)
    } else if (writer.toArray()[0] === 3) {
      // Version 3 without KDF metadata (shouldn't happen, but handle gracefully)
      writer.writeUInt8(0) // Flag indicating no KDF metadata
    }

    // Write outpoint string
    const outpointBytes = Utils.toArray(token.currentOutpoint, 'utf8')
    writer.writeVarIntNum(outpointBytes.length)
    writer.write(outpointBytes)

    return writer.toArray()
  }

  /**
   * Deserializes a UMP token from binary format (Handles Version 1, 2, and 3).
   */
  private deserializeUMPToken(bin: number[]): UMPToken {
    const reader = new Utils.Reader(bin)
    const version = reader.readUInt8()

    if (version !== 1 && version !== 2 && version !== 3) {
      throw new Error(`Unsupported UMP token serialization version: ${version}`)
    }

    const readArray = (): number[] => {
      const length = reader.readVarIntNum()
      if (length <= 0 || length > MAX_STATE_SNAPSHOT_BYTES) {
        throw new Error('UMP token field exceeds allowed bounds.')
      }
      return reader.read(length)
    }

    // Read standard fields (order matches serialization)
    const passwordSalt = readArray() // 0
    const passwordPresentationPrimary = readArray() // 1
    const passwordRecoveryPrimary = readArray() // 2
    const presentationRecoveryPrimary = readArray() // 3
    const passwordPrimaryPrivileged = readArray() // 4
    const presentationRecoveryPrivileged = readArray() // 5
    const presentationHash = readArray() // 6
    const recoveryHash = readArray() // 7
    const presentationKeyEncrypted = readArray() // 8
    const passwordKeyEncrypted = readArray() // 9
    const recoveryKeyEncrypted = readArray() // 10

    // Read optional profiles (V2 and V3)
    let profilesEncrypted: number[] | undefined
    if (version >= 2) {
      const profilesFlag = reader.readUInt8()
      if (profilesFlag === 1) {
        profilesEncrypted = readArray()
      }
    }

    // Read KDF metadata (V3 only)
    let umpVersion: number | undefined
    let passwordKdf: UMPToken['passwordKdf']
    if (version === 3) {
      const kdfFlag = reader.readUInt8()
      if (kdfFlag === 1) {
        umpVersion = reader.readUInt8() // On-chain UMP version
        const algorithmBytes = readArray()
        const algorithm = Utils.toUTF8(algorithmBytes) as 'pbkdf2-sha512' | 'argon2id'

        const kdfParamsBytes = readArray()
        const kdfParamsJson = Utils.toUTF8(kdfParamsBytes)

        const kdfParams = JSON.parse(kdfParamsJson) as Record<string, unknown>
        passwordKdf = {
          algorithm,
          iterations: kdfParams.iterations as number,
          memoryKiB: kdfParams.memoryKiB as number | undefined,
          parallelism: kdfParams.parallelism as number | undefined,
          hashLength: kdfParams.hashLength as number | undefined
        }
        if (!isValidKdfConfig(passwordKdf)) {
          throw new Error('Serialized UMP token contains unsupported or unsafe KDF parameters.')
        }
      }
    }

    // Read outpoint string
    const outpointLen = reader.readVarIntNum()
    const outpointBytes = reader.read(outpointLen)
    const currentOutpoint = Utils.toUTF8(outpointBytes)
    if (currentOutpoint.length > 128 || !/^[^\s.:]+[.:]\d+$/.test(currentOutpoint)) {
      throw new Error('Serialized UMP token contains an invalid outpoint.')
    }

    const token: UMPToken = {
      passwordSalt,
      passwordPresentationPrimary,
      passwordRecoveryPrimary,
      presentationRecoveryPrimary,
      passwordPrimaryPrivileged,
      presentationRecoveryPrivileged,
      presentationHash,
      recoveryHash,
      presentationKeyEncrypted,
      passwordKeyEncrypted,
      recoveryKeyEncrypted,
      profilesEncrypted,
      currentOutpoint,
      umpVersion,
      passwordKdf
    }

    return token
  }

  /**
   * Sets up the root key infrastructure after authentication or loading from snapshot.
   * Initializes the root primary key, root privileged key manager, loads profiles,
   * and sets the authenticated flag. Does NOT switch profile initially.
   *
   * @param rootPrimaryKey      The user's root primary key (32 bytes).
   * @param ephemeralRootPrivilegedKey Optional root privileged key (e.g., during recovery flows).
   */
  private async setupRootInfrastructure(
    rootPrimaryKey: number[],
    ephemeralRootPrivilegedKey?: number[]
  ): Promise<void> {
    if (this.currentUMPToken == null) {
      throw new Error('A UMP token must exist before setting up root infrastructure!')
    }
    this.rootPrimaryKey = rootPrimaryKey

    // Store ephemeral key if provided, for one-time use by the manager
    let oneTimePrivilegedKey: PrivateKey | undefined =
      ephemeralRootPrivilegedKey == null ? undefined : new PrivateKey(ephemeralRootPrivilegedKey)

    // Create the ROOT PrivilegedKeyManager
    this.rootPrivilegedKeyManager = new PrivilegedKeyManager(async (reason: string) => {
      // 1. Use one-time key if available (for recovery)
      if (oneTimePrivilegedKey != null) {
        const tempKey = oneTimePrivilegedKey
        oneTimePrivilegedKey = undefined // Consume it
        return tempKey
      }

      // 2. Otherwise, derive from password
      const password = await this.passwordRetriever(reason, async (passwordCandidate: string) => {
        try {
          const derivedPasswordKey = await derivePasswordKey(
            this.currentUMPToken!,
            Utils.toArray(passwordCandidate, 'utf8')
          )
          const privilegedDecryptor = this.XOR(this.rootPrimaryKey!, derivedPasswordKey)
          const decryptedPrivileged = new SymmetricKey(privilegedDecryptor).decrypt(
            this.currentUMPToken!.passwordPrimaryPrivileged
          ) as number[]
          return !!decryptedPrivileged // Test passes if decryption works
        } catch {
          // Decryption failure means the password candidate is wrong — this is the
          // expected rejection path for an incorrect password.  Returning false causes
          // the password-retriever loop to prompt the user again rather than crashing.
          return false
        }
      })

      // Decrypt the root privileged key using the confirmed password (with token-driven KDF)
      const derivedPasswordKey = await derivePasswordKey(this.currentUMPToken!, Utils.toArray(password, 'utf8'))
      const privilegedDecryptor = this.XOR(this.rootPrimaryKey!, derivedPasswordKey)
      const rootPrivilegedBytes = new SymmetricKey(privilegedDecryptor).decrypt(
        this.currentUMPToken!.passwordPrimaryPrivileged
      ) as number[]

      return new PrivateKey(rootPrivilegedBytes) // Return the ROOT key object
    })

    // Decrypt and load profiles if present in the token
    this.profiles = [] // Clear existing profiles before loading
    if (this.currentUMPToken.profilesEncrypted != null && this.currentUMPToken.profilesEncrypted.length > 0) {
      try {
        const decryptedProfileBytes = new SymmetricKey(rootPrimaryKey).decrypt(
          this.currentUMPToken.profilesEncrypted
        ) as number[]
        const profilesJson = Utils.toUTF8(decryptedProfileBytes)
        const profiles = JSON.parse(profilesJson) as unknown
        if (!Array.isArray(profiles) || profiles.length > 1000 || !profiles.every(isValidProfile)) {
          throw new Error('Decrypted profile data is invalid or exceeds supported bounds.')
        }
        this.profiles = profiles
      } catch (error) {
        this.profiles = []
        this.telemetry.capture({
          name: 'wallet-toolbox.profile.load-failed',
          component: 'wallet-toolbox.cwi-manager',
          severity: 'error',
          error
        })
        const message = error instanceof Error ? error.message : 'Unknown error'
        throw new Error(`Failed to load profiles: ${message}`, { cause: error })
      }
    }

    this.authenticated = true
    // Note: We don't call switchProfile here anymore.
    // It's called by the auth methods (providePassword/provideRecoveryKey) or loadSnapshot after this.
  }

  /*
   * ---------------------------------------------------------------------------------------
   * Standard WalletInterface methods proxying to the *active* underlying wallet.
   * Includes authentication checks and admin originator protection.
   * ---------------------------------------------------------------------------------------
   */

  private checkAuthAndUnderlying(originator?: string): void {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (this.underlying == null) {
      // This might happen if authentication succeeded but profile switching failed
      throw new Error('Underlying wallet for the active profile is not initialized.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
  }

  // Example proxy method (repeat pattern for all others)
  async getPublicKey(
    args: GetPublicKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetPublicKeyResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.getPublicKey(args, originator)
  }

  async revealCounterpartyKeyLinkage(
    args: RevealCounterpartyKeyLinkageArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealCounterpartyKeyLinkageResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.revealCounterpartyKeyLinkage(args, originator)
  }

  async revealSpecificKeyLinkage(
    args: RevealSpecificKeyLinkageArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RevealSpecificKeyLinkageResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.revealSpecificKeyLinkage(args, originator)
  }

  async encrypt(
    args: WalletEncryptArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletEncryptResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.encrypt(args, originator)
  }

  async decrypt(
    args: WalletDecryptArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<WalletDecryptResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.decrypt(args, originator)
  }

  async createHmac(
    args: CreateHmacArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateHmacResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.createHmac(args, originator)
  }

  async verifyHmac(
    args: VerifyHmacArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifyHmacResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.verifyHmac(args, originator)
  }

  async createSignature(
    args: CreateSignatureArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateSignatureResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.createSignature(args, originator)
  }

  async verifySignature(
    args: VerifySignatureArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<VerifySignatureResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.verifySignature(args, originator)
  }

  async createAction(
    args: CreateActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<CreateActionResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.createAction(args, originator)
  }

  async signAction(
    args: SignActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<SignActionResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.signAction(args, originator)
  }

  async abortAction(
    args: AbortActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AbortActionResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.abortAction(args, originator)
  }

  async listActions(
    args: ListActionsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListActionsResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.listActions(args, originator)
  }

  async internalizeAction(
    args: InternalizeActionArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<InternalizeActionResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.internalizeAction(args, originator)
  }

  async listOutputs(
    args: ListOutputsArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListOutputsResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.listOutputs(args, originator)
  }

  async relinquishOutput(
    args: RelinquishOutputArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishOutputResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.relinquishOutput(args, originator)
  }

  async acquireCertificate(
    args: AcquireCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AcquireCertificateResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.acquireCertificate(args, originator)
  }

  async listCertificates(
    args: ListCertificatesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ListCertificatesResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.listCertificates(args, originator)
  }

  async proveCertificate(
    args: ProveCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<ProveCertificateResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.proveCertificate(args, originator)
  }

  async relinquishCertificate(
    args: RelinquishCertificateArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<RelinquishCertificateResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.relinquishCertificate(args, originator)
  }

  async discoverByIdentityKey(
    args: DiscoverByIdentityKeyArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.discoverByIdentityKey(args, originator)
  }

  async discoverByAttributes(
    args: DiscoverByAttributesArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<DiscoverCertificatesResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.discoverByAttributes(args, originator)
  }

  async isAuthenticated(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<AuthenticatedResult> {
    if (!this.authenticated) {
      throw new Error('User is not authenticated.')
    }
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    return { authenticated: true }
  }

  async waitForAuthentication(
    _: {},
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<AuthenticatedResult> {
    if (originator === this.adminOriginator) {
      throw new Error('External applications are not allowed to use the admin originator.')
    }
    while (!this.authenticated || this.underlying == null) {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return await this.underlying.waitForAuthentication({}, originator)
  }

  async getHeight(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetHeightResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.getHeight({}, originator)
  }

  async getHeaderForHeight(
    args: GetHeaderArgs,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ): Promise<GetHeaderResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.getHeaderForHeight(args, originator)
  }

  async getNetwork(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetNetworkResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.getNetwork({}, originator)
  }

  async getVersion(_: {}, originator?: OriginatorDomainNameStringUnder250Bytes): Promise<GetVersionResult> {
    this.checkAuthAndUnderlying(originator)
    return await this.underlying!.getVersion({}, originator)
  }
}
