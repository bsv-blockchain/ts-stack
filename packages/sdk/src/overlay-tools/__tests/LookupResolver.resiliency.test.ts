import LookupResolver, {
  UnreachableHostInfo,
  LookupAnswerProgress
} from '../LookupResolver'
import { getOverlayHostReputationTracker } from '../HostReputationTracker'
import { Transaction } from '../../transaction/index'
import { LockingScript } from '../../script/index'

// --------------------------------------------------------------------------
// Test fixtures: distinct BEEFs representing distinct outputs
// --------------------------------------------------------------------------

const makeBeef = (satoshis: number): number[] =>
  new Transaction(
    1,
    [],
    [{ lockingScript: LockingScript.fromHex('88'), satoshis }],
    0
  ).toBEEF()

const beefs = Array.from({ length: 6 }, (_, i) => makeBeef(i + 1))

// --------------------------------------------------------------------------
// Helper: facilitator mock that lets us script per-host latency + outputs
// --------------------------------------------------------------------------

interface HostScript {
  /** ms to wait before resolving (uses jest fake timers). */
  delayMs: number
  /** Outputs to return; if undefined, the host throws. */
  outputs?: Array<{ beef: number[], outputIndex: number }>
  /** Error to throw instead of returning outputs. */
  throws?: Error
}

const makeFacilitator = (scripts: Record<string, HostScript>): {
  lookup: jest.Mock
  callOrder: string[]
} => {
  const callOrder: string[] = []
  const lookup = jest.fn(async (url: string) => {
    callOrder.push(url)
    const script = scripts[url]
    if (script === undefined) throw new Error(`Unscripted host: ${url}`)
    await new Promise<void>((resolve) => setTimeout(resolve, script.delayMs))
    if (script.throws !== undefined) throw script.throws
    return { type: 'output-list', outputs: script.outputs ?? [] }
  })
  return { lookup, callOrder }
}

describe('LookupResolver resilience', () => {
  beforeEach(() => {
    getOverlayHostReputationTracker().reset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  // -----------------------------------------------------------------------
  // Root-cause fix from the May 19 meeting: reproduce the ap-1 vs eu-1 bias
  // bug and prove completeness-aware reputation corrects it across queries.
  // -----------------------------------------------------------------------
  it('does not collapse to the fast-but-incomplete host across repeated queries', async () => {
    const fastIncompleteHost = 'https://overlay-ap-1.bsvb.tech'
    const slowCompleteHost = 'https://overlay-eu-1.bsvb.tech'

    const fastOutputs = [
      { beef: beefs[0], outputIndex: 0 },
      { beef: beefs[1], outputIndex: 1 }
    ]
    const slowOutputs = [
      { beef: beefs[0], outputIndex: 0 },
      { beef: beefs[1], outputIndex: 1 },
      { beef: beefs[2], outputIndex: 2 },
      { beef: beefs[3], outputIndex: 3 },
      { beef: beefs[4], outputIndex: 4 }
    ]

    const { lookup } = makeFacilitator({
      [fastIncompleteHost]: { delayMs: 200, outputs: fastOutputs },
      [slowCompleteHost]: { delayMs: 900, outputs: slowOutputs }
    })

    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_topic: [fastIncompleteHost, slowCompleteHost] }
    })

    // Drain query$() to the final emission so the slow host's full set lands.
    for (let i = 0; i < 20; i++) {
      const queryPromise = (async () => {
        let last: LookupAnswerProgress | null = null
        for await (const partial of resolver.query$(
          { service: 'ls_topic', query: { i } },
          undefined,
          { graceMs: 2000 } // wide grace so the slow host's full set lands
        )) {
          last = partial
        }
        return last
      })()
      await jest.advanceTimersByTimeAsync(3000)
      const res = await queryPromise
      expect(res?.outputs.length).toBe(5)
    }

    // After 20 queries the slow host's completeness EMA should be near 1.0,
    // the fast host's near its share (2/5 = 0.4).
    const slowSnap = getOverlayHostReputationTracker().snapshot(slowCompleteHost)
    const fastSnap = getOverlayHostReputationTracker().snapshot(fastIncompleteHost)
    expect(slowSnap?.avgCompleteness).not.toBeNull()
    expect(slowSnap!.avgCompleteness!).toBeGreaterThan(0.9)
    expect(fastSnap?.avgCompleteness).not.toBeNull()
    expect(fastSnap!.avgCompleteness!).toBeLessThan(0.5)
  })

  // -----------------------------------------------------------------------
  // query$() progressive emissions include late slow-host contributions.
  // -----------------------------------------------------------------------
  it('emits cumulative progress via query$() including late slow-host contributions', async () => {
    const fastHost = 'https://fast.host'
    const slowHost = 'https://slow.host'

    const { lookup } = makeFacilitator({
      [fastHost]: {
        delayMs: 100,
        outputs: [{ beef: beefs[0], outputIndex: 0 }]
      },
      [slowHost]: {
        delayMs: 2000,
        outputs: [
          { beef: beefs[1], outputIndex: 1 },
          { beef: beefs[2], outputIndex: 2 }
        ]
      }
    })

    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_topic: [fastHost, slowHost] }
    })

    const emissions: LookupAnswerProgress[] = []
    const queryPromise = (async () => {
      for await (const partial of resolver.query$(
        { service: 'ls_topic', query: {} },
        undefined,
        { graceMs: 200 } // grace expires before slow host so we see both fast-only AND enriched emissions
      )) {
        emissions.push({ ...partial, outputs: partial.outputs.slice() })
      }
    })()

    await jest.advanceTimersByTimeAsync(3000)
    await queryPromise

    // Expect at least three emissions: post-grace (fast only), late-host enrichment, final.
    expect(emissions.length).toBeGreaterThanOrEqual(2)
    const finalEmission = emissions[emissions.length - 1]
    expect(finalEmission.isFinal).toBe(true)
    expect(finalEmission.outputs.length).toBe(3) // all 3 unique outputs across both hosts
    expect(finalEmission.completedHosts).toBe(2)
    // First emission was post-grace, containing only the fast host's contribution.
    expect(emissions[0].outputs.length).toBe(1)
  })

  // -----------------------------------------------------------------------
  // onUnreachableHost fires per failed host with advertisedBy attribution.
  // -----------------------------------------------------------------------
  it('fires onUnreachableHost via query options for host-override failures (no advertisedBy)', async () => {
    const goodHost = 'https://good.host'
    const badHost = 'https://bad.host'

    const { lookup } = makeFacilitator({
      [goodHost]: {
        delayMs: 50,
        outputs: [{ beef: beefs[0], outputIndex: 0 }]
      },
      [badHost]: {
        delayMs: 50,
        throws: new Error('connection refused')
      }
    })

    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_topic: [goodHost, badHost] }
    })

    const calls: UnreachableHostInfo[] = []
    const queryPromise = (async () => {
      for await (const _ of resolver.query$(
        { service: 'ls_topic', query: {} },
        undefined,
        { onUnreachableHost: (info) => calls.push(info) }
      )) { /* drain */ }
    })()

    await jest.advanceTimersByTimeAsync(500)
    await queryPromise

    expect(calls.length).toBe(1)
    expect(calls[0].host).toBe(badHost)
    expect(calls[0].service).toBe('ls_topic')
    expect(calls[0].error).toBe('connection refused')
    expect(calls[0].advertisedBy).toBeUndefined()
  })

  it('populates advertisedBy when failing hosts come from SLAP', async () => {
    const { PrivateKey } = await import('../../primitives/index')
    const { CompletedProtoWallet } = await import(
      '../../auth/certificates/__tests/CompletedProtoWallet'
    )
    const OverlayAdminTokenTemplate = (
      await import('../OverlayAdminTokenTemplate')
    ).default

    const badHost = 'https://bad.host'
    const slapTrackerUrl = 'https://slap.tracker'

    const slapKey = new PrivateKey(99)
    const slapWallet = new CompletedProtoWallet(slapKey)
    const slapLib = new OverlayAdminTokenTemplate(slapWallet)
    const slapScript = await slapLib.lock('SLAP', badHost, 'ls_topic')
    const slapTx = new Transaction(
      1,
      [],
      [{ lockingScript: slapScript, satoshis: 1 }],
      0
    )

    const lookup = jest.fn(async (url: string) => {
      if (url === slapTrackerUrl) {
        return {
          type: 'output-list',
          outputs: [{ outputIndex: 0, beef: slapTx.toBEEF() }]
        }
      }
      if (url === badHost) throw new Error('host offline')
      throw new Error(`Unscripted host: ${url}`)
    })

    const calls: UnreachableHostInfo[] = []
    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: [slapTrackerUrl]
    })

    const queryPromise = (async () => {
      for await (const _ of resolver.query$(
        { service: 'ls_topic', query: {} },
        undefined,
        { onUnreachableHost: (info) => calls.push(info) }
      )) { /* drain */ }
    })()

    await jest.advanceTimersByTimeAsync(500)
    await queryPromise

    expect(calls.length).toBe(1)
    expect(calls[0].host).toBe(badHost)
    expect(calls[0].advertisedBy).toBe(slapTrackerUrl)
  })

  // -----------------------------------------------------------------------
  // Self-healing: warm cache + all hosts in backoff → re-discover via SLAP.
  // -----------------------------------------------------------------------
  it('self-heals when warm-cache hosts have all slid into backoff', async () => {
    const { PrivateKey } = await import('../../primitives/index')
    const { CompletedProtoWallet } = await import(
      '../../auth/certificates/__tests/CompletedProtoWallet'
    )
    const OverlayAdminTokenTemplate = (
      await import('../OverlayAdminTokenTemplate')
    ).default

    const slapTrackerUrl = 'https://slap.tracker'
    const oldDeadHost = 'https://old-dead.host'
    const newHealthyHost = 'https://new-healthy.host'

    const slapKey = new PrivateKey(7)
    const slapWallet = new CompletedProtoWallet(slapKey)
    const slapLib = new OverlayAdminTokenTemplate(slapWallet)
    const slapScript = await slapLib.lock('SLAP', newHealthyHost, 'ls_topic')
    const slapTx = new Transaction(
      1,
      [],
      [{ lockingScript: slapScript, satoshis: 1 }],
      0
    )

    const lookup = jest.fn(async (url: string, q: any) => {
      if (q.service === 'ls_slap') {
        return {
          type: 'output-list',
          outputs: [{ outputIndex: 0, beef: slapTx.toBEEF() }]
        }
      }
      if (url === newHealthyHost) {
        return { type: 'output-list', outputs: [{ beef: beefs[0], outputIndex: 0 }] }
      }
      throw new Error(`unexpected: ${url}`)
    })

    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: [slapTrackerUrl]
    })

    // Prime warm cache with the old dead host
    ;(resolver as any).hostsCache.set('ls_topic', {
      hosts: [oldDeadHost],
      expiresAt: Date.now() + 5 * 60 * 1000
    })

    // Push the dead host deep into backoff
    const tracker = getOverlayHostReputationTracker()
    for (let i = 0; i < 5; i++) {
      tracker.recordFailure(oldDeadHost, 'connection refused')
    }

    const queryPromise = resolver.query({ service: 'ls_topic', query: {} })
    await jest.advanceTimersByTimeAsync(1000)
    const res = await queryPromise

    expect(res.outputs.length).toBe(1)
    const calledUrls = lookup.mock.calls.map((c) => c[0])
    expect(calledUrls).toContain(slapTrackerUrl)
    expect(calledUrls).toContain(newHealthyHost)
  })

  // -----------------------------------------------------------------------
  // HTTP 4xx is treated as empty output-list (semantic rejection, not a
  // host availability failure). Sanity-check via the real facilitator.
  // -----------------------------------------------------------------------
  it('does not backoff a host that responds 4xx (semantic rejection)', async () => {
    const partialHost = 'https://partial.host'
    const fakeFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: { get: () => 'application/json' },
      json: async () => ({})
    })
    const { HTTPSOverlayLookupFacilitator } = await import('../LookupResolver')
    const realFacilitator = new HTTPSOverlayLookupFacilitator(fakeFetch as unknown as typeof fetch, true)

    const resolver = new LookupResolver({
      facilitator: realFacilitator,
      hostOverrides: { ls_kvstore: [partialHost] }
    })

    for (let i = 0; i < 6; i++) {
      const queryPromise = resolver.query({ service: 'ls_kvstore', query: { i } })
      await jest.advanceTimersByTimeAsync(50)
      const res = await queryPromise
      expect(res.outputs.length).toBe(0)
    }

    const snap = getOverlayHostReputationTracker().snapshot(partialHost)
    expect(snap?.totalFailures).toBe(0)
    expect(snap?.backoffUntil).toBe(0)
  })
})
