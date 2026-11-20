import type { KeyDeriverApi, PubKeyHex, SecurityLevel } from '@bsv/sdk'
import type Point from '@bsv/sdk/primitives/Point'

export type SigmaOperation = 'key' | 'schnorr' | 'dleq' | 'or'

export type ParsedPlaintext =
  | { operation: 'key'; H?: Point }
  | { operation: 'schnorr'; ctx: number[] }
  | { operation: 'dleq'; H: Point; ctx: number[] }
  | { operation: 'or'; n: number; index: number; others: Point[]; ctx: number[] }

export type SigmaKeyDeriver = Pick<KeyDeriverApi, 'derivePrivateKey'>

export type SigmaPrivilegedKeyDeriver = (
  reason: string
) => SigmaKeyDeriver | Promise<SigmaKeyDeriver>

export interface SigmaAuthorizationRequest {
  originator: string
  securityLevel: SecurityLevel
  logicalProtocolID: string
  keyID: string
  counterparty: PubKeyHex | 'self' | 'anyone'
  privileged: boolean
  privilegedReason?: string
  operation: SigmaOperation
  /** Lowercase hex SHA-256 of the context; present for schnorr, dleq and or. */
  contextSha256?: string
  /** True when the application chose the base point: `key` with a base, and every `dleq`. */
  applicationBase: boolean
  /** Lowercase hex SHA-256 of the whole operation input (the request's plaintext). */
  inputSha256: string
}

/**
 * How requests at security levels 1 and 2, and privileged requests, are authorized.
 * `'each'` asks for every proof and remembers only a plain public-key request;
 * `'grant'` remembers one approval as a grant covering every operation.
 */
export type SigmaProofAuthorization = 'each' | 'grant'

export type SigmaAuthorizationHandler = (
  request: SigmaAuthorizationRequest
) => boolean | Promise<boolean>

export interface SigmaPermissionModuleOptions {
  /** Derives ordinary BRC-42/43 keys for this wallet. */
  keyDeriver: SigmaKeyDeriver
  /** Retrieves a privileged deriver only after the supplied reason is authorized. */
  privilegedKeyDeriver?: SigmaPrivilegedKeyDeriver
  /** Required for security levels 1/2 and every privileged request. */
  authorize?: SigmaAuthorizationHandler
  /** Duration of a successful protocol grant. Defaults to five minutes. */
  authorizationTTL?: number
  /** How requests are authorized. Defaults to 'each'. */
  proofAuthorization?: SigmaProofAuthorization
}
