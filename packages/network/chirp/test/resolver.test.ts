import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRP_CHUNK_SIZE,
  CHIRPDownloader,
  objectIdentifierForBytes
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
