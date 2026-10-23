import type { PubKeyHex, SecurityLevel, WalletProtocol } from '@bsv/sdk'

export type RabinOperation = 'key' | 'sign'

export type RabinBits = 2048 | 3072 | 4096

export type RabinCounterparty = PubKeyHex | 'self' | 'anyone'

/**
 * The part of a BRC-42/43 key deriver the module uses; any `KeyDeriverApi` satisfies it. It is
 * structural rather than `Pick<KeyDeriverApi, 'derivePrivateKey'>` so that a host whose
 * TypeScript resolves @bsv/sdk to different declaration files than this package does (ESM and
 * CJS typings of the same SDK) can still pass its deriver: SDK classes with private fields are
 * not assignable across two declaration copies.
 */
export interface RabinKeyDeriver {
  derivePrivateKey: (
    protocolID: WalletProtocol,
    keyID: string,
    counterparty: RabinCounterparty
  ) => { toArray: (endian: 'be', length: number) => number[] }
}

export type RabinPrivilegedKeyDeriver = (
  reason: string
) => RabinKeyDeriver | Promise<RabinKeyDeriver>

/** What trusted authorization UI or policy sees before any key material is derived. */
export interface RabinAuthorizationRequest {
  originator: string
  securityLevel: SecurityLevel
  logicalProtocolID: string
  keyID: string
  counterparty: RabinCounterparty
  privileged: boolean
  privilegedReason?: string
  operation: RabinOperation
  bits: RabinBits
  /** `sign` only. */
  messageLength?: number
  /** `sign` only: lowercase hex SHA-256 of the message. */
  messageSha256?: string
}

export type RabinAuthorizationHandler = (
  request: RabinAuthorizationRequest
) => boolean | Promise<boolean>

export interface RabinPermissionModuleOptions {
  /** Derives ordinary BRC-42/43 private keys for this wallet. */
  keyDeriver: RabinKeyDeriver
  /** Retrieves a privileged deriver only after the supplied reason is authorized. */
  privilegedKeyDeriver?: RabinPrivilegedKeyDeriver
  /** Required for security levels 1/2 and every privileged request. */
  authorize?: RabinAuthorizationHandler
  /** Duration of a successful protocol grant. Defaults to five minutes; at most 24 hours. */
  authorizationTTL?: number
  /** Ordinary keys kept in memory. Defaults to 32; between 1 and 1024. */
  maxCachedKeys?: number
  /**
   * Cached keys one originator's requests may occupy; at the cap its own least recently used key
   * is evicted. Defaults to 8 (or `maxCachedKeys` if smaller); at most `maxCachedKeys`.
   */
  maxCachedKeysPerOriginator?: number
  /** Generations admitted at once, the running one included. Defaults to 8; between 1 and 64. */
  maxPendingGenerations?: number
  /**
   * Signatures admitted at once, the running one included; signatures run one at a time so a flood
   * cannot stall the host. A bound on responsiveness, not a rate limit. Defaults to 16; 1 to 256.
   */
  maxPendingSignatures?: number
  /** A queued generation waiting longer fails as busy. Defaults to 60 s; at most 10 minutes. */
  generationQueueTimeout?: number
  /** Uncached generations an originator may start in a burst. Defaults to 4. */
  originatorGenerationBurst?: number
  /** Milliseconds per regained originator generation. Defaults to 15 s (4 per minute). */
  originatorGenerationInterval?: number
  /** Uncached generations all originators together may start in a burst. Defaults to 10. */
  globalGenerationBurst?: number
  /** Milliseconds per regained global generation. Defaults to 6 s (10 per minute). */
  globalGenerationInterval?: number
  /** Largest accepted `sign` message. Defaults to 1 MiB, the spec minimum; at most 256 MiB. */
  maxMessageBytes?: number
}

export interface ParsedRabinRequest {
  operation: RabinOperation
  bits: RabinBits
  logicalProtocolID: string
  derivationProtocolID: WalletProtocol
  keyID: string
  counterparty: RabinCounterparty
  privileged: boolean
  privilegedReason?: string
  seekPermission: boolean
  /** The message for `sign`; empty for `key`. */
  message: Uint8Array
}
