import {
  canonicalOutputJSON,
  outputIdentity,
  outputString,
  OutputProtocolError,
  type OutputJSON,
  type OutputJSONObject
} from '@bsv/sdk'
import type { Source, SourceBatch, SourceRequest } from '../ports.js'
import { parseSourceBatch, parseSourceRequest } from '../validation.js'
import { ProposalPolicyRegistry } from './ProposalPolicyRegistry.js'
import { ProposalChannelHeadsContract } from './ProposalChannelHeadsContract.js'

/**
 * Opt-in grammar gate around an already authenticated durable live lookup source.
 * Connect the underlying source first, then pass its exact request here. Complete
 * groups are checked before core receipt; signature/policy acceptance and current
 * head projection remain separate. This wrapper never submits or finalizes work.
 */
export class ProposalChannelHeadsSource implements Source {
  readonly requiredDurability = 'durable' as const
  readonly id: string
  private readonly parameters: OutputJSONObject
  private readonly query: OutputJSON
  constructor(
    private readonly source: Source,
    private readonly registry: ProposalPolicyRegistry,
    parameters: OutputJSONObject,
    query: OutputJSON
  ) {
    if (source.requiredDurability !== 'durable')
      throw new OutputProtocolError(
        'unsupported',
        'Current-channel lookup requires durable source receipts'
      )
    this.id = outputString(source.id)
    this.parameters = JSON.parse(
      canonicalOutputJSON(parameters, { bytes: 65536 })
    ) as OutputJSONObject
    this.query = JSON.parse(canonicalOutputJSON(query, { bytes: 65536 })) as OutputJSON
  }

  async *open(input: SourceRequest, signal: AbortSignal): AsyncIterable<SourceBatch> {
    const request = parseSourceRequest(input)
    outputIdentity(request.scope.provider)
    const contract = new ProposalChannelHeadsContract(
      this.registry,
      request.scope,
      this.parameters,
      this.query
    )
    this.checkSignal(signal)
    for await (const incoming of this.source.open(request, signal)) {
      this.checkSignal(signal)
      const batch = parseSourceBatch(incoming, { ...request, adapter: this.id }, request.limits)
      if (batch.provenance.authentication !== 'brc103')
        throw new OutputProtocolError(
          'unauthorized',
          'Current-channel lookup requires authenticated provider provenance'
        )
      const phase = batch.coverage.phase
      if (phase !== 'snapshot' && phase !== 'live')
        throw new OutputProtocolError(
          'unsupported',
          'Current-channel lookup requires snapshot/live ordering'
        )
      if (batch.coverage.status === 'reset-required') {
        if (batch.groups.length !== 0)
          throw new OutputProtocolError(
            'equivocation',
            'Reset cannot carry current-channel observations'
          )
      } else if (batch.checkpoint === undefined)
        throw new OutputProtocolError(
          'reset-required',
          'Current-channel lookup lost its retained checkpoint'
        )
      for (const group of batch.groups) contract.check(group, phase)
      this.checkSignal(signal)
      yield batch
    }
  }

  private checkSignal(signal: AbortSignal): void {
    if (signal.aborted)
      throw new OutputProtocolError('cancelled', 'Current-channel source cancelled')
  }
}
