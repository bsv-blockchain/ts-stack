import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, jest, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRPError,
  CHIRP_MAGIC,
  CHIRPResilienceError,
  CHIRP_MAX_EXTENSION_BYTES,
  CHIRP_MAX_NODE_BYTES,
  MemoryCHIRPCache,
  bigEndian,
  buildBranchLevels,
  chirpURLForIdentifier,
  concat,
  createSHA256,
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
  sumLogicalLength,
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

async function collect(source: CHIRPByteSource, signal?: AbortSignal): Promise<number[]> {
  const result: number[] = []
  for await (const bytes of toAsyncBytes(source, signal)) result.push(...bytes)
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
    for (const width of [0, 9, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => bigEndian(0n, width)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' })
      )
      expect(() => readBigEndian(Uint8Array.of(1), 0, width)).toThrow(TypeError)
    }
    expect(() => decodeCompactSize('bytes' as unknown as Uint8Array)).toThrow(TypeError)
    expect([...concat(Uint8Array.of(1), Uint8Array.of(2, 3))]).toEqual([1, 2, 3])
  })

  test('rejects invalid concat parts and unsafe aggregate lengths', () => {
    expect(() => concat(Uint8Array.of(1), [] as unknown as Uint8Array)).toThrow(
      'concat requires Uint8Array parts.'
    )

    const maximumSafeLength = new Uint8Array()
    Object.defineProperty(maximumSafeLength, 'byteLength', {
      value: Number.MAX_SAFE_INTEGER
    })
    expect(() => concat(maximumSafeLength, Uint8Array.of(1))).toThrow(
      'Concatenated byte length is too large.'
    )
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
    const incremental = createSHA256()
    incremental.update(Uint8Array.of(1))
    const digest = incremental.digest()
    digest.fill(0)
    expect(incremental.digest()).toEqual(sha256(Uint8Array.of(1)))
    expect(() => incremental.update(Uint8Array.of(2))).toThrow('finalized')
    expect(() => sha256('bytes' as unknown as Uint8Array)).toThrow('Uint8Array')
  })

  test('normalizes CHIRP URLs and derives only exact complete-host object paths', async () => {
    const identifier = (await new CHIRPBuilder().build(Uint8Array.of(1))).rootIdentifier
    const objectIdentifier = objectIdentifierForBytes(Uint8Array.of(2))
    expect(parseCHIRPURL(`CHIRP:${identifier}`)).toEqual({
      chirpURL: `chirp://${identifier}`,
      uhrpURL: `uhrp://${identifier}`,
      rootIdentifier: identifier
    })
    expect(chirpURLForIdentifier(identifier)).toBe(`chirp://${identifier}`)
    const advertised = `https://host.example/base/chirp/v1/${identifier}/objects/${identifier}`
    expect(deriveCHIRPObjectURL(advertised, identifier, objectIdentifier)).toBe(
      `https://host.example/base/chirp/v1/${identifier}/objects/${objectIdentifier}`
    )
    expect(
      deriveCHIRPObjectURL(
        `http://host.example/chirp/v1/${identifier}/objects/${identifier}`,
        identifier,
        objectIdentifier,
        true
      )
    ).toContain(`/objects/${objectIdentifier}`)

    for (const value of [null, '', 'chirp://bad', `chirp://${identifier}/extra`]) {
      expect(() => parseCHIRPURL(value as unknown as string)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_URL' })
      )
    }
    expect(() => chirpURLForIdentifier('bad')).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_IDENTIFIER' })
    )
    for (const object of ['object', '../admin', `${objectIdentifier}?admin=1`]) {
      expect(() => deriveCHIRPObjectURL(advertised, identifier, object)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_IDENTIFIER' })
      )
    }
    for (const value of [
      'not a url',
      `ftp://host.example/chirp/v1/${identifier}/objects/${identifier}`,
      `http://host.example/chirp/v1/${identifier}/objects/${identifier}`,
      `https://user@host.example/chirp/v1/${identifier}/objects/${identifier}`,
      `https://host.example/chirp/v1/${identifier}/objects/${identifier}?query=1`,
      `https://host.example/chirp/v1/${identifier}/objects/${identifier}#fragment`,
      `https://host.example/not-chirp/${identifier}`
    ]) {
      expect(() => deriveCHIRPObjectURL(value, identifier, objectIdentifier)).toThrow(
        expect.objectContaining({ code: 'ERR_CHIRP_HOST_URL' })
      )
    }
  })
})

describe('byte sources and bounded cache', () => {
  test('snapshots build inputs and never shares verified result buffers with sinks', async () => {
    const source = Uint8Array.of(1, 2, 3)
    let calls = 0
    const sink = {
      async putObject(_identifier: string, bytes: Uint8Array) {
        calls += 1
        bytes.fill(0)
      }
    }
    const options = { mediaType: 'application/octet-stream', sink }
    const pending = new CHIRPBuilder().build(source, options)
    source.fill(9)
    options.mediaType = 'text/plain'
    sink.putObject = async () => {
      throw new Error('mutated sink method was used')
    }
    const result = await pending
    expect(calls).toBeGreaterThan(0)
    expect(result.logicalLength).toBe(3n)
    expect(result.contentHash).toEqual(sha256(Uint8Array.of(1, 2, 3)))
    expect(objectIdentifierForBytes(result.rootBytes)).toBe(result.rootIdentifier)
    expect(mediaTypeFromRoot(result.root)).toBe('application/octet-stream')
  })

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

  test('does not wait on a hostile iterator return and swallows its throw and rejection', async () => {
    const sourceText = readFileSync(join(process.cwd(), 'src/sources.ts'), 'utf8')
    const generator = sourceText.slice(sourceText.indexOf('async function* asyncIterableBytes'))
    expect(generator).not.toContain('iterator.return()')
    expect(generator).toContain('iteratorReturnValue(iterator)')

    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => {
      rejections.push(reason)
    }
    process.on('unhandledRejection', onRejection)
    try {
      const cancelled = async (finish: () => unknown): Promise<void> => {
        const controller = new AbortController()
        const source = {
          [Symbol.asyncIterator]() {
            return {
              next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
              return: finish
            }
          }
        }
        const pending = collect(source as CHIRPByteSource, controller.signal)
        controller.abort()
        const outcome = await Promise.race([
          pending.then(
            () => 'resolved',
            (error: unknown) => error
          ),
          new Promise(resolve => setTimeout(() => resolve('waited'), 50))
        ])
        expect(outcome).not.toBe('waited')
        const error = outcome as { name?: string; message?: string }
        expect(error.name === 'AbortError' || /abort/i.test(error.message ?? '')).toBe(true)
        expect(error.message ?? '').not.toMatch(/hostile/)
      }

      let syncCalled = false
      await cancelled(() => {
        syncCalled = true
        throw new Error('hostile-sync')
      })
      expect(syncCalled).toBe(true)

      let asyncCalled = false
      await cancelled(() => {
        asyncCalled = true
        return Promise.reject(new Error('hostile-async'))
      })
      expect(asyncCalled).toBe(true)
      await new Promise(resolve => setImmediate(resolve))
      expect(rejections).toEqual([])
    } finally {
      process.off('unhandledRejection', onRejection)
    }
  })

  test('rejects unsupported and non-byte source chunks', async () => {
    await expect(collect({} as CHIRPByteSource)).rejects.toMatchObject({ code: 'ERR_CHIRP_SOURCE' })
    const sparse: number[] = []
    sparse.length = 1
    for (const source of [[-1], [256], [1.5], [Number.NaN], sparse]) {
      await expect(collect(source as number[])).rejects.toMatchObject({ code: 'ERR_CHIRP_SOURCE' })
    }
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

    let accesses = 0
    const accessorArray = [1]
    Object.defineProperty(accessorArray, '0', {
      enumerable: true,
      get() {
        accesses += 1
        return 1
      }
    })
    await expect(collect(accessorArray)).rejects.toMatchObject({ code: 'ERR_CHIRP_SOURCE' })
    expect(accesses).toBe(0)
  })

  test('rejects hostile build option and source snapshots before invoking a sink', async () => {
    const putObject = jest.fn(async () => {})
    const sink = { putObject }
    let optionAccesses = 0
    const accessorOptions = Object.defineProperty({ sink }, 'mediaType', {
      enumerable: true,
      get() {
        optionAccesses += 1
        return 'text/plain'
      }
    })
    const invalidOptions = [
      null,
      [],
      Object.create({ inherited: true }),
      { unsupported: true, sink },
      accessorOptions,
      { mediaType: 1, sink },
      { signal: {}, sink },
      { sink: 1 }
    ]
    for (const options of invalidOptions) {
      await expect(new CHIRPBuilder().build(Uint8Array.of(1), options as never)).rejects.toThrow()
    }
    expect(optionAccesses).toBe(0)

    let sourceAccesses = 0
    const accessorSource = [1]
    Object.defineProperty(accessorSource, '0', {
      enumerable: true,
      get() {
        sourceAccesses += 1
        return 1
      }
    })
    await expect(new CHIRPBuilder().build(accessorSource, { sink })).rejects.toThrow(
      'own data properties'
    )
    expect(sourceAccesses).toBe(0)
    expect(putObject).not.toHaveBeenCalled()
  })

  test.each([new Error('sink stopped'), 'sink stopped'])(
    'preserves an abort raised synchronously by the sink: %#',
    async reason => {
      const controller = new AbortController()
      const pending = new CHIRPBuilder().build(Uint8Array.of(1), {
        signal: controller.signal,
        sink: {
          async putObject() {
            controller.abort(reason)
          }
        }
      })
      if (reason instanceof Error) await expect(pending).rejects.toBe(reason)
      else await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    }
  )

  test('aborts and closes a non-cooperative asynchronous source', async () => {
    const controller = new AbortController()
    let returned = false
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => await new Promise<IteratorResult<Uint8Array>>(() => {}),
          return: async () => {
            returned = true
            return { done: true, value: undefined }
          }
        }
      }
    }
    const pending = collect(source, controller.signal)
    controller.abort(new Error('source stopped'))
    await expect(pending).rejects.toThrow('source stopped')
    await Promise.resolve()
    expect(returned).toBe(true)
  })

  test('aborts a non-cooperative object sink', async () => {
    const controller = new AbortController()
    let sinkStarted: (() => void) | undefined
    const started = new Promise<void>(resolve => {
      sinkStarted = resolve
    })
    const pending = new CHIRPBuilder().build(Uint8Array.of(1), {
      signal: controller.signal,
      sink: {
        async putObject() {
          sinkStarted?.()
          await new Promise<void>(() => {})
        }
      }
    })
    await started
    controller.abort(new Error('sink stopped'))
    await expect(pending).rejects.toThrow('sink stopped')
  })

  test('copies, updates, and evicts cache entries within both bounds', () => {
    expect(() => new MemoryCHIRPCache(-1, 1)).toThrow('maxBytes')
    expect(() => new MemoryCHIRPCache(1, -1)).toThrow('maxEntries')
    expect(() => new MemoryCHIRPCache(1.5, 1)).toThrow('maxBytes')
    const cache = new MemoryCHIRPCache(4, 2)
    const original = Uint8Array.of(1)
    const firstIdentifier = objectIdentifierForBytes(original)
    cache.set(firstIdentifier, original)
    original[0] = 9
    expect(cache.get(firstIdentifier)).toEqual(Uint8Array.of(1))
    const copy = cache.get(firstIdentifier)
    copy?.fill(8)
    expect(cache.get(firstIdentifier)).toEqual(Uint8Array.of(1))
    const second = Uint8Array.of(2, 2)
    const third = Uint8Array.of(3, 3)
    const secondIdentifier = objectIdentifierForBytes(second)
    const thirdIdentifier = objectIdentifierForBytes(third)
    cache.set(secondIdentifier, second)
    cache.set(thirdIdentifier, third)
    expect(cache.get(firstIdentifier)).toBeUndefined()
    expect(cache.get(thirdIdentifier)).toEqual(third)
    expect(() => cache.set(secondIdentifier, third)).toThrow('Object bytes do not match')
    cache.set('too-large', new Uint8Array(5))
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

  test('rejects malformed public tree-builder references', async () => {
    await expect(
      buildBranchLevels([{ childKind: 0, logicalLength: -1n, objectHash: new Uint8Array(32) }])
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_CHILD_KIND' })
    const sparse: CHIRPChildReference[] = []
    sparse.length = 1
    await expect(buildBranchLevels(sparse)).rejects.toMatchObject({ code: 'ERR_CHIRP_FANOUT' })
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
      rootBytes(
        Array.from({ length: 1025 }, (_value, index) => ({
          type: BigInt(index * 2 + 3),
          value: new Uint8Array()
        }))
      )
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_COUNT' }))
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
    expect(() => mediaTypeExtension(null as unknown as string)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_MEDIA_TYPE' })
    )
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

  test('rejects malformed collection shapes, framing lengths, and uint64 overflow', () => {
    const validRoot = {
      chunkingProfile: 1,
      logicalLength: 1n,
      contentHash: HASH,
      children: [child()],
      extensions: []
    }
    expect(() =>
      encodeRootNode({ ...validRoot, children: null as unknown as CHIRPChildReference[] })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_FANOUT' }))

    const sparseChildren: CHIRPChildReference[] = []
    sparseChildren.length = 1
    expect(() => encodeRootNode({ ...validRoot, children: sparseChildren })).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_FANOUT' })
    )
    expect(() =>
      encodeRootNode({ ...validRoot, extensions: null as unknown as CHIRPExtension[] })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_COUNT' }))

    const sparseExtensions: CHIRPExtension[] = []
    sparseExtensions.length = 1
    expect(() => encodeRootNode({ ...validRoot, extensions: sparseExtensions })).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_COUNT' })
    )
    expect(() =>
      encodeRootNode({ ...validRoot, extensions: [null as unknown as CHIRPExtension] })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_SIZE' }))
    expect(() =>
      encodeRootNode({
        chunkingProfile: 1,
        logicalLength: 0n,
        contentHash: HASH,
        children: [],
        extensions: []
      })
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_CONTENT_HASH' }))
    expect(() =>
      sumLogicalLength([
        child({ logicalLength: 0xffffffffffffffffn }),
        child({ logicalLength: 1n })
      ])
    ).toThrow(expect.objectContaining({ code: 'ERR_CHIRP_INTEGER_RANGE' }))

    const rootLengthMismatch = encodeRootNode(validRoot)
    rootLengthMismatch[17] = 2
    expect(() => decodeCHIRPNode(rootLengthMismatch)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_LENGTH' })
    )
    const branchLengthMismatch = encodeBranchNode({
      logicalLength: 1n,
      children: [child()],
      extensions: []
    })
    branchLengthMismatch[15] = 2
    expect(() => decodeCHIRPNode(branchLengthMismatch)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_LENGTH' })
    )

    expect(() => decodeCHIRPNode('not bytes' as unknown as Uint8Array)).toThrow(TypeError)
    expect(() => decodeCHIRPNode(CHIRP_MAGIC.slice())).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_TRUNCATED' })
    )
    const oversizedExtensionValue = concat(
      rootBytes().slice(0, -1),
      encodeCompactSize(1n),
      encodeCompactSize(3n),
      encodeCompactSize(BigInt(CHIRP_MAX_EXTENSION_BYTES + 1))
    )
    expect(() => decodeCHIRPNode(oversizedExtensionValue)).toThrow(
      expect.objectContaining({ code: 'ERR_CHIRP_EXTENSION_SIZE' })
    )
  })

  test('does not let mutation of the exported magic constant change canonical wire bytes', () => {
    const original = CHIRP_MAGIC.slice()
    try {
      CHIRP_MAGIC.fill(0)
      const encoded = rootBytes()
      expect([...encoded.subarray(0, 5)]).toEqual([...original])
      expect(decodeCHIRPNode(encoded).nodeKind).toBe(0)
    } finally {
      CHIRP_MAGIC.set(original)
    }
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
