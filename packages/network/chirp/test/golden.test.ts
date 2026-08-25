import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRPError,
  buildBranchLevels,
  concat,
  decodeCHIRPNode,
  hashHex,
  objectIdentifierForBytes,
  sha256
} from '../src/index.js'
import type { CHIRPChildReference } from '../src/types.js'

const vectorPath = fileURLToPath(
  new URL('../../../../conformance/vectors/storage/chirp-v1.json', import.meta.url)
)
const vectors = JSON.parse(readFileSync(vectorPath, 'utf8')) as {
  vectors: Array<{
    id: string
    input: {
      source?:
        | { encoding: 'hex' | 'utf8'; value: string }
        | { encoding: 'repeat'; byte: number; length: number }
      mediaType?: string | null
      leafCount?: number
      logicalLength?: string
      hashSeed?: string
    }
    expected: {
      logicalLength?: string
      contentHash?: string
      rootBytes?: string
      rootHash?: string
      rootIdentifier?: string
      chirpURL?: string
      branchCount?: number
      levelWidths?: number[]
      rootChildren?: Array<{ childKind: number; logicalLength: string; objectHash: string }>
    }
  }>
  invalid: Array<{ name: string; rootBytes: string; errorCode: string }>
}

describe('portable BRC-167 vectors', () => {
  test.each(vectors.vectors)('$id', async vector => {
    if (vector.input.leafCount != null) {
      const encoder = new TextEncoder()
      const leaves: CHIRPChildReference[] = Array.from(
        { length: vector.input.leafCount },
        (_, index) => ({
          childKind: 0,
          logicalLength: BigInt(vector.input.logicalLength as string),
          objectHash: sha256(encoder.encode(`${vector.input.hashSeed}:${index}`))
        })
      )
      const result = await buildBranchLevels(leaves)
      expect(result.branchCount).toBe(vector.expected.branchCount)
      expect(treeLevelWidths(vector.input.leafCount)).toEqual(vector.expected.levelWidths)
      if (vector.expected.rootChildren != null) {
        expect(
          result.children.map(child => ({
            childKind: child.childKind,
            logicalLength: child.logicalLength.toString(),
            objectHash: hashHex(child.objectHash)
          }))
        ).toEqual(vector.expected.rootChildren)
      }
      return
    }
    const sourceDescription = vector.input.source
    if (sourceDescription == null) throw new Error('Vector source is missing.')
    const source =
      sourceDescription.encoding === 'hex'
        ? Uint8Array.from(Buffer.from(sourceDescription.value, 'hex'))
        : sourceDescription.encoding === 'utf8'
          ? new TextEncoder().encode(sourceDescription.value)
          : new Uint8Array(sourceDescription.length).fill(sourceDescription.byte)
    const result = await new CHIRPBuilder().build(source, {
      mediaType: vector.input.mediaType ?? undefined
    })
    expect(Buffer.from(result.rootBytes).toString('hex')).toBe(vector.expected.rootBytes)
    expect(hashHex(result.contentHash)).toBe(vector.expected.contentHash)
    expect(hashHex((await import('../src/hash.js')).sha256(result.rootBytes))).toBe(
      vector.expected.rootHash
    )
    expect(result.rootIdentifier).toBe(vector.expected.rootIdentifier)
    expect(result.chirpURL).toBe(vector.expected.chirpURL)
    expect(result.logicalLength.toString()).toBe(vector.expected.logicalLength)
  })

  test.each(vectors.invalid)('rejects $name', vector => {
    try {
      decodeCHIRPNode(Uint8Array.from(Buffer.from(vector.rootBytes, 'hex')))
      throw new Error('Expected vector rejection.')
    } catch (error) {
      expect(error).toBeInstanceOf(CHIRPError)
      expect((error as CHIRPError).code).toBe(vector.errorCode)
    }
  })
})

function treeLevelWidths(leafCount: number): number[] {
  const widths = [leafCount]
  let width = leafCount
  while (width > 256) {
    width = Math.ceil(width / 256)
    widths.push(width)
  }
  return widths
}

test('257 leaves produce two canonical branches beneath the root', async () => {
  const leaves: CHIRPChildReference[] = Array.from({ length: 257 }, (_, index) => ({
    childKind: 0,
    logicalLength: 4_194_304n,
    objectHash: Uint8Array.from({ length: 32 }, (_value, byte) => (index + byte) & 0xff)
  }))
  const objects = new Map<string, Uint8Array>()
  const result = await buildBranchLevels(leaves, {
    async putObject(identifier, bytes) {
      objects.set(identifier, bytes)
    }
  })
  expect(result.children).toHaveLength(2)
  expect(result.children.every(child => child.childKind === 1)).toBe(true)
  expect(result.branchCount).toBe(2)
  expect(objects.size).toBe(2)
  for (const [identifier, bytes] of objects)
    expect(objectIdentifierForBytes(bytes)).toBe(identifier)
})

test('256 leaves remain directly beneath the root', async () => {
  const leaves: CHIRPChildReference[] = Array.from({ length: 256 }, (_, index) => ({
    childKind: 0,
    logicalLength: 1n,
    objectHash: new Uint8Array(32).fill(index)
  }))
  const result = await buildBranchLevels(leaves)
  expect(result.children).toHaveLength(256)
  expect(result.children.every(child => child.childKind === 0)).toBe(true)
  expect(result.branchCount).toBe(0)
})

test('65,537 leaves produce a deterministic multi-level tree', async () => {
  const leaves: CHIRPChildReference[] = Array.from({ length: 65_537 }, (_, index) => ({
    childKind: 0,
    logicalLength: 1n,
    objectHash: Uint8Array.from({ length: 32 }, (_value, byte) => (index + byte) & 0xff)
  }))
  const result = await buildBranchLevels(leaves)
  expect(result.children).toHaveLength(2)
  expect(result.children.every(child => child.childKind === 1)).toBe(true)
  expect(result.branchCount).toBe(259)
})

test('fails closed on invalid version, profile, child kind, fanout, and critical extension', async () => {
  const hello = vectors.vectors.find(vector => vector.id === 'storage.chirp-v1.hello')
  expect(hello).toBeDefined()
  const valid = Uint8Array.from(Buffer.from(hello?.expected.rootBytes ?? '', 'hex'))
  const cases: Array<[number, number, string]> = [
    [5, 2, 'ERR_CHIRP_VERSION'],
    [9, 0, 'ERR_CHIRP_PROFILE'],
    [51, 2, 'ERR_CHIRP_CHILD_KIND']
  ]
  for (const [offset, value, code] of cases) {
    const invalid = valid.slice()
    invalid[offset] = value
    expect(() => decodeCHIRPNode(invalid)).toThrow(expect.objectContaining({ code }))
  }

  const excessiveFanout = concat(valid.slice(0, 50), Uint8Array.of(0xfd, 0x01, 0x01))
  expect(() => decodeCHIRPNode(excessiveFanout)).toThrow(
    expect.objectContaining({
      code: 'ERR_CHIRP_FANOUT'
    })
  )

  const advisory = (await new CHIRPBuilder().build(new TextEncoder().encode('x'))).rootBytes
  const withUnknownAdvisory = concat(advisory.slice(0, -1), Uint8Array.of(1, 3, 1, 0))
  expect(decodeCHIRPNode(withUnknownAdvisory).extensions[0]?.type).toBe(3n)
  withUnknownAdvisory[withUnknownAdvisory.length - 3] = 2
  expect(() => decodeCHIRPNode(withUnknownAdvisory)).toThrow(
    expect.objectContaining({
      code: 'ERR_CHIRP_CRITICAL_EXTENSION'
    })
  )
})
