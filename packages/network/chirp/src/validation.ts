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
  signal?: AbortSignal
}

export async function validateCHIRPClosure(
  chirpURLOrIdentifier: string,
  loadObject: CHIRPObjectLoader,
  options: CHIRPValidationOptions = {}
): Promise<CHIRPClosureValidation> {
  const limits = snapshotValidationOptions(options)
  const rootIdentifier = chirpURLOrIdentifier.toLowerCase().startsWith('chirp:')
    ? parseCHIRPURL(chirpURLOrIdentifier).rootIdentifier
    : parseCHIRPURL(`chirp://${chirpURLOrIdentifier}`).rootIdentifier
  const maxDepth = limits.maxDepth ?? CHIRP_MAX_DEPTH
  const maxObjects = limits.maxObjects ?? 100_000
  const maxLogicalLength = limits.maxLogicalLength ?? 0xffffffffffffffffn
  const maxObjectBytes = limits.maxObjectBytes ?? CHIRP_CHUNK_SIZE
  const rootBytes = await loadBounded(
    loadObject,
    rootIdentifier,
    CHIRP_MAX_NODE_BYTES,
    limits.signal
  )
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
      const bytes = await loadBounded(loadObject, identifier, maximum, limits.signal)
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
    const bytes = await loadBounded(loadObject, identifier, CHIRP_MAX_NODE_BYTES, limits.signal)
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
    rootBytes: rootBytes.slice(),
    rootIdentifier,
    closure: [...closure],
    nodeIdentifiers: [...nodeIdentifiers],
    logicalLength: root.logicalLength,
    contentHash: root.contentHash.slice(),
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
  maximumBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const bytes = await raceWithSignal(Promise.resolve(loadObject(identifier)), signal)
  if (!(bytes instanceof Uint8Array)) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_TYPE', 'CHIRP object loader returned non-byte data.')
  }
  if (bytes.byteLength > maximumBytes) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_SIZE', 'CHIRP object exceeds its permitted size.')
  }
  return bytes.slice()
}

function snapshotValidationOptions(options: CHIRPValidationOptions): CHIRPValidationOptions {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(options))
  ) {
    throw new TypeError('CHIRP validation options must be a plain object.')
  }
  const allowed = new Set([
    'maxDepth',
    'maxObjects',
    'maxLogicalLength',
    'maxObjectBytes',
    'signal'
  ])
  const values = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError('CHIRP validation options contain an unsupported property.')
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key)!
    if (!('value' in descriptor)) {
      throw new TypeError('CHIRP validation options cannot use accessors.')
    }
    values[key] = descriptor.value
  }
  const maxDepth = boundedInteger(values.maxDepth, 0, CHIRP_MAX_DEPTH, 'maxDepth')
  const maxObjects = boundedInteger(values.maxObjects, 1, 10_000_000, 'maxObjects')
  const maxObjectBytes = boundedInteger(
    values.maxObjectBytes,
    1,
    Number.MAX_SAFE_INTEGER,
    'maxObjectBytes'
  )
  if (
    values.maxLogicalLength !== undefined &&
    (typeof values.maxLogicalLength !== 'bigint' ||
      values.maxLogicalLength < 0n ||
      values.maxLogicalLength > 0xffffffffffffffffn)
  ) {
    throw new RangeError('maxLogicalLength must be a bigint in the uint64 range.')
  }
  if (values.signal !== undefined && !isAbortSignal(values.signal)) {
    throw new TypeError('signal must be an AbortSignal.')
  }
  return {
    maxDepth,
    maxObjects,
    maxLogicalLength: values.maxLogicalLength as bigint | undefined,
    maxObjectBytes,
    signal: values.signal as AbortSignal | undefined
  }
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  )
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('CHIRP closure validation was aborted.', 'AbortError')
  }
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  if (signal == null) return await promise
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('CHIRP closure validation was aborted.', 'AbortError')
      )
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`)
  }
  return value as number
}

export function isRootNode(node: CHIRPRootNode | CHIRPBranchNode): node is CHIRPRootNode {
  return node.nodeKind === 0
}
