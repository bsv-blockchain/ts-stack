import type Transaction from '../transaction/Transaction.js'
import TransactionParser from '../transaction/Transaction.js'
import type { BroadcastResponse, BroadcastFailure } from '../transaction/Broadcaster.js'
import type ReliableLookupResolver from './ReliableLookupResolver.js'
import { HTTPSOverlayBroadcastFacilitator } from './SHIPBroadcaster.js'
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
            validate: async answer => {
              if (answer.outputs.length > 256) throw new LookupValidationError('malformed')
              const candidates: string[] = []
              for (const output of answer.outputs) {
                try {
                  const tx = TransactionParser.fromBEEF(output.beef)
                  const ad = OverlayAdminTokenTemplate.decode(
                    tx.outputs[output.outputIndex].lockingScript
                  )
                  if (ad.protocol === 'SHIP' && this.topics.includes(ad.topicOrService))
                    candidates.push(ad.domain)
                } catch {
                  throw new LookupValidationError('malformed')
                }
              }
              return candidates
            }
          }
        )
        const hosts = normalizeHosts(
          discovery.hosts.flatMap(host => (host.kind === 'answer' ? host.values : [])),
          this.allowHTTP
        ).slice(0, 32)
        const beef = transaction.toBEEF()
        const outcomes = await Promise.all(
          hosts.map(async host => {
            try {
              return await withinDeadline(
                async child => {
                  const facilitator = new HTTPSOverlayBroadcastFacilitator(
                    async (input, init) => await this.httpClient(input, { ...init, signal: child }),
                    this.allowHTTP
                  )
                  const response = await facilitator.send(host, { beef, topics: this.topics })
                  return this.topics.every(topic => {
                    const ack = response?.[topic]
                    if (ack === undefined) return false
                    const admitted = ack.outputsToAdmit ?? []
                    const retained = ack.coinsToRetain ?? []
                    const removed = ack.coinsRemoved ?? []
                    return (
                      [admitted, retained, removed].every(
                        indices =>
                          Array.isArray(indices) &&
                          indices.every(index => Number.isInteger(index) && index >= 0)
                      ) &&
                      admitted.every(index => index < transaction.outputs.length) &&
                      [...retained, ...removed].every(index => index < transaction.inputs.length) &&
                      admitted.length + retained.length + removed.length > 0
                    )
                  })
                },
                Math.min(2000, remaining()),
                signal
              )
            } catch {
              return false
            }
          })
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
