import { ArcadeProvider } from '../ArcadeProvider.js'
import { ChaintracksProvider } from '../ChaintracksProvider.js'
import { ProviderChainBroadcaster } from '../ProviderChainBroadcaster.js'

describe('Overlay transaction providers', () => {
  const tx = {
    id: jest.fn(() => '11'.repeat(32)),
    toHexEF: jest.fn(() => 'efhex'),
    toHex: jest.fn(() => 'rawhex')
  } as any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('tries the next broadcaster after a transient provider failure', async () => {
    const first = {
      broadcast: jest.fn(async () => ({
        status: 'error' as const,
        code: '503',
        description: 'backpressure',
        more: { terminal: false }
      }))
    }
    const second = {
      broadcast: jest.fn(async () => ({
        status: 'success' as const,
        txid: tx.id(),
        message: 'accepted'
      }))
    }
    const chain = new ProviderChainBroadcaster([
      { name: 'Arcade', broadcaster: first },
      { name: 'ARC', broadcaster: second }
    ])

    const response = await chain.broadcast(tx)

    expect(response.status).toBe('success')
    expect(first.broadcast).toHaveBeenCalledTimes(1)
    expect(second.broadcast).toHaveBeenCalledTimes(1)
  })

  it('stops on terminal double-spend failures', async () => {
    const first = {
      broadcast: jest.fn(async () => ({
        status: 'error' as const,
        code: 'DOUBLE_SPEND_ATTEMPTED',
        description: 'double spend',
        more: { terminal: true, competingTxs: ['22'.repeat(32)] }
      }))
    }
    const second = {
      broadcast: jest.fn(async () => ({
        status: 'success' as const,
        txid: tx.id(),
        message: 'accepted'
      }))
    }
    const chain = new ProviderChainBroadcaster([
      { name: 'Arcade', broadcaster: first },
      { name: 'ARC', broadcaster: second }
    ])

    const response = await chain.broadcast(tx)

    expect(response.status).toBe('error')
    if (response.status === 'error') {
      expect(response.code).toBe('DOUBLE_SPEND_ATTEMPTED')
    }
    expect(first.broadcast).toHaveBeenCalledTimes(1)
    expect(second.broadcast).not.toHaveBeenCalled()
  })

  it('rejects an internally exhausted provider list defensively', async () => {
    const broadcaster = new ProviderChainBroadcaster([
      {
        name: 'ARC',
        broadcaster: {
          broadcast: jest.fn(async () => ({
            status: 'success' as const,
            txid: tx.id(),
            message: 'accepted'
          }))
        }
      }
    ])
    ;(broadcaster as unknown as { providers: unknown[] }).providers = []

    await expect(broadcaster.broadcast(tx)).rejects.toThrow(
      'ProviderChainBroadcaster exhausted no providers'
    )
  })

  it('returns the last annotated failure after every provider fails transiently', async () => {
    const first = {
      broadcast: jest.fn(async () => ({
        status: 'error' as const,
        code: '503',
        description: 'first unavailable'
      }))
    }
    const second = {
      broadcast: jest.fn(async () => ({
        status: 'error' as const,
        code: '504',
        description: 'second unavailable'
      }))
    }
    const broadcaster = new ProviderChainBroadcaster([
      { name: 'first', broadcaster: first },
      { name: 'second', broadcaster: second }
    ])

    await expect(broadcaster.broadcast(tx)).resolves.toMatchObject({
      status: 'error',
      code: '504',
      more: {
        provider: 'second',
        providerFailures: [
          { provider: 'first', code: '503' },
          { provider: 'second', code: '504' }
        ]
      }
    })
  })

  it('classifies Arcade double-spend status as a broadcast failure', async () => {
    const requests: Array<{ url: string, init?: RequestInit }> = []
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(JSON.stringify({
        txid: tx.id(),
        txStatus: 'DOUBLE_SPEND_ATTEMPTED',
        competingTxs: ['22'.repeat(32)]
      }), { status: 202 })
    }) as any
    const arcade = new ArcadeProvider('https://arcade.example/', {
      apiKey: 'secret',
      callbackUrl: 'https://overlay.example/arc-ingest',
      callbackToken: 'callback',
      fetch: fetcher
    })

    const response = await arcade.broadcast(tx)

    expect(response.status).toBe('error')
    if (response.status === 'error') {
      expect(response.code).toBe('DOUBLE_SPEND_ATTEMPTED')
    }
    const request = requests[0]
    expect(request).toBeDefined()
    expect(request?.url).toBe('https://arcade.example/tx')
    const requestHeaders = request?.init?.headers as Record<string, string> | undefined
    expect(requestHeaders?.Authorization).toBe('Bearer secret')
  })

  it('validates merkle roots through go-chaintracks headers', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.endsWith('/height')) {
        return new Response(JSON.stringify({ height: 900000 }), { status: 200 })
      }
      if (url.endsWith('/header/height/900000')) {
        return new Response(JSON.stringify({
          height: 900000,
          hash: 'aa'.repeat(32),
          merkleRoot: 'bb'.repeat(32)
        }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }) as any
    const chaintracks = new ChaintracksProvider('https://arcade.example', { fetch: fetcher })

    await expect(chaintracks.currentHeight()).resolves.toBe(900000)
    await expect(chaintracks.isValidRootForHeight('bb'.repeat(32), 900000)).resolves.toBe(true)
    await expect(chaintracks.isValidRootForHeight('cc'.repeat(32), 900000)).resolves.toBe(false)
    await expect(chaintracks.isValidRootForHeight('bb'.repeat(32), 900001)).resolves.toBe(false)
    expect(chaintracks.reorgStreamUrl()).toBe('https://arcade.example/chaintracks/v2/reorg/stream')
  })
})
