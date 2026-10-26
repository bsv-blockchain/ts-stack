import { MerklePath } from '@bsv/sdk'
import { ArcadeProvider, type ArcadeProviderConfig } from '../ArcadeProvider.js'
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
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(
        JSON.stringify({
          txid: tx.id(),
          txStatus: 'DOUBLE_SPEND_ATTEMPTED',
          competingTxs: ['22'.repeat(32)]
        }),
        { status: 202 }
      )
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

  it('snapshots provider credentials and custom headers before asynchronous use', async () => {
    const fetcher = jest.fn(
      async () =>
        new Response(JSON.stringify({ txid: tx.id(), txStatus: 'RECEIVED' }), { status: 202 })
    ) as any
    const headers = { 'X-Tenant': 'original' }
    const config = { apiKey: 'original-key', headers, fetch: fetcher }
    const arcade = new ArcadeProvider('https://arcade.example', config)

    config.apiKey = 'attacker-key'
    headers['X-Tenant'] = 'attacker'
    await arcade.broadcast(tx)

    const sent = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(sent.Authorization).toBe('Bearer original-key')
    expect(sent['X-Tenant']).toBe('original')
  })

  it('rejects type-confused private-host options and reserved custom headers', () => {
    expect(
      () =>
        new ArcadeProvider('http://127.0.0.1:8080', {
          allowPrivateHosts: 'false' as unknown as boolean
        })
    ).toThrow('boolean')
    expect(
      () =>
        new ChaintracksProvider('http://127.0.0.1:8080', {
          allowPrivateHosts: 'false' as unknown as boolean
        })
    ).toThrow('boolean')
    expect(
      () =>
        new ArcadeProvider('https://arcade.example', {
          headers: { Authorization: 'substitute' }
        })
    ).toThrow('reserved')
    expect(
      () =>
        new ArcadeProvider('https://arcade.example', {
          headers: { 'x-custom': undefined as unknown as string }
        })
    ).toThrow('must be a bounded string')
  })

  it('rejects accessor-backed provider configuration without invoking it', () => {
    const getter = jest.fn(() => true)
    const config: Record<string, unknown> = {}
    Object.defineProperty(config, 'allowPrivateHosts', { get: getter, enumerable: true })

    expect(
      () => new ArcadeProvider('https://arcade.example', config as ArcadeProviderConfig)
    ).toThrow('own data property')
    expect(getter).not.toHaveBeenCalled()
  })

  it('validates merkle roots through go-chaintracks headers', async () => {
    const fetcher = jest.fn(async (url: string) => {
      if (url.endsWith('/height')) {
        return new Response(JSON.stringify({ height: 900000 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      if (url.endsWith('/header/height/900000')) {
        return new Response(
          JSON.stringify({
            height: 900000,
            hash: 'aa'.repeat(32),
            merkleRoot: 'bb'.repeat(32)
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
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

  it('fails closed on a mismatched or unknown Arcade success response', async () => {
    const mismatched = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              txid: '22'.repeat(32),
              txStatus: 'RECEIVED'
            }),
            { status: 202 }
          )
      ) as any
    })
    const unknown = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              txid: tx.id(),
              txStatus: 'SOMETHING_NEW'
            }),
            { status: 202 }
          )
      ) as any
    })

    await expect(mismatched.broadcast(tx)).resolves.toMatchObject({ status: 'error' })
    await expect(unknown.broadcast(tx)).resolves.toMatchObject({ status: 'error' })
  })

  it('rejects a Chaintracks header that is not correlated to the requested height', async () => {
    const chaintracks = new ChaintracksProvider('https://arcade.example', {
      fetch: jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              height: 8,
              hash: 'aa'.repeat(32),
              merkleRoot: 'bb'.repeat(32)
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            }
          )
      ) as any
    })

    await expect(chaintracks.findHeaderForHeight(9)).rejects.toThrow(/does not match/)
  })

  it.each([
    [{ fetch: 'not-a-function' }, 'fetch must be a function'],
    [{ apiKey: 'bad\r\nkey' }, 'control characters'],
    [{ callbackUrl: 'http://arcade.example/callback' }, 'credential-free HTTPS'],
    [{ callbackUrl: 'https://user:pass@arcade.example/callback' }, 'credential-free HTTPS'],
    [{ callbackUrl: 'https://arcade.example/callback#secret' }, 'credential-free HTTPS'],
    [{ headers: { 'X-Test': 'bad\nvalue' } }, 'control characters'],
    [{ requestTimeoutMs: 0 }, 'between 1 and 300000'],
    [{ requestTimeoutMs: 300_001 }, 'between 1 and 300000']
  ])('rejects hostile Arcade configuration %#', (config, message) => {
    expect(
      () => new ArcadeProvider('https://arcade.example', config as ArcadeProviderConfig)
    ).toThrow(message)
  })

  it('accepts an explicit private-development callback and forwards optional headers', async () => {
    const fetcher = jest.fn(
      async () => new Response(JSON.stringify({ txStatus: 'RECEIVED' }), { status: 202 })
    ) as any
    const arcade = new ArcadeProvider('http://127.0.0.1:8080/', {
      allowPrivateHosts: true,
      callbackUrl: 'http://127.0.0.1:8081/callback',
      callbackToken: 'callback-token',
      deploymentId: 'deployment',
      fetch: fetcher,
      requestTimeoutMs: 1_000
    })

    await expect(arcade.broadcast(tx)).resolves.toMatchObject({
      status: 'success',
      txid: tx.id()
    })
    const headers = fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers['X-CallbackUrl']).toBe('http://127.0.0.1:8081/callback')
    expect(headers['X-CallbackToken']).toBe('callback-token')
    expect(headers['XDeployment-ID']).toBe('deployment')
  })

  it.each([
    [{ detail: 'detail' }, 'detail'],
    [{ reason: 'reason' }, 'reason'],
    [{ error: 'error' }, 'error'],
    [{ txStatus: 'REJECTED', extraInfo: 'policy' }, 'REJECTED policy']
  ])('uses bounded Arcade error detail priority %#', async (body, description) => {
    const arcade = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(async () => new Response(JSON.stringify(body), { status: 400 })) as any
    })

    await expect(arcade.broadcast(tx)).resolves.toMatchObject({
      status: 'error',
      description
    })
  })

  it.each([
    ['non-object', []],
    ['invalid status', { txStatus: 'RECEIVED', status: {} }],
    ['oversized status', { txStatus: 'RECEIVED', status: 'x'.repeat(129) }],
    ['non-array competitors', { txStatus: 'RECEIVED', competingTxs: 'bad' }],
    [
      'duplicate competitors',
      { txStatus: 'RECEIVED', competingTxs: ['22'.repeat(32), '22'.repeat(32).toUpperCase()] }
    ],
    ['invalid merkle path', { txStatus: 'RECEIVED', merklePath: '0' }],
    ['invalid block height', { txStatus: 'RECEIVED', blockHeight: -1 }],
    ['invalid block hash', { txStatus: 'RECEIVED', blockHash: 'not-a-hash' }]
  ])('fails closed on an Arcade response with %s', async (_label, body) => {
    const arcade = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(async () => new Response(JSON.stringify(body), { status: 202 })) as any
    })

    await expect(arcade.broadcast(tx)).resolves.toMatchObject({ status: 'error' })
  })

  it('bounds non-JSON error bodies and rejects malformed successful JSON', async () => {
    const errorProvider = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(async () => new Response('plain failure', { status: 503 })) as any
    })
    const malformedProvider = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(async () => new Response('{', { status: 202 })) as any
    })

    await expect(errorProvider.broadcast(tx)).resolves.toMatchObject({
      status: 'error',
      description: 'plain failure'
    })
    await expect(malformedProvider.broadcast(tx)).resolves.toMatchObject({ status: 'error' })
  })

  it('handles missing, rejected, pending, and height-mismatched proof responses', async () => {
    const txid = tx.id()
    const missing = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(async () => new Response('', { status: 404 })) as any
    })
    await expect(missing.fetchMerkleProof(txid)).resolves.toBeUndefined()

    const rejected = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(
        async () => new Response(JSON.stringify({ detail: 'not ready' }), { status: 503 })
      ) as any
    })
    await expect(rejected.fetchMerkleProof(txid)).rejects.toThrow('not ready')

    const pending = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(
        async () => new Response(JSON.stringify({ txid, txStatus: 'RECEIVED' }), { status: 200 })
      ) as any
    })
    await expect(pending.fetchMerkleProof(txid)).resolves.toBeUndefined()

    const merklePath = new MerklePath(7, [[{ offset: 0, txid: true, hash: txid }]])
    const mismatched = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              txid,
              txStatus: 'MINED',
              merklePath: merklePath.toHex(),
              blockHeight: 8
            }),
            { status: 200 }
          )
      ) as any
    })
    await expect(mismatched.fetchMerkleProof(txid)).rejects.toThrow('block height')
  })

  it('returns a correlated mined Arcade proof', async () => {
    const txid = tx.id()
    const merklePath = new MerklePath(7, [[{ offset: 0, txid: true, hash: txid }]])
    const arcade = new ArcadeProvider('https://arcade.example', {
      fetch: jest.fn(
        async () =>
          new Response(
            JSON.stringify({
              txid,
              txStatus: 'MINED',
              merklePath: merklePath.toHex(),
              blockHeight: 7,
              blockHash: '33'.repeat(32)
            }),
            { status: 200 }
          )
      ) as any
    })

    await expect(arcade.fetchMerkleProof(txid)).resolves.toMatchObject({
      txid,
      blockHeight: 7,
      blockHash: '33'.repeat(32),
      merkleRoot: txid
    })
  })
})
