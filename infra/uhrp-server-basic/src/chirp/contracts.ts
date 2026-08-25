import type { Readable } from 'node:stream'

export interface ChirpSession {
  uploadId: string
  identityFingerprint: string
  retentionSeconds: string
  logicalLength: string | null
  createdAt: number
  stagingExpiresAt: number
}

export interface ChirpCommitRecord {
  rootIdentifier: string
  identityFingerprint: string
  expiryTime: number
  rootLength: number
  logicalLength: string
  closure: string[]
  nodeIdentifiers: string[]
  state: 'pending' | 'active'
  preparedAt: number
}

export interface ChirpObjectRead {
  length: number
  contentType: 'application/vnd.bsv.chirp-node' | 'application/octet-stream'
  expiryTime: number
  stream: Readable
}

export type ChirpStageResult =
  | 'created'
  | 'exists'
  | 'session_missing'
  | 'digest_mismatch'
  | 'size_mismatch'
  | 'too_large'

export interface ChirpStore {
  createSession(
    identityKey: string,
    retentionSeconds: string,
    logicalLength: string | null
  ): Promise<ChirpSession>
  getSession(uploadId: string, identityKey: string): Promise<ChirpSession | null>
  hasStagedObject(uploadId: string, identityKey: string, objectIdentifier: string): Promise<boolean>
  stageObject(
    uploadId: string,
    identityKey: string,
    objectIdentifier: string,
    source: AsyncIterable<Uint8Array>,
    declaredLength: number | null,
    maximumBytes: number
  ): Promise<ChirpStageResult>
  readStagedObject(uploadId: string, identityKey: string, objectIdentifier: string): Promise<Uint8Array>
  withCommitLock<T>(uploadId: string, operation: () => Promise<T>): Promise<T>
  getCommit(rootIdentifier: string): Promise<ChirpCommitRecord | null>
  prepareCommit(record: ChirpCommitRecord): Promise<void>
  activateCommit(rootIdentifier: string): Promise<void>
  abortCommit(rootIdentifier: string): Promise<void>
  getCommittedObject(rootIdentifier: string, objectIdentifier: string): Promise<ChirpObjectRead | null>
  extendRootLease(rootIdentifier: string, expiryTime: number): Promise<void>
  collectGarbage(): Promise<void>
}
