const fs = require('node:fs')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { Readable } = require('node:stream')

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'chirp-store-'))
process.env.CHIRP_DATA_DIR = dataRoot

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
