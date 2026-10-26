import { Transaction } from '../../transaction'
import LookupResolver, { HTTPSOverlayLookupFacilitator } from '../LookupResolver'
import SHIPBroadcaster, { HTTPSOverlayBroadcastFacilitator } from '../SHIPBroadcaster'

describe('overlay HTTP security boundaries', () => {
  it('rejects private literal hosts in default public lookup and broadcast transports', async () => {
    await expect(
      new HTTPSOverlayLookupFacilitator().lookup('https://127.0.0.1', {
        service: 'ls_test',
        query: {}
      })
    ).rejects.toThrow('non-public address')

    await expect(
      new HTTPSOverlayBroadcastFacilitator().send('https://127.0.0.1', {
        beef: [1],
        topics: ['tm_test']
      })
    ).rejects.toThrow('non-public address')
  })

  it('requires a credential-free origin and prohibits redirects', async () => {
    const fetcher = jest.fn().mockResolvedValue({ ok: false, status: 500, statusText: '' })
    const lookup = new HTTPSOverlayLookupFacilitator(fetcher as typeof fetch)
    await expect(
      lookup.lookup('https://user@example.com', { service: 'ls_test', query: {} })
    ).rejects.toThrow('credential-free origin')
    expect(fetcher).not.toHaveBeenCalled()

    await expect(
      lookup.lookup('https://example.com', { service: 'ls_test', query: {} })
    ).rejects.toThrow('HTTP 500')
    expect(fetcher.mock.calls[0][1]).toEqual(expect.objectContaining({ redirect: 'error' }))
  })

  it('rejects oversized and malformed lookup response bytes', async () => {
    const oversized = new HTTPSOverlayLookupFacilitator(
      jest.fn().mockResolvedValue(
        new Response('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '33554433' }
        })
      ) as typeof fetch
    )
    await expect(
      oversized.lookup('https://example.com', { service: 'ls_test', query: {} })
    ).rejects.toThrow('maxResponseBytes')

    const malformed = new HTTPSOverlayLookupFacilitator(
      jest.fn().mockResolvedValue(
        new Response(Uint8Array.from([0xff]), {
          headers: { 'content-type': 'application/json' }
        })
      ) as typeof fetch
    )
    await expect(
      malformed.lookup('https://example.com', { service: 'ls_test', query: {} })
    ).rejects.toThrow('valid UTF-8')
  })

  it('rejects excessive output cardinality before aggregation', async () => {
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({
        type: 'output-list',
        outputs: Array.from({ length: 4097 }, () => ({ beef: [1], outputIndex: 0 }))
      })
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetcher as typeof fetch)
    await expect(
      facilitator.lookup('https://example.com', { service: 'ls_test', query: {} })
    ).rejects.toThrow('maxOutputs')
  })

  it('detaches and portably normalizes JSON returned by an injected fetch client', async () => {
    const shared = {
      type: 'output-list',
      outputs: [{ beef: Uint8Array.from([1, 2, 3]), outputIndex: 0 }]
    }
    const fetcher = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => shared
    })
    const facilitator = new HTTPSOverlayLookupFacilitator(fetcher as typeof fetch)

    const answer = await facilitator.lookup('https://example.com', {
      service: 'ls_test',
      query: {}
    })
    shared.outputs[0].beef[0] = 99
    shared.outputs[0].outputIndex = 1

    expect(answer).toEqual({
      type: 'output-list',
      outputs: [{ beef: [1, 2, 3], outputIndex: 0 }]
    })
  })

  it('does not synthesize a lookup answer from Object.prototype', async () => {
    Object.defineProperties(Object.prototype, {
      type: { configurable: true, value: 'output-list' },
      outputs: {
        configurable: true,
        value: [{ beef: [1, 2, 3], outputIndex: 0 }]
      }
    })
    try {
      const facilitator = new HTTPSOverlayLookupFacilitator(
        jest
          .fn()
          .mockResolvedValue(
            new Response('{}', { headers: { 'content-type': 'application/json' } })
          ) as typeof fetch
      )

      await expect(
        facilitator.lookup('https://example.com', { service: 'ls_test', query: {} })
      ).rejects.toThrow('Malformed lookup response')
    } finally {
      delete (Object.prototype as Record<string, unknown>).type
      delete (Object.prototype as Record<string, unknown>).outputs
    }
  })

  it('does not let a failed host disappear from an all-host acknowledgment requirement', async () => {
    const facilitator = {
      send: jest.fn(async (host: string) => {
        if (host === 'https://failed.example') throw new Error('offline')
        return { tm_test: { outputsToAdmit: [0], coinsToRetain: [] } }
      })
    }
    const broadcaster = new SHIPBroadcaster(['tm_test'], {
      facilitator,
      resolver: {} as LookupResolver,
      requireAcknowledgmentFromAllHostsForTopics: 'all',
      requireAcknowledgmentFromAnyHostForTopics: []
    })
    ;(broadcaster as any).findInterestedHosts = async () => ({
      'https://failed.example': new Set(['tm_test']),
      'https://ok.example': new Set(['tm_test'])
    })

    await expect(broadcaster.broadcast(new Transaction())).resolves.toEqual({
      status: 'error',
      code: 'ERR_REQUIRE_ACK_FROM_ALL_HOSTS_FAILED',
      description: 'Not all hosts acknowledged the required topics.'
    })
  })

  it('rejects unexpected or malformed STEAK acknowledgments', async () => {
    const broadcaster = new SHIPBroadcaster(['tm_test'], {
      facilitator: {
        send: async () => ({
          tm_other: { outputsToAdmit: [0], coinsToRetain: [] }
        })
      },
      resolver: {} as LookupResolver
    })
    ;(broadcaster as any).findInterestedHosts = async () => ({
      'https://host.example': new Set(['tm_test'])
    })

    await expect(broadcaster.broadcast(new Transaction())).resolves.toMatchObject({
      status: 'error',
      code: 'ERR_ALL_HOSTS_REJECTED'
    })
  })
})
