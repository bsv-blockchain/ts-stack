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

// --------------------------------------------------------------------------
// Completeness-aware hold: the production GlobalKVStore shape. A consumer
// calling plain query() (no options — exactly what GlobalKVStore does) must
// converge to the complete result set, not the fast host's partial view.
// --------------------------------------------------------------------------

describe('LookupResolver completeness-aware hold (default query())', () => {
  const fastHost = 'https://overlay-ap-1.bsvb.tech'
  const slowHost = 'https://overlay-us-1.bsvb.tech'

  const manyBeefs = Array.from({ length: 40 }, (_, i) => makeBeef(100 + i))
  const fastOutputs = manyBeefs.slice(0, 2).map((beef, i) => ({ beef, outputIndex: i }))
  const slowOutputs = manyBeefs.map((beef, i) => ({ beef, outputIndex: i }))

  beforeEach(() => {
    getOverlayHostReputationTracker().reset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  const makeResolver = (scripts: Record<string, HostScript>): LookupResolver => {
    const { lookup } = makeFacilitator(scripts)
    return new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_kvstore: [fastHost, slowHost] }
    })
  }

  const defaultQuery = async (resolver: LookupResolver, i: number): Promise<number> => {
    const p = resolver.query({ service: 'ls_kvstore', query: { i } })
    // Advance past both hosts' latencies AND the per-host timeout so every
    // settlement (and the detached completeness scoring) lands.
    await jest.advanceTimersByTimeAsync(3000)
    const res = await p
    return res.outputs.length
  }

  it('returns the complete set on the very FIRST default query() — cold start waits for unknown hosts', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })

    // Cold start: no completeness history for either host, so query() treats
    // both as potentially complete and waits for every host to settle before
    // answering — merged result, not the fast host's partial view.
    expect(await defaultQuery(resolver, 0)).toBe(40)
    expect(await defaultQuery(resolver, 1)).toBe(40)
    expect(await defaultQuery(resolver, 2)).toBe(40)
  })

  it('trained: skips the wait when the host that already answered is known-complete', async () => {
    // Here the COMPLETE host is the fast one. After training, a pending
    // known-incomplete host must NOT hold the first emission — the fast path
    // stays fast once evidence says waiting buys nothing.
    const completeFast = makeResolver({
      [fastHost]: { delayMs: 150, outputs: slowOutputs }, // fast AND complete
      [slowHost]: { delayMs: 900, outputs: fastOutputs } // slow AND partial
    })
    await defaultQuery(completeFast, 0) // train: fast→1.0, slow→0.05

    let settled = false
    const p = completeFast
      .query({ service: 'ls_kvstore', query: { fastpath: true } })
      .then((res) => { settled = true; return res })
    // Advance past fast host + grace but NOT past the slow host: the query
    // must already have resolved — no hold for a known-worse host.
    await jest.advanceTimersByTimeAsync(400)
    expect(settled).toBe(true)
    expect((await p).outputs.length).toBe(40)
    await jest.advanceTimersByTimeAsync(2000) // let the slow host settle
  })

  it('bare query$() cold start stays latency-first (streaming consumers get partials immediately)', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })

    const emissions: LookupAnswerProgress[] = []
    const p = (async () => {
      for await (const partial of resolver.query$({ service: 'ls_kvstore', query: {} })) {
        emissions.push({ ...partial, outputs: partial.outputs.slice() })
      }
    })()
    await jest.advanceTimersByTimeAsync(3000)
    await p

    // First emission arrives post-grace with only the fast host's data; the
    // final emission carries the complete merge.
    expect(emissions[0].outputs.length).toBe(2)
    expect(emissions[emissions.length - 1].isFinal).toBe(true)
    expect(emissions[emissions.length - 1].outputs.length).toBe(40)
  })

  it('trains the completeness EMA correctly even though query() closes the iterator early', async () => {
    // Regression guard: scoring used to run in the generator finally, which
    // fires at the first emission — before the slow host settles. The fast host
    // was then measured against itself (2/2 = ratio 1.0) and trained to perfect
    // completeness while the slow host was never scored at all.
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })

    await defaultQuery(resolver, 0)

    const tracker = getOverlayHostReputationTracker()
    const fastSnap = tracker.snapshot(fastHost)
    const slowSnap = tracker.snapshot(slowHost)
    expect(slowSnap?.avgCompleteness).toBeCloseTo(1.0)
    expect(fastSnap?.avgCompleteness).toBeCloseTo(2 / 40)
  })

  it('releases the hold when the more-complete host fails, returning what arrived', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })
    await defaultQuery(resolver, 0) // train

    // The complete host goes down. The hold must lift when it settles (fails),
    // not hang, and the caller gets the fast host's partial view.
    const resolver2 = new LookupResolver({
      facilitator: {
        lookup: makeFacilitator({
          [fastHost]: { delayMs: 150, outputs: fastOutputs },
          [slowHost]: { delayMs: 400, throws: new Error('host offline') }
        }).lookup
      },
      hostOverrides: { ls_kvstore: [fastHost, slowHost] }
    })
    expect(await defaultQuery(resolver2, 1)).toBe(2)
  })

  it('soft timeout overrides the completeness hold', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })
    await defaultQuery(resolver, 0) // train

    // Caller explicitly asks to bail out early — the hold must not override an
    // explicit latency budget.
    const p = resolver.query(
      { service: 'ls_kvstore', query: { soft: true } },
      undefined,
      { softTimeoutMs: 200 }
    )
    await jest.advanceTimersByTimeAsync(3000)
    const res = await p
    expect(res.outputs.length).toBe(2)
  })

  it('query$() first emission is held for the trained more-complete host', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })
    await defaultQuery(resolver, 0) // train

    const emissions: LookupAnswerProgress[] = []
    const p = (async () => {
      for await (const partial of resolver.query$({ service: 'ls_kvstore', query: { s: 1 } })) {
        emissions.push({ ...partial, outputs: partial.outputs.slice() })
      }
    })()
    await jest.advanceTimersByTimeAsync(3000)
    await p

    // No partial 2-output emission leaks out before the complete host lands.
    expect(emissions[0].outputs.length).toBe(40)
    expect(emissions[emissions.length - 1].isFinal).toBe(true)
  })
})
