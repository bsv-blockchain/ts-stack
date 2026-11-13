import { expect, it, jest } from '@jest/globals'
import { CompletedProtoWallet, PrivateKey } from '@bsv/sdk'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'

it('serves private acquisition before publication fallback and legacy parsers with a shared authenticated host', async () => {
  const f = await privateAcquisitionHTTPFixture({}, false, undefined, (host, options) => {
    host.configurePrivatePublication({
      identity: options.identity,
      baseURL: options.baseURL,
      service: {
        publish: async () => {
          throw new Error('Acquisition reached publication')
        },
        status: async () => {
          throw new Error('Acquisition reached publication')
        }
      },
      disclosure: {
        prepare: () => {
          throw new Error('Acquisition reached publication')
        },
        enqueueControl: (_input, _caller, send) => {
          send()
        }
      }
    })
  })
  try {
    expect(Object.getOwnPropertyDescriptor(f.server, 'maxHeaderSize')?.value).toBe(131072)
    expect((await f.fetch()).status).toBe(402)
    const paid = await f.fetch('acquire', undefined, f.payment)
    expect(paid.status).toBe(200)
    expect(await paid.json()).toMatchObject({ status: 'delivered', result: { context: 'AQID' } })
    expect((await f.fetch('recover')).status).toBe(200)
    expect(f.getCredits()).toBe(1)
    for (const operation of ['acquire', 'recover', 'publish', 'status']) {
      const preflight = await fetch(f.origin + '/api/overlay/v1/private/' + operation, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://unlisted.example',
          'access-control-request-headers': 'content-type, x-bsv-overlay-profile'
        }
      })
      expect(preflight.status).toBe(204)
      expect(preflight.headers.get('access-control-allow-origin')).toBe('*')
      expect(preflight.headers.has('access-control-allow-credentials')).toBe(false)
    }
    const legacy = await fetch(f.origin + '/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'records', query: {} })
    })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).toEqual({ type: 'output-list', outputs: [] })
    const selected = { ...f.options, identity: f.contract.installation.seller }
    expect(() => f.host!.configurePrivateAcquisition(selected)).toThrow('before start')
  } finally {
    await f.close()
  }
}, 30000)
it('inherits host request ceilings for acquisition while keeping bounded payment header capacity explicit', async () => {
  const f = await privateAcquisitionHTTPFixture({}, false, undefined, host => {
    host.configureEdgePolicy({ jsonBodyLimitBytes: 1024 })
  })
  try {
    const large = await fetch(f.origin + '/api/overlay/v1/private/acquire', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: ' '.repeat(1025)
    })
    expect(large.status).toBe(413)
    expect(f.counts.prepare).toBe(0)
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('owns the explicitly configured acquisition origin list across host startup', async () => {
  const origins = ['https://first.example']
  const f = await privateAcquisitionHTTPFixture({}, false, undefined, (host, options) => {
    host.configureEdgePolicy({ allowedOrigins: ['https://host.example'] })
    host.configurePrivateAcquisition({ ...options, allowedOrigins: origins })
    origins.push('https://later.example')
  })
  try {
    for (const [origin, expected] of [
      ['https://first.example', 204],
      ['https://later.example', 403],
      ['https://host.example', 403]
    ] as const) {
      const response = await fetch(f.origin + '/api/overlay/v1/private/acquire', {
        method: 'OPTIONS',
        headers: { origin }
      })
      expect(response.status).toBe(expected)
      if (expected === 204) expect(response.headers.get('access-control-allow-origin')).toBe(origin)
    }
  } finally {
    await f.close()
  }
}, 30000)

it.each(['missing', 'mismatched'] as const)(
  'refuses a %s authentication wallet before mounting any host route',
  async mode => {
    let use: ReturnType<typeof jest.spyOn> | undefined
    await expect(
      privateAcquisitionHTTPFixture({}, false, undefined, host => {
        use = jest.spyOn(host.app, 'use')
        if (mode === 'missing') host.serverWallet = undefined
        else Object.assign(host, { serverWallet: new CompletedProtoWallet(new PrivateKey(107)) })
      })
    ).rejects.toThrow(mode === 'missing' ? 'require a server wallet' : 'must match')
    expect(use).not.toHaveBeenCalled()
  }
)
