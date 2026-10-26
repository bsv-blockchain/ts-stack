process.env.GCP_BUCKET_NAME = 'test-bucket'
process.env.CHIRP_MAX_ACTIVE_SESSIONS = '2'
process.env.CHIRP_MAX_ACTIVE_SESSIONS_PER_IDENTITY = '1'
process.env.CHIRP_MAX_STAGED_OBJECTS_PER_SESSION = '1'
process.env.CHIRP_MAX_STAGED_BYTES_PER_SESSION = '4'
process.env.CHIRP_GC_MAX_ENTRIES = '1'

jest.mock('../../logger', () => ({ log: { info: jest.fn(), error: jest.fn() } }))

const { CloudBucketChirpStore } = require('../store')
const { objectIdentifierForBytes } = require('../core/hash')

const PREFIX = 'chirp/v1'

class FakeStorage {
  constructor() {
    this.testBucket = new FakeBucket()
  }

  bucket() {
    return this.testBucket
  }
}

class FakeBucket {
  constructor() {
    this.records = new Map()
    this.generation = 0
  }

  file(name) {
    return new FakeFile(this, name)
  }

  async getFiles(options = {}) {
    let names = [...this.records.keys()].sort()
    if (options.prefix != null) names = names.filter(name => name.startsWith(options.prefix))
    if (options.matchGlob != null) {
      const expression = new RegExp(
        `^${options.matchGlob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`
      )
      names = names.filter(name => expression.test(name))
    }
    if (options.autoPaginate !== false) return [names.map(name => this.file(name))]

    const start = Number(options.pageToken ?? 0)
    const end = Math.min(start + Number(options.maxResults ?? names.length), names.length)
    return [
      names.slice(start, end).map(name => this.file(name)),
      end < names.length ? { pageToken: String(end) } : null
    ]
  }
}

class FakeFile {
  constructor(bucket, name) {
    this.bucket = bucket
    this.name = name
  }

  get metadata() {
    return this.bucket.records.get(this.name)?.metadata ?? {}
  }

  async save(value, options = {}) {
    const existing = this.bucket.records.get(this.name)
    if (options.preconditionOpts?.ifGenerationMatch === 0 && existing != null) {
      throw cloudError(412)
    }
    const data = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(String(value))
    const generation = ++this.bucket.generation
    this.bucket.records.set(this.name, {
      data,
      metadata: {
        ...options.metadata,
        generation: String(generation),
        metageneration: '1',
        size: String(data.byteLength)
      }
    })
  }

  async getMetadata() {
    const record = this.bucket.records.get(this.name)
    if (record == null) throw cloudError(404)
    return [record.metadata]
  }

  async download() {
    const record = this.bucket.records.get(this.name)
    if (record == null) throw cloudError(404)
    return [Buffer.from(record.data)]
  }

  async exists() {
    return [this.bucket.records.has(this.name)]
  }

  async delete(options = {}) {
    const record = this.bucket.records.get(this.name)
    if (record == null) {
      if (options.ignoreNotFound === true) return
      throw cloudError(404)
    }
    if (
      options.ifGenerationMatch != null &&
      Number(record.metadata.generation) !== Number(options.ifGenerationMatch)
    ) {
      throw cloudError(412)
    }
    this.bucket.records.delete(this.name)
  }

  async setMetadata(metadata, options = {}) {
    const record = this.bucket.records.get(this.name)
    if (record == null) throw cloudError(404)
    if (options.ifMetagenerationMatch != null && String(options.ifMetagenerationMatch) !== record.metadata.metageneration) throw cloudError(412)
    record.metadata = { ...record.metadata, ...metadata, metageneration: String(Number(record.metadata.metageneration) + 1) }
    return [record.metadata]
  }
}

function cloudError(code) {
  return Object.assign(new Error(`Cloud error ${code}`), { code })
}

async function* chunks(bytes) {
  yield bytes
}

test('enforces global and per-identity active-session quotas atomically', async () => {
  const storage = new FakeStorage()
  const store = new CloudBucketChirpStore(storage)

  await store.createSession('identity-a', '3600', null)
  await expect(store.createSession('identity-a', '3600', null)).rejects.toMatchObject({
    code: 'ERR_CHIRP_SESSION_QUOTA'
  })
  await store.createSession('identity-b', '3600', null)
  await expect(store.createSession('identity-c', '3600', null)).rejects.toMatchObject({
    code: 'ERR_CHIRP_SESSION_QUOTA'
  })
})

test('enforces staged-object count and byte quotas before creating markers', async () => {
  const storage = new FakeStorage()
  const store = new CloudBucketChirpStore(storage)
  const session = await store.createSession('identity-a', '3600', null)
  const first = Buffer.from('four')
  const second = Buffer.from('x')

  await expect(
    store.stageObject(
      session.uploadId,
      'identity-a',
      objectIdentifierForBytes(first),
      chunks(first),
      first.byteLength,
      16
    )
  ).resolves.toBe('created')
  await expect(
    store.stageObject(
      session.uploadId,
      'identity-a',
      objectIdentifierForBytes(second),
      chunks(second),
      second.byteLength,
      16
    )
  ).resolves.toBe('quota_exceeded')

  const otherSession = await store.createSession('identity-b', '3600', null)
  const oversized = Buffer.from('five!')
  await expect(
    store.stageObject(
      otherSession.uploadId,
      'identity-b',
      objectIdentifierForBytes(oversized),
      chunks(oversized),
      null,
      16
    )
  ).resolves.toBe('quota_exceeded')
  expect(
    storage.testBucket.records.has(
      `${PREFIX}/uploads/${otherSession.uploadId}/objects/${objectIdentifierForBytes(oversized)}`
    )
  ).toBe(false)
})

test('serializes commits to the same root across separate upload sessions', async () => {
  const store = new CloudBucketChirpStore(new FakeStorage())
  const rootIdentifier = objectIdentifierForBytes(Buffer.from('root'))
  const uploadA = '00000000-0000-4000-8000-000000000001'
  const uploadB = '00000000-0000-4000-8000-000000000002'
  let active = 0
  let maximumActive = 0
  let releaseFirst
  let signalFirst
  const firstEntered = new Promise(resolve => {
    signalFirst = resolve
  })
  const firstRelease = new Promise(resolve => {
    releaseFirst = resolve
  })
  const operation = async wait => {
    active += 1
    maximumActive = Math.max(maximumActive, active)
    if (wait) {
      signalFirst()
      await firstRelease
    }
    active -= 1
  }

  const first = store.withCommitLock(uploadA, rootIdentifier, async () => await operation(true))
  await firstEntered
  const second = store.withCommitLock(uploadB, rootIdentifier, async () => await operation(false))
  await new Promise(resolve => setTimeout(resolve, 25))
  expect(maximumActive).toBe(1)
  releaseFirst()
  await Promise.all([first, second])
  expect(maximumActive).toBe(1)
})

test('bounds each garbage-collection wave without abandoning later objects', async () => {
  const storage = new FakeStorage()
  const store = new CloudBucketChirpStore(storage)
  const expired = new Date(Date.now() - 1_000).toISOString()
  const identifiers = [
    objectIdentifierForBytes(Buffer.from('orphan-a')),
    objectIdentifierForBytes(Buffer.from('orphan-b'))
  ]
  for (const identifier of identifiers) {
    await storage.testBucket.file(`${PREFIX}/objects/${identifier}`).save('orphan', {
      metadata: { customTime: expired }
    })
  }

  await store.collectGarbage()
  expect(
    identifiers.filter(identifier =>
      storage.testBucket.records.has(`${PREFIX}/objects/${identifier}`)
    )
  ).toHaveLength(1)

  await store.collectGarbage()
  expect(
    identifiers.filter(identifier =>
      storage.testBucket.records.has(`${PREFIX}/objects/${identifier}`)
    )
  ).toHaveLength(0)
})
