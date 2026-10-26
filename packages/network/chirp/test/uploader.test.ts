import { expect, test } from '@jest/globals'
import { CHIRPError, CHIRPResilienceError, CHIRPUploader, sha256 } from '../src/index.js'
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
        { uploadId: `upload-${host}`, stagingExpiresAt: '2000000000' },
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
    { uploadId: `upload-${new URL(host).host}`, stagingExpiresAt: String(future) },
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
  const sparseHosts: string[] = []
  sparseHosts.length = 1
  const invalidTypes = [
    () => new CHIRPUploader(null as never),
    () =>
      new CHIRPUploader({
        wallet,
        storageURL: 'https://host.example',
        unsupported: true
      } as never),
    () => new CHIRPUploader({ wallet: null as never, storageURL: 'https://host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: 1 as never }),
    () => new CHIRPUploader({ wallet, storageURLs: 'https://host.example' as never }),
    () => new CHIRPUploader({ wallet, storageURLs: sparseHosts }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://host.example', fetch: 1 as never }),
    () =>
      new CHIRPUploader({ wallet, storageURL: 'https://host.example', fetchClient: 1 as never }),
    () =>
      new CHIRPUploader({
        wallet,
        storageURL: 'https://host.example',
        allowPrivateHosts: 'true' as never
      })
  ]
  for (const construct of invalidTypes) expect(construct).toThrow(TypeError)

  const invalid = [
    () => new CHIRPUploader({ wallet }),
    () => new CHIRPUploader({ wallet, storageURLs: [] }),
    () => new CHIRPUploader({ wallet, storageURL: 'not a URL' }),
    () => new CHIRPUploader({ wallet, storageURL: 'ftp://host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: 'http://host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: ' https://host.example' }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://127.0.0.1' }),
    () => new CHIRPUploader({ wallet, storageURL: 'https://[::1]' }),
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
    () => new CHIRPUploader({ wallet, storageURL: 'https://host.example', retriesPerRequest: 9 }),
    () =>
      new CHIRPUploader({
        wallet,
        storageURL: 'https://host.example',
        fetch: async () => new Response(null),
        fetchClient: async () => new Response(null)
      })
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
  expect(
    () =>
      new CHIRPUploader({
        wallet,
        storageURL: 'https://host.example',
        fetchClient: async () => new Response(null)
      })
  ).not.toThrow()
  expect(
    () =>
      new CHIRPUploader({
        wallet,
        storageURL: 'https://127.0.0.1',
        allowPrivateHosts: true
      })
  ).not.toThrow()

  let accesses = 0
  const accessorConfig = Object.defineProperty(
    { wallet, storageURL: 'https://host.example' },
    'fetch',
    {
      enumerable: true,
      get() {
        accesses += 1
        return async () => new Response(null)
      }
    }
  )
  expect(() => new CHIRPUploader(accessorConfig as never)).toThrow('accessors')
  expect(accesses).toBe(0)
})

test.each([
  0,
  -1,
  Number.MAX_SAFE_INTEGER + 1,
  0x1_0000_0000_0000_0000n,
  '01',
  '184467440737095516160000000000000000000000000',
  'not-a-number'
])('rejects non-canonical retention %s', async retentionSeconds => {
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async () => new Response(null, { status: 500 })
  })
  await expect(
    uploader.publish({ source: new Uint8Array(), retentionSeconds })
  ).rejects.toMatchObject({ code: 'ERR_CHIRP_INTEGER' })
})

test.each([true, null, {}, []])('rejects non-integer runtime retention %#', async value => {
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async () => new Response(null, { status: 500 })
  })
  await expect(
    uploader.publish({
      source: new Uint8Array(),
      retentionSeconds: value as unknown as number
    })
  ).rejects.toMatchObject({ code: 'ERR_CHIRP_INTEGER' })
})

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
        return Response.json({ uploadId: 'upload-b', stagingExpiresAt: future }, { status: 201 })
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
      { host: 'https://host.example', uploadId: 'one', stagingExpiresAt: String(future) },
      { host: 'https://host.example/', uploadId: 'duplicate', stagingExpiresAt: String(future) },
      { host: 'https://foreign.example', uploadId: 'foreign', stagingExpiresAt: String(future) },
      { host: 'not a URL', uploadId: 'invalid', stagingExpiresAt: String(future) },
      { host: 'https://host.example', uploadId: '', stagingExpiresAt: String(future) },
      { host: 'https://host.example', uploadId: 'expired', stagingExpiresAt: '1' }
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

test.each([
  { kind: 'status' },
  { kind: 'shape' },
  { kind: 'mismatch' },
  { kind: 'location' },
  { kind: 'foreign-location' },
  { kind: 'expired' },
  { kind: 'short-retention' }
])('rejects invalid commit response: $kind', async ({ kind }) => {
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
      return commit(
        'https://host.example',
        body.rootIdentifier,
        kind === 'location'
          ? { hostedFileLocation: 'not a URL' }
          : kind === 'expired'
            ? { expiryTime: 1 }
            : kind === 'short-retention'
              ? { expiryTime: Math.floor(Date.now() / 1000) + 10 }
              : {
                  hostedFileLocation: `https://foreign.example/chirp/v1/${body.rootIdentifier}/objects/${body.rootIdentifier}`
                }
      )
    }
  })
  await expect(
    uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)
})

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

test('cancels a publication stalled in a non-cooperative input source', async () => {
  const controller = new AbortController()
  let startSource: (() => void) | undefined
  const sourceStarted = new Promise<void>(resolve => {
    startSource = resolve
  })
  let returned = false
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          startSource?.()
          return await new Promise<IteratorResult<Uint8Array>>(() => {})
        },
        return: async () => {
          returned = true
          return { done: true, value: undefined }
        }
      }
    }
  }
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async input =>
      input.endsWith('/chirp/v1/uploads')
        ? session('https://host.example')
        : new Response(null, { status: 500 })
  })
  const pending = uploader.publish({ source, retentionSeconds: 60, signal: controller.signal })
  await sourceStarted
  controller.abort(new Error('publication stopped'))
  await expect(pending).rejects.toThrow('publication stopped')
  await Promise.resolve()
  expect(returned).toBe(true)
})

test('bounds and strictly decodes control responses', async () => {
  const oversized = new Uint8Array(256 * 1024 + 1)
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    retriesPerRequest: 0,
    fetch: async () =>
      new Response(oversized, {
        status: 201,
        headers: { 'Content-Length': String(oversized.byteLength) }
      })
  })
  await expect(
    uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)

  const malformed = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    retriesPerRequest: 0,
    fetch: async () => new Response(Uint8Array.of(0xff), { status: 201 })
  })
  await expect(
    malformed.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)
})

test('enforces request timeouts against non-cooperative fetchers and control bodies', async () => {
  const stalledFetch = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    requestTimeoutMs: 5,
    retriesPerRequest: 0,
    fetch: async () => await new Promise<Response>(() => {})
  })
  await expect(
    stalledFetch.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)

  let releaseResponse: ((response: Response) => void) | undefined
  let lateBodyCancelled = false
  const lateFetch = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    requestTimeoutMs: 5,
    retriesPerRequest: 0,
    fetch: async () =>
      await new Promise<Response>(resolve => {
        releaseResponse = resolve
      })
  })
  await expect(
    lateFetch.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)
  releaseResponse?.(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          lateBodyCancelled = true
        }
      }),
      { status: 201 }
    )
  )
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(lateBodyCancelled).toBe(true)

  const stalledBody = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    requestTimeoutMs: 5,
    retriesPerRequest: 0,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: async () => await new Promise<void>(() => {}),
          cancel: async () => await new Promise<void>(() => {})
        }),
        { status: 201 }
      )
  })
  await expect(
    stalledBody.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)
})

test('does not let a non-cooperative rejected body block retries', async () => {
  let requests = 0
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    retriesPerRequest: 1,
    fetch: async (input, init) => {
      requests += 1
      if (input.endsWith('/chirp/v1/uploads')) {
        if (requests === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel: async () => await new Promise<void>(() => {})
            }),
            { status: 503 }
          )
        }
        return session('https://host.example')
      }
      if (init?.method === 'HEAD') return new Response(null, { status: 204 })
      const body = JSON.parse(String(init?.body)) as { rootIdentifier: string }
      return commit('https://host.example', body.rootIdentifier)
    }
  })
  await expect(
    uploader.publish({ source: Uint8Array.of(1), retentionSeconds: 60 })
  ).resolves.toMatchObject({ hostedBy: ['https://host.example'] })
})

test('snapshots publish bytes and callbacks before asynchronous network work', async () => {
  const callbacks: string[] = []
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async (input, init) => {
      if (input.endsWith('/chirp/v1/uploads')) return session('https://host.example')
      if (init?.method === 'HEAD') return new Response(null, { status: 204 })
      const body = JSON.parse(String(init?.body)) as { rootIdentifier: string }
      return commit('https://host.example', body.rootIdentifier)
    }
  })
  const source = Uint8Array.of(1)
  const publishOptions = {
    source,
    retentionSeconds: 60,
    onCheckpoint: () => {
      callbacks.push('captured')
    }
  }
  const pending = uploader.publish(publishOptions)
  source[0] = 9
  publishOptions.onCheckpoint = () => {
    callbacks.push('mutated')
  }
  const result = await pending
  expect(result.contentHash).toEqual(sha256(Uint8Array.of(1)))
  expect(callbacks).toContain('captured')
  expect(callbacks).not.toContain('mutated')

  let accesses = 0
  const accessorOptions = Object.defineProperty(
    { source: Uint8Array.of(1), retentionSeconds: 60 },
    'onCheckpoint',
    {
      enumerable: true,
      get() {
        accesses += 1
        return () => {}
      }
    }
  )
  await expect(uploader.publish(accessorOptions as never)).rejects.toThrow('accessors')
  expect(accesses).toBe(0)
})

test('rejects hostile publish and resume snapshots before network activity', async () => {
  let requests = 0
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async () => {
      requests += 1
      return new Response(null, { status: 500 })
    }
  })
  const sparseSource: number[] = []
  sparseSource.length = 1
  let sourceAccesses = 0
  const accessorSource = [1]
  Object.defineProperty(accessorSource, '0', {
    enumerable: true,
    get() {
      sourceAccesses += 1
      return 1
    }
  })
  const sparseSessions: Array<{ host: string; uploadId: string; stagingExpiresAt: string }> = []
  sparseSessions.length = 1
  const checkpoint = {
    version: 1 as const,
    retentionSeconds: '60',
    logicalLength: null
  }
  const invalid = [
    [null, 'plain object'],
    [{ retentionSeconds: 60 }, 'require source'],
    [{ source: Uint8Array.of(1) }, 'require source'],
    [{ source: Uint8Array.of(1), retentionSeconds: 60, unsupported: true }, 'unsupported property'],
    [{ source: sparseSource, retentionSeconds: 60 }, 'own data bytes'],
    [{ source: accessorSource, retentionSeconds: 60 }, 'own data bytes'],
    [{ source: Uint8Array.of(1), retentionSeconds: 60, mediaType: 1 }, 'mediaType'],
    [{ source: Uint8Array.of(1), retentionSeconds: 60, onCheckpoint: true }, 'onCheckpoint'],
    [{ source: Uint8Array.of(1), retentionSeconds: 60, signal: {} }, 'AbortSignal'],
    [
      {
        source: Uint8Array.of(1),
        retentionSeconds: 60,
        resume: { ...checkpoint, sessions: {} }
      },
      'invalid sessions'
    ],
    [
      {
        source: Uint8Array.of(1),
        retentionSeconds: 60,
        resume: { ...checkpoint, sessions: sparseSessions }
      },
      'dense data'
    ]
  ] as const

  for (const [options, message] of invalid) {
    await expect(uploader.publish(options as never)).rejects.toThrow(message)
  }
  expect(sourceAccesses).toBe(0)
  expect(requests).toBe(0)
})

test('rejects overlong resume upload identifiers without issuing requests', async () => {
  let requests = 0
  const uploader = new CHIRPUploader({
    wallet,
    storageURL: 'https://host.example',
    fetch: async () => {
      requests += 1
      return new Response(null, { status: 500 })
    }
  })
  await expect(
    uploader.publish({
      source: Uint8Array.of(1),
      retentionSeconds: 60,
      resume: {
        version: 1,
        retentionSeconds: '60',
        logicalLength: null,
        sessions: [
          {
            host: 'https://host.example',
            uploadId: 'x'.repeat(513),
            stagingExpiresAt: String(future)
          }
        ]
      }
    })
  ).rejects.toBeInstanceOf(CHIRPResilienceError)
  expect(requests).toBe(0)
})

function objectIdentifier(): string {
  return 'XUSvYkywHxEMvs7oiYYMV8bJ1sJjHq2mHgZvu8jSLyLhbNRVjG8E'
}
