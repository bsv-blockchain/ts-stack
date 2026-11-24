import {
  Beef,
  LookupResolver,
  Utils,
  canonicalOutputBase,
  canonicalOutputJSON,
  outputPacketDigest,
  outputHex32,
  OutputProtocolError,
  type LookupAnswer,
  type LookupAnswerProgress,
  type LookupQuestion,
  type OverlayLookupFacilitator
} from '@bsv/sdk'
import { DirectDeliverySource } from './DirectDeliverySource.js'
import { SourceSession, type SourceBinding } from './SourceSession.js'
import type { OutputObservation, Source, SourceBatch, SourceRequest } from '../ports.js'

export const LEGACY_LOOKUP_CONTEXT_SCHEMA =
  'https://bsv.brc.dev/apps/0192#legacy-lookup-context-json-v1'
export interface LookupOutputSourceOptions extends SourceBinding {
  host: string
  question: LookupQuestion
  facilitator?: OverlayLookupFacilitator
  /** Trusted development configuration only. */
  allowLocalHTTP?: boolean
}
export function lookupOutputQueryDigest(question: LookupQuestion): string {
  return outputPacketDigest('lookup-query', question)
}

function observation(
  row: LookupAnswer['outputs'][number],
  session: SourceSession,
  id: string
): OutputObservation {
  let txid = row.txid?.toLowerCase()
  if (txid === undefined) {
    // Legacy BRC-24 assigns the final BEEF entry as its target. Wallet aggregate
    // evidence follows a different adapter and always supplies an explicit txid.
    const bundle = Beef.fromBinaryStrict(row.beef)
    txid = bundle.atomicTxid ?? bundle.txs.at(-1)?.txid
  }
  return {
    id,
    scope: session.scope,
    kind: 'output',
    payload: {
      evidence: {
        txid: outputHex32(txid),
        outputIndex: row.outputIndex,
        beef: Utils.toBase64(row.beef)
      },
      ...(row.context === undefined
        ? {}
        : {
            context: {
              schema: LEGACY_LOOKUP_CONTEXT_SCHEMA,
              bytes: Utils.toBase64(Utils.toArray(JSON.stringify(row.context), 'utf8'))
            }
          })
    }
  }
}

/**
 * One legacy host per Source preserves provider receipts before resolver union.
 * Attach several instances concurrently for progressive federated ingestion.
 * Finite completion has no restart/live continuity claim and no replay cursor.
 */
export class LookupOutputSource implements Source {
  readonly id: string
  private readonly session: SourceSession
  private readonly resolver: LookupResolver
  private readonly question: LookupQuestion
  private readonly host: string

  constructor(options: LookupOutputSourceOptions) {
    this.session = new SourceSession(options)
    this.id = this.session.id
    this.host = canonicalOutputBase(options.host, options.allowLocalHTTP)
    this.question = JSON.parse(canonicalOutputJSON(options.question)) as LookupQuestion
    if (
      this.session.scope.provider !== this.host ||
      this.session.scope.service !== this.question.service ||
      this.session.scope.queryDigest !== lookupOutputQueryDigest(this.question)
    )
      throw new OutputProtocolError('invalid', 'Lookup host or query differs from configured scope')
    this.resolver = new LookupResolver({
      facilitator: options.facilitator,
      networkPreset: options.allowLocalHTTP ? 'local' : 'mainnet',
      slapTrackers: [],
      hostOverrides: { [this.question.service]: [this.host] },
      limits: { maxHosts: 1, hostConcurrency: 1 },
      reputationStorage: { get: () => null, set: () => {} }
    })
  }
  async *open(input: SourceRequest, signal: AbortSignal): AsyncIterable<SourceBatch> {
    const request = this.session.begin(input, signal),
      inbox = new DirectDeliverySource({
        id: this.id,
        scope: this.session.scope,
        now: this.session.now,
        allowVolatileReceipts: true,
        maximumQueuedDeliveries: request.limits.observations
      }),
      incoming = inbox.open(request, signal),
      transport = new AbortController(),
      stop = () => transport.abort()
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    let progress: LookupAnswerProgress | undefined,
      failure: unknown,
      received = 0
    const receipts: Promise<void>[] = []
    const pump = (async () => {
      try {
        for await (const next of this.resolver.query$(this.question, request.limits.deadlineMs, {
          signal: transport.signal,
          deadlineMs: request.limits.deadlineMs,
          graceMs: 0,
          evidenceLimits: {
            maxOutputs: request.limits.observations,
            maxBytes: request.limits.pendingBytes
          },
          onEvidence: event => {
            if (failure !== undefined || signal.aborted) return
            try {
              if (event.type === 'limit')
                throw new OutputProtocolError('limited', 'Lookup evidence intake limit', true)
              if (canonicalOutputBase(event.host, this.host.startsWith('http:')) !== this.host)
                throw new OutputProtocolError('unauthorized', 'Lookup receipt changed provider')
              const id = `lookup:${request.generation}:${received++}`,
                pending = inbox.deliver({
                  id,
                  observations: [observation(event.output, this.session, id)]
                })
              receipts.push(pending)
              void pending.catch(error => {
                failure ??= error
                transport.abort()
              })
            } catch (error) {
              failure = error
              transport.abort()
            }
          }
        }))
          progress = next
      } catch (error) {
        failure ??= error
      } finally {
        await Promise.allSettled(receipts)
        inbox.close()
      }
    })()
    try {
      for await (const batch of incoming) yield batch
      await pump
      this.session.check(signal)
      const limited =
          (failure instanceof OutputProtocolError && failure.code === 'limited') ||
          progress?.terminalReason === 'resource-limit' ||
          progress?.terminalReason === 'deadline',
        complete =
          failure === undefined &&
          progress?.terminalReason === 'settled' &&
          progress.successfulHosts === 1 &&
          progress.failedHosts === 0 &&
          progress.rejectedHosts === 0 &&
          progress.freeformHosts === 0
      let status: SourceBatch['coverage']['status'] = complete ? 'complete' : 'unavailable'
      if (limited) status = 'limited'
      yield this.session.batch(request, [], status)
    } finally {
      transport.abort()
      inbox.close()
      signal.removeEventListener('abort', stop)
      this.session.end()
    }
  }
}
