import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRP_CHUNK_SIZE,
  CHIRPError,
  encodeRootNode,
  objectIdentifierForBytes,
  sha256,
  validateCHIRPClosure
} from '../src/index.js'

describe('closure validation', () => {
  test('uploads the first bounded blob before the source reaches EOF', async () => {
    let releaseSource: (() => void) | undefined
    const sourceReleased = new Promise<void>(resolve => {
      releaseSource = resolve
    })
    let observeFirstObject: (() => void) | undefined
    const firstObject = new Promise<void>(resolve => {
      observeFirstObject = resolve
    })
    let largestObject = 0
    async function* source(): AsyncGenerator<Uint8Array> {
      yield new Uint8Array(CHIRP_CHUNK_SIZE).fill(0x41)
      await sourceReleased
      yield Uint8Array.of(0x42)
    }
    const publication = new CHIRPBuilder().build(source(), {
      sink: {
        async putObject(_identifier, bytes, kind) {
          largestObject = Math.max(largestObject, bytes.byteLength)
          if (kind === 'blob') observeFirstObject?.()
        }
      }
    })
    await firstObject
    releaseSource?.()
    const result = await publication
    expect(result.logicalLength).toBe(BigInt(CHIRP_CHUNK_SIZE + 1))
    expect(largestObject).toBeLessThanOrEqual(CHIRP_CHUNK_SIZE)
  })

  test('validates a complete multi-blob profile 1 closure', async () => {
    const source = new Uint8Array(CHIRP_CHUNK_SIZE + 7)
    source.fill(0x5a)
    const objects = new Map<string, Uint8Array>()
    const result = await new CHIRPBuilder().build(source, {
      sink: {
        async putObject(identifier, bytes) {
          objects.set(identifier, bytes.slice())
        }
      }
    })
    const validated = await validateCHIRPClosure(result.chirpURL, async identifier => {
      const bytes = objects.get(identifier)
      if (bytes == null) throw new Error('missing')
      return bytes
    })
    expect(validated.logicalLength).toBe(BigInt(source.byteLength))
    expect(validated.closure).toHaveLength(3)
    expect(validated.profileCanonical).toBe(true)
  })

  test('rejects a missing closure object without advertising partial hosting', async () => {
    const objects = new Map<string, Uint8Array>()
    const result = await new CHIRPBuilder().build(new TextEncoder().encode('missing'), {
      sink: {
        async putObject(identifier, bytes) {
          objects.set(identifier, bytes.slice())
        }
      }
    })
    objects.delete([...objects.keys()][0])
    await expect(
      validateCHIRPClosure(result.rootIdentifier, async identifier => {
        const bytes = objects.get(identifier)
        if (bytes == null) throw new CHIRPError('ERR_MISSING', 'missing')
        return bytes
      })
    ).rejects.toBeInstanceOf(CHIRPError)
  })

  test('verifies but does not claim canonical construction for a future profile', async () => {
    const blob = new TextEncoder().encode('future profile')
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
    const blobIdentifier = objectIdentifierForBytes(blob)
    const validated = await validateCHIRPClosure(rootIdentifier, async identifier => {
      if (identifier === rootIdentifier) return rootBytes
      if (identifier === blobIdentifier) return blob
      throw new Error('missing')
    })
    expect(validated.profileCanonical).toBe(false)
  })

  test('re-reads repeated blobs instead of retaining the closure content in memory', async () => {
    const blob = new TextEncoder().encode('repeat')
    const content = new Uint8Array(blob.byteLength * 2)
    content.set(blob)
    content.set(blob, blob.byteLength)
    const reference = {
      childKind: 0 as const,
      logicalLength: BigInt(blob.byteLength),
      objectHash: sha256(blob)
    }
    const rootBytes = encodeRootNode({
      chunkingProfile: 2,
      logicalLength: BigInt(content.byteLength),
      contentHash: sha256(content),
      children: [reference, reference],
      extensions: []
    })
    const rootIdentifier = objectIdentifierForBytes(rootBytes)
    const blobIdentifier = objectIdentifierForBytes(blob)
    let blobLoads = 0
    const validated = await validateCHIRPClosure(rootIdentifier, async identifier => {
      if (identifier === rootIdentifier) return rootBytes
      if (identifier === blobIdentifier) {
        blobLoads += 1
        return blob
      }
      throw new Error('missing')
    })
    expect(validated.closure).toHaveLength(2)
    expect(blobLoads).toBe(2)
  })

  test('bounds future-profile blob bodies with an explicit local ceiling', async () => {
    const blob = new Uint8Array(65).fill(0x03)
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
    await expect(
      validateCHIRPClosure(
        rootIdentifier,
        async identifier => (identifier === rootIdentifier ? rootBytes : blob),
        { maxObjectBytes: 64 }
      )
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_SIZE' })
  })
})
