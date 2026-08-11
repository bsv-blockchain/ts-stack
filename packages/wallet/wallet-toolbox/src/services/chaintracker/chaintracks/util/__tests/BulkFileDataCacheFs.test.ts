import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { BulkHeaderFileInfo } from '../BulkHeaderFile'
import { BulkFileDataCacheFs } from '../BulkFileDataCacheFs'

const file: BulkHeaderFileInfo = {
  chain: 'main',
  count: 1,
  fileHash: 'fixture',
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

  test('atomically persists, reads, and deletes an immutable object', async () => {
    const cache = new BulkFileDataCacheFs(root)
    const data = new Uint8Array(80).fill(9)

    await cache.set(file, data)
    await expect(cache.get(file)).resolves.toEqual(data)
    expect((await fs.readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])

    await cache.delete(file)
    await expect(cache.get(file)).resolves.toBeUndefined()
  })

  test('rejects path traversal before filesystem access', async () => {
    const cache = new BulkFileDataCacheFs(root)
    await expect(cache.get({ ...file, fileName: '../outside.headers' })).rejects.toThrow(
      'Invalid bulk-header cache file name'
    )
  })
})
