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
})
