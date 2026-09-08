import type {
  GetPublicKeyArgs,
  KeyDeriverApi,
  PrivateKey,
  PubKeyHex,
  SecurityLevel,
  WalletProtocol
} from '@bsv/sdk'

export type EcpmOperation = 'apply' | 'remove'

export type EcpmKeyDeriver = Pick<KeyDeriverApi, 'derivePrivateKey'>

export type EcpmPrivilegedKeyDeriver = (reason: string) => EcpmKeyDeriver | Promise<EcpmKeyDeriver>

export interface EcpmAuthorizationRequest {
  originator: string
  securityLevel: SecurityLevel
  logicalProtocolID: string
  keyID: string
  counterparty: PubKeyHex | 'self' | 'anyone'
  privileged: boolean
  privilegedReason?: string
  operation: EcpmOperation
  point: PubKeyHex
}

export type EcpmAuthorizationHandler = (
  request: EcpmAuthorizationRequest
) => boolean | Promise<boolean>

export interface EcpmPermissionModuleOptions {
  /** Derives ordinary BRC-42/43 keys for this wallet. */
  keyDeriver: EcpmKeyDeriver
  /** Retrieves a privileged deriver only after the supplied reason is authorized. */
  privilegedKeyDeriver?: EcpmPrivilegedKeyDeriver
  /** Required for security levels 1/2 and every privileged request. */
  authorize?: EcpmAuthorizationHandler
  /** Duration of a successful protocol grant. Defaults to five minutes. */
  authorizationTTL?: number
}

export interface ParsedEcpmRequest {
  args: GetPublicKeyArgs
  operation: EcpmOperation
  point: PubKeyHex
  logicalProtocolID: string
  derivationProtocolID: WalletProtocol
  keyID: string
  counterparty: PubKeyHex | 'self' | 'anyone'
  privileged: boolean
  privilegedReason?: string
}

export interface EcpmMultiplyInput {
  point: PubKeyHex
  derivedKey: PrivateKey
  operation: EcpmOperation
}
