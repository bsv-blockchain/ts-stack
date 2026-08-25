import { describe, expect, test } from '@jest/globals'
import {
  CHIRPBuilder,
  CHIRP_CHUNK_SIZE,
  CHIRP_MAX_NODE_BYTES,
  encodeBranchNode,
  encodeRootNode,
  objectIdentifierForBytes,
  sha256,
  validateCHIRPClosure
} from '../src/index.js'
import type { CHIRPChildReference } from '../src/index.js'

type Objects = Map<string, Uint8Array>

function put(objects: Objects, bytes: Uint8Array): string {
  const identifier = objectIdentifierForBytes(bytes)
  objects.set(identifier, bytes)
  return identifier
}

function reference(
  bytes: Uint8Array,
  childKind: 0 | 1,
  logicalLength?: bigint
): CHIRPChildReference {
  return {
    childKind,
    logicalLength: logicalLength ?? BigInt(bytes.byteLength),
    objectHash: sha256(bytes)
  }
}

function branch(
  objects: Objects,
  children: CHIRPChildReference[]
): {
  bytes: Uint8Array
  reference: CHIRPChildReference
} {
  const logicalLength = children.reduce((total, child) => total + child.logicalLength, 0n)
  const bytes = encodeBranchNode({ logicalLength, children, extensions: [] })
  put(objects, bytes)
  return { bytes, reference: reference(bytes, 1, logicalLength) }
}

function root(
  objects: Objects,
  children: CHIRPChildReference[],
  content: Uint8Array,
  profile = 2,
  logicalLength = children.reduce((total, child) => total + child.logicalLength, 0n)
): string {
  const bytes = encodeRootNode({
    chunkingProfile: profile,
    logicalLength,
    contentHash: sha256(content),
    children,
    extensions: []
  })
  return put(objects, bytes)
}

function loader(objects: Objects): (identifier: string) => Promise<Uint8Array> {
  return async identifier => {
    const bytes = objects.get(identifier)
    if (bytes == null) throw new Error(`missing ${identifier}`)
    return bytes
  }
}

describe('closure validation limits and shape', () => {
  test('rejects branch roots, logical limits, and empty children', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(1)
    put(objects, blob)
    const branchNode = branch(objects, [reference(blob, 0)])
    const branchIdentifier = objectIdentifierForBytes(branchNode.bytes)
    await expect(validateCHIRPClosure(branchIdentifier, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_ROOT_KIND'
    })

    const valid = root(objects, [reference(blob, 0)], blob)
    await expect(
      validateCHIRPClosure(valid, loader(objects), { maxLogicalLength: 0n })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_LOGICAL_LIMIT' })

    const empty = new Uint8Array()
    put(objects, empty)
    const invalidEmpty = root(objects, [reference(empty, 0)], empty)
    await expect(validateCHIRPClosure(invalidEmpty, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_EMPTY'
    })

    const mixed = root(objects, [reference(blob, 0), branchNode.reference], Uint8Array.of(1, 1))
    await expect(validateCHIRPClosure(mixed, loader(objects))).resolves.toMatchObject({
      logicalLength: 2n,
      profileCanonical: false
    })
  })

  test('bounds object count, traversal depth, loader types, sizes, and hashes', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(2)
    put(objects, blob)
    const identifier = root(objects, [reference(blob, 0)], blob)
    await expect(
      validateCHIRPClosure(identifier, loader(objects), { maxObjects: 1 })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_LIMIT' })
    await expect(
      validateCHIRPClosure(identifier, loader(objects), { maxDepth: 0 })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_DEPTH' })
    await expect(
      validateCHIRPClosure(identifier, async () => 'not bytes' as unknown as Uint8Array)
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_TYPE' })
    await expect(
      validateCHIRPClosure(identifier, async () => new Uint8Array(CHIRP_MAX_NODE_BYTES + 1))
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_SIZE' })
    await expect(
      validateCHIRPClosure(identifier, async () => Uint8Array.of(9))
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_OBJECT_HASH' })
  })

  test('detects blob length, content hash, and profile-one chunk-boundary failures', async () => {
    const objects = new Map<string, Uint8Array>()
    const first = Uint8Array.of(1)
    const second = Uint8Array.of(2)
    put(objects, first)
    put(objects, second)

    const wrongLength = root(objects, [reference(first, 0, 2n)], first)
    await expect(validateCHIRPClosure(wrongLength, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_LENGTH'
    })

    const wrongHashBytes = encodeRootNode({
      chunkingProfile: 2,
      logicalLength: 1n,
      contentHash: new Uint8Array(32),
      children: [reference(first, 0)],
      extensions: []
    })
    const wrongHash = put(objects, wrongHashBytes)
    await expect(validateCHIRPClosure(wrongHash, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_CONTENT_HASH'
    })

    const shortNonFinal = root(
      objects,
      [reference(first, 0), reference(second, 0)],
      Uint8Array.of(1, 2),
      1
    )
    await expect(validateCHIRPClosure(shortNonFinal, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_CHUNK_SIZE'
    })

    const oversized = new Uint8Array(CHIRP_CHUNK_SIZE + 1)
    put(objects, oversized)
    const oversizedFinal = root(objects, [reference(oversized, 0)], oversized, 1)
    await expect(validateCHIRPClosure(oversizedFinal, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_OBJECT_SIZE'
    })
  })

  test('validates branch identity and referenced length', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(3)
    put(objects, blob)
    const nestedRootBytes = encodeRootNode({
      chunkingProfile: 2,
      logicalLength: 1n,
      contentHash: sha256(blob),
      children: [reference(blob, 0)],
      extensions: []
    })
    put(objects, nestedRootBytes)
    const wrongKind = root(objects, [reference(nestedRootBytes, 1, 1n)], blob)
    await expect(validateCHIRPClosure(wrongKind, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_BRANCH_KIND'
    })

    const validBranch = branch(objects, [reference(blob, 0)])
    const wrongLength = root(
      objects,
      [{ ...validBranch.reference, logicalLength: 2n }],
      blob,
      2,
      2n
    )
    await expect(validateCHIRPClosure(wrongLength, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_LENGTH'
    })
  })

  test('streams duplicate branch and blob occurrences without retaining their bodies', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(4)
    put(objects, blob)
    const shared = branch(objects, [reference(blob, 0)])
    const identifier = root(objects, [shared.reference, shared.reference], Uint8Array.of(4, 4))
    const loads = new Map<string, number>()
    const validated = await validateCHIRPClosure(identifier, async objectIdentifier => {
      loads.set(objectIdentifier, (loads.get(objectIdentifier) ?? 0) + 1)
      return await loader(objects)(objectIdentifier)
    })
    expect(validated.logicalLength).toBe(2n)
    expect(loads.get(objectIdentifierForBytes(shared.bytes))).toBe(2)
    expect(loads.get(objectIdentifierForBytes(blob))).toBe(2)
  })

  test('allows unknown-profile shapes but rejects non-canonical profile-one branches', async () => {
    const objects = new Map<string, Uint8Array>()
    const first = Uint8Array.of(5)
    const second = Uint8Array.of(6)
    put(objects, first)
    put(objects, second)
    const shallow = branch(objects, [reference(first, 0)])
    const inner = branch(objects, [reference(second, 0)])
    const deep = branch(objects, [inner.reference])
    const unequal = root(objects, [shallow.reference, deep.reference], Uint8Array.of(5, 6))
    await expect(validateCHIRPClosure(unequal, loader(objects))).resolves.toMatchObject({
      profileCanonical: false
    })

    const nonCanonical = root(objects, [shallow.reference], first, 1)
    await expect(validateCHIRPClosure(nonCanonical, loader(objects))).rejects.toMatchObject({
      code: 'ERR_CHIRP_TREE_SHAPE'
    })
  })

  test('bounds repeated references independently of unique object count', async () => {
    const objects = new Map<string, Uint8Array>()
    const blob = Uint8Array.of(7)
    put(objects, blob)
    const identifier = root(
      objects,
      [reference(blob, 0), reference(blob, 0), reference(blob, 0)],
      Uint8Array.of(7, 7, 7)
    )
    await expect(
      validateCHIRPClosure(identifier, loader(objects), { maxObjects: 2 })
    ).rejects.toMatchObject({ code: 'ERR_CHIRP_REFERENCE_LIMIT' })
  })

  test('accepts the canonical empty profile-one closure', async () => {
    const objects = new Map<string, Uint8Array>()
    const built = await new CHIRPBuilder().build(new Uint8Array(), {
      sink: {
        async putObject(identifier, bytes) {
          objects.set(identifier, bytes)
        }
      }
    })
    const validated = await validateCHIRPClosure(built.chirpURL, loader(objects))
    expect(validated).toMatchObject({ logicalLength: 0n, profileCanonical: true })
  })
})
