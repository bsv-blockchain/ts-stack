import ReliableHTTPSLookupFacilitator from './ReliableHTTPSLookupFacilitator.js'
import LookupResolver, { type LookupResolverConfig, type LookupQuestion } from './LookupResolver.js'
import { ReliableHostReputation, type ReliableReputationStorage } from './ReliableHostReputation.js'
import {
  withinDeadline,
  monotonicNow,
  boundedMs,
  normalizeHosts,
  requestReliableHost,
  type ReliableLookupOptions,
  type ReliableLookupResult
} from './ReliableLookup.js'

export interface ReliableLookupResolverConfig extends LookupResolverConfig {
  reliableReputationStorage?: ReliableReputationStorage
}
/** Optional resolver adapter; deliberately excluded from the legacy UMD bundle. */
export default class ReliableLookupResolver extends LookupResolver {
  private readonly reliableReputation: ReliableHostReputation
  constructor(config: ReliableLookupResolverConfig = {}) {
    super({
      ...config,
      facilitator:
        config.facilitator ??
        new ReliableHTTPSLookupFacilitator(undefined, config.networkPreset === 'local')
    })
    this.reliableReputation = new ReliableHostReputation(config.reliableReputationStorage)
  }
  async queryReliable<T>(
    question: LookupQuestion,
    options: ReliableLookupOptions<T>
  ): Promise<ReliableLookupResult<T>> {
    const startedAt = monotonicNow()
    const deadlineMs = boundedMs(options.deadlineMs, 5000)
    boundedMs(options.hostTimeoutMs, 2000)
    const remaining = (): number => Math.max(0, deadlineMs - (monotonicNow() - startedAt))
    const settled: ReliableLookupResult<T>['hosts'] = []
    let discoveryComplete = true
    try {
      await withinDeadline(
        async signal => {
          let candidates: string[] = []
          if (this.hostOverrides[question.service] !== undefined) {
            candidates = this.hostOverrides[question.service].slice()
          } else if (this.networkPreset === 'local') {
            candidates = ['http://localhost:8080']
          } else if (question.service === 'ls_slap') {
            candidates = this.slapTrackers.slice()
          } else {
            // Discover the union. No first-tracker cache and no reputation exclusion.
            const trackers = normalizeHosts(this.slapTrackers, false)
            const answers = await Promise.all(
              trackers.slice(0, 32).map(async host => {
                try {
                  const answer = await withinDeadline(
                    async child =>
                      await this.facilitator.lookup(
                        host,
                        { service: 'ls_slap', query: { service: question.service } },
                        Math.min(1500, remaining()),
                        child
                      ),
                    Math.min(1500, remaining()),
                    signal
                  )
                  if (answer?.type !== 'output-list' || !Array.isArray(answer.outputs))
                    throw new Error('Invalid discovery response')
                  return this.extractHostsFromAnswer(answer, question.service)
                } catch {
                  discoveryComplete = false
                  return []
                }
              })
            )
            if (trackers.length === 0 || trackers.length > 32) discoveryComplete = false
            candidates = answers.flat()
          }
          candidates.push(...(this.additionalHosts[question.service] ?? []))
          const hosts = normalizeHosts(candidates, this.networkPreset === 'local')
          if (hosts.length > 32 || hosts.length === 0) discoveryComplete = false
          // Every selected host is probed, including cooled hosts. Reputation is ordering only.
          await Promise.all(
            this.reliableReputation
              .rank(this.networkPreset, question.service, hosts)
              .slice(0, 32)
              .map(async host => {
                const outcome = await requestReliableHost(
                  this.facilitator,
                  this.reliableReputation,
                  this.networkPreset,
                  host,
                  question,
                  options,
                  remaining(),
                  signal
                )
                settled.push(outcome)
              })
          )
        },
        deadlineMs,
        options.signal
      )
    } catch {
      discoveryComplete = false
    }
    return { hosts: settled.slice(), discoveryComplete, durationMs: monotonicNow() - startedAt }
  }
}
