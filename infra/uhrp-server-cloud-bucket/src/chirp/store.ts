import { Storage, type Bucket, type File } from '@google-cloud/storage'
import { createHash, randomUUID } from 'node:crypto'
import { objectIdentifierForHash } from './core/hash'
import { CHIRPError } from './core/errors'
import { ChirpCommitIndex } from './commitIndex'
import type {
  ChirpCommitRecord,
  ChirpObjectRead,
  ChirpSession,
  ChirpStageResult,
  ChirpStore
} from './contracts'
import { log } from '../logger'

const PREFIX = 'chirp/v1'
const IDENTIFIER = /^[1-9A-HJ-NP-Za-km-z]{40,128}$/
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STAGING_SECONDS = positiveEnvironment('CHIRP_STAGING_SECONDS', 86_400)
const GC_INTERVAL_MS = positiveEnvironment('CHIRP_GC_INTERVAL_MS', 15 * 60 * 1000)
const GC_MAX_ENTRIES = positiveEnvironment('CHIRP_GC_MAX_ENTRIES', 100_000)
const COMMIT_CACHE_ROOTS = positiveEnvironment('CHIRP_COMMIT_CACHE_ROOTS', 128)
const COMMIT_CACHE_OBJECTS = positiveEnvironment('CHIRP_COMMIT_CACHE_OBJECTS', 200_000)
const COMMIT_CACHE_SECONDS = positiveEnvironment('CHIRP_COMMIT_CACHE_SECONDS', 30)
const LOCK_SECONDS = 300

class CloudBucketChirpStore implements ChirpStore {
  private readonly storage: Storage
  private readonly commitIndex = new ChirpCommitIndex(
    COMMIT_CACHE_ROOTS,
    COMMIT_CACHE_OBJECTS,
    COMMIT_CACHE_SECONDS
  )

  constructor() {
    const credentials = process.env.GCP_STORAGE_CREDS
    this.storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID,
      credentials: credentials == null || credentials === '' ? undefined : JSON.parse(credentials)
    })
  }

  async createSession(
    identityKey: string,
    retentionSeconds: string,
    logicalLength: string | null
  ): Promise<ChirpSession> {
    const now = Math.floor(Date.now() / 1000)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const uploadId = randomUUID()
      const session: ChirpSession = {
        uploadId,
        identityFingerprint: fingerprintIdentity(identityKey),
        retentionSeconds,
        logicalLength,
        createdAt: now,
        stagingExpiresAt: now + STAGING_SECONDS
      }
      try {
        await this.file(sessionName(uploadId)).save(JSON.stringify(session), {
          resumable: false,
          contentType: 'application/json',
          preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { customTime: isoTime(session.stagingExpiresAt) }
        })
        return session
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error
      }
    }
    throw new CHIRPError('ERR_CHIRP_SESSION', 'Unable to allocate a CHIRP upload session.')
  }

  async getSession(uploadId: string, identityKey: string): Promise<ChirpSession | null> {
    if (!UPLOAD_ID.test(uploadId)) return null
    const session = await this.readJSON<ChirpSession>(sessionName(uploadId))
    if (session?.identityFingerprint !== fingerprintIdentity(identityKey)) return null
    if (session.stagingExpiresAt <= Math.floor(Date.now() / 1000)) return null
    return session
  }

  async hasStagedObject(
    uploadId: string,
    identityKey: string,
    objectIdentifier: string
  ): Promise<boolean> {
    if (
      (await this.getSession(uploadId, identityKey)) == null ||
      !IDENTIFIER.test(objectIdentifier)
    )
      return false
    const [exists] = await this.file(markerName(uploadId, objectIdentifier)).exists()
    return exists
  }

  async stageObject(
    uploadId: string,
    identityKey: string,
    objectIdentifier: string,
    source: AsyncIterable<Uint8Array>,
    declaredLength: number | null,
    maximumBytes: number
  ): Promise<ChirpStageResult> {
    const session = await this.getSession(uploadId, identityKey)
    if (session == null || !IDENTIFIER.test(objectIdentifier)) {
      drain(source)
      return session == null ? 'session_missing' : 'digest_mismatch'
    }
    if (await this.hasStagedObject(uploadId, identityKey, objectIdentifier)) {
      drain(source)
      return 'exists'
    }
    const staged = await bufferObjectSource(source, declaredLength, maximumBytes)
    if (typeof staged === 'string') return staged
    const actualIdentifier = objectIdentifierForHash(staged.digest)
    if (actualIdentifier !== objectIdentifier) return 'digest_mismatch'
    const object = this.file(objectName(objectIdentifier))
    try {
      await object.save(Buffer.concat(staged.chunks, staged.length), {
        resumable: false,
        contentType: 'application/octet-stream',
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { customTime: isoTime(session.stagingExpiresAt) }
      })
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error
      await extendCustomTime(object, session.stagingExpiresAt)
    }
    try {
      await this.file(markerName(uploadId, objectIdentifier)).save('', {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { customTime: isoTime(session.stagingExpiresAt) }
      })
      return 'created'
    } catch (error) {
      if (isPreconditionFailure(error)) return 'exists'
      throw error
    }
  }

  async readStagedObject(
    uploadId: string,
    identityKey: string,
    objectIdentifier: string
  ): Promise<Uint8Array> {
    if (!(await this.hasStagedObject(uploadId, identityKey, objectIdentifier))) {
      throw new CHIRPError(
        'ERR_CHIRP_MISSING_OBJECT',
        'Object is not available to this upload session.'
      )
    }
    const [bytes] = await this.file(objectName(objectIdentifier)).download()
    return Uint8Array.from(bytes)
  }

  async withCommitLock<T>(uploadId: string, operation: () => Promise<T>): Promise<T> {
    if (!UPLOAD_ID.test(uploadId))
      throw new CHIRPError('ERR_CHIRP_SESSION', 'Invalid upload session.')
    const lock = this.file(lockName(uploadId))
    const generation = await acquireCommitLock(lock)
    if (generation == null)
      throw new CHIRPError('ERR_CHIRP_COMMIT_BUSY', 'CHIRP commit is already in progress.')
    try {
      return await operation()
    } finally {
      await lock.delete({ ignoreNotFound: true, ifGenerationMatch: generation }).catch(() => {})
    }
  }

  async getCommit(rootIdentifier: string): Promise<ChirpCommitRecord | null> {
    return IDENTIFIER.test(rootIdentifier)
      ? await this.readJSON<ChirpCommitRecord>(rootName(rootIdentifier))
      : null
  }

  async prepareCommit(record: ChirpCommitRecord): Promise<void> {
    await mapLimited(record.closure, 16, async identifier => {
      const object = this.file(objectName(identifier))
      const [exists] = await object.exists()
      if (!exists)
        throw new CHIRPError(
          'ERR_CHIRP_MISSING_OBJECT',
          'Cannot lease an incomplete CHIRP closure.'
        )
      await extendCustomTime(object, record.expiryTime)
    })
    await this.writeJSON(rootName(record.rootIdentifier), record, record.expiryTime)
    this.commitIndex.invalidate(record.rootIdentifier)
  }

  async activateCommit(rootIdentifier: string): Promise<void> {
    const record = await this.getCommit(rootIdentifier)
    if (record == null) throw new CHIRPError('ERR_CHIRP_COMMIT', 'Missing pending commit.')
    record.state = 'active'
    await this.writeJSON(rootName(rootIdentifier), record, record.expiryTime)
    this.commitIndex.set(record)
  }

  async abortCommit(rootIdentifier: string): Promise<void> {
    const record = await this.getCommit(rootIdentifier)
    if (record?.state === 'pending') {
      await this.file(rootName(rootIdentifier)).delete({ ignoreNotFound: true })
    }
    this.commitIndex.invalidate(rootIdentifier)
  }

  async getCommittedObject(
    rootIdentifier: string,
    objectIdentifier: string
  ): Promise<ChirpObjectRead | null> {
    const membership = await this.commitIndex.get(
      rootIdentifier,
      async () => await this.getCommit(rootIdentifier)
    )
    const record = membership?.record
    if (
      record?.state !== 'active' ||
      record.expiryTime <= Math.floor(Date.now() / 1000) ||
      membership == null ||
      !membership.closure.has(objectIdentifier)
    )
      return null
    const file = this.file(objectName(objectIdentifier))
    const [metadata] = await file.getMetadata().catch(() => [null])
    const length = Number(metadata?.size)
    if (!Number.isSafeInteger(length) || length < 0) return null
    return {
      length,
      contentType: membership.nodeIdentifiers.has(objectIdentifier)
        ? 'application/vnd.bsv.chirp-node'
        : 'application/octet-stream',
      expiryTime: record.expiryTime,
      stream: file.createReadStream({ validation: true })
    }
  }

  async extendRootLease(rootIdentifier: string, expiryTime: number): Promise<boolean> {
    const record = await this.getCommit(rootIdentifier)
    if (record?.state !== 'active') return false
    if (expiryTime > record.expiryTime) {
      record.expiryTime = expiryTime
      await mapLimited(record.closure, 16, async identifier => {
        await extendCustomTime(this.file(objectName(identifier)), expiryTime)
      })
      await this.writeJSON(rootName(rootIdentifier), record, expiryTime)
      this.commitIndex.set(record)
    }
    return true
  }

  async collectGarbage(): Promise<void> {
    const bucket = this.bucket()
    const [files] = await bucket.getFiles({
      prefix: `${PREFIX}/`,
      maxResults: GC_MAX_ENTRIES + 1
    })
    if (files.length > GC_MAX_ENTRIES) {
      log.warn(
        { operation: 'chirp.gc', outcome: 'bounded', entries: files.length },
        'CHIRP GC entry bound reached'
      )
      return
    }
    const now = Math.floor(Date.now() / 1000)
    const live = new Set<string>()
    const sessions = files.filter(file => /\/uploads\/[^/]+\/session\.json$/.test(file.name))
    const roots = files.filter(file => /\/roots\/[^/]+\.json$/.test(file.name))
    await collectLiveCloudSessions(bucket, files, sessions, live, now)
    await collectLiveCloudRoots(roots, live, now)
    await deleteUnreferencedCloudObjects(files, live)
    log.info(
      { operation: 'chirp.gc', live_objects: live.size },
      'CHIRP garbage collection completed'
    )
  }

  private bucket() {
    const name = process.env.GCP_BUCKET_NAME
    if (name == null || name === '')
      throw new CHIRPError('ERR_CHIRP_BUCKET', 'GCP_BUCKET_NAME is required.')
    return this.storage.bucket(name)
  }

  private file(name: string): File {
    return this.bucket().file(name)
  }

  private async readJSON<T>(name: string): Promise<T | null> {
    return await downloadJSON<T>(this.file(name))
  }

  private async writeJSON(name: string, value: unknown, expiryTime: number): Promise<void> {
    await this.file(name).save(JSON.stringify(value), {
      resumable: false,
      contentType: 'application/json',
      metadata: { customTime: isoTime(expiryTime) }
    })
  }
}

async function bufferObjectSource(
  source: AsyncIterable<Uint8Array>,
  declaredLength: number | null,
  maximumBytes: number
): Promise<
  { chunks: Buffer[]; digest: Uint8Array; length: number } | 'too_large' | 'size_mismatch'
> {
  const chunks: Buffer[] = []
  const hasher = createHash('sha256')
  let length = 0
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.byteLength
    if (length > maximumBytes || (declaredLength != null && length > declaredLength)) {
      return 'too_large'
    }
    chunks.push(bytes)
    hasher.update(bytes)
  }
  if (declaredLength != null && length !== declaredLength) return 'size_mismatch'
  return { chunks, digest: Uint8Array.from(hasher.digest()), length }
}

async function acquireCommitLock(lock: File): Promise<number | undefined> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await lock.save(String(Date.now()), {
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: { customTime: isoTime(Math.floor(Date.now() / 1000) + LOCK_SECONDS) }
      })
      const [metadata] = await lock.getMetadata()
      return Number(metadata.generation)
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error
      const [metadata] = await lock.getMetadata().catch(() => [null])
      const customTime = metadata?.customTime == null ? 0 : Date.parse(metadata.customTime)
      if (customTime > 0 && customTime <= Date.now()) {
        await lock.delete({ ignoreNotFound: true })
      } else {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
  return undefined
}

async function collectLiveCloudSessions(
  bucket: Bucket,
  allFiles: File[],
  sessions: File[],
  live: Set<string>,
  now: number
): Promise<void> {
  for (const file of sessions) {
    const session = await downloadJSON<ChirpSession>(file)
    const prefix = file.name.slice(0, -'session.json'.length)
    if (session == null || session.stagingExpiresAt <= now) {
      await deletePrefix(bucket, prefix)
      continue
    }
    const markers = allFiles.filter(candidate => candidate.name.startsWith(`${prefix}objects/`))
    for (const marker of markers) {
      const identifier = marker.name.split('/').at(-1)
      if (identifier != null && IDENTIFIER.test(identifier)) live.add(identifier)
    }
  }
}

async function collectLiveCloudRoots(roots: File[], live: Set<string>, now: number): Promise<void> {
  for (const file of roots) {
    const record = await downloadJSON<ChirpCommitRecord>(file)
    const pendingExpired = record?.state === 'pending' && record.preparedAt + STAGING_SECONDS <= now
    if (record == null || record.expiryTime <= now || pendingExpired) {
      await file.delete({ ignoreNotFound: true })
      continue
    }
    for (const identifier of record.closure) live.add(identifier)
  }
}

async function deleteUnreferencedCloudObjects(files: File[], live: Set<string>): Promise<void> {
  const objects = files.filter(candidate => candidate.name.startsWith(`${PREFIX}/objects/`))
  for (const file of objects) {
    const identifier = file.name.split('/').at(-1)
    if (identifier == null || live.has(identifier)) continue
    const [metadata] = await file.getMetadata().catch(() => [null])
    const customTime =
      metadata?.customTime == null ? Number.POSITIVE_INFINITY : Date.parse(metadata.customTime)
    if (customTime <= Date.now()) await file.delete({ ignoreNotFound: true })
  }
}

let singleton: CloudBucketChirpStore | undefined

export function getChirpStore(): ChirpStore {
  singleton ??= new CloudBucketChirpStore()
  return singleton
}

export function startChirpGarbageCollector(): () => void {
  const store = getChirpStore()
  void store.collectGarbage().catch(error => {
    log.error(
      { operation: 'chirp.gc', outcome: 'error', err: error },
      'Initial CHIRP garbage collection failed'
    )
  })
  const timer = setInterval(() => {
    void store.collectGarbage().catch(error => {
      log.error(
        { operation: 'chirp.gc', outcome: 'error', err: error },
        'CHIRP garbage collection failed'
      )
    })
  }, GC_INTERVAL_MS)
  timer.unref()
  return () => clearInterval(timer)
}

function sessionName(uploadId: string): string {
  return `${PREFIX}/uploads/${uploadId}/session.json`
}

function markerName(uploadId: string, identifier: string): string {
  return `${PREFIX}/uploads/${uploadId}/objects/${identifier}`
}

function lockName(uploadId: string): string {
  return `${PREFIX}/uploads/${uploadId}/commit.lock`
}

function objectName(identifier: string): string {
  return `${PREFIX}/objects/${identifier}`
}

function rootName(identifier: string): string {
  return `${PREFIX}/roots/${identifier}.json`
}

function isoTime(seconds: number): string {
  return new Date((seconds + 300) * 1000).toISOString()
}

async function downloadJSON<T>(file: File): Promise<T | null> {
  try {
    const [bytes] = await file.download()
    return JSON.parse(bytes.toString('utf8')) as T
  } catch (error) {
    if (isNotFound(error)) return null
    throw error
  }
}

async function extendCustomTime(file: File, expiryTime: number): Promise<void> {
  const [metadata] = await file.getMetadata()
  const current = metadata.customTime == null ? 0 : Date.parse(metadata.customTime)
  const proposed = (expiryTime + 300) * 1000
  if (proposed > current) await file.setMetadata({ customTime: new Date(proposed).toISOString() })
}

async function deletePrefix(bucket: Bucket, prefix: string): Promise<void> {
  const [files] = await bucket.getFiles({ prefix })
  await mapLimited(files, 16, async file => {
    await file.delete({ ignoreNotFound: true })
  })
}

async function mapLimited<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>
): Promise<void> {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next
        next += 1
        await operation(values[index])
      }
    })
  )
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (Number((error as { code: unknown }).code) === 409 ||
      Number((error as { code: unknown }).code) === 412)
  )
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Number((error as { code: unknown }).code) === 404
  )
}

function fingerprintIdentity(identityKey: string): string {
  return createHash('sha256').update(identityKey, 'utf8').digest('hex')
}

function positiveEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer.`)
  return value
}

function drain(source: AsyncIterable<Uint8Array>): void {
  void (async () => {
    for await (const _chunk of source) {
      // Drain rejected request bodies to permit connection reuse.
    }
  })().catch(() => {})
}
