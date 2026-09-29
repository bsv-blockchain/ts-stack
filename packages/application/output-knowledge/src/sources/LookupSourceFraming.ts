import {
  canonicalOutputJSON,
  parseOutputJSON,
  closedOutputObject,
  parseOutputScope,
  parseOutputLookupBatch,
  parseOutputLookupCheckpoint,
  parseOutputLookupOpen,
  outputPacketDigest,
  outputString,
  outputIdentity,
  outputU64,
  OutputProtocolError,
  type OutputLookupCheckpoint,
  type OutputLookupOpen,
  type OutputScope
} from '@bsv/sdk'
import { parseSourceBatch, parseSourceRequest } from '../validation.js'
import type { Provenance, SourceBatch, SourceRequest } from '../ports.js'

/** The query identity known before the provider assigns access and epoch. */
export type LookupQueryScope = Omit<OutputScope, 'access' | 'epoch'>
export interface LookupSourceFrame {
  id: string
  partition: SourceRequest['partition']
  /** Source refresh generation, independent of VerificationContext.generation. */
  generation: string
  limits: SourceRequest['limits']
  scope: LookupQueryScope
  authentication: Provenance['authentication']
}

const maximumU64 = '18446744073709551615'
// A single UTF-8 byte can expand to six JSON bytes. These strings attain that
// bound for the four provider-assigned fields without invalid Unicode.
const maximumEscapedText = '\u0000'.repeat(1024)
const bytes = (value: unknown): number =>
  new TextEncoder().encode(canonicalOutputJSON(value)).length

/** Local framing only: this neither authenticates HTTP nor advances a cursor. */
export class LookupSourceFraming {
  private readonly frame: LookupSourceFrame

  constructor(input: LookupSourceFrame) {
    const request = parseSourceRequest({
      partition: input.partition,
      generation: input.generation,
      scope: { ...input.scope, access: 'unassigned', epoch: 'unassigned' },
      limits: input.limits
    })
    const { access: _access, epoch: _epoch, ...scope } = request.scope
    if (input.authentication !== 'brc103' && input.authentication !== 'configured-transport')
      throw new OutputProtocolError('invalid', 'Invalid lookup source authentication mode')
    if (input.authentication === 'brc103') outputIdentity(scope.provider)
    this.frame = {
      id: outputString(input.id),
      partition: request.partition,
      generation: request.generation,
      limits: request.limits,
      scope,
      authentication: input.authentication
    }
  }

  private checkScope(input: unknown): OutputScope {
    const scope = parseOutputScope(input)
    const { access: _access, epoch: _epoch, ...query } = scope
    if (canonicalOutputJSON(query) !== canonicalOutputJSON(this.frame.scope))
      throw new OutputProtocolError('context-changed', 'Lookup source query identity changed')
    return scope
  }

  checkpoint(input: unknown): OutputLookupCheckpoint {
    const checkpoint = parseOutputLookupCheckpoint(input)
    this.checkScope(checkpoint.scope)
    return checkpoint
  }

  opening(input: unknown): OutputLookupOpen {
    const open = parseOutputLookupOpen(input)
    if (
      open.service !== this.frame.scope.service ||
      outputPacketDigest('lookup-query', { service: open.service, query: open.query }) !==
        this.frame.scope.queryDigest ||
      (open.requiredRulesDigest !== undefined &&
        open.requiredRulesDigest !== this.frame.scope.rulesDigest)
    )
      throw new OutputProtocolError('context-changed', 'Original lookup query or rules changed')
    return open
  }

  /** Call only after selected HTTP authentication, using the original receipt time. */
  fromLookup(input: unknown, maximumWireBytes: number, receivedAt: string): SourceBatch {
    const packet = parseOutputLookupBatch(input, maximumWireBytes)
    const scope = this.checkScope(packet.scope)
    outputU64(receivedAt)
    return this.parse({
      provenance: {
        partition: this.frame.partition,
        generation: this.frame.generation,
        adapter: this.frame.id,
        scope,
        authentication: this.frame.authentication,
        peer: scope.provider,
        receivedAt
      },
      groups: packet.groups,
      coverage: {
        scope,
        phase: packet.phase,
        status:
          packet.phase === 'snapshot'
            ? packet.snapshotComplete
              ? 'complete'
              : 'partial'
            : packet.through === packet.highWater
              ? 'complete'
              : 'partial',
        through: packet.through,
        highWater: packet.highWater
      },
      checkpoint: {
        session: packet.session,
        cursor: packet.cursor,
        expiresAt: packet.expiresAt,
        replayUntil: packet.replayUntil
      }
    })
  }

  /** Local continuity loss: no observations, successful cursor or remote spend claim. */
  reset(previous: OutputLookupCheckpoint, receivedAt: string): SourceBatch {
    const checkpoint = this.checkpoint(previous)
    outputU64(receivedAt)
    return this.parse({
      provenance: {
        partition: this.frame.partition,
        generation: this.frame.generation,
        adapter: this.frame.id,
        scope: checkpoint.scope,
        authentication: this.frame.authentication,
        peer: checkpoint.scope.provider,
        receivedAt
      },
      groups: [],
      coverage: {
        scope: checkpoint.scope,
        phase: checkpoint.phase,
        status: 'reset-required',
        through: checkpoint.through,
        highWater: checkpoint.highWater
      }
    })
  }

  /** Recheck an owned stored receipt; a local checksum is not remote authentication. */
  parse(input: unknown): SourceBatch {
    const value = parseOutputJSON(
      canonicalOutputJSON(input, { bytes: this.frame.limits.batchBytes }),
      { bytes: this.frame.limits.batchBytes }
    )
    closedOutputObject(value, ['provenance', 'groups', 'coverage'], ['checkpoint'])
    closedOutputObject(value.provenance, [
      'partition',
      'generation',
      'adapter',
      'scope',
      'authentication',
      'peer',
      'receivedAt'
    ])
    const scope = this.checkScope(value.provenance.scope)
    const batch = parseSourceBatch(
      value,
      {
        partition: this.frame.partition,
        generation: this.frame.generation,
        adapter: this.frame.id,
        scope
      },
      this.frame.limits
    )
    if (
      batch.provenance.authentication !== this.frame.authentication ||
      batch.provenance.peer !== scope.provider ||
      (batch.coverage.phase !== 'snapshot' && batch.coverage.phase !== 'live') ||
      !['partial', 'complete', 'reset-required'].includes(batch.coverage.status)
    )
      throw new OutputProtocolError('invalid', 'Invalid stored lookup source receipt')
    if (batch.coverage.status === 'reset-required') {
      if (
        batch.groups.length !== 0 ||
        batch.checkpoint !== undefined ||
        batch.coverage.through === undefined ||
        batch.coverage.highWater === undefined
      )
        throw new OutputProtocolError('invalid', 'Invalid local continuity reset')
    } else lookupSourceCheckpoint(batch)
    return batch
  }

  /**
   * Conservative envelope bound with no groups. A canonical wire batch already
   * contains all canonical group bytes, so wireAllowance + this bound covers the
   * complete SourceBatch, including duplicated scope and maximally escaped IDs.
   * The empty group brackets are deliberately counted twice in that inequality.
   */
  maximumEnvelope(): SourceBatch {
    const scope = { ...this.frame.scope, access: maximumEscapedText, epoch: maximumEscapedText }
    return structuredClone<SourceBatch>({
      provenance: {
        partition: this.frame.partition,
        generation: this.frame.generation,
        adapter: this.frame.id,
        scope,
        authentication: this.frame.authentication,
        peer: scope.provider,
        receivedAt: maximumU64
      },
      groups: [],
      coverage: {
        scope,
        phase: 'snapshot',
        status: 'complete',
        through: maximumU64,
        highWater: maximumU64
      },
      checkpoint: {
        session: maximumEscapedText,
        cursor: maximumEscapedText,
        expiresAt: maximumU64,
        replayUntil: maximumU64
      }
    })
  }

  /** No implicit lowering of a stored Open: use this before reserving its limits. */
  maximumWireBytes(): number {
    const allowance = this.frame.limits.batchBytes - bytes(this.maximumEnvelope())
    if (allowance < 1)
      throw new OutputProtocolError('limited', 'Source capacity cannot hold lookup framing')
    return allowance
  }
}

/** Compact metadata is recoverable from the SAME receipt committed with its groups. */
export function lookupSourceCheckpoint(batch: SourceBatch): OutputLookupCheckpoint {
  const coverage = batch.coverage
  if (
    !batch.checkpoint ||
    coverage.phase === 'finite' ||
    coverage.through === undefined ||
    coverage.highWater === undefined
  )
    throw new OutputProtocolError('invalid', 'Missing live lookup checkpoint metadata')
  if (
    coverage.phase === 'live' &&
    (coverage.status === 'complete') !== (coverage.through === coverage.highWater)
  )
    throw new OutputProtocolError('invalid', 'Live lookup coverage differs from its watermark')
  return parseOutputLookupCheckpoint({
    version: 1,
    ...batch.checkpoint,
    scope: batch.provenance.scope,
    phase: coverage.phase,
    snapshotComplete: coverage.phase === 'live' || coverage.status === 'complete',
    through: coverage.through,
    highWater: coverage.highWater
  })
}
