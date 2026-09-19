import LookupResolver, {
  DEFAULT_LOOKUP_LIMITS,
  LookupResourceLimitError,
  type LookupAnswer,
  type LookupAnswerProgress,
  type LookupEvidenceEvent,
  type LookupFacilitatorAnswer,
  type LookupQuestion,
  type LookupRequestOptions,
  type UnreachableHostInfo
} from '../LookupResolver'
import { getOverlayHostReputationTracker } from '../HostReputationTracker'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import { PrivateKey } from '../../primitives/index'
import { LockingScript } from '../../script/index'
import { Transaction } from '../../transaction/index'

const service = 'ls_limits'
const question: LookupQuestion = { service, query: { id: 1 } }

type LookupOutput = LookupAnswer['outputs'][number]

/** Structurally parseable receipt; no chain-validity claim is made here. */
function receipt(satoshis: number): LookupOutput {
  const tx = new Transaction(1, [], [{ lockingScript: LockingScript.fromHex('88'), satoshis }], 0)
  return { beef: tx.toBEEF(), outputIndex: 0 }
}

/** A SLAP advertisement naming `domain` as a host for `advertised`. */
async function slapAdvertisement(
  scalar: number,
  domain: string,
  advertised: string
): Promise<LookupOutput> {
  const wallet = new CompletedProtoWallet(new PrivateKey(scalar))
  const template = new OverlayAdminTokenTemplate(wallet)
  const lockingScript = await template.lock('SLAP', domain, advertised)
  const tx = new Transaction(1, [], [{ lockingScript, satoshis: 1 }], 0)
  return { beef: tx.toBEEF(), outputIndex: 0 }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

async function collect(
  progress: AsyncIterable<LookupAnswerProgress>
): Promise<LookupAnswerProgress[]> {
  const emissions: LookupAnswerProgress[] = []
  for await (const emission of progress) emissions.push(emission)
  return emissions
}

async function finalEmission(
  progress: AsyncIterable<LookupAnswerProgress>
): Promise<LookupAnswerProgress> {
  const emissions = await collect(progress)
  const last = emissions.at(-1)
  if (last === undefined) throw new Error('expected at least one emission')
  return last
}

async function caught(work: Promise<unknown>): Promise<unknown> {
  return await work.then(
    () => {
      throw new Error('expected the query to reject')
    },
    (error: unknown) => error
  )
}

/** One macrotask turn: every pending microtask continuation has run. */
async function eventLoopTurn(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0))
}

describe('LookupResolver query resource bounds', () => {
  beforeEach(() => {
    getOverlayHostReputationTracker().reset()
  })

  afterEach(() => {
    getOverlayHostReputationTracker().reset()
  })

  it('stops merging at maxOutputs once a second host contributes a new outpoint', async () => {
    const answers: Record<string, LookupFacilitatorAnswer> = {
      'https://first.example': { type: 'output-list', outputs: [receipt(1)] },
      'https://second.example': { type: 'output-list', outputs: [receipt(2)] }
    }
    const resolver = new LookupResolver({
      hostOverrides: { [service]: Object.keys(answers) },
      limits: { maxOutputs: 1 },
      facilitator: { lookup: async host => answers[host] }
    })

    const { answer, progress } = await resolver.queryDetailed(question)

    expect(answer.outputs).toHaveLength(1)
    expect(progress.successfulHosts).toBe(2)
    expect(progress.limitsHit).toContain('maxOutputs')
    expect(progress.terminalReason).toBe('resource-limit')
  })

  it('defaults the evidence byte budget when only an output count is supplied', async () => {
    const events: LookupEvidenceEvent[] = []
    const first = receipt(1)
    const resolver = new LookupResolver({
      hostOverrides: { [service]: ['https://evidence.example'] },
      facilitator: {
        lookup: async () => ({ type: 'output-list', outputs: [first, receipt(2)] })
      }
    })

    const { progress } = await resolver.queryDetailed(question, undefined, {
      evidenceLimits: { maxOutputs: 1 },
      onEvidence: event => {
        events.push(event)
      }
    })

    expect(events.filter(event => event.type === 'output')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'limit' })
    expect(progress.limitsHit).toContain('maxEvidenceOutputs')
    // The default byte budget is generous: the single receipt was admitted whole.
    expect(progress.evidenceBytes).toBe(first.beef.length)
    // Evidence intake is additive; legacy aggregation still merged both outputs.
    expect(progress.outputs).toHaveLength(2)
  })

  it('bounds the candidate scan and skips malformed and over-budget host entries', async () => {
    const queried: string[] = []
    const resolver = new LookupResolver({
      hostOverrides: {
        [service]: [
          'not a url',
          'https://h1.example',
          'https://h2.example',
          'https://h3.example',
          'https://h4.example',
          'https://h5.example'
        ]
      },
      limits: { maxHosts: 1 },
      facilitator: {
        lookup: async host => {
          queried.push(host)
          return { type: 'output-list', outputs: [receipt(1)] }
        }
      }
    })

    const { answer, progress } = await resolver.queryDetailed(question)

    expect(queried).toEqual(['https://h1.example'])
    expect(answer.outputs).toHaveLength(1)
    expect(progress.discoveredHosts).toBe(1)
    // 2 beyond the maxHosts * 4 scan window, 1 unparseable, 2 past maxHosts.
    expect(progress.skippedHosts).toBe(5)
    expect(progress.limitsHit).toContain('maxHosts')
  })

  it('cancelling from the first limit notification leaves every host unqueried', async () => {
    const controller = new AbortController()
    const queried: string[] = []
    const events: LookupEvidenceEvent[] = []
    const resolver = new LookupResolver({
      hostOverrides: { [service]: ['https://one.example', 'https://two.example'] },
      additionalHosts: { [service]: ['https://three.example'] },
      limits: { maxHosts: 1 },
      facilitator: {
        lookup: async host => {
          queried.push(host)
          return { type: 'output-list', outputs: [] }
        }
      }
    })

    const error = await caught(
      resolver.query(question, undefined, {
        signal: controller.signal,
        onEvidence: event => {
          events.push(event)
          if (event.type === 'limit') controller.abort()
        }
      })
    )

    expect((error as Error).name).toBe('AbortError')
    expect(queried).toEqual([])
    // Exactly one limit notification, even though cancellation records its own.
    expect(events).toEqual([{ type: 'limit' }])
  })

  it('reserves a per-source quota for additional hosts while discovery is refreshed', async () => {
    const queried: string[] = []
    const resolver = new LookupResolver({
      networkPreset: 'mainnet',
      slapTrackers: ['https://tracker.example'],
      additionalHosts: { [service]: ['https://add1.example', 'https://add2.example'] },
      limits: { maxHosts: 2, maxTrackers: 1 },
      facilitator: {
        lookup: async (host, asked) => {
          queried.push(host)
          if (asked.service === 'ls_slap') return { type: 'output-list', outputs: [] }
          return { type: 'output-list', outputs: [receipt(1)] }
        }
      }
    })

    const { answer, progress } = await resolver.queryDetailed(question)

    expect(queried).toEqual(['https://add1.example', 'https://tracker.example'])
    expect(answer.outputs).toHaveLength(1)
    expect(progress.discoveredHosts).toBe(1)
    expect(progress.skippedHosts).toBe(1)
    expect(progress.limitsHit).toContain('maxHosts')
  })

  it('cancelling on the quota limit releases discovery before any tracker or host is contacted', async () => {
    const controller = new AbortController()
    const queried: string[] = []
    const resolver = new LookupResolver({
      networkPreset: 'mainnet',
      slapTrackers: ['https://tracker.example'],
      additionalHosts: { [service]: ['https://add1.example', 'https://add2.example'] },
      limits: { maxHosts: 2, maxTrackers: 1 },
      facilitator: {
        lookup: async host => {
          queried.push(host)
          return { type: 'output-list', outputs: [] }
        }
      }
    })

    const error = await caught(
      resolver.query(question, undefined, {
        signal: controller.signal,
        onEvidence: event => {
          if (event.type === 'limit') controller.abort()
        }
      })
    )
    await eventLoopTurn()

    expect((error as Error).name).toBe('AbortError')
    // The additional host was already dispatched and the SLAP refresh was about
    // to subscribe; cancellation must reach both before either sends a request.
    expect(queried).toEqual([])
  })

  it('fails closed when SLAP discovery bytes would exceed the aggregate budget', async () => {
    const hostCharged = deferred<void>()
    const resolver = new LookupResolver({
      networkPreset: 'mainnet',
      slapTrackers: ['https://tracker.example'],
      additionalHosts: { [service]: ['https://add.example'] },
      limits: { maxHosts: 4, maxTrackers: 1, maxTotalBytes: 100 },
      facilitator: {
        lookup: async (
          _host: string,
          asked: LookupQuestion,
          _timeout?: number,
          _signal?: AbortSignal,
          options?: LookupRequestOptions
        ) => {
          if (asked.service === 'ls_slap') {
            await hostCharged.promise
            await eventLoopTurn()
            options?.consumeBytes?.(30)
            return { type: 'output-list', outputs: [] }
          }
          options?.consumeBytes?.(80)
          hostCharged.resolve()
          return { type: 'output-list', outputs: [] }
        }
      }
    })

    const { progress } = await resolver.queryDetailed(question)

    expect(progress.hostCount).toBe(1)
    expect(progress.successfulHosts).toBe(1)
    // 80 host bytes were accepted; the 30 discovery bytes that would have
    // breached maxTotalBytes are refused and never credited.
    expect(progress.receivedBytes).toBe(80)
    expect(progress.limitsHit).toContain('maxTotalBytes')
    expect(progress.terminalReason).toBe('resource-limit')
    expect(progress.discoveryComplete).toBe(false)
  })

  it('refuses byte reports that arrive after the query was cancelled', async () => {
    const controller = new AbortController()
    const resolver = new LookupResolver({
      hostOverrides: { [service]: ['https://late.example'] },
      limits: { maxTotalBytes: 1024 },
      facilitator: {
        lookup: async (
          _host: string,
          _asked: LookupQuestion,
          _timeout?: number,
          _signal?: AbortSignal,
          options?: LookupRequestOptions
        ) => {
          options?.consumeBytes?.(4)
          controller.abort()
          options?.consumeBytes?.(4)
          return { type: 'output-list', outputs: [] }
        }
      }
    })

    const final = await finalEmission(
      resolver.query$(question, undefined, { signal: controller.signal })
    )

    expect(final.terminalReason).toBe('cancelled')
    expect(final.receivedBytes).toBe(4)
  })

  it('cancelling mid-flight drops the in-flight peer answer and skips queued hosts', async () => {
    const controller = new AbortController()
    const queried: string[] = []
    const hosts = ['https://q1.example', 'https://q2.example', 'https://q3.example']
    const resolver = new LookupResolver({
      hostOverrides: { [service]: hosts },
      limits: { maxHosts: 3, hostConcurrency: 2 },
      facilitator: {
        lookup: async host => {
          queried.push(host)
          return { type: 'output-list', outputs: [receipt(hosts.indexOf(host) + 1)] }
        }
      }
    })

    const final = await finalEmission(
      resolver.query$(question, undefined, {
        signal: controller.signal,
        onEvidence: event => {
          if (event.type === 'output') controller.abort()
        }
      })
    )

    expect(queried).toEqual(['https://q1.example', 'https://q2.example'])
    expect(final.terminalReason).toBe('cancelled')
    expect(final.hostCount).toBe(2)
    // The third host never left the queue, and neither in-flight answer was
    // aggregated: a cancelled attempt never answered the question.
    expect(final.skippedHosts).toBe(1)
    expect(final.successfulHosts).toBe(0)
    expect(final.outputs).toEqual([])
  })

  it('treats a second cancellation of the same query as a no-op', async () => {
    const controller = new AbortController()
    const events: LookupEvidenceEvent[] = []
    const resolver = new LookupResolver({
      hostOverrides: { [service]: ['https://stalled.example'] },
      facilitator: {
        lookup: async () => await new Promise<LookupFacilitatorAnswer>(() => {})
      }
    })

    const iterator = resolver
      .query$(question, undefined, {
        signal: controller.signal,
        softTimeoutMs: 0,
        graceMs: 0,
        onEvidence: event => {
          events.push(event)
        }
      })
      [Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.done).toBe(false)
    expect(first.value.isFinal).toBe(false)
    expect(first.value.hostCount).toBe(1)

    controller.abort()
    // Breaking the iterator cancels a second time through the iterator signal.
    await iterator.return?.(undefined)

    expect(events).toEqual([{ type: 'limit' }])
  })

  it('refuses a new query once the concurrent query ceiling is reached', async () => {
    const gate = deferred<LookupFacilitatorAnswer>()
    const resolver = new LookupResolver({
      hostOverrides: { [service]: ['https://capped.example'] },
      facilitator: { lookup: async () => await gate.promise }
    })

    const iterators = Array.from({ length: 128 }, () =>
      resolver.query$(question)[Symbol.asyncIterator]()
    )
    const pending = iterators.map(async iterator => await iterator.next())
    await eventLoopTurn()

    const error = await caught(resolver.query(question))
    expect(error).toBeInstanceOf(LookupResourceLimitError)
    expect((error as LookupResourceLimitError).limit).toBe('activeQueries')

    gate.resolve({ type: 'output-list', outputs: [] })
    await Promise.all(pending)
    await Promise.all(
      iterators.map(async iterator => {
        await iterator.return?.(undefined)
      })
    )

    // Every finished query released its slot.
    const released = await resolver.queryDetailed(question)
    expect(released.progress.hostCount).toBe(1)
  })

  it('drops an answer whose receipts exceed maxResponseBytes without blaming the host', async () => {
    const host = 'https://oversized.example'
    const resolver = new LookupResolver({
      hostOverrides: { [service]: [host] },
      limits: { maxResponseBytes: 16 },
      facilitator: { lookup: async () => ({ type: 'output-list', outputs: [receipt(1)] }) }
    })

    const { answer, progress } = await resolver.queryDetailed(question)

    expect(answer.outputs).toEqual([])
    expect(progress.limitsHit).toEqual(['maxResponseBytes'])
    expect(progress.terminalReason).toBe('resource-limit')
    // A client-side budget rejection is not an availability failure.
    expect(progress.failedHosts).toBe(0)
    expect(progress.rejectedHosts).toBe(0)
    expect(getOverlayHostReputationTracker().snapshot(host)?.totalFailures).toBe(0)
  })

  it('drops an answer with more outputs than maxOutputs instead of truncating it', async () => {
    const host = 'https://overcounted.example'
    const resolver = new LookupResolver({
      hostOverrides: { [service]: [host] },
      limits: { maxOutputs: 1 },
      facilitator: {
        lookup: async () => ({ type: 'output-list', outputs: [receipt(1), receipt(2)] })
      }
    })

    const { answer, progress } = await resolver.queryDetailed(question)

    expect(answer.outputs).toEqual([])
    expect(progress.limitsHit).toEqual(['maxOutputs'])
    expect(progress.failedHosts).toBe(0)
    expect(getOverlayHostReputationTracker().snapshot(host)?.totalFailures).toBe(0)
  })

  it('queries only the budgeted number of SLAP trackers and names the limit it hit', async () => {
    const trackers = ['https://t1.example', 'https://t2.example']
    const queried: string[] = []
    const resolver = new LookupResolver({
      networkPreset: 'mainnet',
      slapTrackers: trackers,
      limits: { maxTrackers: 1 },
      facilitator: {
        lookup: async host => {
          queried.push(host)
          return { type: 'output-list', outputs: [] }
        }
      }
    })

    const error = await caught(resolver.query(question))

    expect(queried).toEqual(['https://t1.example'])
    // A budget exhausted during discovery keeps its own error rather than
    // borrowing the no-competent-hosts message.
    expect(error).toBeInstanceOf(LookupResourceLimitError)
    expect((error as LookupResourceLimitError).limit).toBe('maxTrackers')
  })

  it('evicts the oldest SLAP attribution once the advertisement map is full', async () => {
    const tracker = 'https://ad-tracker.example'
    const advertisements = await Promise.all([
      slapAdvertisement(11, 'https://adv1.example', service),
      slapAdvertisement(12, 'https://adv2.example', service),
      slapAdvertisement(13, 'https://adv3.example', service)
    ])
    const unreachable: UnreachableHostInfo[] = []
    const resolver = new LookupResolver({
      networkPreset: 'mainnet',
      slapTrackers: [tracker],
      cache: { hostsMaxEntries: 1 },
      limits: { maxHosts: 2, maxTrackers: 1 },
      facilitator: {
        lookup: async (_host, asked) => {
          if (asked.service === 'ls_slap') {
            return { type: 'output-list', outputs: advertisements }
          }
          throw new Error('connection refused')
        }
      }
    })

    const { progress } = await resolver.queryDetailed(question, undefined, {
      onUnreachableHost: info => {
        unreachable.push(info)
      }
    })

    expect(progress.failedHosts).toBe(2)
    const attribution = new Map(unreachable.map(info => [info.host, info.advertisedBy]))
    expect(attribution.size).toBe(2)
    expect(attribution.get('https://adv2.example')).toBe(tracker)
    // adv1 was evicted when adv3's attribution arrived, so it reports no tracker.
    expect(attribution.has('https://adv1.example')).toBe(true)
    expect(attribution.get('https://adv1.example')).toBeUndefined()
  })

  it('keeps a still-fresh broader host cache when a tighter query rediscovers', async () => {
    const tracker = 'https://cache-tracker.example'
    const broad = await slapAdvertisement(21, 'https://cached.example', service)
    const tight = await slapAdvertisement(22, 'https://rediscovered.example', service)
    let trackerCalls = 0
    const resolver = new LookupResolver({
      networkPreset: 'mainnet',
      slapTrackers: [tracker],
      limits: { maxTrackers: 1 },
      facilitator: {
        lookup: async (_host, asked) => {
          if (asked.service === 'ls_slap') {
            trackerCalls++
            return { type: 'output-list', outputs: [trackerCalls === 1 ? broad : tight] }
          }
          // An immediate-backoff failure, so the cached host stops being
          // available and the tighter query must refresh discovery.
          throw new Error('Failed to fetch')
        }
      }
    })

    const first = await resolver.queryDetailed(question)
    expect(first.progress.failedHosts).toBe(1)

    const second = await resolver.queryDetailed(question, undefined, {
      limits: { maxOutputs: 8 }
    })
    expect(trackerCalls).toBe(2)
    expect(second.progress.failedHosts).toBe(1)

    const cache = (
      resolver as unknown as {
        hostsCache: Map<string, { hosts: string[]; maxOutputs: number }>
      }
    ).hostsCache
    const entry = cache.get(service)
    expect(entry?.hosts).toEqual(['https://cached.example'])
    expect(entry?.maxOutputs).toBe(DEFAULT_LOOKUP_LIMITS.maxOutputs)
  })
})
