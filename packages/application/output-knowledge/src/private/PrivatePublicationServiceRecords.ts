import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputString,
  parseOutputJSON
} from '@bsv/sdk'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import { protectedInteger, protectedValue } from './ProtectedLedgerCodec.js'
import type { PrivatePublicationContracts } from './PrivatePublicationContracts.js'
import {
  parsePrivatePublicationContractRecord,
  parsePrivatePublicationContractMetadata
} from './PrivatePublicationContractRecord.js'
import { createPrivateLookupBinding, privateLookupBindingAddress } from './PrivateLookupBinding.js'
import {
  parsePrivatePublicationRecords,
  type createPrivatePublicationRecords,
  type PrivatePublicationFence,
  type PrivatePublicationBlob
} from './PrivatePublicationRecords.js'
import type { PrivatePublicationProgress } from './PrivatePublicationProgress.js'

export interface PrivatePublicationServiceInstallation {
  contracts: PrivatePublicationContracts
  validationPolicy: { id: string; digest: string }
  lookup: { service: string; rulesDigest: string }
  maximumBindingBytes: number
  maximumOutcomeBytes: number
  supportedExtensions?: readonly string[]
}

/** Owned installed semantics for the explicit verified native path. */
export class PrivatePublicationServiceRecords {
  readonly maximumBindingBytes: number
  private readonly maximumOutcomeBytes: number
  private readonly policy: PrivatePublicationServiceInstallation['validationPolicy']
  private readonly lookup: PrivatePublicationServiceInstallation['lookup']
  private readonly extensions: readonly string[]
  private readonly contracts: PrivatePublicationContracts

  constructor(
    private readonly domain: PrivateServiceDomain,
    input: PrivatePublicationServiceInstallation
  ) {
    this.contracts = input.contracts
    const value = parseOutputJSON(
      canonicalOutputJSON(
        {
          validationPolicy: input.validationPolicy,
          lookup: input.lookup,
          maximumBindingBytes: input.maximumBindingBytes,
          maximumOutcomeBytes: input.maximumOutcomeBytes,
          supportedExtensions: input.supportedExtensions ?? []
        },
        { bytes: 16384 }
      )
    )
    closedOutputObject(value, [
      'validationPolicy',
      'lookup',
      'maximumBindingBytes',
      'maximumOutcomeBytes',
      'supportedExtensions'
    ])
    closedOutputObject(value.validationPolicy, ['id', 'digest'])
    closedOutputObject(value.lookup, ['service', 'rulesDigest'])
    this.policy = {
      id: outputString(value.validationPolicy.id),
      digest: outputHex32(value.validationPolicy.digest)
    }
    this.lookup = {
      service: outputString(value.lookup.service),
      rulesDigest: outputHex32(value.lookup.rulesDigest)
    }
    this.maximumBindingBytes = protectedInteger(value.maximumBindingBytes, 2 * 1048576)
    this.maximumOutcomeBytes = protectedInteger(value.maximumOutcomeBytes, 65536)
    outputAssert(
      Array.isArray(value.supportedExtensions) && value.supportedExtensions.length <= 32,
      'Invalid private service extensions'
    )
    this.extensions = value.supportedExtensions.map(extension => outputString(extension))
    const installed = this.contracts.configuration()
    outputAssert(
      installed.seller === domain.scope.seller &&
        canonicalOutputJSON(installed.chain) === canonicalOutputJSON(domain.scope.chain),
      'Private service and native custody domain differ',
      'context-changed'
    )
  }

  prepare(prepared: ReturnType<typeof createPrivatePublicationRecords>, input: unknown) {
    const pair = parseOutputJSON(canonicalOutputJSON(prepared, { bytes: 4194304 }))
    const originalInput = parseOutputJSON(canonicalOutputJSON(input, { bytes: 1048576 }))
    closedOutputObject(pair, ['blob', 'fence'])
    prepared = parsePrivatePublicationRecords(
      pair.fence,
      pair.blob,
      this.domain.identity,
      this.extensions
    )
    const request = {
      ...prepared.fence.reference,
      privateValues: prepared.blob.privateValues
    }
    const original = parsePrivatePublicationContractRecord(
      originalInput,
      prepared.fence.state,
      request,
      this.contracts,
      this.policy,
      this.extensions
    )
    this.requireLookup(prepared.fence.state)
    const binding = createPrivateLookupBinding(prepared.blob, this.lookup, this.domain.identity)
    const bindingFrame = canonicalOutputJSON({
      ...binding,
      phase: 'active',
      admission: null
    })
    outputAssert(
      Buffer.byteLength(bindingFrame) - 4 + this.maximumOutcomeBytes <= this.maximumBindingBytes,
      'Private lookup completion does not fit its reservation',
      'limited'
    )
    // Bound the complete maximum future state, including escaped reason bytes.
    // The admission port's complete outcome allowance safely exceeds its retained
    // admission projection. A reason may occupy six JSON bytes per UTF-8 byte.
    const progressFrame = canonicalOutputJSON({
      ...prepared.fence.state,
      updatedAt: '18446744073709551615',
      progress: {
        phase: 'unavailable',
        admission: null,
        binding: {
          publicationId: prepared.fence.state.publicationId,
          requestDigest: prepared.fence.state.requestDigest,
          blobKey: prepared.fence.state.blobKey,
          ...this.lookup,
          receiptDigest: '0'.repeat(64)
        },
        reason: null
      }
    })
    outputAssert(
      Buffer.byteLength(progressFrame) - 8 + this.maximumOutcomeBytes + 6146 <= 65536,
      'Private publication admission cannot fit its complete progress record',
      'limited'
    )
    const fence: PrivatePublicationFence = {
      ...prepared.fence,
      format: 'private-publication-fence/2',
      original: protectedValue(original, 1048576).value
    }
    return {
      blob: prepared.blob,
      fence,
      binding,
      bindingAddress: privateLookupBindingAddress(this.domain.identity, binding)
    }
  }

  restore(fence: PrivatePublicationFence, blob: PrivatePublicationBlob) {
    outputAssert(
      fence.format === 'private-publication-fence/2',
      'Original private publication service contract is unavailable',
      'unavailable'
    )
    this.requireLookup(fence.state)
    return parsePrivatePublicationContractRecord(
      fence.original,
      fence.state,
      { ...fence.reference, privateValues: blob.privateValues },
      this.contracts,
      this.policy,
      this.extensions
    )
  }

  /** Retained public metadata is sufficient to report loss, never to establish readiness. */
  restoreStatus(fence: PrivatePublicationFence) {
    outputAssert(
      fence.format === 'private-publication-fence/2',
      'Original private publication service contract is unavailable',
      'unavailable'
    )
    this.requireLookup(fence.state)
    return parsePrivatePublicationContractMetadata(
      fence.original,
      fence.state,
      fence.reference,
      this.contracts,
      this.policy,
      this.extensions
    )
  }

  bindingAddress(state: PrivatePublicationProgress) {
    this.requireLookup(state)
    return privateLookupBindingAddress(this.domain.identity, {
      blobKey: state.blobKey,
      lookup: this.lookup
    })
  }

  private requireLookup(state: PrivatePublicationProgress): void {
    outputAssert(
      state.lookup.service === this.lookup.service &&
        state.lookup.rulesDigest === this.lookup.rulesDigest,
      'Private publication lookup installation differs',
      'context-changed'
    )
  }
}
