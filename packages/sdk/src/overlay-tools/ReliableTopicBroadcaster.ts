import type { LookupAnswer } from './LookupResolver.js'
import type Transaction from '../transaction/Transaction.js'
import TransactionParser from '../transaction/Transaction.js'
import type { BroadcastResponse, BroadcastFailure } from '../transaction/Broadcaster.js'
import type ReliableLookupResolver from './ReliableLookupResolver.js'
import { HTTPSOverlayBroadcastFacilitator, type STEAK } from './SHIPBroadcaster.js'
import OverlayAdminTokenTemplate from './OverlayAdminTokenTemplate.js'
import {
  withinDeadline,
  normalizeHosts,
  monotonicNow,
  LookupValidationError
} from './ReliableLookup.js'

/** Bounded SHIP discovery/submission without the legacy five-minute candidate cache. */
export class ReliableTopicBroadcaster {
  constructor(
    private readonly topics: string[],
    private readonly resolver: ReliableLookupResolver,
    private readonly allowHTTP = false,
    private readonly httpClient: typeof fetch = globalThis.fetch.bind(globalThis)
  ) {}

  private advertisedHosts(answer: LookupAnswer): string[] {
    if (answer.outputs.length > 256) throw new LookupValidationError('malformed')
    const candidates: string[] = []
    for (const output of answer.outputs) {
      try {
        const tx = TransactionParser.fromBEEF(output.beef)
        const ad = OverlayAdminTokenTemplate.decode(tx.outputs[output.outputIndex].lockingScript)
        if (ad.protocol === 'SHIP' && this.topics.includes(ad.topicOrService))
          candidates.push(ad.domain)
      } catch {
        throw new LookupValidationError('malformed')
      }
    }
    return candidates
  }

  private acknowledged(response: STEAK, transaction: Transaction): boolean {
    return this.topics.every(topic => {
      const ack = response?.[topic]
      if (ack === undefined) return false
      const admitted = ack.outputsToAdmit ?? []
      const retained = ack.coinsToRetain ?? []
      const removed = ack.coinsRemoved ?? []
      const validIndices = (indices: number[], length: number): boolean =>
        Array.isArray(indices) &&
        indices.every(index => Number.isInteger(index) && index >= 0 && index < length)
      return (
        validIndices(admitted, transaction.outputs.length) &&
        validIndices(retained, transaction.inputs.length) &&
        validIndices(removed, transaction.inputs.length) &&
        admitted.length + retained.length + removed.length > 0
      )
    })
  }

  private async submitHost(
    host: string,
    transaction: Transaction,
    beef: number[],
    budget: number,
    signal: AbortSignal
  ): Promise<boolean> {
    try {
      return await withinDeadline(
        async child => {
          const facilitator = new HTTPSOverlayBroadcastFacilitator(
            async (input, init) => await this.httpClient(input, { ...init, signal: child }),
            this.allowHTTP
          )
          const response = await facilitator.send(host, { beef, topics: this.topics })
          return this.acknowledged(response, transaction)
        },
        budget,
        signal
      )
    } catch {
      return false
    }
  }

  async broadcast(transaction: Transaction): Promise<BroadcastResponse | BroadcastFailure> {
    const txid = transaction.id('hex')
    const start = monotonicNow()
    const remaining = (): number => Math.max(0, 5000 - (monotonicNow() - start))
    try {
      return await withinDeadline(async signal => {
        const discovery = await this.resolver.queryReliable(
          { service: 'ls_ship', query: { topics: this.topics } },
          {
            deadlineMs: 2500,
            hostTimeoutMs: 1000,
            signal,
            validate: async answer => this.advertisedHosts(answer)
          }
        )
        const hosts = normalizeHosts(
          discovery.hosts.flatMap(host => (host.kind === 'answer' ? host.values : [])),
          this.allowHTTP
        ).slice(0, 32)
        const beef = transaction.toBEEF()
        const outcomes = await Promise.all(
          hosts.map(
            async host =>
              await this.submitHost(host, transaction, beef, Math.min(2000, remaining()), signal)
          )
        )
        return outcomes.some(Boolean)
          ? {
              status: 'success',
              txid,
              message:
                'Submission acknowledged; independent indexing confirmation is still required.'
            }
          : {
              status: 'error',
              txid,
              code: 'ERR_RELIABLE_SUBMISSION',
              description: 'No valid submission acknowledgment.'
            }
      }, 5000)
    } catch {
      return {
        status: 'error',
        txid,
        code: 'ERR_RELIABLE_SUBMISSION_TIMEOUT',
        description: 'Submission deadline exceeded; reconcile before retrying.'
      }
    }
  }
}
