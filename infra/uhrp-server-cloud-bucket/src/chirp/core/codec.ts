import {
  CHIRP_MAJOR_VERSION,
  CHIRP_MAX_EXTENSION_BYTES,
  CHIRP_MAX_EXTENSIONS,
  CHIRP_MAX_NODE_BYTES,
  CHIRP_MEDIA_TYPE_EXTENSION,
  CHIRP_MINOR_VERSION,
  CHIRP_V1_MAX_CHILDREN
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
const MAX_UINT64 = 0xffffffffffffffffn
const CANONICAL_CHIRP_MAGIC = Uint8Array.from([0x43, 0x48, 0x49, 0x52, 0x50])
const EMPTY_SHA256 = Uint8Array.from([
  0xe3, 0xb0, 0xc4, 0x42, 0x98, 0xfc, 0x1c, 0x14, 0x9a, 0xfb, 0xf4, 0xc8, 0x99, 0x6f, 0xb9, 0x24,
  0x27, 0xae, 0x41, 0xe4, 0x64, 0x9b, 0x93, 0x4c, 0xa4, 0x95, 0x99, 0x1b, 0x78, 0x52, 0xb8, 0x55
])

export function encodeRootNode(
  node: Omit<CHIRPRootNode, 'majorVersion' | 'minorVersion' | 'nodeKind'>
): Uint8Array {
  validateProfileNumber(node.chunkingProfile)
  validateHash(node.contentHash)
  validateChildren(node.children, true)
  validateRootShape(node.logicalLength, node.children, node.contentHash)
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
  const magic = reader.bytes(CANONICAL_CHIRP_MAGIC.byteLength)
  if (!equal(magic, CANONICAL_CHIRP_MAGIC)) {
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
    validateRootShape(logicalLength, children, contentHash)
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
  if (typeof mediaType !== 'string') {
    throw new CHIRPError('ERR_CHIRP_MEDIA_TYPE', 'mediaType must be a string.')
  }
  const normalized = mediaType.toLowerCase()
  const value = textEncoder.encode(normalized)
  decodeMediaType(value)
  return { type: CHIRP_MEDIA_TYPE_EXTENSION, value }
}

export function sumLogicalLength(children: CHIRPChildReference[]): bigint {
  let total = 0n
  for (const child of children) {
    total += child.logicalLength
    if (total > MAX_UINT64) {
      throw new CHIRPError('ERR_CHIRP_INTEGER_RANGE', 'Child lengths exceed uint64.')
    }
  }
  return total
}

function commonPrefix(nodeKind: 0 | 1): Uint8Array {
  return concat(
    CANONICAL_CHIRP_MAGIC,
    Uint8Array.of(CHIRP_MAJOR_VERSION, CHIRP_MINOR_VERSION, nodeKind)
  )
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
  if (!Array.isArray(children)) {
    throw new CHIRPError('ERR_CHIRP_FANOUT', 'CHIRP children must be an array.')
  }
  if (children.length > CHIRP_V1_MAX_CHILDREN || (!root && children.length === 0)) {
    throw new CHIRPError(
      'ERR_CHIRP_FANOUT',
      `CHIRP v1 nodes support at most ${CHIRP_V1_MAX_CHILDREN} children.`
    )
  }
  for (let index = 0; index < children.length; index++) {
    if (!Object.hasOwn(children, index)) {
      throw new CHIRPError('ERR_CHIRP_FANOUT', 'CHIRP children must be dense.')
    }
    const child = children[index]
    if (
      child === null ||
      typeof child !== 'object' ||
      (child.childKind !== 0 && child.childKind !== 1)
    ) {
      throw new CHIRPError('ERR_CHIRP_CHILD_KIND', 'Unsupported CHIRP child kind.')
    }
    if (
      typeof child.logicalLength !== 'bigint' ||
      child.logicalLength < 0n ||
      child.logicalLength > MAX_UINT64
    ) {
      throw new CHIRPError('ERR_CHIRP_INTEGER_RANGE', 'Child length is outside uint64.')
    }
    validateHash(child.objectHash)
  }
}

function validateExtensions(extensions: CHIRPExtension[], nodeKind: 0 | 1): void {
  if (!Array.isArray(extensions)) {
    throw new CHIRPError('ERR_CHIRP_EXTENSION_COUNT', 'CHIRP extensions must be an array.')
  }
  if (extensions.length > CHIRP_MAX_EXTENSIONS) {
    throw new CHIRPError('ERR_CHIRP_EXTENSION_COUNT', 'CHIRP extension count exceeds local limits.')
  }
  let previous = 0n
  let totalBytes = 0
  for (let index = 0; index < extensions.length; index++) {
    if (!Object.hasOwn(extensions, index)) {
      throw new CHIRPError('ERR_CHIRP_EXTENSION_COUNT', 'CHIRP extensions must be dense.')
    }
    const extension = extensions[index]
    if (
      extension === null ||
      typeof extension !== 'object' ||
      typeof extension.type !== 'bigint' ||
      extension.type > MAX_UINT64 ||
      !(extension.value instanceof Uint8Array)
    ) {
      throw new CHIRPError('ERR_CHIRP_EXTENSION_SIZE', 'Invalid CHIRP extension.')
    }
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
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('CHIRP node bytes must be a Uint8Array.')
  }
  if (bytes.byteLength > CHIRP_MAX_NODE_BYTES) {
    throw new CHIRPError('ERR_CHIRP_NODE_SIZE', 'CHIRP node exceeds 65,536 bytes.')
  }
}

function validateRootShape(
  logicalLength: bigint,
  children: CHIRPChildReference[],
  contentHash: Uint8Array
): void {
  if (
    (logicalLength === 0n && children.length !== 0) ||
    (logicalLength > 0n && children.length === 0)
  ) {
    throw new CHIRPError('ERR_CHIRP_EMPTY', 'CHIRP root has an invalid empty-stream shape.')
  }
  if (logicalLength === 0n && !equal(contentHash, EMPTY_SHA256)) {
    throw new CHIRPError('ERR_CHIRP_CONTENT_HASH', 'Empty CHIRP root has an invalid content hash.')
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
    if (count > BigInt(CHIRP_V1_MAX_CHILDREN)) {
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
    if (count > BigInt(CHIRP_MAX_EXTENSIONS)) {
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
