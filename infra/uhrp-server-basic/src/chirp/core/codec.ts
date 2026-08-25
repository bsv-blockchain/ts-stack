import {
  CHIRP_FANOUT,
  CHIRP_MAGIC,
  CHIRP_MAJOR_VERSION,
  CHIRP_MAX_EXTENSION_BYTES,
  CHIRP_MAX_NODE_BYTES,
  CHIRP_MEDIA_TYPE_EXTENSION,
  CHIRP_MINOR_VERSION
} from './constants.js'
import {
  bigEndian,
  concat,
  decodeCompactSize,
  encodeCompactSize,
  readBigEndian
} from './compactSize.js'
import { CHIRPError } from './errors.js'
import type {
  CHIRPBranchNode,
  CHIRPChildReference,
  CHIRPExtension,
  CHIRPNode,
  CHIRPRootNode
} from './types.js'

const textDecoder = new TextDecoder('utf-8', { fatal: true })
const textEncoder = new TextEncoder()
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/

export function encodeRootNode(
  node: Omit<CHIRPRootNode, 'majorVersion' | 'minorVersion' | 'nodeKind'>
): Uint8Array {
  validateProfileNumber(node.chunkingProfile)
  validateHash(node.contentHash)
  validateChildren(node.children, true)
  if (sumLogicalLength(node.children) !== node.logicalLength) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'Root child lengths do not equal logicalLength.')
  }
  const bytes = concat(
    commonPrefix(0),
    bigEndian(BigInt(node.chunkingProfile), 2),
    bigEndian(node.logicalLength, 8),
    node.contentHash,
    encodeChildren(node.children),
    encodeExtensions(node.extensions, 0)
  )
  enforceNodeSize(bytes)
  return bytes
}

export function encodeBranchNode(
  node: Omit<CHIRPBranchNode, 'majorVersion' | 'minorVersion' | 'nodeKind'>
): Uint8Array {
  validateChildren(node.children, false)
  if (sumLogicalLength(node.children) !== node.logicalLength) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'Branch child lengths do not equal logicalLength.')
  }
  const bytes = concat(
    commonPrefix(1),
    bigEndian(node.logicalLength, 8),
    encodeChildren(node.children),
    encodeExtensions(node.extensions, 1)
  )
  enforceNodeSize(bytes)
  return bytes
}

export function decodeCHIRPNode(bytes: Uint8Array): CHIRPNode {
  enforceNodeSize(bytes)
  const reader = new Reader(bytes)
  const magic = reader.bytes(CHIRP_MAGIC.byteLength)
  if (!equal(magic, CHIRP_MAGIC)) {
    throw new CHIRPError('ERR_CHIRP_MAGIC', 'Object does not begin with CHIRP magic.')
  }
  const majorVersion = reader.uint8()
  const minorVersion = reader.uint8()
  const nodeKind = reader.uint8()
  if (majorVersion !== CHIRP_MAJOR_VERSION) {
    throw new CHIRPError('ERR_CHIRP_VERSION', `Unsupported CHIRP major version ${majorVersion}.`)
  }
  if (nodeKind !== 0 && nodeKind !== 1) {
    throw new CHIRPError('ERR_CHIRP_NODE_KIND', `Unsupported CHIRP node kind ${nodeKind}.`)
  }

  if (nodeKind === 0) {
    const chunkingProfile = reader.uint16()
    const logicalLength = reader.uint64()
    const contentHash = reader.bytes(32)
    const children = reader.children()
    const extensions = reader.extensions(0)
    reader.finish()
    validateProfileNumber(chunkingProfile)
    validateChildren(children, true)
    if (sumLogicalLength(children) !== logicalLength) {
      throw new CHIRPError('ERR_CHIRP_LENGTH', 'Root child lengths do not equal logicalLength.')
    }
    return {
      majorVersion,
      minorVersion,
      nodeKind,
      chunkingProfile,
      logicalLength,
      contentHash,
      children,
      extensions
    }
  }

  const logicalLength = reader.uint64()
  const children = reader.children()
  const extensions = reader.extensions(1)
  reader.finish()
  validateChildren(children, false)
  if (sumLogicalLength(children) !== logicalLength) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'Branch child lengths do not equal logicalLength.')
  }
  return {
    majorVersion,
    minorVersion,
    nodeKind,
    logicalLength,
    children,
    extensions
  }
}

export function mediaTypeFromRoot(root: CHIRPRootNode): string | null {
  const extension = root.extensions.find(candidate => candidate.type === CHIRP_MEDIA_TYPE_EXTENSION)
  if (extension == null) return null
  return decodeMediaType(extension.value)
}

export function mediaTypeExtension(mediaType: string): CHIRPExtension {
  const normalized = mediaType.toLowerCase()
  const value = textEncoder.encode(normalized)
  decodeMediaType(value)
  return { type: CHIRP_MEDIA_TYPE_EXTENSION, value }
}

export function sumLogicalLength(children: CHIRPChildReference[]): bigint {
  return children.reduce((total, child) => total + child.logicalLength, 0n)
}

function commonPrefix(nodeKind: 0 | 1): Uint8Array {
  return concat(CHIRP_MAGIC, Uint8Array.of(CHIRP_MAJOR_VERSION, CHIRP_MINOR_VERSION, nodeKind))
}

function encodeChildren(children: CHIRPChildReference[]): Uint8Array {
  return concat(
    encodeCompactSize(BigInt(children.length)),
    ...children.map(child => {
      validateHash(child.objectHash)
      if (child.childKind !== 0 && child.childKind !== 1) {
        throw new CHIRPError('ERR_CHIRP_CHILD_KIND', 'Unsupported CHIRP child kind.')
      }
      return concat(
        Uint8Array.of(child.childKind),
        bigEndian(child.logicalLength, 8),
        child.objectHash
      )
    })
  )
}

function encodeExtensions(extensions: CHIRPExtension[], nodeKind: 0 | 1): Uint8Array {
  validateExtensions(extensions, nodeKind)
  return concat(
    encodeCompactSize(BigInt(extensions.length)),
    ...extensions.map(extension =>
      concat(
        encodeCompactSize(extension.type),
        encodeCompactSize(BigInt(extension.value.byteLength)),
        extension.value
      )
    )
  )
}

function validateChildren(children: CHIRPChildReference[], root: boolean): void {
  if (children.length > CHIRP_FANOUT || (!root && children.length === 0)) {
    throw new CHIRPError(
      'ERR_CHIRP_FANOUT',
      `CHIRP nodes support at most ${CHIRP_FANOUT} children.`
    )
  }
  for (const child of children) {
    if (child.logicalLength < 0n || child.logicalLength > 0xffffffffffffffffn) {
      throw new CHIRPError('ERR_CHIRP_INTEGER_RANGE', 'Child length is outside uint64.')
    }
    validateHash(child.objectHash)
  }
}

function validateExtensions(extensions: CHIRPExtension[], nodeKind: 0 | 1): void {
  let previous = 0n
  let totalBytes = 0
  for (const extension of extensions) {
    if (extension.type <= previous || extension.type === 0n) {
      throw new CHIRPError(
        'ERR_CHIRP_EXTENSION_ORDER',
        'CHIRP extensions must be unique and strictly ordered.'
      )
    }
    previous = extension.type
    totalBytes += extension.value.byteLength
    if (totalBytes > CHIRP_MAX_EXTENSION_BYTES) {
      throw new CHIRPError(
        'ERR_CHIRP_EXTENSION_SIZE',
        'CHIRP extension values exceed the v1 limit.'
      )
    }
    if (extension.type === CHIRP_MEDIA_TYPE_EXTENSION) {
      if (nodeKind !== 0) {
        throw new CHIRPError('ERR_CHIRP_EXTENSION_NODE', 'mediaType is valid only on a root node.')
      }
      decodeMediaType(extension.value)
    } else if (extension.type % 2n === 0n) {
      throw new CHIRPError(
        'ERR_CHIRP_CRITICAL_EXTENSION',
        `Unsupported critical CHIRP extension ${extension.type}.`
      )
    }
  }
}

function decodeMediaType(value: Uint8Array): string {
  if (value.byteLength < 3 || value.byteLength > 127) {
    throw new CHIRPError('ERR_CHIRP_MEDIA_TYPE', 'mediaType must contain 3 to 127 ASCII bytes.')
  }
  let decoded: string
  try {
    decoded = textDecoder.decode(value)
  } catch {
    throw new CHIRPError('ERR_CHIRP_MEDIA_TYPE', 'mediaType is not valid UTF-8.')
  }
  if (!MEDIA_TYPE.test(decoded) || decoded !== decoded.toLowerCase()) {
    throw new CHIRPError(
      'ERR_CHIRP_MEDIA_TYPE',
      'mediaType must be a lower-case media-type essence without parameters.'
    )
  }
  for (const byte of value) {
    if (byte < 0x21 || byte > 0x7e) {
      throw new CHIRPError('ERR_CHIRP_MEDIA_TYPE', 'mediaType must contain printable ASCII.')
    }
  }
  return decoded
}

function validateHash(hash: Uint8Array): void {
  if (!(hash instanceof Uint8Array) || hash.byteLength !== 32) {
    throw new CHIRPError('ERR_CHIRP_HASH_LENGTH', 'CHIRP hashes must contain 32 bytes.')
  }
}

function validateProfileNumber(profile: number): void {
  if (!Number.isInteger(profile) || profile <= 0 || profile > 0xffff) {
    throw new CHIRPError('ERR_CHIRP_PROFILE', 'Chunking profile must be a nonzero uint16.')
  }
}

function enforceNodeSize(bytes: Uint8Array): void {
  if (bytes.byteLength > CHIRP_MAX_NODE_BYTES) {
    throw new CHIRPError('ERR_CHIRP_NODE_SIZE', 'CHIRP node exceeds 65,536 bytes.')
  }
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  )
}

class Reader {
  private offset = 0

  constructor(private readonly source: Uint8Array) {}

  uint8(): number {
    return this.bytes(1)[0]
  }

  uint16(): number {
    const value = readBigEndian(this.source, this.offset, 2)
    this.offset += 2
    return Number(value)
  }

  uint64(): bigint {
    const value = readBigEndian(this.source, this.offset, 8)
    this.offset += 8
    return value
  }

  compactSize(): bigint {
    const decoded = decodeCompactSize(this.source, this.offset)
    this.offset = decoded.offset
    return decoded.value
  }

  bytes(length: number): Uint8Array {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      this.offset + length > this.source.byteLength
    ) {
      throw new CHIRPError('ERR_CHIRP_TRUNCATED', 'CHIRP serialization is truncated.')
    }
    const result = this.source.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }

  children(): CHIRPChildReference[] {
    const count = this.compactSize()
    if (count > BigInt(CHIRP_FANOUT)) {
      throw new CHIRPError('ERR_CHIRP_FANOUT', 'CHIRP node fanout exceeds the v1 limit.')
    }
    const children: CHIRPChildReference[] = []
    for (let index = 0; index < Number(count); index += 1) {
      const childKind = this.uint8()
      if (childKind !== 0 && childKind !== 1) {
        throw new CHIRPError('ERR_CHIRP_CHILD_KIND', `Unsupported CHIRP child kind ${childKind}.`)
      }
      children.push({
        childKind,
        logicalLength: this.uint64(),
        objectHash: this.bytes(32)
      })
    }
    return children
  }

  extensions(nodeKind: 0 | 1): CHIRPExtension[] {
    const count = this.compactSize()
    if (count > 1024n) {
      throw new CHIRPError(
        'ERR_CHIRP_EXTENSION_COUNT',
        'CHIRP extension count exceeds local limits.'
      )
    }
    const extensions: CHIRPExtension[] = []
    for (let index = 0; index < Number(count); index += 1) {
      const type = this.compactSize()
      const length = this.compactSize()
      if (length > BigInt(CHIRP_MAX_EXTENSION_BYTES)) {
        throw new CHIRPError('ERR_CHIRP_EXTENSION_SIZE', 'CHIRP extension value is too large.')
      }
      extensions.push({ type, value: this.bytes(Number(length)) })
    }
    validateExtensions(extensions, nodeKind)
    return extensions
  }

  finish(): void {
    if (this.offset !== this.source.byteLength) {
      throw new CHIRPError('ERR_CHIRP_TRAILING_BYTES', 'CHIRP node contains trailing bytes.')
    }
  }
}
