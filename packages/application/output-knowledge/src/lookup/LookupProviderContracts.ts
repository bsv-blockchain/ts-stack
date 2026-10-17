import {
  canonicalOutputJSON,
  OUTPUT_LOOKUP_PROFILE,
  outputHex32,
  OutputProtocolError,
  retainOutputCapability,
  restoreOutputCapability,
  type OutputCapabilityRequest,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilitySelection,
  type OutputLookupLimits
} from '@bsv/sdk'
import { LookupQueryRegistry } from './LookupQueryRegistry.js'
import { lookupServingEpoch } from './LookupServingEpoch.js'

export type LookupProviderTrust = Omit<
  OutputCapabilityRequest,
  'now' | 'kind' | 'profile' | 'rules' | 'supportedExtensions' | 'authenticatedPeer'
>

/** One installed service, with exact retained rules independent of current discovery. */
export class LookupProviderContracts {
  private readonly request: Omit<OutputCapabilityRequest, 'now'>
  constructor(
    trust: LookupProviderTrust,
    readonly queries: LookupQueryRegistry,
    private readonly currentManifest: () => unknown
  ) {
    const rules = new Map(
      queries.describe().map(description => [
        description.rules.id,
        (parameters: unknown) => {
          if (canonicalOutputJSON(parameters) !== canonicalOutputJSON(description.rules.parameters))
            throw new OutputProtocolError(
              'unsupported',
              'Lookup rule parameters differ from installed rules'
            )
        }
      ])
    )
    this.request = {
      ...trust,
      chain: { ...trust.chain },
      rules,
      kind: 'lookup',
      profile: OUTPUT_LOOKUP_PROFILE,
      supportedExtensions: []
    }
  }

  recoveryTrust(): OutputCapabilityRecoveryRequest {
    return { ...this.request, chain: { ...this.request.chain }, rules: new Map(this.request.rules) }
  }

  fresh(selector: string, now: string): ReturnType<typeof retainOutputCapability> {
    outputHex32(selector)
    const selected = retainOutputCapability(this.currentManifest(), { ...this.request, now })
    this.check(selected.selection, selector)
    return selected
  }

  restore(record: unknown, selector: string): OutputCapabilitySelection {
    const selected = restoreOutputCapability(record, this.request)
    this.check(selected, selector)
    return selected
  }

  private check(selection: OutputCapabilitySelection, selector: string): void {
    if (selection.digest !== outputHex32(selector))
      throw new OutputProtocolError('context-changed', 'Lookup selection changed')
    lookupServingEpoch(selection.manifest.body, selection.service.name)
  }
}

export function lookupProviderMaximums(selection: OutputCapabilitySelection): OutputLookupLimits {
  return {
    maxBytes: selection.profile.maxResponseBytes,
    maxObservations: selection.profile.parameters.maxObservations as number,
    waitMs: selection.profile.parameters.maxWaitMs as number
  }
}
