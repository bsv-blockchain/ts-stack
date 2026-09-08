import {
  CHIRP_CHUNK_SIZE,
  CHIRP_MAX_DEPTH,
  CHIRP_MAX_NODE_BYTES,
  CHIRP_PROFILE_FIXED_4_MIB
} from './constants.js'
import { buildBranchLevels } from './tree.js'
import { decodeCHIRPNode } from './codec.js'
import { CHIRPError } from './errors.js'
import { createSHA256, equalBytes, objectIdentifierForHash, verifyObjectBytes } from './hash.js'
import { parseCHIRPURL } from './uri.js'
import type {
  CHIRPBranchNode,
  CHIRPChildReference,
  CHIRPClosureValidation,
  CHIRPObjectLoader,
  CHIRPRootNode
} from './types.js'

export interface CHIRPValidationOptions {
  maxDepth?: number
  maxObjects?: number
  maxLogicalLength?: bigint
  maxObjectBytes?: number
}

export async function validateCHIRPClosure(
  chirpURLOrIdentifier: string,
  loadObject: CHIRPObjectLoader,
  options: CHIRPValidationOptions = {}
): Promise<CHIRPClosureValidation> {
  const rootIdentifier = chirpURLOrIdentifier.toLowerCase().startsWith('chirp:')
    ? parseCHIRPURL(chirpURLOrIdentifier).rootIdentifier
    : parseCHIRPURL(`chirp://${chirpURLOrIdentifier}`).rootIdentifier
  const maxDepth = options.maxDepth ?? CHIRP_MAX_DEPTH
  const maxObjects = options.maxObjects ?? 100_000
  const maxLogicalLength = options.maxLogicalLength ?? 0xffffffffffffffffn
  const maxObjectBytes = options.maxObjectBytes ?? CHIRP_CHUNK_SIZE
  const rootBytes = await loadBounded(loadObject, rootIdentifier, CHIRP_MAX_NODE_BYTES)
  verifyObjectBytes(rootIdentifier, rootBytes)
  const decoded = decodeCHIRPNode(rootBytes)
  if (decoded.nodeKind !== 0) {
    throw new CHIRPError('ERR_CHIRP_ROOT_KIND', 'CHIRP root identifier resolved to a branch node.')
  }
  const root = decoded
  if (root.logicalLength > maxLogicalLength) {
    throw new CHIRPError('ERR_CHIRP_LOGICAL_LIMIT', 'CHIRP logical length exceeds the local limit.')
  }
  if (root.logicalLength === 0n && root.children.length !== 0) {
    throw new CHIRPError('ERR_CHIRP_EMPTY', 'An empty CHIRP root cannot contain children.')
  }
  if (root.logicalLength > 0n && root.children.length === 0) {
    throw new CHIRPError('ERR_CHIRP_EMPTY', 'A non-empty CHIRP root must contain children.')
  }

  const closure = new Set<string>([rootIdentifier])
  const nodeIdentifiers = new Set<string>([rootIdentifier])
  const ancestry = new Set<string>()
  const leaves: CHIRPChildReference[] = []
  const leafDepths = new Set<number>()
  const contentHasher = createSHA256()
  let referenceCount = 0

  const countObject = (identifier: string): void => {
    closure.add(identifier)
    if (closure.size > maxObjects) {
      throw new CHIRPError(
        'ERR_CHIRP_OBJECT_LIMIT',
        'CHIRP closure exceeds the local object limit.'
      )
    }
  }

  const visit = async (reference: CHIRPChildReference, depth: number): Promise<void> => {
    referenceCount += 1
    if (referenceCount > maxObjects) {
      throw new CHIRPError(
        'ERR_CHIRP_REFERENCE_LIMIT',
        'CHIRP closure exceeds the local reference limit.'
      )
    }
    if (depth > maxDepth) {
      throw new CHIRPError('ERR_CHIRP_DEPTH', 'CHIRP traversal exceeds the v1 depth limit.')
    }
    const identifier = objectIdentifierForHash(reference.objectHash)
    countObject(identifier)
    if (reference.childKind === 0) {
      const maximum =
        root.chunkingProfile === CHIRP_PROFILE_FIXED_4_MIB ? CHIRP_CHUNK_SIZE : maxObjectBytes
      if (reference.logicalLength > BigInt(maximum)) {
        throw new CHIRPError(
          'ERR_CHIRP_OBJECT_SIZE',
          'CHIRP blob reference exceeds its permitted per-object size.'
        )
      }
      const bytes = await loadBounded(loadObject, identifier, maximum)
      verifyObjectBytes(identifier, bytes)
      if (BigInt(bytes.byteLength) !== reference.logicalLength) {
        throw new CHIRPError('ERR_CHIRP_LENGTH', 'Blob length does not match its child reference.')
      }
      leaves.push(reference)
      leafDepths.add(depth)
      contentHasher.update(bytes)
      return
    }

    if (ancestry.has(identifier)) {
      throw new CHIRPError('ERR_CHIRP_CYCLE', 'CHIRP graph contains an active-ancestry cycle.')
    }
    const bytes = await loadBounded(loadObject, identifier, CHIRP_MAX_NODE_BYTES)
    verifyObjectBytes(identifier, bytes)
    const node = decodeCHIRPNode(bytes)
    if (node.nodeKind !== 1) {
      throw new CHIRPError(
        'ERR_CHIRP_BRANCH_KIND',
        'Branch reference resolved to a non-branch node.'
      )
    }
    const branch = node
    nodeIdentifiers.add(identifier)
    if (branch.logicalLength !== reference.logicalLength) {
      throw new CHIRPError('ERR_CHIRP_LENGTH', 'Branch length does not match its child reference.')
    }
    ancestry.add(identifier)
    try {
      for (const child of branch.children) await visit(child, depth + 1)
    } finally {
      ancestry.delete(identifier)
    }
  }

  for (const child of root.children) await visit(child, 1)
  const actualContentHash = contentHasher.digest()
  if (!equalBytes(actualContentHash, root.contentHash)) {
    throw new CHIRPError(
      'ERR_CHIRP_CONTENT_HASH',
      'Logical content does not match root contentHash.'
    )
  }
  const actualLength = leaves.reduce((total, leaf) => total + leaf.logicalLength, 0n)
  if (actualLength !== root.logicalLength) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'Traversed content length does not match the root.')
  }

  if (root.chunkingProfile === CHIRP_PROFILE_FIXED_4_MIB) {
    await validateProfileOneConstruction(root, leaves, leafDepths)
  }

  return {
    root,
    rootBytes,
    rootIdentifier,
    closure: [...closure],
    nodeIdentifiers: [...nodeIdentifiers],
    logicalLength: root.logicalLength,
    contentHash: root.contentHash,
    profileCanonical: root.chunkingProfile === CHIRP_PROFILE_FIXED_4_MIB
  }
}

export async function validateProfileOneConstruction(
  root: CHIRPRootNode,
  leaves: CHIRPChildReference[],
  leafDepths: ReadonlySet<number>
): Promise<void> {
  if (root.children.some(child => child.childKind !== root.children[0]?.childKind)) {
    throw new CHIRPError(
      'ERR_CHIRP_MIXED_ROOT',
      'All profile 1 root children must have the same kind.'
    )
  }
  if (leafDepths.size > 1) {
    throw new CHIRPError('ERR_CHIRP_TREE_SHAPE', 'Profile 1 leaves must have equal depth.')
  }
  validateProfileOneLeaves(leaves)
  const canonical = await buildBranchLevels(leaves)
  if (!equalReferences(canonical.children, root.children)) {
    throw new CHIRPError(
      'ERR_CHIRP_TREE_SHAPE',
      'CHIRP tree is not canonical profile 1 construction.'
    )
  }
}

function validateProfileOneLeaves(leaves: CHIRPChildReference[]): void {
  for (let index = 0; index < leaves.length; index += 1) {
    const length = leaves[index].logicalLength
    const isFinal = index === leaves.length - 1
    if ((!isFinal && length !== BigInt(CHIRP_CHUNK_SIZE)) || length > BigInt(CHIRP_CHUNK_SIZE)) {
      throw new CHIRPError('ERR_CHIRP_CHUNK_SIZE', 'Profile 1 contains an invalid blob boundary.')
    }
    if (length === 0n) {
      throw new CHIRPError('ERR_CHIRP_CHUNK_SIZE', 'Profile 1 cannot contain an empty blob.')
    }
  }
}

function equalReferences(left: CHIRPChildReference[], right: CHIRPChildReference[]): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => {
      const candidate = right[index]
      if (candidate == null) return false
      return (
        reference.childKind === candidate.childKind &&
        reference.logicalLength === candidate.logicalLength &&
        equalBytes(reference.objectHash, candidate.objectHash)
      )
    })
  )
}

async function loadBounded(
  loadObject: CHIRPObjectLoader,
  identifier: string,
  maximumBytes: number
): Promise<Uint8Array> {
  const bytes = await loadObject(identifier)
  if (!(bytes instanceof Uint8Array)) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_TYPE', 'CHIRP object loader returned non-byte data.')
  }
  if (bytes.byteLength > maximumBytes) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_SIZE', 'CHIRP object exceeds its permitted size.')
  }
  return bytes
}

export function isRootNode(node: CHIRPRootNode | CHIRPBranchNode): node is CHIRPRootNode {
  return node.nodeKind === 0
}
