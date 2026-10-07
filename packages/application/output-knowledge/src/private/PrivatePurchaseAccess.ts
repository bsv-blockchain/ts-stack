import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputPurchasePrepare,
  type OutputPurchasePrepare
} from '@bsv/sdk'
import {
  PrivateAcquisitionPayloads,
  parsePrivateAcquisitionPayload
} from './PrivateAcquisitionPayloads.js'
import { nativeOutputBytes } from './NativeOutputBytes.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type { ProtectedLedgerGuard, ProtectedLedgerView } from './ProtectedLedgerCodec.js'
import type { PrivatePurchaseCandidateProfile } from './PrivatePurchaseProgress.js'

/** Current permission shares native purchase custody. Match recipient ownership
 * before reading original chunks; a lookup catalogue is not recovery authority.
 */
export class PrivatePurchaseAccess {
  private readonly topic: string
  private readonly payloads: PrivateAcquisitionPayloads
  constructor(
    private readonly domain: PrivateServiceDomain,
    topic: string,
    private readonly policy: (
      request: OutputPurchasePrepare,
      buyer: string,
      mode: 'initial' | 'retained',
      view: ProtectedLedgerView
    ) => boolean,
    private readonly candidateProfile?: PrivatePurchaseCandidateProfile,
    /** Explicit installation for new alias-owned state3; historical formats are
     * not silently reopened or migrated by this companion. */
    private readonly ownerProfile?: 'alias-custody-v1'
  ) {
    this.topic = outputString(topic)
    outputAssert(
      candidateProfile === undefined || candidateProfile === 'full-purchase-commitment-v1',
      'Unsupported purchase access candidate profile',
      'unsupported'
    )
    outputAssert(
      typeof policy === 'function' && policy.constructor.name !== 'AsyncFunction',
      'Purchase access policy must be synchronous'
    )
    outputAssert(
      ownerProfile === undefined ||
        (ownerProfile === 'alias-custody-v1' && candidateProfile === 'full-purchase-commitment-v1'),
      'Unsupported purchase access owner profile',
      'unsupported'
    )
    this.payloads = new PrivateAcquisitionPayloads(domain.identity)
  }
  guard(
    idInput: string,
    buyerInput: string,
    current: () => boolean,
    initial?: OutputPurchasePrepare
  ): ProtectedLedgerGuard {
    const id = outputHex32(idInput),
      buyer = outputIdentity(buyerInput),
      proposed = initial === undefined ? undefined : parseOutputPurchasePrepare(initial),
      address = this.domain.identity.address('acquisition', {
        purpose: 'private-purchase-state',
        acquisitionId: id
      })
    outputAssert(
      typeof current === 'function' && current.constructor.name !== 'AsyncFunction',
      'Purchase request context must be synchronous'
    )
    if (proposed) this.check(proposed, id, buyer)
    return view => {
      if (!permitted(current())) throw missing()
      const row = view.get(address)
      let request: OutputPurchasePrepare, mode: 'initial' | 'retained'
      if (row) {
        if (row.value.recipient !== buyer) throw missing()
        outputAssert(this.acceptsState(row.value), 'Purchase access state differs', 'unavailable')
        const descriptor = parsePrivateAcquisitionPayload(row.value.original)
        outputAssert(
          descriptor.acquisitionId === id && descriptor.purpose === 'material',
          'Purchase original access binding differs',
          'unavailable'
        )
        const custody = parseOutputJSON(
          Uint8Array.from(
            nativeOutputBytes(
              this.payloads.read(
                descriptor,
                this.payloads.addresses(descriptor).map(item => view.get(item))
              ),
              descriptor.maximumBytes
            )
          ),
          { bytes: descriptor.maximumBytes }
        )
        closedOutputObject(custody, [
          'format',
          'original',
          'validationPolicy',
          'schema',
          'maximumSecretBytes',
          'material'
        ])
        closedOutputObject(custody.original, [
          'format',
          'request',
          'terms',
          'capability',
          'createdAt'
        ])
        request = parseOutputPurchasePrepare(custody.original.request)
        outputAssert(
          outputPacketDigest('purchase-request', request) === descriptor.requestDigest,
          'Purchase retained access request differs',
          'unavailable'
        )
        mode = 'retained'
      } else {
        if (!proposed) throw missing()
        request = proposed
        mode = 'initial'
      }
      this.check(request, id, buyer)
      if (
        !permitted(this.policy(structuredClone(request), buyer, mode, view)) ||
        !permitted(current())
      )
        throw missing()
    }
  }
  private acceptsState(value: Record<string, unknown>): boolean {
    if (!this.candidateProfile) return value.format === 'private-purchase-state/1'
    const formatMatches =
      this.ownerProfile === 'alias-custody-v1'
        ? value.format === 'private-purchase-state/3' &&
          value.clockProfile === 'native-observation-v1'
        : value.format === 'private-purchase-state/2'
    return formatMatches && value.candidateProfile === this.candidateProfile
  }
  private check(request: OutputPurchasePrepare, id: string, buyer: string): void {
    outputAssert(
      request.recipient === buyer &&
        request.topic === this.topic &&
        canonicalOutputJSON(request.listing.chain) ===
          canonicalOutputJSON(this.domain.scope.chain) &&
        outputPacketDigest('purchase', {
          chain: this.domain.scope.chain,
          seller: this.domain.scope.seller,
          recipient: buyer,
          topic: this.topic,
          requestId: request.requestId
        }) === id,
      'Purchase access request binding differs',
      'unavailable'
    )
  }
}
function missing(): OutputProtocolError {
  return new OutputProtocolError('not-found', 'Purchase not found')
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
