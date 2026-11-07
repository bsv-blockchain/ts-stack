import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  OutputProtocolError,
  parseOutputPaidLookupAcquire,
  type OutputPaidLookupAcquire
} from '@bsv/sdk'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import { privateAcquisitionAddress } from './PrivateAcquisitionState.js'

/** Current buyer access shares the native state domain; catalogue availability is separate. */
export class PrivateAcquisitionAccess {
  private readonly service: string
  private readonly extensions: readonly string[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    service: string,
    private readonly policy: (
      request: OutputPaidLookupAcquire,
      buyer: string,
      mode: 'initial' | 'retained'
    ) => boolean,
    supportedExtensions: readonly string[] = []
  ) {
    this.service = outputString(service)
    outputAssert(
      typeof policy === 'function' && policy.constructor.name !== 'AsyncFunction',
      'Acquisition access policy must be synchronous'
    )
    this.extensions = [...supportedExtensions]
  }
  guard(
    acquisitionId: string,
    buyer: string,
    current: () => boolean,
    initial?: OutputPaidLookupAcquire
  ): ProtectedLedgerGuard {
    const id = outputHex32(acquisitionId),
      identity = outputIdentity(buyer)
    outputAssert(
      typeof current === 'function' && current.constructor.name !== 'AsyncFunction',
      'Acquisition request context must be synchronous'
    )
    const proposed =
      initial === undefined ? undefined : parseOutputPaidLookupAcquire(initial, this.extensions)
    if (proposed) this.check(proposed, id, identity)
    const address = privateAcquisitionAddress(this.domain.identity, 'acquisition', id)
    const quote = privateAcquisitionAddress(this.domain.identity, 'quote', id)
    return view => {
      if (!permitted(current())) throw missing()
      const row = view.get(address)
      let request: OutputPaidLookupAcquire, mode: 'initial' | 'retained'
      if (row) {
        const state = row.value.progress
        if (!state || typeof state !== 'object' || Array.isArray(state)) throw missing()
        const challenge = state.challenge
        // Match ownership before parsing the original or decrypting result material.
        if (
          !challenge ||
          typeof challenge !== 'object' ||
          Array.isArray(challenge) ||
          challenge.buyer !== identity
        )
          throw missing()
        outputAssert(
          challenge.acquisitionId === id,
          'Acquisition access binding differs',
          'unavailable'
        )
        const original = view.get(quote)
        outputAssert(original, 'Acquisition original is unavailable', 'unavailable')
        request = parseOutputPaidLookupAcquire(original.value.request, this.extensions)
        outputAssert(
          outputPacketDigest('acquire-request', request) === challenge.requestDigest,
          'Acquisition access request differs',
          'unavailable'
        )
        mode = 'retained'
      } else {
        if (!proposed) throw missing()
        request = proposed
        mode = 'initial'
      }
      this.check(request, id, identity)
      if (
        !permitted(this.policy(structuredClone(request), identity, mode)) ||
        !permitted(current())
      )
        throw missing()
    }
  }
  private check(request: OutputPaidLookupAcquire, id: string, buyer: string): void {
    outputAssert(
      request.recipient === buyer &&
        request.service === this.service &&
        canonicalOutputJSON(request.listing.chain) ===
          canonicalOutputJSON(this.domain.scope.chain) &&
        outputPacketDigest('acquisition', {
          chain: this.domain.scope.chain,
          seller: this.domain.scope.seller,
          buyer,
          service: this.service,
          requestId: request.requestId
        }) === id,
      'Acquisition access request binding differs',
      'unavailable'
    )
  }
}
function missing(): OutputProtocolError {
  return new OutputProtocolError('not-found', 'Acquisition not found')
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
