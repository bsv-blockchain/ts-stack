import {
  canonicalOutputJSON,
  closedOutputObject,
  outputString,
  parseOutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import { NodeProtectedPayloadCodec } from './NodeProtectedPayloadCodec.js'
import { SQLiteProtectedLedger } from './SQLiteProtectedLedger.js'
import { type ProtectedLedgerConfiguration } from './ProtectedLedgerCodec.js'
import {
  PrivateServiceIdentity,
  type PrivateIdentityCustody,
  type PrivateServiceIdentityScope
} from './PrivateServiceIdentity.js'

export interface PrivateServiceDomainConfiguration {
  identity: PrivateServiceIdentityScope
  indexKeyId: string
  capacity: Omit<ProtectedLedgerConfiguration, 'binding'>
  application: OutputJSONObject
}

/**
 * Internal physical owner for all private services under one seller/chain.
 * The factory always binds opaque addressing custody into authenticated storage;
 * callers cannot accidentally pair a ledger with another indexing namespace.
 * Create is explicit and exclusive. Open never creates or repairs missing state.
 * Publication/acquisition owners supply typed semantics and current authorization.
 * Multiple independent databases still do not enforce global funding uniqueness.
 */
export class PrivateServiceDomain {
  readonly identity: PrivateServiceIdentity
  readonly ledger: SQLiteProtectedLedger
  private readonly serviceScope: PrivateServiceIdentityScope

  private constructor(
    path: string,
    input: PrivateServiceDomainConfiguration,
    custody: PrivateIdentityCustody,
    payloads: NodeProtectedPayloadCodec,
    create: boolean
  ) {
    // Own configuration before any installed custody callback is invoked.
    const config = parseOutputJSON(canonicalOutputJSON(input, { bytes: 32768 }))
    closedOutputObject(config, ['identity', 'indexKeyId', 'capacity', 'application'])
    this.identity = new PrivateServiceIdentity(
      config.identity as unknown as PrivateServiceIdentityScope,
      custody,
      outputString(config.indexKeyId)
    )
    this.serviceScope = structuredClone(config.identity) as unknown as PrivateServiceIdentityScope
    const bound = this.identity.configuration(
      config.capacity as unknown as PrivateServiceDomainConfiguration['capacity'],
      config.application as OutputJSONObject
    )
    this.ledger = create
      ? SQLiteProtectedLedger.create(path, bound, payloads)
      : SQLiteProtectedLedger.open(path, bound, payloads)
  }

  static create(
    path: string,
    config: PrivateServiceDomainConfiguration,
    custody: PrivateIdentityCustody,
    payloads: NodeProtectedPayloadCodec
  ): PrivateServiceDomain {
    return new PrivateServiceDomain(path, config, custody, payloads, true)
  }
  static open(
    path: string,
    config: PrivateServiceDomainConfiguration,
    custody: PrivateIdentityCustody,
    payloads: NodeProtectedPayloadCodec
  ): PrivateServiceDomain {
    return new PrivateServiceDomain(path, config, custody, payloads, false)
  }
  get scope(): PrivateServiceIdentityScope {
    return structuredClone(this.serviceScope)
  }
  close(): void {
    this.ledger.close()
  }
}
