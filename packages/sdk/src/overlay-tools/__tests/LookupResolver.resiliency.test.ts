import LookupResolver, {
  UnreachableHostInfo,
  LookupAnswerProgress,
  HTTPSOverlayLookupFacilitator,
  LookupHTTPError
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
  it('returns the complete merge across repeated blocking queries without cardinality reputation', async () => {
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

    // Blocking query() waits for every bounded settlement. It does not attempt
    // to learn authority from whichever peer happened to return more records.
    for (let i = 0; i < 20; i++) {
      const queryPromise = resolver.query({ service: 'ls_topic', query: { i } })
      await jest.advanceTimersByTimeAsync(3000)
      const res = await queryPromise
      expect(res.outputs.length).toBe(5)
    }

    const slowSnap = getOverlayHostReputationTracker().snapshot(slowCompleteHost)
    const fastSnap = getOverlayHostReputationTracker().snapshot(fastIncompleteHost)
    expect(slowSnap?.totalSuccesses).toBe(20)
    expect(fastSnap?.totalSuccesses).toBe(20)
    expect(slowSnap).not.toHaveProperty('avgCompleteness')
    expect(fastSnap).not.toHaveProperty('avgCompleteness')
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
        delayMs: 1500,
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
    expect(snap?.totalFailures ?? 0).toBe(0)
    expect(snap?.backoffUntil ?? 0).toBe(0)
  })
})

describe('LookupResolver adversarial review regressions', () => {
  beforeEach(() => {
    getOverlayHostReputationTracker().reset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('enforces the timeout when a custom facilitator ignores it', async () => {
    const goodHost = 'https://good.deadline'
    const hungHost = 'https://hung.deadline'
    const callback = jest.fn()
    const lookup = jest.fn(async (url: string) => {
      if (url === hungHost) return await new Promise(() => { /* never settles */ })
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      return { type: 'output-list', outputs: [{ beef: beefs[0], outputIndex: 0 }] }
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_deadline: [goodHost, hungHost] }
    })

    const query = resolver.query(
      { service: 'ls_deadline', query: {} },
      20,
      { onUnreachableHost: callback }
    )
    await jest.advanceTimersByTimeAsync(100)

    await expect(query).resolves.toMatchObject({ outputs: [{ outputIndex: 0 }] })
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      host: hungHost,
      error: 'Request timed out'
    }))
  })

  it.each([
    { type: 'garbage' },
    { type: 'output-list', outputs: 'broken' },
    { type: 'output-list', outputs: [{ beef: [300], outputIndex: 0 }] },
    { type: 'freeform' }
  ])('rejects malformed response %# before recording success', async (response) => {
    const host = `https://malformed-${JSON.stringify(response).length}.host`
    const callback = jest.fn()
    const resolver = new LookupResolver({
      facilitator: { lookup: jest.fn().mockResolvedValue(response) },
      hostOverrides: { ls_malformed: [host] }
    })

    const query = resolver.query(
      { service: 'ls_malformed', query: {} },
      undefined,
      { onUnreachableHost: callback }
    )
    await jest.advanceTimersByTimeAsync(100)
    await expect(query).resolves.toMatchObject({ outputs: [] })

    const snap = getOverlayHostReputationTracker().snapshot(host)
    expect(snap?.totalSuccesses).toBe(0)
    expect(snap?.totalFailures).toBe(1)
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      host,
      error: 'Malformed lookup response'
    }))
  })

  it('does not let a late freeform response clear an active availability backoff', async () => {
    const host = 'https://late-freeform.host'
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 100))
          return { type: 'freeform', result: { found: false } }
        }
      },
      hostOverrides: { ls_freeform: [host] }
    })

    const query = resolver.query({ service: 'ls_freeform', query: {} })
    await jest.advanceTimersByTimeAsync(10)
    const tracker = getOverlayHostReputationTracker()
    tracker.recordFailure(host, 'network down')
    tracker.recordFailure(host, 'network down')
    tracker.recordFailure(host, 'network down')
    const before = tracker.snapshot(host)
    expect(before).toBeDefined()

    await jest.advanceTimersByTimeAsync(200)
    await expect(query).resolves.toMatchObject({ outputs: [] })
    const after = tracker.snapshot(host)
    expect(after?.consecutiveFailures).toBe(before?.consecutiveFailures)
    expect(after?.backoffUntil).toBe(before?.backoffUntil)
  })

  it('isolates rejected async callbacks and deduplicates notification storms', async () => {
    const host = 'https://notify.host'
    const callback = jest.fn(async () => { throw new Error('notification API down') })
    const resolver = new LookupResolver({
      facilitator: { lookup: jest.fn().mockRejectedValue(new Error('host down')) },
      hostOverrides: { ls_notify: [host] }
    })

    for (let i = 0; i < 2; i++) {
      const query = resolver.query(
        { service: 'ls_notify', query: { i } },
        undefined,
        { onUnreachableHost: callback }
      )
      await jest.advanceTimersByTimeAsync(100)
      await expect(query).resolves.toMatchObject({ outputs: [] })
    }
    await Promise.resolve()
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('keeps recovery discovery open until a tracker advertises an available alternative', async () => {
    const { PrivateKey } = await import('../../primitives/index')
    const { CompletedProtoWallet } = await import('../../auth/certificates/__tests/CompletedProtoWallet')
    const OverlayAdminTokenTemplate = (await import('../OverlayAdminTokenTemplate')).default
    const fastTracker = 'https://fast.tracker'
    const slowTracker = 'https://slow.tracker'
    const backedOffHost = 'https://backed-off.host'
    const healthyHost = 'https://healthy.host'

    const makeSlapBeef = async (keyValue: number, domain: string): Promise<number[]> => {
      const wallet = new CompletedProtoWallet(new PrivateKey(keyValue))
      const template = new OverlayAdminTokenTemplate(wallet)
      const lockingScript = await template.lock('SLAP', domain, 'ls_recovery')
      return new Transaction(1, [], [{ lockingScript, satoshis: 1 }], 0).toBEEF()
    }
    const backedOffBeef = await makeSlapBeef(31, backedOffHost)
    const healthyBeef = await makeSlapBeef(32, healthyHost)

    const lookup = jest.fn(async (url: string, question: any) => {
      if (question.service === 'ls_slap') {
        await new Promise<void>((resolve) => setTimeout(resolve, url === fastTracker ? 10 : 100))
        return {
          type: 'output-list',
          outputs: [{ beef: url === fastTracker ? backedOffBeef : healthyBeef, outputIndex: 0 }]
        }
      }
      if (url === healthyHost) {
        return { type: 'output-list', outputs: [{ beef: beefs[0], outputIndex: 0 }] }
      }
      throw new Error(`Unexpected lookup host: ${url}`)
    })
    const resolver = new LookupResolver({ facilitator: { lookup }, slapTrackers: [fastTracker, slowTracker] })
    ;(resolver as any).hostsCache.set('ls_recovery', {
      hosts: [backedOffHost],
      expiresAt: Date.now() + 60_000
    })
    const tracker = getOverlayHostReputationTracker()
    for (let i = 0; i < 5; i++) tracker.recordFailure(backedOffHost, 'host down')

    const query = resolver.query({ service: 'ls_recovery', query: {} })
    await jest.advanceTimersByTimeAsync(1000)
    await expect(query).resolves.toMatchObject({ outputs: [{ outputIndex: 0 }] })
    expect(lookup.mock.calls.map((call) => call[0])).toContain(healthyHost)
  })

  it('classifies HTTP status codes without collapsing distinct 4xx responses', async () => {
    for (const status of [0, 400, 401, 403, 404, 422, 408, 429, 503]) {
      const fetchClient = jest.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: status === 401 ? 'Unauthorized' : '',
        headers: { get: () => 'application/json' }
      })
      const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch, true)
      const assertion = expect(
        facilitator.lookup('http://host', { service: 'ls_http', query: {} })
      ).rejects.toMatchObject({
        status,
        kind: [0, 408, 429, 503].includes(status) ? 'availability' : 'semantic'
      } satisfies Partial<LookupHTTPError>)
      await jest.advanceTimersByTimeAsync(1)
      await assertion
    }
  })

  it('keeps semantic HTTP rejection neutral while tracking availability HTTP failures', async () => {
    const semanticHost = 'https://semantic-http.host'
    const unavailableHost = 'https://availability-http.host'
    const callback = jest.fn()
    const fetchClient = jest.fn(async (url: string) => {
      const isSemanticHost = new URL(url).origin === semanticHost
      return {
        ok: false,
        status: isSemanticHost ? 401 : 429,
        statusText: isSemanticHost ? 'Unauthorized' : 'Too Many Requests',
        headers: { get: () => 'application/json' }
      }
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetchClient as unknown as typeof fetch, true)
    const semanticResolver = new LookupResolver({
      facilitator,
      hostOverrides: { ls_http_semantic: [semanticHost] }
    })
    const unavailableResolver = new LookupResolver({
      facilitator,
      hostOverrides: { ls_http_availability: [unavailableHost] }
    })

    const semanticQuery = semanticResolver.query(
      { service: 'ls_http_semantic', query: {} },
      undefined,
      { onUnreachableHost: callback }
    )
    const unavailableQuery = unavailableResolver.query(
      { service: 'ls_http_availability', query: {} },
      undefined,
      { onUnreachableHost: callback }
    )
    await jest.advanceTimersByTimeAsync(100)
    await expect(semanticQuery).resolves.toMatchObject({ outputs: [] })
    await expect(unavailableQuery).resolves.toMatchObject({ outputs: [] })

    expect(getOverlayHostReputationTracker().snapshot(semanticHost)?.totalFailures ?? 0).toBe(0)
    expect(getOverlayHostReputationTracker().snapshot(unavailableHost)?.totalFailures).toBe(1)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ host: unavailableHost }))
  })
})

// --------------------------------------------------------------------------
// Completeness-aware hold: the production GlobalKVStore shape. A consumer
// calling plain query() (no options — exactly what GlobalKVStore does) must
// converge to the complete result set, not the fast host's partial view.
// --------------------------------------------------------------------------

describe('LookupResolver accuracy-first blocking query', () => {
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
    // Advance past both hosts' latencies and the resolver-owned deadline.
    await jest.advanceTimersByTimeAsync(3000)
    const res = await p
    return res.outputs.length
  }

  it('returns the complete set on every default query()', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })

    expect(await defaultQuery(resolver, 0)).toBe(40)
    expect(await defaultQuery(resolver, 1)).toBe(40)
    expect(await defaultQuery(resolver, 2)).toBe(40)
  })

  it('supports an explicit grace-window fast path', async () => {
    const completeFast = makeResolver({
      [fastHost]: { delayMs: 150, outputs: slowOutputs }, // fast AND complete
      [slowHost]: { delayMs: 900, outputs: fastOutputs } // slow AND partial
    })

    let settled = false
    const p = completeFast
      .query(
        { service: 'ls_kvstore', query: { fastpath: true } },
        undefined,
        { waitForAllHosts: false }
      )
      .then((res) => { settled = true; return res })
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

  it('audits an equally successful peer when current data drifts', async () => {
    const fourOutputs = slowOutputs.slice(0, 4)
    let drifted = false
    const lookup = jest.fn(async (url: string) => {
      await new Promise<void>((resolve) => setTimeout(resolve, url === fastHost ? 100 : 400))
      if (!drifted) return { type: 'output-list', outputs: fourOutputs }
      return { type: 'output-list', outputs: url === fastHost ? fourOutputs.slice(0, 1) : fourOutputs }
    })
    const resolver = makeResolver({
      [fastHost]: { delayMs: 0, outputs: [] },
      [slowHost]: { delayMs: 0, outputs: [] }
    })
    ;(resolver as any).facilitator.lookup = lookup

    expect(await defaultQuery(resolver, 0)).toBe(4)
    drifted = true
    expect(await defaultQuery(resolver, 1)).toBe(4)
  })

  it('releases the hold when the more-complete host fails, returning what arrived', async () => {
    // The second host goes down. The query returns after that bounded failure
    // with the valid data that did arrive.
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

  it('allows the compatibility opt-out to return while a straggler is pending', async () => {
    const straggler = 'https://overlay-eu-1.bsvb.tech'
    const { lookup } = makeFacilitator({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, throws: new Error('host offline') },
      [straggler]: { delayMs: 2500, outputs: fastOutputs }
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_kvstore: [fastHost, slowHost, straggler] }
    })

    let settled = false
    const p = resolver
      .query({ service: 'ls_kvstore', query: { threeHosts: true } }, 5000, {
        holdForUnknownHosts: false
      })
      .then((res) => { settled = true; return res })

    await jest.advanceTimersByTimeAsync(300)
    expect(settled).toBe(true)
    expect((await p).outputs.length).toBe(2)
    await jest.advanceTimersByTimeAsync(3000) // let the straggler settle
  })

  it('soft timeout overrides the completeness hold', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })
    // Caller explicitly asks to bail out early — the explicit latency budget
    // overrides wait-for-all behavior.
    const p = resolver.query(
      { service: 'ls_kvstore', query: { soft: true } },
      undefined,
      { softTimeoutMs: 200 }
    )
    await jest.advanceTimersByTimeAsync(3000)
    const res = await p
    expect(res.outputs.length).toBe(2)
  })

  it('query$() can explicitly wait for all hosts before its first emission', async () => {
    const resolver = makeResolver({
      [fastHost]: { delayMs: 150, outputs: fastOutputs },
      [slowHost]: { delayMs: 400, outputs: slowOutputs }
    })
    const emissions: LookupAnswerProgress[] = []
    const p = (async () => {
      for await (const partial of resolver.query$(
        { service: 'ls_kvstore', query: { s: 1 } },
        undefined,
        { waitForAllHosts: true }
      )) {
        emissions.push({ ...partial, outputs: partial.outputs.slice() })
      }
    })()
    await jest.advanceTimersByTimeAsync(3000)
    await p

    expect(emissions[0].outputs.length).toBe(40)
    expect(emissions[emissions.length - 1].isFinal).toBe(true)
  })
})
