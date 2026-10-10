import {
  ownOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  OutputProtocolError,
  parseOutputPrivatePublish,
  type OutputPrivatePublish
} from '@bsv/sdk'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import { privatePublicationFenceAddress } from './PrivatePublicationRecords.js'

export type PrivatePublicationPublicReference = Omit<OutputPrivatePublish, 'privateValues'>

/** Current installed publisher authority, evaluated inside the native transaction. */
export class PrivatePublicationAccess {
  private readonly topic: string
  private readonly extensions: readonly string[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    topic: string,
    private readonly policy: (
      reference: PrivatePublicationPublicReference,
      publisher: string
    ) => boolean,
    supportedExtensions: readonly string[] = []
  ) {
    this.topic = outputString(topic)
    outputAssert(
      typeof policy === 'function' && policy.constructor.name !== 'AsyncFunction',
      'Private publication access policy must be synchronous'
    )
    this.extensions = [...supportedExtensions]
  }

  /**
   * A reference permits initial staging only; it cannot replace a retained one.
   * Authentication supplies publisher/current. An HTTP body never supplies them.
   */
  guard(
    publicationId: string,
    publisher: string,
    current: () => boolean,
    initial?: PrivatePublicationPublicReference
  ): ProtectedLedgerGuard {
    const id = outputHex32(publicationId),
      identity = outputIdentity(publisher)
    outputAssert(
      typeof current === 'function' && current.constructor.name !== 'AsyncFunction',
      'Private publication request context must be synchronous'
    )
    const proposed = initial === undefined ? undefined : this.reference(initial)
    if (proposed) this.checkReference(proposed, id, identity)
    const address = privatePublicationFenceAddress(this.domain.identity, id)
    return view => {
      if (!permitted(current())) throw missing()
      const record = view.get(address)
      let reference: PrivatePublicationPublicReference
      if (record) {
        const state = record.value.state
        // Check ownership before parsing other retained details or reading a blob.
        // A wrong caller receives no record-specific diagnostic or private values.
        if (
          !state ||
          typeof state !== 'object' ||
          Array.isArray(state) ||
          state.publisher !== identity
        )
          throw missing()
        outputAssert(
          state.publicationId === id && state.topic === this.topic,
          'Private publication access binding differs',
          'unavailable'
        )
        reference = this.reference(record.value.reference)
      } else {
        if (!proposed) throw missing()
        reference = proposed
      }
      this.checkReference(reference, id, identity)
      if (!permitted(this.policy(structuredClone(reference), identity)) || !permitted(current()))
        throw missing()
    }
  }

  private reference(input: unknown): PrivatePublicationPublicReference {
    const value = ownOutputJSON(input).value
    closedOutputObject(
      value,
      ['version', 'requestId', 'topic', 'evidence', 'assetId', 'schema'],
      ['extensions', 'critical']
    )
    const { privateValues: _unused, ...reference } = parseOutputPrivatePublish(
      { ...value, privateValues: '' },
      this.extensions
    )
    return reference
  }
  private checkReference(
    reference: PrivatePublicationPublicReference,
    id: string,
    publisher: string
  ) {
    outputAssert(
      reference.topic === this.topic &&
        outputPacketDigest('private-publication', {
          chain: this.domain.scope.chain,
          publisher,
          topic: reference.topic,
          requestId: reference.requestId
        }) === id,
      'Private publication request identity differs',
      'unavailable'
    )
  }
}
function missing(): OutputProtocolError {
  return new OutputProtocolError('not-found', 'Private publication not found')
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
