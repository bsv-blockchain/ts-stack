import LookupResolver, { LookupAnswerProgress } from '../LookupResolver'
import { getOverlayHostReputationTracker } from '../HostReputationTracker'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import { PrivateKey } from '../../primitives/index'
import { LockingScript } from '../../script/index'
import { Transaction } from '../../transaction/index'

const makeBeef = (satoshis: number): number[] =>
  new Transaction(1, [], [{ lockingScript: LockingScript.fromHex('88'), satoshis }], 0).toBEEF()

const later = async (ms: number): Promise<void> => {
  await new Promise<void>(resolve => setTimeout(resolve, ms))
}

async function overlayReceipt(
  protocol: 'SHIP' | 'SLAP',
  scalar: number,
  domain: string,
  topicOrService: string
): Promise<{ beef: number[]; outputIndex: number }> {
  const wallet = new CompletedProtoWallet(new PrivateKey(scalar))
  const token = new OverlayAdminTokenTemplate(wallet)
  const lockingScript = await token.lock(protocol, domain, topicOrService)
  const transaction = new Transaction(1, [], [{ lockingScript, satoshis: 1 }], 0)
  return { beef: transaction.toBEEF(), outputIndex: 0 }
}

async function slapReceipt(
  scalar: number,
  domain: string,
  service: string
): Promise<{ beef: number[]; outputIndex: number }> {
  return await overlayReceipt('SLAP', scalar, domain, service)
}

describe('LookupResolver dynamic discovery', () => {
  beforeEach(() => {
    getOverlayHostReputationTracker().reset()
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('starts a discovered host without waiting for a slower tracker and merges only the late host contribution', async () => {
    const fastTracker = 'https://fast-tracker.example'
    const slowTracker = 'https://slow-tracker.example'
    const fastHost = 'https://fast-host.example'
    const lateHost = 'https://late-host.example'
    const service = 'ls_dynamic'
    const fastReceipt = await slapReceipt(101, fastHost, service)
    const lateReceipt = await slapReceipt(102, lateHost, service)
    const fastBeef = makeBeef(1)
    const lateBeef = makeBeef(2)
    const calls: Array<{ url: string; service: string }> = []
    const evidence: Array<{ type: string; host?: string }> = []

    const lookup = jest.fn(async (url: string, question: { service: string }) => {
      calls.push({ url, service: question.service })
      if (url === fastTracker) {
        await later(10)
        return { type: 'output-list' as const, outputs: [fastReceipt] }
      }
      if (url === slowTracker) {
        await later(100)
        return { type: 'output-list' as const, outputs: [lateReceipt] }
      }
      if (url === fastHost) {
        await later(1)
        return { type: 'output-list' as const, outputs: [{ beef: fastBeef, outputIndex: 0 }] }
      }
      if (url === lateHost) {
        await later(1)
        return { type: 'output-list' as const, outputs: [{ beef: lateBeef, outputIndex: 1 }] }
      }
      throw new Error(`unexpected host ${url}`)
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: [fastTracker, slowTracker]
    })
    const progress: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$({ service, query: { q: 1 } }, undefined, {
        graceMs: 0,
        onEvidence: event => evidence.push(event)
      })) {
        progress.push({ ...item, outputs: item.outputs.slice() })
      }
    })()

    await jest.advanceTimersByTimeAsync(20)
    expect(calls).toContainEqual({ url: fastHost, service })
    expect(calls).not.toContainEqual({ url: lateHost, service })
    expect(calls.filter(call => call.url === fastTracker || call.url === slowTracker)).toEqual([
      { url: fastTracker, service: 'ls_slap' },
      { url: slowTracker, service: 'ls_slap' }
    ])
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'output', host: fastHost })])
    )

    await jest.advanceTimersByTimeAsync(200)
    await pending

    const final = progress.at(-1)
    expect(final?.isFinal).toBe(true)
    expect(final?.outputs).toEqual([
      { beef: fastBeef, outputIndex: 0 },
      { beef: lateBeef, outputIndex: 1 }
    ])
    expect(final).toMatchObject({ discoveryComplete: true, trackersTotal: 2, trackersCompleted: 2 })
    // The SLAP receipt is discovery evidence only; it never becomes a topic result.
    expect(
      final?.outputs.some(
        output => output.beef === fastReceipt.beef || output.beef === lateReceipt.beef
      )
    ).toBe(false)
  })

  it('queries only eligible advertised hosts for the requested service', async () => {
    const fooTracker = 'https://foo-tracker.example'
    const barTracker = 'https://bar-tracker.example'
    const shipTracker = 'https://ship-tracker.example'
    const offlineTracker = 'https://offline-tracker.example'
    const fooHost = 'https://foo-host.example'
    const barHost = 'https://bar-host.example'
    const shipHost = 'https://ship-host.example'
    const service = 'ls_foo'
    const fooReceipt = await slapReceipt(201, fooHost, service)
    const barReceipt = await slapReceipt(202, barHost, 'ls_bar')
    const shipReceipt = await overlayReceipt('SHIP', 203, shipHost, service)
    const hostCalls: string[] = []
    const lookup = jest.fn(async (url: string, question: { service: string }) => {
      if (url === fooTracker) return { type: 'output-list' as const, outputs: [fooReceipt] }
      if (url === barTracker) return { type: 'output-list' as const, outputs: [barReceipt] }
      if (url === shipTracker) return { type: 'output-list' as const, outputs: [shipReceipt] }
      if (url === offlineTracker) throw new Error('tracker offline')
      hostCalls.push(url)
      expect(question.service).toBe(service)
      return { type: 'output-list' as const, outputs: [{ beef: makeBeef(9), outputIndex: 0 }] }
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: [fooTracker, barTracker, shipTracker, offlineTracker]
    })
    const pending = resolver.query({ service, query: {} })
    await jest.runAllTimersAsync()
    await expect(pending).resolves.toEqual({
      type: 'output-list',
      outputs: [{ beef: makeBeef(9), outputIndex: 0 }]
    })

    expect(hostCalls).toEqual([fooHost])
    expect(lookup.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([fooTracker, barTracker, shipTracker, offlineTracker])
    )
  })

  it('delivers a useful host while another peer never finishes, then settles after the 2s host bound', async () => {
    const usefulHost = 'https://useful-hang.example'
    const hangingHost = 'https://hanging-peer.example'
    const usefulBeef = makeBeef(11)
    const lookup = jest.fn(async (url: string, _question: unknown, timeout?: number) => {
      expect(timeout).toBeUndefined()
      if (url === hangingHost) await new Promise<void>(() => {})
      await later(20)
      return { type: 'output-list' as const, outputs: [{ beef: usefulBeef, outputIndex: 0 }] }
    })
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      hostOverrides: { ls_hang: [usefulHost, hangingHost] }
    })
    const progress: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$({ service: 'ls_hang', query: {} }, undefined, {
        graceMs: 0
      })) {
        progress.push({ ...item, outputs: item.outputs.slice() })
      }
    })()

    await jest.advanceTimersByTimeAsync(100)
    expect(progress.some(item => !item.isFinal && item.outputs.length > 0)).toBe(true)
    expect(progress.find(item => item.outputs.length > 0)?.outputs).toEqual([
      { beef: usefulBeef, outputIndex: 0 }
    ])
    expect(progress.at(-1)?.isFinal).toBe(false)

    await jest.advanceTimersByTimeAsync(2000)
    await pending
    expect(progress.at(-1)).toMatchObject({
      isFinal: true,
      terminalReason: 'settled',
      successfulHosts: 1,
      failedHosts: 1,
      outputs: [{ beef: usefulBeef, outputIndex: 0 }]
    })
  })

  it('unblocks a pending iterator once on abort and reports a cancelled terminal snapshot', async () => {
    const host = 'https://pending.example'
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    const lookup = jest.fn(
      async (_url: string, _question: unknown, _timeout: unknown, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          requestSignal = signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      hostOverrides: { ls_abort: [host] }
    })
    const iterator = resolver
      .query$({ service: 'ls_abort', query: {} }, undefined, {
        signal: controller.signal
      } as any)
      [Symbol.asyncIterator]()

    const first = iterator.next()
    await Promise.resolve()
    controller.abort(new Error('caller stopped lookup'))

    const terminal = await first
    expect(requestSignal?.aborted).toBe(true)
    expect(terminal.done).toBe(false)
    expect(terminal.value).toMatchObject({
      isFinal: true,
      terminalReason: 'cancelled'
    })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('emits a deadline terminal snapshot when no host receipt arrives', async () => {
    const host = 'https://deadline.example'
    const lookup = jest.fn(
      async (_url: string, _question: unknown, _timeout: unknown, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      hostOverrides: { ls_deadline: [host] }
    })
    const received: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$({ service: 'ls_deadline', query: {} }, undefined, {
        deadlineMs: 25
      } as any)) {
        received.push(item)
      }
    })()

    await jest.advanceTimersByTimeAsync(25)
    await pending

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      isFinal: true,
      terminalReason: 'deadline',
      outputs: []
    })
  })

  it('keeps empty, failed, and freeform host receipts distinct at a settled terminal', async () => {
    const emptyHost = 'https://empty.example'
    const freeformHost = 'https://freeform.example'
    const failedHost = 'https://failed.example'
    const lookup = jest.fn(async (url: string) => {
      if (url === emptyHost) return { type: 'output-list' as const, outputs: [] }
      if (url === freeformHost) return { type: 'freeform' as const, result: { supported: false } }
      throw new Error('offline')
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_outcomes: [emptyHost, freeformHost, failedHost] }
    })
    const values: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$({ service: 'ls_outcomes', query: {} }))
        values.push(item)
    })()
    await jest.runAllTimersAsync()
    await pending

    expect(values).toHaveLength(1)
    expect(values[0]).toMatchObject({
      isFinal: true,
      terminalReason: 'settled',
      emptyHosts: 1,
      freeformHosts: 1,
      failedHosts: 1,
      rejectedHosts: 0
    })
  })

  it('caps evidence delivery independently and reports the limit evidence', async () => {
    const host = 'https://bounded.example'
    const first = makeBeef(31)
    const second = makeBeef(32)
    const evidence: Array<{ type: string }> = []
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => ({
          type: 'output-list',
          outputs: [
            { beef: first, outputIndex: 0 },
            { beef: second, outputIndex: 1 }
          ]
        })
      },
      hostOverrides: { ls_bounded: [host] }
    })
    const values: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$({ service: 'ls_bounded', query: {} }, undefined, {
        limits: { maxEvidenceOutputs: 1 },
        onEvidence: event => evidence.push(event)
      } as any)) {
        values.push(item)
      }
    })()
    await jest.runAllTimersAsync()
    await pending

    expect(values.at(-1)).toMatchObject({
      isFinal: true,
      terminalReason: 'resource-limit',
      limitsHit: expect.arrayContaining(['maxEvidenceOutputs'])
    })
    expect(values.at(-1)?.outputs).toHaveLength(2)
    expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'limit' })]))
  })

  it('shares one tracker discovery between queries and keeps it alive when one subscriber cancels', async () => {
    const tracker = 'https://shared-tracker.example'
    const host = 'https://shared-host.example'
    const receipt = await slapReceipt(103, host, 'ls_shared')
    let completeTracker: (() => void) | undefined
    let trackerSignal: AbortSignal | undefined
    const lookup = jest.fn(
      async (url: string, _question: unknown, _timeout: unknown, signal?: AbortSignal) => {
        if (url === tracker) {
          trackerSignal = signal
          await new Promise<void>(resolve => {
            completeTracker = resolve
          })
          return { type: 'output-list' as const, outputs: [receipt] }
        }
        return { type: 'output-list' as const, outputs: [{ beef: makeBeef(41), outputIndex: 0 }] }
      }
    )
    const resolver = new LookupResolver({ facilitator: { lookup } as any, slapTrackers: [tracker] })
    const firstAbort = new AbortController()
    const first = resolver
      .query$({ service: 'ls_shared', query: { caller: 1 } }, undefined, {
        signal: firstAbort.signal
      } as any)
      [Symbol.asyncIterator]()
    const secondProgress: LookupAnswerProgress[] = []
    const second = (async () => {
      for await (const progress of resolver.query$({
        service: 'ls_shared',
        query: { caller: 2 }
      })) {
        secondProgress.push(progress)
      }
    })()

    const firstPending = first.next()
    await Promise.resolve()
    firstAbort.abort()
    await expect(firstPending).resolves.toMatchObject({ value: { terminalReason: 'cancelled' } })
    expect(trackerSignal?.aborted).toBe(false)
    completeTracker?.()
    await jest.runAllTimersAsync()
    await second
    expect(secondProgress.at(-1)).toMatchObject({
      isFinal: true,
      terminalReason: 'settled',
      outputs: [{ beef: makeBeef(41), outputIndex: 0 }]
    })
    expect(lookup.mock.calls.filter(([url]) => url === tracker)).toHaveLength(1)
  })

  it('does not let an abandoned custom-facilitator completion leak into a later query or its evidence', async () => {
    const host = 'https://late-custom.example'
    const staleBeef = makeBeef(51)
    const freshBeef = makeBeef(52)
    let resolveStale:
      | ((value: {
          type: 'output-list'
          outputs: Array<{ beef: number[]; outputIndex: number }>
        }) => void)
      | undefined
    let calls = 0
    const lookup = jest.fn(() => {
      calls++
      if (calls === 1) {
        return new Promise<{
          type: 'output-list'
          outputs: Array<{ beef: number[]; outputIndex: number }>
        }>(resolve => {
          resolveStale = resolve
        })
      }
      return Promise.resolve({
        type: 'output-list' as const,
        outputs: [{ beef: freshBeef, outputIndex: 0 }]
      })
    })
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      hostOverrides: { ls_late_custom: [host] }
    })
    const abort = new AbortController()
    const abandonedEvidence: Array<{ type: string }> = []
    const abandoned = resolver
      .query$({ service: 'ls_late_custom', query: { generation: 1 } }, undefined, {
        signal: abort.signal,
        onEvidence: event => abandonedEvidence.push(event)
      } as any)
      [Symbol.asyncIterator]()
    const abandonedPending = abandoned.next()
    await Promise.resolve()
    abort.abort()
    await abandonedPending

    const next = resolver.query({ service: 'ls_late_custom', query: { generation: 2 } })
    resolveStale?.({ type: 'output-list', outputs: [{ beef: staleBeef, outputIndex: 0 }] })
    await jest.runAllTimersAsync()
    await expect(next).resolves.toEqual({
      type: 'output-list',
      outputs: [{ beef: freshBeef, outputIndex: 0 }]
    })
    expect(abandonedEvidence).toEqual([{ type: 'limit' }])
  })

  it('stops evidence and aggregate intake when the first evidence callback aborts', async () => {
    const host = 'https://callback-abort.example'
    const controller = new AbortController()
    const events: Array<{ type: string; output?: unknown }> = []
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => ({
          type: 'output-list' as const,
          outputs: [
            { beef: makeBeef(201), outputIndex: 0 },
            { beef: makeBeef(202), outputIndex: 1 },
            { beef: makeBeef(203), outputIndex: 2 }
          ]
        })
      },
      hostOverrides: { ls_callback_abort: [host] }
    })
    const iterator = resolver
      .query$({ service: 'ls_callback_abort', query: {} }, undefined, {
        signal: controller.signal,
        onEvidence: event => {
          events.push(event)
          if (event.type === 'output') controller.abort()
        }
      })
      [Symbol.asyncIterator]()

    const terminal = await iterator.next()
    expect(terminal.value).toMatchObject({
      isFinal: true,
      terminalReason: 'cancelled',
      outputs: []
    })
    expect(events.filter(event => event.type === 'output')).toHaveLength(1)
    expect(events.filter(event => event.type === 'limit')).toHaveLength(1)
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('aborts and settles a pending iterator when return() is called', async () => {
    const host = 'https://return-pending.example'
    let requestSignal: AbortSignal | undefined
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async (_url, _question, _timeout, signal) =>
          await new Promise<never>((_resolve, reject) => {
            requestSignal = signal
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
      },
      hostOverrides: { ls_return_pending: [host] }
    })
    const iterator = resolver
      .query$({ service: 'ls_return_pending', query: {} })
      [Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    await expect(iterator.return?.()).resolves.toEqual({ done: true, value: undefined })
    expect(requestSignal?.aborted).toBe(true)
    await expect(pending).resolves.toMatchObject({
      done: false,
      value: { isFinal: true, terminalReason: 'cancelled' }
    })
  })

  it('cleans terminal queries before yielding so 130 final-only consumers do not exhaust slots', async () => {
    const resolver = new LookupResolver({
      facilitator: { lookup: async () => ({ type: 'output-list' as const, outputs: [] }) },
      hostOverrides: { ls_final_only: ['https://final-only.example'] }
    })
    for (let index = 0; index < 130; index++) {
      const first = await resolver
        .query$({ service: 'ls_final_only', query: { index } })
        [Symbol.asyncIterator]()
        .next()
      expect(first.value?.isFinal).toBe(true)
    }
    expect((resolver as any).activeQueries).toBe(0)
  })

  it('enforces decoded BEEF and context retention across hosts independently of reported wire bytes', async () => {
    const firstHost = 'https://decoded-one.example'
    const secondHost = 'https://decoded-two.example'
    const firstOutput = { beef: makeBeef(211), outputIndex: 0, context: Array(10).fill(7) }
    const secondOutput = { beef: makeBeef(212), outputIndex: 1, context: Array(10).fill(8) }
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async (host, _question, _timeout, _signal, requestOptions) => {
          requestOptions?.consumeBytes?.(1)
          return {
            type: 'output-list' as const,
            outputs: [host === firstHost ? firstOutput : secondOutput]
          }
        }
      },
      hostOverrides: { ls_decoded_budget: [firstHost, secondHost] }
    })
    const progress: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$(
        { service: 'ls_decoded_budget', query: {} },
        undefined,
        {
          limits: {
            hostConcurrency: 1,
            maxTotalBytes: firstOutput.beef.length + firstOutput.context.length
          }
        }
      ))
        progress.push(item)
    })()
    await jest.runAllTimersAsync()
    await pending

    expect(progress.at(-1)).toMatchObject({
      isFinal: true,
      terminalReason: 'resource-limit',
      limitsHit: expect.arrayContaining(['maxTotalBytes']),
      receivedBytes: 2,
      retainedBytes: firstOutput.beef.length + firstOutput.context.length,
      outputs: [firstOutput]
    })
  })

  it('normalizes duplicate configured endpoints and never exceeds the host concurrency budget', async () => {
    const one = 'https://one.example'
    const two = 'https://two.example'
    const three = 'https://three.example'
    const calls: string[] = []
    let active = 0
    let peak = 0
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async (host: string) => {
          calls.push(host)
          active++
          peak = Math.max(peak, active)
          await later(20)
          active--
          return { type: 'output-list' as const, outputs: [] }
        }
      },
      hostOverrides: { ls_concurrency: [`${one}/`, one, two, three] }
    })
    const pending = resolver.query({ service: 'ls_concurrency', query: {} }, undefined, {
      limits: { hostConcurrency: 2 }
    })
    await jest.runAllTimersAsync()
    await pending

    expect(calls).toEqual(expect.arrayContaining([one, two, three]))
    expect(calls.filter(host => host === one)).toHaveLength(1)
    expect(peak).toBeLessThanOrEqual(2)
  })

  it('gives a later tracker source a turn before draining an earlier tracker flood', async () => {
    const firstTracker = 'https://first-tracker.example'
    const lateTracker = 'https://late-tracker.example'
    const floodHosts = [
      'https://flood-1.example',
      'https://flood-2.example',
      'https://flood-3.example'
    ]
    const lateHost = 'https://late-fair.example'
    const service = 'ls_fair'
    const receipts = await Promise.all([
      ...floodHosts.map((host, index) => slapReceipt(110 + index, host, service)),
      slapReceipt(120, lateHost, service)
    ])
    const hostCalls: string[] = []
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async (host: string) => {
          if (host === firstTracker)
            return { type: 'output-list' as const, outputs: receipts.slice(0, 3) }
          if (host === lateTracker) {
            await later(1)
            return { type: 'output-list' as const, outputs: [receipts[3]] }
          }
          hostCalls.push(host)
          await later(20)
          return { type: 'output-list' as const, outputs: [] }
        }
      },
      slapTrackers: [firstTracker, lateTracker]
    })
    const pending = resolver.query({ service, query: {} }, undefined, {
      limits: { hostConcurrency: 1 }
    })
    await jest.runAllTimersAsync()
    await pending

    expect(hostCalls).toContain(lateHost)
    expect(hostCalls.indexOf(lateHost)).toBeLessThan(hostCalls.indexOf(floodHosts[1]))
  })

  it('joins an in-flight refresh even after a stale cached host becomes fresh for a later query', async () => {
    const tracker = 'https://refresh-tracker.example'
    const cachedHost = 'https://cached-refresh.example'
    const lateHost = 'https://late-refresh.example'
    const service = 'ls_refresh'
    const receipt = await slapReceipt(130, lateHost, service)
    const cachedBeef = makeBeef(61)
    const lateBeef = makeBeef(62)
    let finishRefresh: (() => void) | undefined
    const lookup = jest.fn(async (host: string) => {
      if (host === tracker) {
        await new Promise<void>(resolve => {
          finishRefresh = resolve
        })
        return { type: 'output-list' as const, outputs: [receipt] }
      }
      return {
        type: 'output-list' as const,
        outputs: [{ beef: host === cachedHost ? cachedBeef : lateBeef, outputIndex: 0 }]
      }
    })
    const resolver = new LookupResolver({ facilitator: { lookup }, slapTrackers: [tracker] })
    ;(resolver as any).hostsCache.set(service, { hosts: [cachedHost], expiresAt: 0 })

    const first = resolver.query$({ service, query: { caller: 1 } })[Symbol.asyncIterator]()
    const firstPending = first.next()
    await Promise.resolve()
    ;(resolver as any).hostsCache.set(service, {
      hosts: [cachedHost],
      expiresAt: Date.now() + 60_000
    })
    const secondProgress: LookupAnswerProgress[] = []
    const second = (async () => {
      for await (const progress of resolver.query$({ service, query: { caller: 2 } })) {
        secondProgress.push(progress)
      }
    })()

    finishRefresh?.()
    await jest.runAllTimersAsync()
    await firstPending
    await first.return?.()
    await second

    expect(lookup.mock.calls.filter(([host]) => host === tracker)).toHaveLength(1)
    expect(secondProgress.at(-1)?.outputs).toEqual(
      expect.arrayContaining([
        { beef: cachedBeef, outputIndex: 0 },
        { beef: lateBeef, outputIndex: 0 }
      ])
    )
  })

  it('bounds tracker work by trackerConcurrency', async () => {
    const trackers = [
      'https://tracker-one.example',
      'https://tracker-two.example',
      'https://tracker-three.example'
    ]
    const service = 'ls_tracker_bound'
    const host = 'https://tracker-bound-host.example'
    const receipt = await slapReceipt(140, host, service)
    let active = 0
    let peak = 0
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async (url: string) => {
          if (trackers.includes(url)) {
            active++
            peak = Math.max(peak, active)
            await later(20)
            active--
            return { type: 'output-list' as const, outputs: url === trackers[0] ? [receipt] : [] }
          }
          return { type: 'output-list' as const, outputs: [] }
        }
      },
      slapTrackers: trackers
    })
    const pending = resolver.query({ service, query: {} }, undefined, {
      limits: { trackerConcurrency: 1 }
    })
    await jest.runAllTimersAsync()
    await pending
    expect(peak).toBe(1)
  })

  it('isolates a slow or throwing evidence listener so the terminal snapshot still arrives', async () => {
    const host = 'https://listener.example'
    let evidenceCalls = 0
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => ({
          type: 'output-list' as const,
          outputs: [
            { beef: makeBeef(71), outputIndex: 0 },
            { beef: makeBeef(72), outputIndex: 1 }
          ]
        })
      },
      hostOverrides: { ls_listener: [host] }
    })
    const progress: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$({ service: 'ls_listener', query: {} }, undefined, {
        onEvidence: () => {
          evidenceCalls++
          if (evidenceCalls === 1) return new Promise<void>(() => {})
          throw new Error('consumer failed')
        }
      }))
        progress.push(item)
    })()
    await jest.runAllTimersAsync()
    await pending
    expect(progress.at(-1)).toMatchObject({
      isFinal: true,
      terminalReason: 'settled',
      successfulHosts: 1
    })
    expect(evidenceCalls).toBe(2)
  })

  it('does not reuse a cancelled last-subscriber discovery when its old tracker completes late', async () => {
    const tracker = 'https://abandoned-tracker.example'
    const staleHost = 'https://abandoned-stale.example'
    const freshHost = 'https://abandoned-fresh.example'
    const service = 'ls_abandoned'
    const staleReceipt = await slapReceipt(150, staleHost, service)
    const freshReceipt = await slapReceipt(151, freshHost, service)
    let resolveOld: (() => void) | undefined
    let trackerCalls = 0
    const lookup = jest.fn(async (url: string) => {
      if (url === tracker) {
        trackerCalls++
        if (trackerCalls === 1) {
          await new Promise<void>(resolve => {
            resolveOld = resolve
          })
          return { type: 'output-list' as const, outputs: [staleReceipt] }
        }
        return { type: 'output-list' as const, outputs: [freshReceipt] }
      }
      return {
        type: 'output-list' as const,
        outputs: [{ beef: makeBeef(url === freshHost ? 81 : 80), outputIndex: 0 }]
      }
    })
    const resolver = new LookupResolver({ facilitator: { lookup }, slapTrackers: [tracker] })
    const abort = new AbortController()
    const abandoned = resolver
      .query$({ service, query: { attempt: 1 } }, undefined, {
        signal: abort.signal
      })
      [Symbol.asyncIterator]()
    const terminal = abandoned.next()
    await Promise.resolve()
    abort.abort()
    await terminal
    resolveOld?.()
    await Promise.resolve()

    const fresh = resolver.query({ service, query: { attempt: 2 } })
    await jest.runAllTimersAsync()
    await expect(fresh).resolves.toEqual({
      type: 'output-list',
      outputs: [{ beef: makeBeef(81), outputIndex: 0 }]
    })
    expect(trackerCalls).toBe(2)
  })

  it('keeps the ordinary 2s host and 5s tracker attempts within the 10s query deadline', async () => {
    const usefulTracker = 'https://useful-4500.example'
    const hangingTracker = 'https://hanging-tracker.example'
    const discoveredHost = 'https://discovered-1500.example'
    const service = 'ls_default_deadline'
    const receipt = await slapReceipt(160, discoveredHost, service)
    const lookup = jest.fn(async (url: string, _question: unknown, timeout?: number) => {
      if (url === usefulTracker) {
        expect(timeout).toBe(5000)
        await later(4500)
        return { type: 'output-list' as const, outputs: [receipt] }
      }
      if (url === hangingTracker) {
        expect(timeout).toBe(5000)
        await new Promise<void>(() => {})
      }
      expect(timeout).toBeUndefined()
      await later(1500)
      return { type: 'output-list' as const, outputs: [{ beef: makeBeef(91), outputIndex: 0 }] }
    })
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      slapTrackers: [usefulTracker, hangingTracker]
    })
    const pending = resolver.query({ service, query: {} })
    await jest.advanceTimersByTimeAsync(6_100)
    await expect(pending).resolves.toEqual({
      type: 'output-list',
      outputs: [{ beef: makeBeef(91), outputIndex: 0 }]
    })
  })

  it('does not let a tighter-limit cache hide later tracker hosts from a subsequent default query', async () => {
    const tracker = 'https://tight-cache-tracker.example'
    const firstHost = 'https://tight-cache-a.example'
    const laterHost = 'https://tight-cache-b.example'
    const service = 'ls_tight_cache'
    const firstReceipt = await slapReceipt(170, firstHost, service)
    const laterReceipt = await slapReceipt(171, laterHost, service)
    const firstBeef = makeBeef(101)
    const laterBeef = makeBeef(102)
    const lookup = jest.fn(async (url: string) => {
      if (url === tracker) {
        return { type: 'output-list' as const, outputs: [firstReceipt, laterReceipt] }
      }
      return {
        type: 'output-list' as const,
        outputs: [{ beef: url === firstHost ? firstBeef : laterBeef, outputIndex: 0 }]
      }
    })
    const resolver = new LookupResolver({ facilitator: { lookup }, slapTrackers: [tracker] })

    const tight = resolver.query({ service, query: { n: 1 } }, undefined, { limits: { maxHosts: 1 } })
    await jest.runAllTimersAsync()
    await tight

    const hostCallsAfterTight = lookup.mock.calls
      .map(([url]) => url)
      .filter((url: string) => url === firstHost || url === laterHost)
    expect(hostCallsAfterTight).toHaveLength(1)

    const full = resolver.query({ service, query: { n: 2 } })
    await jest.runAllTimersAsync()
    const answer = await full
    expect(answer.outputs).toEqual(
      expect.arrayContaining([
        { beef: firstBeef, outputIndex: 0 },
        { beef: laterBeef, outputIndex: 0 }
      ])
    )
    expect(answer.outputs).toHaveLength(2)
    expect(lookup.mock.calls.filter(([url]) => url === tracker).length).toBeGreaterThan(1)
    expect(lookup.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([firstHost, laterHost])
    )
  })

  it('throws from query() when a deadline expires before any host is admitted', async () => {
    const tracker = 'https://deadline-miss-tracker.example'
    const lookup = jest.fn(
      async (_url: string, _question: unknown, _timeout: unknown, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      slapTrackers: [tracker]
    })
    const pending = expect(
      resolver.query({ service: 'ls_deadline_miss', query: {} }, undefined, {
        deadlineMs: 25
      })
    ).rejects.toThrow(
      'No competent mainnet hosts found by the SLAP trackers for lookup service: ls_deadline_miss'
    )
    await jest.advanceTimersByTimeAsync(25)
    await pending
  })

  it('keeps query$ deadline snapshots when no host was admitted while Promise callers still throw', async () => {
    const tracker = 'https://deadline-snapshot-tracker.example'
    const lookup = jest.fn(
      async (_url: string, _question: unknown, _timeout: unknown, signal?: AbortSignal) =>
        await new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const resolver = new LookupResolver({
      facilitator: { lookup } as any,
      slapTrackers: [tracker]
    })
    const received: LookupAnswerProgress[] = []
    const pending = (async () => {
      for await (const item of resolver.query$(
        { service: 'ls_deadline_snapshot', query: {} },
        undefined,
        { deadlineMs: 25 }
      )) {
        received.push(item)
      }
    })()
    await jest.advanceTimersByTimeAsync(25)
    await pending
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      isFinal: true,
      terminalReason: 'deadline',
      hostCount: 0,
      outputs: []
    })
  })
})
