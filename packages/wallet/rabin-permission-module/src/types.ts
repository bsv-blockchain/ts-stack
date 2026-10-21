import type { KeyDeriverApi, PubKeyHex, SecurityLevel, WalletProtocol } from '@bsv/sdk'

export type RabinOperation = 'key' | 'sign'

export type RabinBits = 2048 | 3072 | 4096

export type RabinCounterparty = PubKeyHex | 'self' | 'anyone'

export type RabinKeyDeriver = Pick<KeyDeriverApi, 'derivePrivateKey'>

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
