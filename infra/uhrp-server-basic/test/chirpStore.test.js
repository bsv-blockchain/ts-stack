const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-store-'))
process.env.CHIRP_DATA_DIR = dataRoot
process.env.CHIRP_GC_MAX_ENTRIES = '2'
process.env.CHIRP_MAX_ACTIVE_SESSIONS = '8'
process.env.CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY = '2'
process.env.CHIRP_MAX_STAGED_OBJECTS_PER_SESSION = '2'
process.env.CHIRP_MIN_FREE_BYTES = '0'

const { encodeRootNode } = require('../out/src/chirp/core/codec.js')
const {
  objectIdentifierForBytes,
  sha256
} = require('../out/src/chirp/core/hash.js')
const { getChirpStore } = require('../out/src/chirp/store.js')
const routes = require('../out/src/routes/index.js').default

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  delete process.env.CHIRP_DATA_DIR
  delete process.env.CHIRP_GC_MAX_ENTRIES
  delete process.env.CHIRP_MAX_ACTIVE_SESSIONS
  delete process.env.CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY
  delete process.env.CHIRP_MAX_STAGED_OBJECTS_PER_SESSION
  delete process.env.CHIRP_MIN_FREE_BYTES
})

test('stages, validates, leases, and serves a complete filesystem closure', async () => {
  const store = getChirpStore()
  const blob = Buffer.from('complete closure')
  const blobIdentifier = objectIdentifierForBytes(blob)
  const rootBytes = encodeRootNode({
    chunkingProfile: 1,
    logicalLength: BigInt(blob.length),
    contentHash: sha256(blob),
    children: [{
      childKind: 0,
      logicalLength: BigInt(blob.length),
      objectHash: sha256(blob)
    }],
    extensions: []
  })
  const rootIdentifier = objectIdentifierForBytes(rootBytes)
  const identityFingerprint = crypto.createHash('sha256').update('test-identity').digest('hex')
  const session = await store.createSession('test-identity', '3600', String(blob.length))
  const persistedSession = fs.readFileSync(
    path.join(dataRoot, 'uploads', session.uploadId, 'session.json'),
    'utf8'
  )
  expect(persistedSession).not.toContain('test-identity')
  expect(JSON.parse(persistedSession).identityFingerprint).toBe(identityFingerprint)

  await expect(store.stageObject(
    session.uploadId,
    'test-identity',
    blobIdentifier,
    Readable.from([blob]),
    blob.length,
    4_194_304
  )).resolves.toBe('created')
  await expect(store.stageObject(
    session.uploadId,
    'test-identity',
    rootIdentifier,
    Readable.from([rootBytes]),
    rootBytes.length,
    4_194_304
  )).resolves.toBe('created')

  const expiryTime = Math.floor(Date.now() / 1000) + 3600
  await store.prepareCommit({
    rootIdentifier,
    identityFingerprint,
    expiryTime,
    rootLength: rootBytes.length,
    logicalLength: String(blob.length),
    closure: [rootIdentifier, blobIdentifier],
    nodeIdentifiers: [rootIdentifier],
    state: 'pending',
    preparedAt: Math.floor(Date.now() / 1000)
  })
  await store.activateCommit(rootIdentifier)

  const hosted = await store.getCommittedObject(rootIdentifier, blobIdentifier)
  expect(hosted).not.toBeNull()
  expect(hosted.contentType).toBe('application/octet-stream')
  const chunks = []
  for await (const chunk of hosted.stream) chunks.push(chunk)
  expect(Buffer.concat(chunks)).toEqual(blob)

  await store.extendRootLease(rootIdentifier, expiryTime + 60)
  await expect(store.getCommit(rootIdentifier)).resolves.toMatchObject({
    state: 'active',
    expiryTime: expiryTime + 60
  })
  await store.collectGarbage()
  const hostedRoot = await store.getCommittedObject(rootIdentifier, rootIdentifier)
  expect(hostedRoot).not.toBeNull()
  const rootChunks = []
  for await (const chunk of hostedRoot.stream) rootChunks.push(chunk)
  expect(Buffer.concat(rootChunks)).toEqual(Buffer.from(rootBytes))
})

test('keeps legacy UHRP routes while adding the CHIRP capability', () => {
  const preAuth = routes.preAuth.map(route => route.path)
  const postAuth = routes.postAuth.map(route => route.path)
  expect(preAuth).toEqual(expect.arrayContaining([
    '/put',
    '/quote',
    '/chirp/v1/openapi.json',
    '/chirp/v1/:rootIdentifier/objects/:objectIdentifier'
  ]))
  expect(postAuth).toEqual(expect.arrayContaining([
    '/upload',
    '/list',
    '/renew',
    '/find',
    '/chirp/v1/uploads',
    '/chirp/v1/uploads/:uploadId/commit'
  ]))
})

test('bounds active sessions per authenticated identity', async () => {
  const store = getChirpStore()
  await expect(store.createSession('test-identity', '3600', null)).resolves.toBeDefined()
  await expect(store.createSession('test-identity', '3600', null)).rejects.toMatchObject({
    code: 'ERR_CHIRP_SESSION_QUOTA'
  })
})

test('bounds staged objects per session without consuming a rejected body', async () => {
  const store = getChirpStore()
  const session = await store.createSession('quota-identity', '3600', null)
  for (const value of ['quota-one', 'quota-two']) {
    const bytes = Buffer.from(value)
    await expect(
      store.stageObject(
        session.uploadId,
        'quota-identity',
        objectIdentifierForBytes(bytes),
        Readable.from([bytes]),
        bytes.length,
        4_194_304
      )
    ).resolves.toBe('created')
  }
  const rejected = Buffer.from('quota-three')
  await expect(
    store.stageObject(
      session.uploadId,
      'quota-identity',
      objectIdentifierForBytes(rejected),
      Readable.from([rejected]),
      rejected.length,
      4_194_304
    )
  ).resolves.toBe('quota_exceeded')
})

test('continues bounded garbage collection after the entry threshold is crossed', async () => {
  const store = getChirpStore()
  const identifiers = Array.from({ length: 5 }, (_, index) => {
    const bytes = Buffer.from(`unreferenced-${index}`)
    const identifier = objectIdentifierForBytes(bytes)
    fs.writeFileSync(path.join(dataRoot, 'objects', identifier), bytes)
    return identifier
  })

  for (let pass = 0; pass < 3; pass += 1) await store.collectGarbage()

  for (const identifier of identifiers) {
    expect(fs.existsSync(path.join(dataRoot, 'objects', identifier))).toBe(false)
  }
})

test('serializes commits for the same root across independent upload sessions', async () => {
  const store = getChirpStore()
  const firstSession = await store.createSession('root-lock-one', '3600', null)
  const secondSession = await store.createSession('root-lock-two', '3600', null)
  const rootIdentifier = objectIdentifierForBytes(Buffer.from('shared-root-lock'))
  let active = 0
  let maximumActive = 0
  const operation = async () => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    await new Promise(resolve => setTimeout(resolve, 150))
    active -= 1
  }

  await Promise.all([
    store.withCommitLock(firstSession.uploadId, rootIdentifier, operation),
    store.withCommitLock(secondSession.uploadId, rootIdentifier, operation)
  ])

  expect(maximumActive).toBe(1)
})

test('preserves a stale canonical lock instead of deleting a successor-prone path', async () => {
  const store = getChirpStore()
  const session = await store.createSession('stale-lock-fail-closed', '3600', null)
  const rootIdentifier = objectIdentifierForBytes(Buffer.from('stale-lock-root'))
  const lockDirectory = path.join(dataRoot, 'roots', '.locks')
  fs.mkdirSync(lockDirectory, { recursive: true })
  const lockPath = path.join(lockDirectory, `${rootIdentifier}.lock`)
  fs.writeFileSync(lockPath, 'orphaned-owner\n', { mode: 0o600 })
  const staleTime = new Date(Date.now() - 10 * 60 * 1000)
  fs.utimesSync(lockPath, staleTime, staleTime)

  let operationStarted = false
  await expect(
    store.withCommitLock(session.uploadId, rootIdentifier, async () => {
      operationStarted = true
    })
  ).rejects.toMatchObject({ code: 'ERR_CHIRP_COMMIT_BUSY' })

  expect(operationStarted).toBe(false)
  expect(fs.readFileSync(lockPath, 'utf8')).toBe('orphaned-owner\n')
  fs.rmSync(lockPath)
}, 10_000)
