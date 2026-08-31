import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRP_CHUNK_SIZE,
  CHIRPDownloader,
  encodeRootNode,
  objectIdentifierForBytes,
  sha256
} from '../src/index.js'

describe('interleaved CHIRP resolution', () => {
  test('retries corruption at another host and returns a verified logical range', async () => {
    const source = new Uint8Array(CHIRP_CHUNK_SIZE + 7)
    source.fill(0x61)
    source.fill(0x62, CHIRP_CHUNK_SIZE)
    const objects = new Map<string, Uint8Array>()
    const built = await new CHIRPBuilder().build(source, {
      sink: {
        async putObject(identifier, bytes) {
          objects.set(identifier, bytes.slice())
        }
      }
    })
    const rootPath = `/chirp/v1/${built.rootIdentifier}/objects/${built.rootIdentifier}`
    const locations = [`https://a.example${rootPath}`, `https://b.example${rootPath}`]
    const calls: string[] = []
    const fetcher: typeof fetch = async input => {
      const url = String(input)
      calls.push(url)
      const identifier = new URL(url).pathname.split('/').at(-1) as string
      let bytes = objects.get(identifier)
      if (bytes == null) return new Response(null, { status: 404 })
      if (new URL(url).origin === 'https://a.example' && identifier !== built.rootIdentifier) {
        bytes = new TextEncoder().encode('corrupt')
      }
      return new Response(bytes, {
        status: 200,
        headers: { 'Content-Length': String(bytes.byteLength) }
      })
    }
    const downloader = new CHIRPDownloader({
      resolve: async () => locations,
      fetch: fetcher,
      concurrency: 2
    })
    const result = await downloader.download(built.chirpURL, {
      range: {
        start: BigInt(CHIRP_CHUNK_SIZE - 3),
        endExclusive: BigInt(CHIRP_CHUNK_SIZE + 7)
      }
    })
    expect(new TextDecoder().decode(result.data)).toBe('aaabbbbbbb')
    expect(
      calls.filter(
        url => new URL(url).origin === 'https://a.example' && !url.endsWith(built.rootIdentifier)
      )
    ).toHaveLength(1)
    expect(
      calls.filter(
        url => new URL(url).origin === 'https://b.example' && !url.endsWith(built.rootIdentifier)
      )
    ).toHaveLength(2)
    expect(objectIdentifierForBytes(built.rootBytes)).toBe(built.rootIdentifier)
    expect(result.profileCanonical).toBe(false)
  })

  test('accepts streamed responses without Content-Length and validates profile 1 construction', async () => {
    const objects = new Map<string, Uint8Array>()
    const built = await new CHIRPBuilder().build(new TextEncoder().encode('streamed'), {
      sink: {
        async putObject(identifier, bytes) {
          objects.set(identifier, bytes.slice())
        }
      }
    })
    const rootPath = `/chirp/v1/${built.rootIdentifier}/objects/${built.rootIdentifier}`
    const downloader = new CHIRPDownloader({
      resolve: async () => [`https://cdn.example${rootPath}`],
      fetch: async input => {
        const identifier = new URL(String(input)).pathname.split('/').at(-1) as string
        const bytes = objects.get(identifier)
        return bytes == null ? new Response(null, { status: 404 }) : new Response(bytes)
      }
    })
    const result = await downloader.download(built.chirpURL)
    expect(new TextDecoder().decode(result.data)).toBe('streamed')
    expect(result.profileCanonical).toBe(true)
  })

  test('rejects an oversized profile 1 leaf before fetching it for a tiny range', async () => {
    const blob = Uint8Array.of(0x01)
    const rootBytes = encodeRootNode({
      chunkingProfile: 1,
      logicalLength: BigInt(CHIRP_CHUNK_SIZE + 1),
      contentHash: sha256(blob),
      children: [
        {
          childKind: 0,
          logicalLength: BigInt(CHIRP_CHUNK_SIZE + 1),
          objectHash: sha256(blob)
        }
      ],
      extensions: []
    })
    const rootIdentifier = objectIdentifierForBytes(rootBytes)
    const rootPath = `/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`
    const calls: string[] = []
    const downloader = new CHIRPDownloader({
      resolve: async () => [`https://host.example${rootPath}`],
      fetch: async input => {
        calls.push(String(input))
        return new Response(rootBytes)
      },
      maxDownloadBytes: 1
    })
    await expect(
      downloader.download(`chirp://${rootIdentifier}`, {
        range: { start: 0n, endExclusive: 1n }
      })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_SIZE' })
    expect(calls).toHaveLength(1)
  })

  test('applies a finite configured object ceiling to unknown profiles', async () => {
    const blob = new Uint8Array(65).fill(0x02)
    const rootBytes = encodeRootNode({
      chunkingProfile: 2,
      logicalLength: BigInt(blob.byteLength),
      contentHash: sha256(blob),
      children: [
        {
          childKind: 0,
          logicalLength: BigInt(blob.byteLength),
          objectHash: sha256(blob)
        }
      ],
      extensions: []
    })
    const rootIdentifier = objectIdentifierForBytes(rootBytes)
    const rootPath = `/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`
    const downloader = new CHIRPDownloader({
      resolve: async () => [`https://host.example${rootPath}`],
      fetch: async () => new Response(rootBytes),
      maxObjectBytes: 64
    })
    await expect(
      downloader.download(`chirp://${rootIdentifier}`, {
        range: { start: 0n, endExclusive: 1n }
      })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_SIZE' })
  })

  test('honors cancellation before scheduling network work', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    const downloader = new CHIRPDownloader({ resolve: async () => [] })
    await expect(async () => {
      for await (const _chunk of downloader.stream(
        'chirp://XUSvYkywHxEMvs7oiYYMV8bJ1sJjHq2mHgZvu8jSLyLhbNRVjG8E',
        { signal: controller.signal }
      )) {
        // No chunks are expected.
      }
    }).rejects.toThrow('cancelled')
  })
})
