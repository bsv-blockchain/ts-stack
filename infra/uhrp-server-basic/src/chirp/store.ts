import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import path from 'node:path'
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
import { writeBytesFully } from '../utils/writeBytesFully'

const DATA_ROOT = path.resolve(process.env.CHIRP_DATA_DIR ?? path.join(process.cwd(), 'data/chirp'))
const OBJECTS_ROOT = path.join(DATA_ROOT, 'objects')
const UPLOADS_ROOT = path.join(DATA_ROOT, 'uploads')
const ROOTS_ROOT = path.join(DATA_ROOT, 'roots')
const ROOT_LOCKS_ROOT = path.join(ROOTS_ROOT, '.locks')
const IDENTIFIER = /^[1-9A-HJ-NP-Za-km-z]{40,128}$/
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const STAGING_SECONDS = positiveEnvironment('CHIRP_STAGING_SECONDS', 86_400)
const GC_INTERVAL_MS = positiveEnvironment('CHIRP_GC_INTERVAL_MS', 15 * 60 * 1000)
const GC_MAX_ENTRIES = positiveEnvironment('CHIRP_GC_MAX_ENTRIES', 100_000)
const MAX_ACTIVE_SESSIONS = positiveEnvironment('CHIRP_MAX_ACTIVE_SESSIONS', 1_024)
const MAX_ACTIVE_SESSIONS_PER_IDENTITY = positiveEnvironment(
  'CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY',
  8
)
const MAX_STAGED_OBJECTS_PER_SESSION = positiveEnvironment(
  'CHIRP_MAX_STAGED_OBJECTS_PER_SESSION',
  4_096
)
const MIN_FREE_BYTES = nonNegativeEnvironment('CHIRP_MIN_FREE_BYTES', 1_073_741_824)
const COMMIT_CACHE_ROOTS = positiveEnvironment('CHIRP_COMMIT_CACHE_ROOTS', 128)
const COMMIT_CACHE_OBJECTS = positiveEnvironment('CHIRP_COMMIT_CACHE_OBJECTS', 200_000)
const COMMIT_CACHE_SECONDS = positiveEnvironment('CHIRP_COMMIT_CACHE_SECONDS', 30)
const FILESYSTEM_LOCK_ATTEMPTS = 50
const FILESYSTEM_LOCK_RETRY_MS = 100
const FILESYSTEM_LOCK_HEARTBEAT_MS = 60_000

class FilesystemChirpStore implements ChirpStore {
  private readonly commitIndex = new ChirpCommitIndex(
    COMMIT_CACHE_ROOTS,
    COMMIT_CACHE_OBJECTS,
    COMMIT_CACHE_SECONDS
  )

  async createSession(
    identityKey: string,
    retentionSeconds: string,
    logicalLength: string | null
  ): Promise<ChirpSession> {
    await this.ensureRoots()
    return await withFilesystemLock(
      path.join(DATA_ROOT, '.sessions.lock'),
      'ERR_CHIRP_SESSION_BUSY',
      async () => {
        const now = Math.floor(Date.now() / 1000)
        const identityFingerprint = fingerprintIdentity(identityKey)
        await enforceSessionQuota(identityFingerprint, now)
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const uploadId = randomUUID()
          const directory = uploadDirectory(uploadId)
          try {
            await fs.mkdir(directory, { recursive: false, mode: 0o700 })
            await fs.mkdir(path.join(directory, 'objects'), { mode: 0o700 })
            const session: ChirpSession = {
              uploadId,
              identityFingerprint,
              retentionSeconds,
              logicalLength,
              createdAt: now,
              stagingExpiresAt: now + STAGING_SECONDS
            }
            await writeJSONAtomic(path.join(directory, 'session.json'), session)
            return session
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          }
        }
        throw new CHIRPError('ERR_CHIRP_SESSION', 'Unable to allocate a CHIRP upload session.')
      }
    )
  }

  async getSession(uploadId: string, identityKey: string): Promise<ChirpSession | null> {
    const directory = safeUploadDirectory(uploadId)
    if (directory == null) return null
    const session = await readJSON<ChirpSession>(path.join(directory, 'session.json'))
    if (session?.identityFingerprint !== fingerprintIdentity(identityKey)) return null
    if (session.stagingExpiresAt <= Math.floor(Date.now() / 1000)) return null
    return session
  }

  async hasStagedObject(
    uploadId: string,
    identityKey: string,
    objectIdentifier: string
  ): Promise<boolean> {
    if ((await this.getSession(uploadId, identityKey)) == null) return false
    const marker = stagedMarker(uploadId, objectIdentifier)
    if (marker == null) return false
    return await exists(marker)
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
    const marker = stagedMarker(uploadId, objectIdentifier)
    const objectPath = globalObjectPath(objectIdentifier)
    if (session == null || marker == null || objectPath == null) {
      drain(source)
      return session == null ? 'session_missing' : 'digest_mismatch'
    }
    await this.ensureRoots()
    try {
      return await withFilesystemLock(
        path.join(uploadDirectory(uploadId), '.stage.lock'),
        'ERR_CHIRP_UPLOAD_BUSY',
        async () => {
          if ((await this.getSession(uploadId, identityKey)) == null) {
            drain(source)
            return 'session_missing'
          }
          if (await exists(marker)) {
            drain(source)
            return 'exists'
          }
          const markers = await fs.readdir(path.dirname(marker)).catch(() => [])
          if (
            markers.filter(identifier => IDENTIFIER.test(identifier)).length >=
            MAX_STAGED_OBJECTS_PER_SESSION
          ) {
            drain(source)
            return 'quota_exceeded'
          }
          // Serialize the reserve check and maximum-sized write across every
          // upload session (and process sharing DATA_ROOT). This turns the
          // statfs check into an actual reservation: while the lock is held no
          // sibling upload can independently spend the same free bytes.
          return await withFilesystemLock(
            path.join(DATA_ROOT, '.storage-reserve.lock'),
            'ERR_CHIRP_UPLOAD_BUSY',
            async () => {
              if (!(await hasStorageReserve(maximumBytes))) {
                drain(source)
                return 'insufficient_storage'
              }

              const temporary = path.join(DATA_ROOT, `.object.${randomUUID()}.tmp`)
              const handle = await fs.open(temporary, 'wx', 0o600)
              try {
                const staged = await writeObjectSource(handle, source, declaredLength, maximumBytes)
                if (typeof staged === 'string') return staged
                const actualIdentifier = objectIdentifierForHash(staged.digest)
                if (actualIdentifier !== objectIdentifier) return 'digest_mismatch'
                await handle.sync()
                await handle.close()
                try {
                  await fs.link(temporary, objectPath)
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                }
                try {
                  await fs.writeFile(containedDataPath(marker), '', { flag: 'wx', mode: 0o600 })
                  return 'created'
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
                  throw error
                }
              } finally {
                await handle.close().catch(() => {})
                await fs.rm(temporary, { force: true })
              }
            }
          )
        }
      )
    } catch (error) {
      if (error instanceof CHIRPError && error.code === 'ERR_CHIRP_UPLOAD_BUSY') {
        drain(source)
        return 'busy'
      }
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
    const objectPath = globalObjectPath(objectIdentifier)
    if (objectPath == null)
      throw new CHIRPError('ERR_CHIRP_IDENTIFIER', 'Invalid object identifier.')
    return Uint8Array.from(await fs.readFile(objectPath))
  }

  async withCommitLock<T>(
    uploadId: string,
    rootIdentifier: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const directory = safeUploadDirectory(uploadId)
    const rootPath = rootRecordPath(rootIdentifier)
    if (directory == null || rootPath == null) {
      throw new CHIRPError('ERR_CHIRP_SESSION', 'Invalid upload session or root identifier.')
    }
    await this.ensureRoots()
    return await withFilesystemLock(
      path.join(directory, '.commit.lock'),
      'ERR_CHIRP_COMMIT_BUSY',
      async () =>
        await withFilesystemLock(
          path.join(ROOT_LOCKS_ROOT, `${rootIdentifier}.lock`),
          'ERR_CHIRP_COMMIT_BUSY',
          operation
        )
    )
  }

  async getCommit(rootIdentifier: string): Promise<ChirpCommitRecord | null> {
    const recordPath = rootRecordPath(rootIdentifier)
    if (recordPath == null) return null
    return await readJSON<ChirpCommitRecord>(recordPath)
  }

  async prepareCommit(record: ChirpCommitRecord): Promise<void> {
    await this.ensureRoots()
    for (const identifier of record.closure) {
      const objectPath = globalObjectPath(identifier)
      if (objectPath == null || !(await exists(objectPath))) {
        throw new CHIRPError(
          'ERR_CHIRP_MISSING_OBJECT',
          'Cannot lease an incomplete CHIRP closure.'
        )
      }
    }
    const recordPath = rootRecordPath(record.rootIdentifier)
    if (recordPath == null) throw new CHIRPError('ERR_CHIRP_IDENTIFIER', 'Invalid root identifier.')
    await writeJSONAtomic(recordPath, record)
    this.commitIndex.invalidate(record.rootIdentifier)
  }

  async activateCommit(rootIdentifier: string): Promise<void> {
    const record = await this.getCommit(rootIdentifier)
    const recordPath = rootRecordPath(rootIdentifier)
    if (record == null || recordPath == null)
      throw new CHIRPError('ERR_CHIRP_COMMIT', 'Missing pending commit.')
    record.state = 'active'
    await writeJSONAtomic(recordPath, record)
    this.commitIndex.set(record)
  }

  async abortCommit(rootIdentifier: string): Promise<void> {
    const record = await this.getCommit(rootIdentifier)
    const recordPath = rootRecordPath(rootIdentifier)
    if (record?.state === 'pending' && recordPath != null) await fs.rm(recordPath, { force: true })
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
    if (membership?.record.state !== 'active') return null
    const record = membership.record
    if (
      record.expiryTime <= Math.floor(Date.now() / 1000) ||
      !membership.closure.has(objectIdentifier)
    )
      return null
    const objectPath = globalObjectPath(objectIdentifier)
    if (objectPath == null) return null
    const stat = await fs.stat(objectPath).catch(() => null)
    if (!stat?.isFile()) return null
    return {
      length: stat.size,
      contentType: membership.nodeIdentifiers.has(objectIdentifier)
        ? 'application/vnd.bsv.chirp-node'
        : 'application/octet-stream',
      expiryTime: record.expiryTime,
      stream: createReadStream(objectPath)
    }
  }

  async extendRootLease(rootIdentifier: string, expiryTime: number): Promise<boolean> {
    const record = await this.getCommit(rootIdentifier)
    const recordPath = rootRecordPath(rootIdentifier)
    if (record == null || recordPath == null || record.state !== 'active') return false
    if (expiryTime > record.expiryTime) {
      record.expiryTime = expiryTime
      await writeJSONAtomic(recordPath, record)
      this.commitIndex.set(record)
    }
    return true
  }

  async collectGarbage(): Promise<void> {
    await this.ensureRoots()
    const now = Math.floor(Date.now() / 1000)
    const live = new Set<string>()
    const uploadIds = await fs.readdir(UPLOADS_ROOT).catch(() => [])
    const rootFiles = await fs.readdir(ROOTS_ROOT).catch(() => [])
    const objectFiles = await fs.readdir(OBJECTS_ROOT).catch(() => [])
    await collectLiveUploads(uploadIds, live, now)
    await collectLiveRoots(rootFiles, live, now)
    const objectCleanup = await deleteUnreferencedObjects(objectFiles, live, GC_MAX_ENTRIES)
    await deleteStaleTemporaryObjects(now, GC_MAX_ENTRIES)
    log.info(
      {
        operation: 'chirp.gc',
        live_objects: live.size,
        deleted_objects: objectCleanup.deleted,
        remaining_unreferenced_objects: objectCleanup.remaining
      },
      'CHIRP garbage collection completed'
    )
  }

  private async ensureRoots(): Promise<void> {
    await Promise.all([
      fs.mkdir(OBJECTS_ROOT, { recursive: true, mode: 0o700 }),
      fs.mkdir(UPLOADS_ROOT, { recursive: true, mode: 0o700 }),
      fs.mkdir(ROOTS_ROOT, { recursive: true, mode: 0o700 }),
      fs.mkdir(ROOT_LOCKS_ROOT, { recursive: true, mode: 0o700 })
    ])
  }
}

async function writeObjectSource(
  handle: Awaited<ReturnType<typeof fs.open>>,
  source: AsyncIterable<Uint8Array>,
  declaredLength: number | null,
  maximumBytes: number
): Promise<{ digest: Uint8Array } | 'too_large' | 'size_mismatch'> {
  const hasher = createHash('sha256')
  let length = 0
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += bytes.byteLength
    if (length > maximumBytes || (declaredLength != null && length > declaredLength)) {
      return 'too_large'
    }
    hasher.update(bytes)
    await writeBytesFully(handle, bytes)
  }
  if (declaredLength != null && length !== declaredLength) return 'size_mismatch'
  return { digest: Uint8Array.from(hasher.digest()) }
}

async function collectLiveUploads(
  uploadIds: string[],
  live: Set<string>,
  now: number
): Promise<void> {
  for (const uploadId of uploadIds) {
    const directory = safeUploadDirectory(uploadId)
    if (directory == null) continue
    const session = await readJSON<ChirpSession>(path.join(directory, 'session.json'))
    if (session == null || session.stagingExpiresAt <= now) {
      await fs.rm(directory, { recursive: true, force: true })
      continue
    }
    const markers = await fs.readdir(path.join(directory, 'objects')).catch(() => [])
    for (const identifier of markers) if (IDENTIFIER.test(identifier)) live.add(identifier)
  }
}

async function enforceSessionQuota(identityFingerprint: string, now: number): Promise<void> {
  const uploadIds = await fs.readdir(UPLOADS_ROOT).catch(() => [])
  let activeSessions = 0
  let identitySessions = 0
  for (const uploadId of uploadIds) {
    const directory = safeUploadDirectory(uploadId)
    if (directory == null) continue
    const session = await readJSON<ChirpSession>(path.join(directory, 'session.json'))
    if (session == null || session.stagingExpiresAt <= now) {
      await fs.rm(directory, { recursive: true, force: true })
      continue
    }
    activeSessions += 1
    if (session.identityFingerprint === identityFingerprint) identitySessions += 1
  }
  if (activeSessions >= MAX_ACTIVE_SESSIONS) {
    throw new CHIRPError(
      'ERR_CHIRP_SESSION_QUOTA',
      'The host has reached its active CHIRP upload-session limit.'
    )
  }
  if (identitySessions >= MAX_ACTIVE_SESSIONS_PER_IDENTITY) {
    throw new CHIRPError(
      'ERR_CHIRP_SESSION_QUOTA',
      'This identity has reached its active CHIRP upload-session limit.'
    )
  }
}

async function collectLiveRoots(
  rootFiles: string[],
  live: Set<string>,
  now: number
): Promise<void> {
  for (const file of rootFiles) {
    if (!file.endsWith('.json')) continue
    const recordPath = path.join(ROOTS_ROOT, file)
    const record = await readJSON<ChirpCommitRecord>(recordPath)
    const pendingExpired = record?.state === 'pending' && record.preparedAt + STAGING_SECONDS <= now
    if (record == null || record.expiryTime <= now || pendingExpired) {
      await fs.rm(recordPath, { force: true })
      continue
    }
    for (const identifier of record.closure) live.add(identifier)
  }
}

async function deleteUnreferencedObjects(
  objectFiles: string[],
  live: Set<string>,
  maximumDeletes: number
): Promise<{ deleted: number; remaining: number }> {
  let deleted = 0
  let remaining = 0
  for (const identifier of objectFiles) {
    if (IDENTIFIER.test(identifier) && !live.has(identifier)) {
      if (deleted < maximumDeletes) {
        await fs.rm(path.join(OBJECTS_ROOT, identifier), { force: true })
        deleted += 1
      } else {
        remaining += 1
      }
    }
  }
  return { deleted, remaining }
}

async function deleteStaleTemporaryObjects(now: number, maximumDeletes: number): Promise<void> {
  const entries = await fs.readdir(DATA_ROOT, { withFileTypes: true }).catch(() => [])
  let deleted = 0
  for (const entry of entries) {
    if (
      deleted >= maximumDeletes ||
      !entry.isFile() ||
      !/^\.object\.[0-9a-f-]+\.tmp$/.test(entry.name)
    ) {
      continue
    }
    const candidate = path.join(DATA_ROOT, entry.name)
    const stat = await fs.stat(candidate).catch(() => null)
    if (stat != null && Math.floor(stat.mtimeMs / 1000) + STAGING_SECONDS <= now) {
      await fs.rm(candidate, { force: true })
      deleted += 1
    }
  }
}

let singleton: FilesystemChirpStore | undefined

export function getChirpStore(): ChirpStore {
  singleton ??= new FilesystemChirpStore()
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

function uploadDirectory(uploadId: string): string {
  return path.join(UPLOADS_ROOT, uploadId)
}

function fingerprintIdentity(identityKey: string): string {
  return createHash('sha256').update(identityKey, 'utf8').digest('hex')
}

function containedDataPath(file: string): string {
  const candidate = path.resolve(file)
  const prefix = DATA_ROOT.endsWith(path.sep) ? DATA_ROOT : `${DATA_ROOT}${path.sep}`
  if (!candidate.startsWith(prefix)) {
    throw new CHIRPError('ERR_CHIRP_PATH', 'CHIRP storage path escaped its data directory.')
  }
  return candidate
}

function safeUploadDirectory(uploadId: string): string | null {
  return UPLOAD_ID.test(uploadId) ? uploadDirectory(uploadId) : null
}

function globalObjectPath(identifier: string): string | null {
  return IDENTIFIER.test(identifier) ? path.join(OBJECTS_ROOT, identifier) : null
}

function stagedMarker(uploadId: string, identifier: string): string | null {
  const directory = safeUploadDirectory(uploadId)
  return directory != null && IDENTIFIER.test(identifier)
    ? path.join(directory, 'objects', identifier)
    : null
}

function rootRecordPath(identifier: string): string | null {
  return IDENTIFIER.test(identifier) ? path.join(ROOTS_ROOT, `${identifier}.json`) : null
}

async function writeJSONAtomic(file: string, value: unknown): Promise<void> {
  const destination = containedDataPath(file)
  const temporary = containedDataPath(`${destination}.${randomUUID()}.tmp`)
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 })
    await fs.rename(temporary, destination)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function readJSON<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(containedDataPath(file), 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(containedDataPath(file))
    return true
  } catch {
    return false
  }
}

async function hasStorageReserve(maximumWriteBytes: number): Promise<boolean> {
  const stats = await fs.statfs(DATA_ROOT, { bigint: true })
  const availableBytes = stats.bavail * stats.bsize
  return availableBytes >= BigInt(MIN_FREE_BYTES) + BigInt(maximumWriteBytes)
}

async function withFilesystemLock<T>(
  file: string,
  busyCode: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = containedDataPath(file)
  const ownerToken = randomUUID()
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined
  for (let attempt = 0; attempt < FILESYSTEM_LOCK_ATTEMPTS; attempt += 1) {
    try {
      handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${ownerToken}\n`, 'utf8')
      await handle.sync()
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      await new Promise(resolve => setTimeout(resolve, FILESYSTEM_LOCK_RETRY_MS))
    }
  }
  if (handle == null) {
    throw new CHIRPError(busyCode, 'CHIRP storage operation is already in progress.')
  }
  const heartbeat = setInterval(() => {
    const now = new Date()
    void handle?.utimes(now, now).catch(() => {})
  }, FILESYSTEM_LOCK_HEARTBEAT_MS)
  heartbeat.unref()
  try {
    return await operation()
  } finally {
    clearInterval(heartbeat)
    await handle.close().catch(() => {})
    const currentOwner = await fs.readFile(lockPath, 'utf8').catch(() => null)
    if (currentOwner === `${ownerToken}\n`) await fs.rm(lockPath, { force: true })
  }
}

function positiveEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(`${name} must be a positive integer.`)
  return value
}

function nonNegativeEnvironment(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`)
  }
  return value
}

function drain(source: AsyncIterable<Uint8Array>): void {
  void (async () => {
    for await (const _chunk of source) {
      // Drain rejected request bodies to permit connection reuse.
    }
  })().catch(() => {})
}
