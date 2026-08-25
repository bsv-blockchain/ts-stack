import { expect, test } from '@jest/globals'
import { CHIRPError, CHIRPResilienceError, CHIRPUploader } from '../src/index.js'
import type { WalletInterface } from '@bsv/sdk'

test('uploads bounded objects progressively, skips resumed objects, and commits every host', async () => {
  const calls: Array<{ method: string; url: string }> = []
  const staged = new Set<string>()
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ method, url })
    if (url.endsWith('/chirp/v1/uploads') && method === 'POST') {
      const host = new URL(url).host
      return Response.json(
        { uploadId: `upload-${host}`, stagingExpiresAt: 2_000_000_000 },
        { status: 201 }
      )
    }
    if (url.includes('/objects/') && method === 'HEAD') {
      return new Response(null, { status: staged.has(url) ? 200 : 404 })
    }
    if (url.includes('/objects/') && method === 'PUT') {
      staged.add(url)
      return new Response(null, { status: 201 })
    }
    if (url.endsWith('/commit') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { rootIdentifier: string }
      const host = new URL(url).origin
      return Response.json(
        {
          chirpURL: `chirp://${body.rootIdentifier}`,
          uhrpURL: `uhrp://${body.rootIdentifier}`,
          hostedFileLocation: `${host}/chirp/v1/${body.rootIdentifier}/objects/${body.rootIdentifier}`,
          expiryTime: 2_000_000_000
        },
        { status: 201 }
      )
    }
    return new Response(null, { status: 500 })
  }
  const uploader = new CHIRPUploader({
    wallet: {} as WalletInterface,
    storageURLs: ['https://a.example', 'https://b.example'],
    resilienceLevel: 2,
    fetch: fetcher
  })
  const checkpoints: unknown[] = []
  const result = await uploader.publish({
    source: new TextEncoder().encode('progressive'),
    retentionSeconds: 3600,
    logicalLength: 11,
    onCheckpoint: checkpoint => {
      checkpoints.push(checkpoint)
    }
  })
  expect(result.hostedBy).toEqual(['https://a.example', 'https://b.example'])
  expect(calls.filter(call => call.method === 'PUT')).toHaveLength(4)
  expect(calls.filter(call => call.method === 'POST' && call.url.endsWith('/commit'))).toHaveLength(
    2
  )
  expect(checkpoints.length).toBeGreaterThanOrEqual(3)

  const putCount = calls.filter(call => call.method === 'PUT').length
  const resumed = await uploader.publish({
    source: new TextEncoder().encode('progressive'),
    retentionSeconds: 3600,
    logicalLength: 11,
    resume: result.checkpoint
  })
  expect(resumed.rootIdentifier).toBe(result.rootIdentifier)
  expect(calls.filter(call => call.method === 'PUT')).toHaveLength(putCount)
})

const wallet = {} as WalletInterface
const future = 4_000_000_000

function session(host: string): Response {
  return Response.json(
    { uploadId: `upload-${new URL(host).host}`, stagingExpiresAt: future },
    { status: 201 }
  )
}

function commit(
  host: string,
  rootIdentifier: string,
  overrides: Record<string, unknown> = {}
): Response {
  return Response.json(
    {
      chirpURL: `chirp://${rootIdentifier}`,
      uhrpURL: `uhrp://${rootIdentifier}`,
      hostedFileLocation: `${host}/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`,
      expiryTime: future,
      ...overrides
    },
    { status: 201 }
  )
}

test('rejects unsafe host and resilience configuration before network activity', () => {
  const invalid = [
    () => new CHIRPUploader({ wallet, storageURLs: [] }),
    () => new CHIRPUploader({ wallet, storageURL: 'not a URL' }),
    () => new CHIRPUploader({ wallet, storageURL: 'ftp://host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: 'http://host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://user@host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://host.example?query=1' }),
    () =>
      new CHIRPUploader({
        wallet,
        storageURLs: ['https://host.example'],
        resilienceLevel: 0
      }),
    () =>
      new CHIRPUploader({
        wallet,
        storageURLs: ['https://host.example'],
        resilienceLevel: 2
      }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://host.example', requestTimeoutMs: 0 }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://host.example', retriesPerRequest: 9 })
  ]
  for (const construct of invalid) expect(construct).toThrow(CHIRPError)
  expect(
    () =>
      new CHIRPUploader({
        wallet,
        storageURL: 'http://host.example/',
        allowInsecureHTTP: true
      })
  ).not.toThrow()
})

test.each([0, -1, 0x1_0000_0000_0000_0000n, '01', 'not-a-number'])(
  'rejects non-canonical retention %s',
  async retentionSeconds => {
    const uploader = new CHIRPUploader({
      wallet,
      storageURL: 'https://host.example',
      fetch: async () => new Response(null, { status: 500 })
    })
    await expect(
      uploader.publish({ source: new Uint8Array(), retentionSeconds })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_INTEGER' })
  }
)

test('requires enough well-formed staging sessions', async () => {
  const uploader = new CHIRPUploader({
    wallet,
    storageURLs: ['https://a.example', 'https://b.example', 'https://c.example'],
    resilienceLevel: 2,
    retriesPerRequest: 0,
    fetch: async input => {
      const host = new URL(input).origin
      if (host === 'https://a.example') return session(host)
      if (host === 'https://b.example') {
        return Response.json({ uploadId: 7, stagingExpiresAt: 'bad' }, { status: 201 })
      }
      return new Response(null, { status: 400 })
    }
  })
  await expect(
    uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toEqual(expect.objectContaining({ requiredHosts: 2, successfulHosts: 1 }))
})

test('rejects mismatched, expired, foreign, malformed, and duplicate checkpoints', async () => {
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async () => new Response(null, { status: 500 })
  })
  const base = {
    version: 1 as const,
    retentionSeconds: '60',
    logicalLength: '1',
    sessions: [
      { host: 'https://host.example', uploadId: 'one', stagingExpiresAt: future },
      { host: 'https://host.example/', uploadId: 'duplicate', stagingExpiresAt: future },
      { host: 'https://foreign.example', uploadId: 'foreign', stagingExpiresAt: future },
      { host: 'not a URL', uploadId: 'invalid', stagingExpiresAt: future },
      { host: 'https://host.example', uploadId: '', stagingExpiresAt: future },
      { host: 'https://host.example', uploadId: 'expired', stagingExpiresAt: 1 }
    ]
  }
  for (const resume of [
    { ...base, version: 2 as 1 },
    { ...base, retentionSeconds: '61' },
    { ...base, logicalLength: null }
  ]) {
    await expect(
      uploader.publish({
        source: Uint8Array.of(1),
        retentionSeconds: 60,
        logicalLength: 1,
        resume
      })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_RESUME' })
  }
})

test('survives one failed host, records only committed sessions, and normalizes non-Error failures', async () => {
  const calls: string[] = []
  const uploader = new CHIRPUploader({
    wallet,
    storageURLs: ['https://a.example', 'https://b.example'],
    resilienceLevel: 1,
    retriesPerRequest: 0,
    fetch: async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${input}`)
      const host = new URL(input).origin
      if (input.endsWith('/chirp/v1/uploads')) return session(host)
      if (host === 'https://a.example' && init?.method === 'HEAD') throw 'offline'
      if (init?.method === 'HEAD') return new Response(null, { status: 404 })
      if (init?.method === 'PUT') return new Response(null, { status: 201 })
      const body = JSON.parse(String(init?.body)) as { rootIdentifier: string }
      return commit(host, body.rootIdentifier)
    }
  })
  const result = await uploader.publish({
    source: Uint8Array.of(1),
    retentionSeconds: 60,
    logicalLength: 1
  })
  expect(result.hostedBy).toEqual(['https://b.example'])
  expect(result.checkpoint.sessions.map(value => value.host)).toEqual(['https://b.example'])
  expect(calls.some(value => value.startsWith('PUT https://b.example'))).toBe(true)
})

test('accepts HEAD 204 without PUT and retries transport and 5xx responses', async () => {
  const counts = new Map<string, number>()
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    retriesPerRequest: 2,
    fetch: async (input, init) => {
      const key = `${init?.method ?? 'GET'} ${new URL(input).pathname}`
      const count = (counts.get(key) ?? 0) + 1
      counts.set(key, count)
      if (input.endsWith('/chirp/v1/uploads')) {
        if (count === 1) return new Response('retry', { status: 503 })
        return session('https://host.example')
      }
      if (init?.method === 'HEAD') {
        if (count === 1) throw new Error('temporary transport failure')
        return new Response(null, { status: 204 })
      }
      const body = JSON.parse(String(init?.body)) as { rootIdentifier: string }
      if (count === 1) return new Response('retry', { status: 502 })
      return commit('https://host.example', body.rootIdentifier)
    }
  })
  const result = await uploader.publish({
    source: Uint8Array.of(1),
    retentionSeconds: 60,
    logicalLength: 1
  })
  expect(result.hostedBy).toEqual(['https://host.example'])
  expect([...counts.keys()].some(key => key.startsWith('PUT '))).toBe(false)
  expect([...counts.values()].some(count => count > 1)).toBe(true)
})

test.each([
  { head: 418, put: 201 },
  { head: 404, put: 400 }
])('fails publication for rejected object staging %#', async statuses => {
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    retriesPerRequest: 0,
    fetch: async (input, init) => {
      if (input.endsWith('/chirp/v1/uploads')) return session('https://host.example')
      if (init?.method === 'HEAD') return new Response(null, { status: statuses.head })
      if (init?.method === 'PUT') return new Response(null, { status: statuses.put })
      return new Response(null, { status: 500 })
    }
  })
  await expect(
    uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)
})

test.each([{ kind: 'status' }, { kind: 'shape' }, { kind: 'mismatch' }, { kind: 'location' }])(
  'rejects invalid commit response: $kind',
  async ({ kind }) => {
    const uploader = new CHIRPUploader({
      wallet,
      storageURL: 'https://host.example',
      retriesPerRequest: 0,
      fetch: async (input, init) => {
        if (input.endsWith('/chirp/v1/uploads')) return session('https://host.example')
        if (init?.method === 'HEAD') return new Response(null, { status: 204 })
        const body = JSON.parse(String(init?.body)) as { rootIdentifier: string }
        if (kind === 'status') return new Response(null, { status: 400 })
        if (kind === 'shape') return Response.json({}, { status: 201 })
        if (kind === 'mismatch')
          return commit('https://host.example', body.rootIdentifier, {
            chirpURL: `chirp://${objectIdentifier()}`
          })
        return commit('https://host.example', body.rootIdentifier, {
          hostedFileLocation: 'not a URL'
        })
      }
    })
    await expect(
      uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
    ).rejects.toBeInstanceOf(CHIRPResilienceError)
  }
)

test('rejects a declared logical length that differs from the built source', async () => {
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async (input, init) => {
      if (input.endsWith('/chirp/v1/uploads')) return session('https://host.example')
      if (init?.method === 'HEAD') return new Response(null, { status: 204 })
      return new Response(null, { status: 500 })
    }
  })
  await expect(
    uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60, logicalLength: 2 })
  ).rejects.toMatchObject({ code: 'ERR_CHIRP_LENGTH' })
})

test('preserves caller cancellation instead of converting it to resilience failure', async () => {
  const controller = new AbortController()
  controller.abort('cancelled')
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async () => new Response(null, { status: 500 })
  })
  await expect(
    uploader.publish({
      source: Uint8Array.of(1),
      retentionSeconds: 60,
      signal: controller.signal
    })
  ).rejects.toMatchObject({ name: 'AbortError' })
})

function objectIdentifier(): string {
  return 'XUSvYkywHxEMvs7oiYYMV8bJ1sJjHq2mHgZvu8jSLyLhbNRVjG8E'
}
