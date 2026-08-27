export type CHIRPNodeKind = 0 | 1
export type CHIRPChildKind = 0 | 1

export interface CHIRPChildReference {
  childKind: CHIRPChildKind
  logicalLength: bigint
  objectHash: Uint8Array
}

export interface CHIRPExtension {
  type: bigint
  value: Uint8Array
}

export interface CHIRPRootNode {
  majorVersion: number
  minorVersion: number
  nodeKind: 0
  chunkingProfile: number
  logicalLength: bigint
  contentHash: Uint8Array
  children: CHIRPChildReference[]
  extensions: CHIRPExtension[]
}

export interface CHIRPBranchNode {
  majorVersion: number
  minorVersion: number
  nodeKind: 1
  logicalLength: bigint
  children: CHIRPChildReference[]
  extensions: CHIRPExtension[]
}

export type CHIRPNode = CHIRPRootNode | CHIRPBranchNode

export interface CHIRPObjectSink {
  putObject(
    objectIdentifier: string,
    bytes: Uint8Array,
    kind: 'blob' | 'branch' | 'root'
  ): Promise<void>
}

export type CHIRPByteSource =
  Uint8Array | number[] | Blob | ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>

export interface CHIRPBuildOptions {
  mediaType?: string
  sink?: CHIRPObjectSink
}

export interface CHIRPBuildResult {
  chirpURL: string
  rootIdentifier: string
  rootBytes: Uint8Array
  root: CHIRPRootNode
  contentHash: Uint8Array
  logicalLength: bigint
  objectCount: number
}

export interface CHIRPObjectCache {
  get(objectIdentifier: string): Uint8Array | undefined | Promise<Uint8Array | undefined>
  set(objectIdentifier: string, bytes: Uint8Array): void | Promise<void>
}

export interface CHIRPRange {
  start: bigint
  endExclusive: bigint
}

export interface CHIRPVerifiedChunk {
  data: Uint8Array
  logicalOffset: bigint
  objectIdentifier: string
}

export interface CHIRPDownloadResult {
  data: Uint8Array
  mediaType: string | null
  logicalLength: bigint
  contentHash: Uint8Array
  rootIdentifier: string
  profileCanonical: boolean
}

export interface CHIRPClosureValidation {
  root: CHIRPRootNode
  rootBytes: Uint8Array
  rootIdentifier: string
  closure: string[]
  nodeIdentifiers: string[]
  logicalLength: bigint
  contentHash: Uint8Array
  profileCanonical: boolean
}

export type CHIRPObjectLoader = (objectIdentifier: string) => Promise<Uint8Array>
