import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRPDownloader,
  CHIRP_MAX_NODE_BYTES,
  MemoryCHIRPCache,
  encodeBranchNode,
  encodeRootNode,
  objectIdentifierForBytes,
  sha256
} from '../src/index.js'
import type { CHIRPChildReference, CHIRPObjectCache } from '../src/index.js'

type Objects = Map<string, Uint8Array>

async function build(
  source: Uint8Array,
  mediaType?: string
): Promise<{ objects: Objects; rootIdentifier: string; chirpURL: string }> {
  const objects = new Map<string, Uint8Array>()
  const result = await new CHIRPBuilder().build(source, {
    mediaType,
    sink: {
      async putObject(identifier, bytes) {
        objects.set(identifier, bytes.slice())
      }
    }
  })
  return { objects, rootIdentifier: result.rootIdentifier, chirpURL: result.chirpURL }
}

function rootLocation(rootIdentifier: string, host = 'https://host.example'): string {
  return `${host}/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`
}

function objectResponse(bytes: Uint8Array, headers: Record<string, string> = {}): Response {
  return new Response(bytes, {
    status: 200,
    headers: { 'Content-Length': String(bytes.byteLength), ...headers }
  })
}

function objectFetcher(objects: Objects): typeof fetch {
  return async input => {
    const identifier = new URL(String(input)).pathname.split('/').at(-1) as string
    const bytes = objects.get(identifier)
    return bytes == null ? new Response(null, { status: 404 }) : objectResponse(bytes)
  }
}

function put(objects: Objects, bytes: Uint8Array): string {
  const identifier = objectIdentifierForBytes(bytes)
  objects.set(identifier, bytes)
  return identifier
}

function reference(bytes: Uint8Array, childKind: 0 | 1, length: bigint): CHIRPChildReference {
  return { childKind, logicalLength: length, objectHash: sha256(bytes) }
}

function manualRoot(
  objects: Objects,
  children: CHIRPChildReference[],
  contentHash: Uint8Array,
  logicalLength: bigint,
  profile = 2
): string {
  return put(
    objects,
    encodeRootNode({
      chunkingProfile: profile,
      logicalLength,
      contentHash,
      children,
      extensions: []
    })
  )
}

describe('resolver host and response validation', () => {
  test('rejects invalid numeric configuration', () => {
    const configurations = [
      { concurrency: 0 },
      { concurrency: 1.5 },
      { retriesPerObject: 0 },
      { maxObjects: 0 },
      { maxDownloadBytes: 0 },
      { requestTimeoutMs: 0 },
      { resolutionTimeoutMs: 600_001 }
    ]
    for (const config of configurations) {
      expect(() => new CHIRPDownloader({ resolve: async () => [], ...config })).toThrow(RangeError)
    }
    expect(() => new CHIRPDownloader()).not.toThrow()
  })

  test('filters malformed or incomplete advertisements and requires one complete host', async () => {
    const built = await build(Uint8Array.of(1))
    const downloader = new CHIRPDownloader({
      resolve: async () => [
        'not a URL',
        rootLocation(built.rootIdentifier, 'http://host.example'),
        `https://host.example/not-chirp/${built.rootIdentifier}`
      ]
    })
    await expect(downloader.inspect(built.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_NO_HOSTS'
    })
  })

  test('rejects branch roots and configured logical-length overflow', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(1)
    put(objects, blob)
    const branchBytes = encodeBranchNode({
      logicalLength: 1n,
      children: [reference(blob, 0, 1n)],
      extensions: []
    })
    const branchIdentifier = put(objects, branchBytes)
    const branchDownloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(branchIdentifier)],
      fetch: objectFetcher(objects)
    })
    await expect(branchDownloader.inspect(`chirp://${branchIdentifier}`)).rejects.toMatchObject({
      code: 'ERR_CHIRP_ROOT_KIND'
    })

    const built = await build(Uint8Array.of(1))
    const limited = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      fetch: objectFetcher(built.objects),
      maxLogicalLength: 0n
    })
    await expect(limited.inspect(built.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_LOGICAL_LIMIT'
    })
  })

  test.each([
    'http-status',
    'empty-body',
    'encoding',
    'missing-length',
    'invalid-length',
    'declared-too-large',
    'body-too-short',
    'body-too-long',
    'corrupt'
  ])('fails closed on invalid host response: %s', async kind => {
    const built = await build(Uint8Array.of(1))
    const rootBytes = built.objects.get(built.rootIdentifier) as Uint8Array
    const downloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      retriesPerObject: 1,
      fetch: async () => {
        if (kind === 'http-status') return new Response(null, { status: 404 })
        if (kind === 'empty-body') return new Response(null, { status: 200 })
        if (kind === 'encoding') return objectResponse(rootBytes, { 'Content-Encoding': 'gzip' })
        if (kind === 'missing-length') return new Response(rootBytes, { status: 200 })
        if (kind === 'invalid-length') {
          return new Response(rootBytes, { status: 200, headers: { 'Content-Length': 'x' } })
        }
        if (kind === 'declared-too-large') {
          return new Response(rootBytes, {
            status: 200,
            headers: { 'Content-Length': String(CHIRP_MAX_NODE_BYTES + 1) }
          })
        }
        if (kind === 'body-too-short') {
          return new Response(rootBytes, {
            status: 200,
            headers: { 'Content-Length': String(rootBytes.byteLength + 1) }
          })
        }
        if (kind === 'body-too-long') {
          return new Response(rootBytes, {
            status: 200,
            headers: { 'Content-Length': String(rootBytes.byteLength - 1) }
          })
        }
        return objectResponse(Uint8Array.of(9))
      }
    })
    await expect(downloader.inspect(built.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_FETCH'
    })
  })

  test('applies caller URL policy and rejects private literals by default', async () => {
    const built = await build(Uint8Array.of(1))
    const custom = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      urlPolicy: () => {
        throw new Error('policy rejected')
      }
    })
    await expect(custom.inspect(built.chirpURL)).rejects.toMatchObject({ code: 'ERR_CHIRP_FETCH' })

    for (const host of [
      'https://localhost',
      'https://name.localhost',
      'https://0.0.0.0',
      'https://10.0.0.1',
      'https://127.0.0.1',
      'https://169.254.1.1',
      'https://172.16.0.1',
      'https://192.168.0.1',
      'https://224.0.0.1',
      'https://[::]',
      'https://[::1]',
      'https://[fc00::1]',
      'https://[fd00::1]',
      'https://[fe80::1]',
      'https://[::ffff:127.0.0.1]'
    ]) {
      const downloader = new CHIRPDownloader({
        resolve: async () => [rootLocation(built.rootIdentifier, host)],
        fetch: objectFetcher(built.objects),
        retriesPerObject: 1
      })
      await expect(downloader.inspect(built.chirpURL)).rejects.toMatchObject({
        code: 'ERR_CHIRP_FETCH'
      })
    }
  })

  test('allows explicit insecure development hosts and verified cache hits', async () => {
    const built = await build(Uint8Array.of(1))
    const cache = new MemoryCHIRPCache()
    const rootBytes = built.objects.get(built.rootIdentifier) as Uint8Array
    cache.set(built.rootIdentifier, rootBytes)
    let fetches = 0
    const downloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier, 'http://127.0.0.1')],
      allowInsecureHTTP: true,
      urlPolicy: () => {},
      cache,
      fetch: async () => {
        fetches += 1
        return new Response(null, { status: 500 })
      }
    })
    expect((await downloader.inspect(built.chirpURL)).rootIdentifier).toBe(built.rootIdentifier)
    expect(fetches).toBe(0)
  })

  test('verifies cached bytes and enforces cached object bounds', async () => {
    const built = await build(Uint8Array.of(1))
    const corruptCache: CHIRPObjectCache = {
      get: () => Uint8Array.of(9),
      set: () => {}
    }
    const corrupt = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      cache: corruptCache
    })
    await expect(corrupt.inspect(built.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_OBJECT_HASH'
    })

    const oversized = new Uint8Array(CHIRP_MAX_NODE_BYTES + 1)
    const oversizedIdentifier = objectIdentifierForBytes(oversized)
    const oversizedCache: CHIRPObjectCache = { get: () => oversized, set: () => {} }
    const limited = new CHIRPDownloader({
      resolve: async () => [rootLocation(oversizedIdentifier)],
      cache: oversizedCache
    })
    await expect(limited.inspect(`chirp://${oversizedIdentifier}`)).rejects.toMatchObject({
      code: 'ERR_CHIRP_OBJECT_SIZE'
    })
  })

  test('bounds resolution and object request duration', async () => {
    const built = await build(Uint8Array.of(1))
    const resolution = new CHIRPDownloader({
      resolve: async () => await new Promise<string[]>(() => {}),
      resolutionTimeoutMs: 5
    })
    await expect(resolution.inspect(built.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_TIMEOUT'
    })

    const request = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      requestTimeoutMs: 5,
      retriesPerObject: 1,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
    })
    await expect(request.inspect(built.chirpURL)).rejects.toMatchObject({ code: 'ERR_CHIRP_FETCH' })
  })
})

describe('resolver traversal, range, and terminal integrity', () => {
  test('returns media type, future-profile status, empty content, and explicit empty ranges', async () => {
    const typed = await build(Uint8Array.of(1, 2), 'application/octet-stream')
    const downloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(typed.rootIdentifier)],
      fetch: objectFetcher(typed.objects)
    })
    const result = await downloader.download(typed.chirpURL)
    expect(result).toMatchObject({ mediaType: 'application/octet-stream', profileCanonical: true })
    expect([...result.data]).toEqual([1, 2])
    const emptyChunks = []
    for await (const chunk of downloader.stream(typed.chirpURL, {
      range: { start: 1n, endExclusive: 1n }
    })) {
      emptyChunks.push(chunk)
    }
    expect(emptyChunks).toEqual([])

    const empty = await build(new Uint8Array())
    const emptyDownloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(empty.rootIdentifier)],
      fetch: objectFetcher(empty.objects)
    })
    expect((await emptyDownloader.download(empty.chirpURL)).data).toHaveLength(0)
  })

  test.each([
    { start: -1n, endExclusive: 0n },
    { start: 1n, endExclusive: 0n },
    { start: 0n, endExclusive: 2n }
  ])('rejects invalid logical range %#', async range => {
    const built = await build(Uint8Array.of(1))
    const downloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      fetch: objectFetcher(built.objects)
    })
    await expect(downloader.download(built.chirpURL, { range })).rejects.toMatchObject({
      code: 'ERR_CHIRP_RANGE'
    })
  })

  test('enforces atomic download and per-call concurrency limits', async () => {
    const built = await build(Uint8Array.of(1, 2))
    const limited = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      fetch: objectFetcher(built.objects),
      maxDownloadBytes: 1
    })
    await expect(limited.download(built.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_DOWNLOAD_LIMIT'
    })
    const downloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      fetch: objectFetcher(built.objects)
    })
    await expect(async () => {
      for await (const _chunk of downloader.stream(built.chirpURL, { concurrency: 0 })) {
        // No chunk is expected.
      }
    }).rejects.toBeInstanceOf(RangeError)
  })

  test('rejects terminal contentHash and referenced blob-length mismatches', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(1)
    put(objects, blob)
    const wrongHash = manualRoot(objects, [reference(blob, 0, 1n)], new Uint8Array(32), 1n)
    const hashDownloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(wrongHash)],
      fetch: objectFetcher(objects)
    })
    await expect(hashDownloader.download(`chirp://${wrongHash}`)).rejects.toMatchObject({
      code: 'ERR_CHIRP_CONTENT_HASH'
    })

    const wrongLength = manualRoot(objects, [reference(blob, 0, 2n)], sha256(blob), 2n)
    const lengthDownloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(wrongLength)],
      fetch: objectFetcher(objects)
    })
    await expect(lengthDownloader.download(`chirp://${wrongLength}`)).rejects.toMatchObject({
      code: 'ERR_CHIRP_LENGTH'
    })
  })

  test('rejects branch kind, branch length, object-count, and depth violations', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(1)
    put(objects, blob)
    const nestedRootBytes = encodeRootNode({
      chunkingProfile: 2,
      logicalLength: 1n,
      contentHash: sha256(blob),
      children: [reference(blob, 0, 1n)],
      extensions: []
    })
    put(objects, nestedRootBytes)
    const wrongKind = manualRoot(objects, [reference(nestedRootBytes, 1, 1n)], sha256(blob), 1n)

    const branchBytes = encodeBranchNode({
      logicalLength: 1n,
      children: [reference(blob, 0, 1n)],
      extensions: []
    })
    put(objects, branchBytes)
    const wrongLength = manualRoot(objects, [reference(branchBytes, 1, 2n)], sha256(blob), 2n)

    for (const [identifier, code] of [
      [wrongKind, 'ERR_CHIRP_BRANCH'],
      [wrongLength, 'ERR_CHIRP_BRANCH']
    ]) {
      const downloader = new CHIRPDownloader({
        resolve: async () => [rootLocation(identifier)],
        fetch: objectFetcher(objects)
      })
      await expect(downloader.download(`chirp://${identifier}`)).rejects.toMatchObject({ code })
    }

    const oneObject = await build(Uint8Array.of(1))
    const objectLimited = new CHIRPDownloader({
      resolve: async () => [rootLocation(oneObject.rootIdentifier)],
      fetch: objectFetcher(oneObject.objects),
      maxObjects: 1
    })
    await expect(objectLimited.download(oneObject.chirpURL)).rejects.toMatchObject({
      code: 'ERR_CHIRP_OBJECT_LIMIT'
    })

    let nested = reference(blob, 0, 1n)
    for (let depth = 0; depth < 17; depth += 1) {
      const bytes = encodeBranchNode({ logicalLength: 1n, children: [nested], extensions: [] })
      put(objects, bytes)
      nested = reference(bytes, 1, 1n)
    }
    const tooDeep = manualRoot(objects, [nested], sha256(blob), 1n)
    const depthLimited = new CHIRPDownloader({
      resolve: async () => [rootLocation(tooDeep)],
      fetch: objectFetcher(objects)
    })
    await expect(depthLimited.download(`chirp://${tooDeep}`)).rejects.toMatchObject({
      code: 'ERR_CHIRP_DEPTH'
    })
  })

  test('propagates abort reasons after streaming has started', async () => {
    const built = await build(new Uint8Array(4_194_305).fill(1))
    const controller = new AbortController()
    const downloader = new CHIRPDownloader({
      resolve: async () => [rootLocation(built.rootIdentifier)],
      fetch: objectFetcher(built.objects)
    })
    const iterator = downloader.stream(built.chirpURL, { signal: controller.signal })
    expect((await iterator.next()).done).toBe(false)
    controller.abort('stop')
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' })
  })
})
