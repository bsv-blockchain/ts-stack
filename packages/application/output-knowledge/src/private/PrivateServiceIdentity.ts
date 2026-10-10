import { createHmac, KeyObject } from 'node:crypto'
import {
  ownOutputJSONWithCountedRecords as ownOutputJSON,
  canonicalOutputJSONWithDirectRecords as canonicalOutputJSON,
  closedOutputObject,
  outputIdentity,
  outputString,
  OutputProtocolError,
  parseOutputChain,
  type OutputChain,
  type OutputJSONObject
} from '@bsv/sdk'
import {
  protectedAddress,
  protectedConfiguration,
  protectedValue,
  type ProtectedLedgerAddress,
  type ProtectedLedgerConfiguration,
  type ProtectedLedgerKind
} from './ProtectedLedgerCodec.js'

/** Kept independently of payload encryption keys, for the full lifetime of permanent fences. */
export interface PrivateIdentityCustody {
  /** Never synthesize a replacement when the retained key is unavailable. */
  resolve(keyId: string): KeyObject
}
export interface PrivateServiceIdentityScope {
  chain: OutputChain
  seller: string
}
const FORMAT = 'output-private-service-identity/1'

/**
 * Internal seller/chain-wide opaque addressing for permanent private operation fences.
 * Payload encryption may rotate independently. Replacing this key is a namespace
 * migration requiring reconciliation, never ordinary rotation or open-time repair.
 * Every service for a seller/chain must share the authoritative ledger; separate
 * databases with the same configuration do not enforce global uniqueness.
 */
export class PrivateServiceIdentity {
  private readonly scope: PrivateServiceIdentityScope
  private readonly keyId: string
  private readonly commitment: string

  constructor(
    scope: PrivateServiceIdentityScope,
    private readonly custody: PrivateIdentityCustody,
    keyId: string
  ) {
    const value = ownOutputJSON(scope, { bytes: 4096 }).value
    closedOutputObject(value, ['chain', 'seller'])
    this.scope = { chain: parseOutputChain(value.chain), seller: outputIdentity(value.seller) }
    this.keyId = outputString(keyId)
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(this.keyId))
      throw new OutputProtocolError('invalid', 'Invalid private identity key label')
    this.commitment = this.authenticateKey(this.resolve())
  }

  private resolve(): KeyObject {
    try {
      const key = this.custody.resolve(this.keyId)
      if (!(key instanceof KeyObject) || key.type !== 'secret' || key.symmetricKeySize !== 32)
        throw new Error('Invalid identity custody capability')
      return key
    } catch {
      throw new OutputProtocolError('unavailable', 'Private identity custody is unavailable')
    }
  }
  private authenticateKey(key: KeyObject): string {
    return createHmac('sha256', key)
      .update(canonicalOutputJSON({ format: FORMAT, purpose: 'key-commitment', ...this.scope }))
      .digest('hex')
  }
  private key(): KeyObject {
    const key = this.resolve()
    if (this.authenticateKey(key) !== this.commitment)
      throw new OutputProtocolError('unavailable', 'Private identity custody changed')
    return key
  }

  /** Return owned configuration: persisted by the ledger, checked on every explicit open. */
  configuration(
    capacity: Omit<ProtectedLedgerConfiguration, 'binding'>,
    application: OutputJSONObject
  ): ProtectedLedgerConfiguration {
    // Closed parsing rejects accidental override/accessors without invoking them.
    const value = ownOutputJSON(capacity, { bytes: 4096 }).value
    closedOutputObject(value, [
      'storeId',
      'maximumRecords',
      'maximumReservedBytes',
      'maximumRecordBytes'
    ])
    const ownedApplication = protectedValue(application, 16384).value
    this.key()
    return protectedConfiguration({
      storeId: value.storeId as string,
      maximumRecords: value.maximumRecords as number,
      maximumReservedBytes: value.maximumReservedBytes as number,
      maximumRecordBytes: value.maximumRecordBytes as number,
      binding: {
        identity: {
          format: FORMAT,
          chain: { ...this.scope.chain },
          seller: this.scope.seller,
          keyId: this.keyId,
          keyCommitment: this.commitment
        },
        application: ownedApplication
      }
    })
  }

  /** Descriptors are typed and interpreted by the owning state machine, never a remote mutation API. */
  address(kind: ProtectedLedgerKind, descriptor: OutputJSONObject): ProtectedLedgerAddress {
    if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor))
      throw new OutputProtocolError('invalid', 'Private identity descriptor must be an object')
    // Own the entire descriptor before invoking the installed custody capability.
    const text = canonicalOutputJSON(
      { format: FORMAT, purpose: 'record-address', ...this.scope, kind, descriptor },
      { bytes: 16384 }
    )
    return protectedAddress({
      kind,
      key: createHmac('sha256', this.key()).update(text).digest('hex')
    })
  }
}
