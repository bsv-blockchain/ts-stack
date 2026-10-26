import { readFileSync } from 'node:fs'

import { BlockHeader } from '../../Api/BlockHeaderApi'
import { ChaintracksFsApi } from '../../Api/ChaintracksFsApi'
import { BulkStorageBase } from '../BulkStorageBase'

const fixture = new Uint8Array(
  readFileSync('src/services/chaintracker/chaintracks/__tests/data/cdnTest499/mainNet_0.headers')
)

class FixtureBulkStorage extends BulkStorageBase {
  truncate = false

  async appendHeaders(_minHeight: number, _count: number, _newBulkHeaders: Uint8Array): Promise<void> {}

  async getMaxHeight(): Promise<number> {
    return fixture.length / 80 - 1
  }

  async headersToBuffer(height: number, count: number): Promise<Uint8Array> {
    const data = fixture.slice(height * 80, (height + count) * 80)
    return this.truncate ? data.slice(0, -1) : data
  }

  async findHeaderForHeightOrUndefined(_height: number): Promise<BlockHeader | undefined> {
    return undefined
  }
}

function memoryFs(): { fs: ChaintracksFsApi; writes: Map<string, Uint8Array> } {
  const writes = new Map<string, Uint8Array>()
  const fs = {
    writeFile: jest.fn(async (path: string, data: Uint8Array) => {
      writes.set(path, new Uint8Array(data))
    }),
    pathJoin: (...parts: string[]) => parts.join('/').replaceAll('//', '/'),
    delete: jest.fn(),
    readFile: jest.fn(),
    openReadableFile: jest.fn(),
    openWritableFile: jest.fn(),
    openAppendableFile: jest.fn()
  } as unknown as ChaintracksFsApi
  return { fs, writes }
}

describe('BulkStorageBase export security', () => {
  test('exports a complete authenticated manifest with bounded file sizes', async () => {
    const { fs, writes } = memoryFs()
    const storage = new FixtureBulkStorage(BulkStorageBase.createBulkStorageBaseOptions('main', fs))

    await storage.exportBulkHeaders('/export', 'mainNetBlockHeaders.json', 40)

    const manifestBytes = writes.get('/export/mainNetBlockHeaders.json')
    expect(manifestBytes).toBeDefined()
    const manifest = JSON.parse(new TextDecoder().decode(manifestBytes))
    expect(manifest.files).toHaveLength(3)
    expect(manifest.files.map((file: { firstHeight: number }) => file.firstHeight)).toEqual([0, 40, 80])
    expect(manifest.files.map((file: { count: number }) => file.count)).toEqual([40, 40, 20])
    expect(manifest.files.every((file: { chain: string }) => file.chain === 'main')).toBe(true)
    expect(manifest.files.every((file: { fileHash: string }) => /^[A-Za-z0-9+/]{43}=$/.test(file.fileHash))).toBe(true)
    expect(manifest.files[1].prevHash).toBe(manifest.files[0].lastHash)
    expect(manifest.files[1].prevChainWork).toBe(manifest.files[0].lastChainWork)
  })

  test('rejects path-bearing names, non-progressing chunk sizes, and truncated reads', async () => {
    const { fs, writes } = memoryFs()
    const storage = new FixtureBulkStorage(BulkStorageBase.createBulkStorageBaseOptions('main', fs))

    await expect(storage.exportBulkHeaders('/export', '../index.json', 40)).rejects.toThrow('path-free')
    await expect(storage.exportBulkHeaders('/export', 'index.json', 0)).rejects.toThrow('maxPerFile')
    expect(writes.size).toBe(0)

    storage.truncate = true
    await expect(storage.exportBulkHeaders('/export', 'index.json', 40)).rejects.toThrow('bytes for 40 headers')
    expect(writes.size).toBe(0)
  })
})
