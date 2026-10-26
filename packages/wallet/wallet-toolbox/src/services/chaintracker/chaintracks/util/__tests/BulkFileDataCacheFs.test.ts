import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type { BulkHeaderFileInfo } from '../BulkHeaderFile'
import { BulkFileDataCacheFs } from '../BulkFileDataCacheFs'

const data = new Uint8Array(80).fill(9)
const file: BulkHeaderFileInfo = {
  chain: 'main',
  count: 1,
  fileHash: createHash('sha256').update(data).digest('base64'),
  fileName: 'mainNet_0.headers',
  firstHeight: 0,
  lastChainWork: '02'.repeat(32),
  lastHash: '03'.repeat(32),
  prevChainWork: '00'.repeat(32),
  prevHash: '00'.repeat(32)
}

describe('BulkFileDataCacheFs', () => {
  let root: string

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'bulk-header-cache-'))
  })

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test('atomically persists, reads, and quarantines a content-addressed immutable object', async () => {
    const cache = new BulkFileDataCacheFs(root)

    await cache.set(file, data)
    await expect(cache.get(file)).resolves.toEqual(data)
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])

    await cache.delete(file)
    await expect(cache.get(file)).resolves.toBeUndefined()
    await expect(cache.delete(file)).resolves.toBeUndefined()
    const quarantine = await fs.readdir(path.join(root, 'quarantine'))
    expect(quarantine).toHaveLength(1)
    await expect(fs.readFile(path.join(root, 'quarantine', quarantine[0]))).resolves.toEqual(Buffer.from(data))
  })

  test('requires a canonical SHA-256 digest before filesystem access', async () => {
    const cache = new BulkFileDataCacheFs(root)

    await expect(cache.get({ ...file, fileHash: undefined })).rejects.toThrow('Missing bulk-header digest')
    await expect(cache.get({ ...file, fileHash: Buffer.alloc(31).toString('base64') })).rejects.toThrow(
      'Invalid bulk-header digest'
    )
    await expect(cache.get({ ...file, fileHash: file.fileHash!.replace(/=$/, '') })).rejects.toThrow(
      'Invalid bulk-header digest'
    )
  })

  test('authenticates writes and bounds hostile cache objects before returning them', async () => {
    const cache = new BulkFileDataCacheFs(root)
    await expect(cache.set(file, new Uint8Array(79))).rejects.toThrow('data length')
    await expect(cache.set(file, new Uint8Array(80))).rejects.toThrow('data digest')

    const digest = Buffer.from(file.fileHash!, 'base64').toString('hex')
    const objectPath = path.join(root, 'objects', digest.slice(0, 2), `${digest}.headers`)
    await fs.mkdir(path.dirname(objectPath), { recursive: true })
    await fs.writeFile(objectPath, new Uint8Array(1024 * 1024))

    const loaded = await cache.get(file)
    expect(loaded).toHaveLength(81)
  })

  test('quarantines only the rejected bytes observed by the validator', async () => {
    const cache = new BulkFileDataCacheFs(root)
    await cache.set(file, data)

    await cache.quarantine(file, 'stale rejection', new Uint8Array(80).fill(7))
    await expect(cache.get(file)).resolves.toEqual(data)

    await cache.quarantine(file, 'confirmed rejection', data)
    await expect(cache.get(file)).resolves.toBeUndefined()
  })

  test('promotes a validated legacy file without removing the legacy copy', async () => {
    const legacy = path.join(root, 'legacy')
    const cacheRoot = path.join(root, 'cache')
    await fs.mkdir(legacy)
    await fs.writeFile(path.join(legacy, file.fileName), data)
    const cache = new BulkFileDataCacheFs({ rootFolder: cacheRoot, legacyRoots: [legacy] })

    const loaded = await cache.get(file)
    expect(loaded).toEqual(data)
    await cache.promoteValidated(file, loaded!)
    await fs.unlink(path.join(legacy, file.fileName))

    await expect(cache.get(file)).resolves.toEqual(data)
  })

  test('durably skips a rejected legacy object without deleting the only legacy copy', async () => {
    const legacy = path.join(root, 'legacy')
    const cacheRoot = path.join(root, 'cache')
    const invalid = new Uint8Array(79).fill(4)
    await fs.mkdir(legacy)
    await fs.writeFile(path.join(legacy, file.fileName), invalid)
    const cache = new BulkFileDataCacheFs({ rootFolder: cacheRoot, legacyRoots: [legacy] })

    await expect(cache.get(file)).resolves.toEqual(invalid)
    await cache.quarantine(file, 'invalid length')
    await expect(cache.get(file)).resolves.toBeUndefined()
    await expect(fs.readFile(path.join(legacy, file.fileName))).resolves.toEqual(Buffer.from(invalid))

    await cache.set(file, data)
    await expect(cache.get(file)).resolves.toEqual(data)
  })

  test('rejects path traversal before filesystem access', async () => {
    const cache = new BulkFileDataCacheFs(root)
    await expect(cache.get({ ...file, fileName: '../outside.headers' })).rejects.toThrow(
      'Invalid bulk-header cache file name'
    )
  })

  test('rejects ambiguous roots and unbounded or sparse legacy-root collections', () => {
    expect(() => new BulkFileDataCacheFs({ rootFolder: '' })).toThrow('rootFolder')
    expect(() => new BulkFileDataCacheFs({ rootFolder: path.parse(root).root })).toThrow('filesystem root')
    expect(
      () => new BulkFileDataCacheFs({ rootFolder: root, legacyRoots: Array.from({ length: 65 }, () => root) })
    ).toThrow('no more than 64')
    const sparse = Array(2) as string[]
    sparse[1] = root
    expect(() => new BulkFileDataCacheFs({ rootFolder: root, legacyRoots: sparse })).toThrow('dense array')
  })

  test('serializes independent cache writers and fails closed on an abandoned object lock', async () => {
    const first = new BulkFileDataCacheFs(root)
    const second = new BulkFileDataCacheFs(root)
    await expect(Promise.all([first.set(file, data), second.set(file, data)])).resolves.toEqual([undefined, undefined])
    await expect(first.get(file)).resolves.toEqual(data)

    const digest = Buffer.from(file.fileHash!, 'base64').toString('hex')
    const lockFolder = path.join(root, 'objects', digest.slice(0, 2), `${digest}.headers.lock`)
    await fs.mkdir(lockFolder)
    await fs.writeFile(path.join(lockFolder, 'owner'), 'temporary holder')
    const mutable = data.slice()
    const pending = first.set(file, mutable)
    mutable.fill(1)
    await fs.unlink(path.join(lockFolder, 'owner'))
    await fs.rmdir(lockFolder)
    await expect(pending).resolves.toBeUndefined()
    await expect(first.get(file)).resolves.toEqual(data)

    await fs.mkdir(lockFolder)
    await fs.writeFile(path.join(lockFolder, 'owner'), 'abandoned')
    const bounded = new BulkFileDataCacheFs({ rootFolder: root, lockTimeoutMsecs: 5, lockRetryMsecs: 1 })
    await expect(bounded.set(file, data)).rejects.toThrow('never reclaimed automatically')
  })
})
