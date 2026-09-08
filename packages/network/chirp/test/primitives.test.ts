import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRPError,
  CHIRPResilienceError,
  CHIRP_MAX_EXTENSION_BYTES,
  CHIRP_MAX_NODE_BYTES,
  MemoryCHIRPCache,
  bigEndian,
  chirpURLForIdentifier,
  concat,
  decodeCHIRPNode,
  decodeCompactSize,
  deriveCHIRPObjectURL,
  encodeBranchNode,
  encodeCompactSize,
  encodeRootNode,
  equalBytes,
  hashForObjectIdentifier,
  hashHex,
  isRootNode,
  mediaTypeExtension,
  mediaTypeFromRoot,
  objectIdentifierForBytes,
  objectIdentifierForHash,
  parseCHIRPURL,
  readBigEndian,
  sha256,
  toAsyncBytes,
  verifyObjectBytes
} from '../src/index.js'
import type { CHIRPByteSource, CHIRPChildReference, CHIRPExtension } from '../src/index.js'
import { CHIRP_OPENAPI_DOCUMENT } from '../src/openapi.js'

const HASH = new Uint8Array(32).fill(7)

function child(overrides: Partial<CHIRPChildReference> = {}): CHIRPChildReference {
  return { childKind: 0, logicalLength: 1n, objectHash: HASH, ...overrides }
}

function rootBytes(extensions: CHIRPExtension[] = []): Uint8Array {
  return encodeRootNode({
    chunkingProfile: 1,
    logicalLength: 0n,
    contentHash: sha256(new Uint8Array()),
    children: [],
    extensions
  })
}

async function collect(source: CHIRPByteSource): Promise<number[]> {
  const result: number[] = []
  for await (const bytes of toAsyncBytes(source)) result.push(...bytes)
  return result
}

describe('canonical binary primitives', () => {
  test.each([
    [0n, '00'],
    [252n, 'fc'],
    [253n, 'fdfd00'],
    [65_535n, 'fdffff'],
    [65_536n, 'fe00000100'],
    [0xffff_ffffn, 'feffffffff'],
    [0x1_0000_0000n, 'ff0000000001000000'],
    [0xffff_ffff_ffff_ffffn, 'ffffffffffffffffff']
  ])('encodes CompactSize %s minimally', (value, hexadecimal) => {
    const encoded = encodeCompactSize(value)
    expect(Buffer.from(encoded).toString('hex')).toBe(hexadecimal)
    expect(decodeCompactSize(concat(Uint8Array.of(9), encoded), 1)).toEqual({
      value,
      offset: encoded.byteLength + 1
    })
  })

  test('rejects out-of-range, truncated, and non-minimal CompactSize values', () => {
    expect(() => encodeCompactSize(-1n)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' })
    )
    expect(() => encodeCompactSize(0x1_0000_0000_0000_0000n)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' })
    )
    for (const bytes of [
      new Uint8Array(),
      Uint8Array.of(0xfd),
      Uint8Array.of(0xfe, 1),
      Uint8Array.of(0xff, 1, 2, 3)
    ]) {
      expect(() => decodeCompactSize(bytes)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_TRUNCATED' })
      )
    }
    for (const bytes of [
      Uint8Array.of(0xfd, 0xfc, 0),
      Uint8Array.of(0xfe, 0xff, 0xff, 0, 0),
      Uint8Array.of(0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0)
    ]) {
      expect(() => decodeCompactSize(bytes)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_COMPACT_SIZE_NON_MINIMAL' })
      )
    }
  })

  test('encodes and reads fixed-width big-endian integers', () => {
    const bytes = bigEndian(0x0102_0304n, 4)
    expect([...bytes]).toEqual([1, 2, 3, 4])
    expect(readBigEndian(concat(Uint8Array.of(0), bytes), 1, 4)).toBe(0x0102_0304n)
    expect(() => bigEndian(-1n, 2)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' })
    )
    expect(() => bigEndian(65_536n, 2)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' })
    )
    expect(() => readBigEndian(Uint8Array.of(1), 0, 2)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_TRUNCATED' })
    )
    expect([...concat(Uint8Array.of(1), Uint8Array.of(2, 3))]).toEqual([1, 2, 3])
  })
})

describe('hashes, identifiers, and URLs', () => {
  test('hashes incrementally and compares without length ambiguity', () => {
    const large = new Uint8Array(70_000).fill(9)
    const identifier = objectIdentifierForBytes(large)
    expect(objectIdentifierForHash(sha256(large))).toBe(identifier)
    expect(hashForObjectIdentifier(identifier)).toEqual(sha256(large))
    expect(hashHex(sha256(Uint8Array.of(1)))).toHaveLength(64)
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1))).toBe(true)
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(2))).toBe(false)
    expect(equalBytes(Uint8Array.of(1), Uint8Array.of(1, 2))).toBe(false)
    verifyObjectBytes(identifier, large)
    expect(() => verifyObjectBytes(identifier, Uint8Array.of(1))).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_OBJECT_HASH' })
    )
    expect(() => objectIdentifierForHash(new Uint8Array(31))).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_HASH_LENGTH' })
    )
    expect(() => hashForObjectIdentifier('not-an-identifier')).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_IDENTIFIER' })
    )
  })

  test('normalizes CHIRP URLs and derives only exact complete-host object paths', async () => {
    const identifier = (await new CHIRPBuilder().build(Uint8Array.of(1))).rootIdentifier
    expect(parseCHIRPURL(`CHIRP:${identifier}`)).toEqual({
      chirpURL: `chirp://${identifier}`,
      uhrpURL: `uhrp://${identifier}`,
      rootIdentifier: identifier
    })
    expect(chirpURLForIdentifier(identifier)).toBe(`chirp://${identifier}`)
    const advertised = `https://host.example/base/chirp/v1/${identifier}/objects/${identifier}`
    expect(deriveCHIRPObjectURL(advertised, identifier, 'object')).toBe(
      `https://host.example/base/chirp/v1/${identifier}/objects/object`
    )
    expect(
      deriveCHIRPObjectURL(
        `http://host.example/chirp/v1/${identifier}/objects/${identifier}`,
        identifier,
        'object',
        true
      )
    ).toContain('/objects/object')

    for (const value of [null, '', 'chirp://bad', `chirp://${identifier}/extra`]) {
      expect(() => parseCHIRPURL(value as unknown as string)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_URL' })
      )
    }
    expect(() => chirpURLForIdentifier('bad')).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_IDENTIFIER' })
    )
    for (const value of [
      'not a url',
      `ftp://host.example/chirp/v1/${identifier}/objects/${identifier}`,
      `http://host.example/chirp/v1/${identifier}/objects/${identifier}`,
      `https://user@host.example/chirp/v1/${identifier}/objects/${identifier}`,
      `https://host.example/chirp/v1/${identifier}/objects/${identifier}?query=1`,
      `https://host.example/chirp/v1/${identifier}/objects/${identifier}#fragment`,
      `https://host.example/not-chirp/${identifier}`
    ]) {
      expect(() => deriveCHIRPObjectURL(value, identifier, 'object')).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_HOST_URL' })
      )
    }
  })
})

describe('byte sources and bounded cache', () => {
  test('adapts arrays, blobs, streams, and async iterables without empty chunks', async () => {
    expect(await collect([])).toEqual([])
    expect(await collect([1, 2])).toEqual([1, 2])
    expect(await collect(new Uint8Array())).toEqual([])
    expect(await collect(Uint8Array.of(3))).toEqual([3])
    expect(await collect(new Blob([Uint8Array.of(4, 5)]))).toEqual([4, 5])
    expect(
      await collect(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array())
            controller.enqueue(Uint8Array.of(6))
            controller.close()
          }
        })
      )
    ).toEqual([6])
    expect(
      await collect(
        (async function* () {
          yield new Uint8Array()
          yield Uint8Array.of(7)
        })()
      )
    ).toEqual([7])
  })

  test('rejects unsupported and non-byte source chunks', async () => {
    await expect(collect({} as CHIRPByteSource)).rejects.toMatchObject({ code: 'ERR_CHIRP_SOURCE' })
    await expect(
      collect(
        (async function* () {
          yield 'bad' as unknown as Uint8Array
        })()
      )
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_SOURCE' })
    await expect(
      collect(
        new ReadableStream({
          start(controller) {
            controller.enqueue('bad' as unknown as Uint8Array)
            controller.close()
          }
        })
      )
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_SOURCE' })
  })

  test('copies, updates, and evicts cache entries within both bounds', () => {
    expect(() => new MemoryCHIRPCache(-1, 1)).toThrow('maxBytes')
    expect(() => new MemoryCHIRPCache(1, -1)).toThrow('maxEntries')
    expect(() => new MemoryCHIRPCache(1.5, 1)).toThrow('maxBytes')
    const cache = new MemoryCHIRPCache(3, 2)
    const original = Uint8Array.of(1)
    cache.set('a', original)
    original[0] = 9
    expect(cache.get('a')).toEqual(Uint8Array.of(1))
    const copy = cache.get('a')
    copy?.fill(8)
    expect(cache.get('a')).toEqual(Uint8Array.of(1))
    cache.set('a', Uint8Array.of(2, 2))
    cache.set('b', Uint8Array.of(3, 3))
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toEqual(Uint8Array.of(3, 3))
    cache.set('too-large', new Uint8Array(4))
    expect(cache.get('too-large')).toBeUndefined()
    const disabled = new MemoryCHIRPCache(10, 0)
    disabled.set('x', Uint8Array.of(1))
    expect(disabled.get('x')).toBeUndefined()
  })
})

describe('node codec validation', () => {
  test('round-trips branches and exposes root media types', async () => {
    const leaf = child()
    const branch = decodeCHIRPNode(
      encodeBranchNode({ logicalLength: 1n, children: [leaf], extensions: [] })
    )
    expect(branch.nodeKind).toBe(1)
    expect(isRootNode(branch)).toBe(false)
    const built = await new CHIRPBuilder().build(Uint8Array.of(1), { mediaType: 'text/plain' })
    expect(isRootNode(built.root)).toBe(true)
    expect(mediaTypeFromRoot(built.root)).toBe('text/plain')
    expect(mediaTypeFromRoot({ ...built.root, extensions: [] })).toBeNull()
    expect(new TextDecoder().decode(mediaTypeExtension('TEXT/PLAIN').value)).toBe('text/plain')
  })

  test('rejects invalid root and branch construction', () => {
    const validRoot = {
      chunkingProfile: 1,
      logicalLength: 1n,
      contentHash: HASH,
      children: [child()],
      extensions: []
    }
    for (const chunkingProfile of [0, 1.5, 65_536]) {
      expect(() => encodeRootNode({ ...validRoot, chunkingProfile })).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_PROFILE' })
      )
    }
    expect(() => encodeRootNode({ ...validRoot, contentHash: new Uint8Array(31) })).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_HASH_LENGTH' })
    )
    expect(() => encodeRootNode({ ...validRoot, logicalLength: 2n })).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_LENGTH' })
    )
    expect(() =>
      encodeRootNode({ ...validRoot, children: Array.from({ length: 257 }, () => child()) })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_FANOUT' }))
    expect(() =>
      encodeRootNode({ ...validRoot, children: [child({ childKind: 2 as 0 })] })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_CHILD_KIND' }))
    expect(() =>
      encodeRootNode({ ...validRoot, children: [child({ logicalLength: -1n })] })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' }))
    expect(() => encodeBranchNode({ logicalLength: 0n, children: [], extensions: [] })).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_FANOUT' })
    )
    expect(() =>
      encodeBranchNode({ logicalLength: 2n, children: [child()], extensions: [] })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_LENGTH' }))
  })

  test('rejects malformed extensions, media types, and node framing', () => {
    for (const extensions of [
      [
        { type: 3n, value: new Uint8Array() },
        { type: 3n, value: new Uint8Array() }
      ],
      [{ type: 0n, value: new Uint8Array() }],
      [{ type: 2n, value: new Uint8Array() }],
      [{ type: 3n, value: new Uint8Array(CHIRP_MAX_EXTENSION_BYTES + 1) }]
    ]) {
      expect(() => rootBytes(extensions)).toThrow(CHIRPError)
    }
    expect(() =>
      encodeBranchNode({
        logicalLength: 1n,
        children: [child()],
        extensions: [{ type: 1n, value: new TextEncoder().encode('text/plain') }]
      })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_NODE' }))
    for (const mediaType of ['', 'x', 'text/plain; charset=utf-8', 'text/\u0001plain']) {
      expect(() => mediaTypeExtension(mediaType)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_MEDIA_TYPE' })
      )
    }
    expect(() => rootBytes([{ type: 1n, value: Uint8Array.of(0xff, 0xff, 0xff) }])).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_MEDIA_TYPE' })
    )

    const valid = rootBytes()
    const wrongMagic = valid.slice()
    wrongMagic[0] = 0
    const wrongKind = valid.slice()
    wrongKind[7] = 2
    for (const [bytes, code] of [
      [wrongMagic, 'ERR_CHIRP_MAGIC'],
      [wrongKind, 'ERR_CHIRP_NODE_KIND'],
      [concat(valid, Uint8Array.of(0)), 'ERR_CHIRP_TRAILING_BYTES'],
      [new Uint8Array(CHIRP_MAX_NODE_BYTES + 1), 'ERR_CHIRP_NODE_SIZE'],
      [valid.slice(0, -1), 'ERR_CHIRP_TRUNCATED']
    ] as const) {
      expect(() => decodeCHIRPNode(bytes)).toThrow(expect.objectContaining({ code }))
    }
    const excessiveExtensions = concat(valid.slice(0, -1), encodeCompactSize(1025n))
    expect(() => decodeCHIRPNode(excessiveExtensions)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_COUNT' })
    )
  })

  test('exposes the complete-host OpenAPI contract and resilience evidence', () => {
    expect(CHIRP_OPENAPI_DOCUMENT.openapi).toBe('3.1.0')
    expect(CHIRP_OPENAPI_DOCUMENT.paths['/chirp/v1/uploads'].post.responses['201']).toBeDefined()
    const error = new CHIRPResilienceError(3, 1)
    expect(error).toMatchObject({
      name: 'CHIRPResilienceError',
      code: 'ERR_CHIRP_RESILIENCE',
      requiredHosts: 3,
      successfulHosts: 1
    })
  })
})
