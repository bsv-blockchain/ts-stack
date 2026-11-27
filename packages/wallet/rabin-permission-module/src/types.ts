import type {
  KeyDeriverApi,
  PubKeyHex,
  SecurityLevel,
  WalletEncryptArgs,
  WalletProtocol
} from '@bsv/sdk'

export type RabinOperation = 'key' | 'sign'
export type RabinModulusBits = 2048 | 3072 | 4096

/** Structural slice of the host deriver. The returned scalar is read with `toHex()`. */
export type RabinKeyDeriver = Pick<KeyDeriverApi, 'derivePrivateKey'>

export type RabinPrivilegedKeyDeriver = (
  reason: string
) => RabinKeyDeriver | Promise<RabinKeyDeriver>

export interface RabinAuthorizationRequest {
  originator: string
  securityLevel: SecurityLevel
  logicalProtocolID: string
  keyID: string
  counterparty: PubKeyHex | 'self' | 'anyone'
  privileged: boolean
  privilegedReason?: string
  operation: RabinOperation
  modulusBits: RabinModulusBits
}

export type RabinAuthorizationHandler = (
  request: RabinAuthorizationRequest
) => boolean | Promise<boolean>

export interface RabinPermissionModuleOptions {
  /** Derives ordinary BRC-42/43 keys for this wallet. */
  keyDeriver: RabinKeyDeriver
  /** Retrieves a privileged deriver only after the supplied reason is authorized. */
  privilegedKeyDeriver?: RabinPrivilegedKeyDeriver
  /** Required for security levels 1 and 2 and for every privileged request. */
  authorize?: RabinAuthorizationHandler
  /** Duration of a successful grant. Defaults to five minutes and cannot exceed 24 hours. */
  authorizationTTL?: number
  /** Distinct Rabin keys retained in memory. Defaults to 32. */
  maxCachedKeys?: number
  /** Distinct key generations allowed in flight. Defaults to 4. */
  maxInflightKeygens?: number
}

export interface ParsedRabinRequest {
  args: WalletEncryptArgs
  operation: RabinOperation
  modulusBits: RabinModulusBits
  logicalProtocolID: string
  derivationProtocolID: WalletProtocol
  keyID: string
  counterparty: PubKeyHex | 'self' | 'anyone'
  privileged: boolean
  privilegedReason?: string
  message: Uint8Array
}
