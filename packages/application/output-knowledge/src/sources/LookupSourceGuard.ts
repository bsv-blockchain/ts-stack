import { canonicalOutputJSON, outputU64, OutputProtocolError, type OutputScope } from '@bsv/sdk'
import { parseVerificationContext } from '../validation.js'
import type { SourceBatch, VerificationContext } from '../ports.js'
import type { KnowledgeStore } from '../KnowledgeStore.js'
import { outputSourceIdentity } from '../SourceMembership.js'
import { knowledgeMutation, type JournalEntry } from '../storage/Journal.js'
import { lookupSourceCheckpoint } from './LookupSourceFraming.js'
import type { LookupSourceState } from './LookupSourceState.js'
import type { NormalizedLiveLookupConfiguration } from './LiveLookupConfiguration.js'

/** Local receipt-history fence, independent of VerificationContext.generation. */
export class LookupSourceGuard {
  constructor(
    private readonly core: KnowledgeStore,
    private readonly configuration: NormalizedLiveLookupConfiguration
  ) {
    if (core.durability !== 'durable')
      throw new OutputProtocolError('unsupported', 'Live lookup requires a durable core journal')
    if (
      core.journalId !== configuration.journalId ||
      canonicalOutputJSON(core.partition) !== canonicalOutputJSON(configuration.partition)
    )
      throw new OutputProtocolError('context-changed', 'Live lookup core binding changed')
  }

  async inspect(
    minimumReceived: string,
    scope: OutputScope | undefined,
    signal: AbortSignal,
    continuity: Pick<LookupSourceState, 'previous' | 'previousReceipt'>,
    replayResetKey?: string
  ): Promise<string> {
    const history = await this.core.inspect(signal)
    if (outputU64(history.revision.received) < outputU64(minimumReceived))
      throw new OutputProtocolError('reset-required', 'Core journal precedes retained lookup state')
    this.checkPredecessor(history.entries, continuity)
    const current = this.latestContext(history.entries)
    if (
      canonicalOutputJSON(current.partition) !==
        canonicalOutputJSON(this.configuration.partition) ||
      canonicalOutputJSON(current.view.chain) !==
        canonicalOutputJSON(this.configuration.scope.chain)
    )
      throw new OutputProtocolError('context-changed', 'Live lookup core chain changed')
    if (scope !== undefined)
      for (const entry of history.entries)
        if (entry.body.kind === 'receive') this.checkSource(entry.body.batch, scope, replayResetKey)
    return history.revision.received
  }

  private latestContext(entries: readonly JournalEntry[]): VerificationContext {
    // Preserve the ES2022 consumer target without copying the complete history.
    for (let index = entries.length - 1; index >= 0; index--) {
      const body = entries[index].body
      if (body.kind === 'context') return parseVerificationContext(body.context)
    }
    throw new OutputProtocolError(
      'revision-unavailable',
      'Live lookup requires an initial verification context'
    )
  }

  private checkPredecessor(
    entries: readonly JournalEntry[],
    continuity: Pick<LookupSourceState, 'previous' | 'previousReceipt'>
  ): void {
    const expected = continuity.previousReceipt
    if (expected === null) return
    const receipt = entries.find(entry => entry.key === expected.key)
    if (
      receipt?.revision.received !== expected.received ||
      receipt.body.kind !== 'receive' ||
      canonicalOutputJSON(lookupSourceCheckpoint(receipt.body.batch)) !==
        canonicalOutputJSON(continuity.previous)
    )
      throw new OutputProtocolError(
        'reset-required',
        'Saved lookup cursor lost its exact core receipt'
      )
  }
  private checkSource(batch: SourceBatch, scope: OutputScope, replayResetKey?: string): void {
    if (outputSourceIdentity(batch.provenance.scope) !== outputSourceIdentity(scope)) return
    const generation = outputU64(batch.provenance.generation)
    const selected = outputU64(this.configuration.generation)
    if (
      generation > selected ||
      (generation === selected && batch.provenance.scope.epoch !== scope.epoch)
    )
      throw new OutputProtocolError(
        'context-changed',
        'Live lookup source generation retired or epoch changed'
      )
    if (
      generation === selected &&
      batch.coverage.status === 'reset-required' &&
      knowledgeMutation({ kind: 'receive', batch }).key !== replayResetKey
    )
      throw new OutputProtocolError(
        'reset-required',
        'Live lookup source continuity was invalidated'
      )
  }
}
