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
})
