import { asUint8Array } from '../../../../../utility/utilityHelpers.noBuffer'
import { ChaintracksFsApi } from '../../Api/ChaintracksFsApi'
import { ChaintracksStorageBase } from '../../Storage/ChaintracksStorageBase'
import { BulkFilesReader, BulkFilesReaderFs } from '../BulkFilesReader'
import { BulkHeaderFileStorage } from '../BulkHeaderFile'
import { BulkFileDataManager } from '../BulkFileDataManager'
import { BulkFileDataReader } from '../BulkFileDataReader'
import { HeightRange } from '../HeightRange'

function mockFs(overrides: Partial<ChaintracksFsApi>): ChaintracksFsApi {
  return {
    delete: jest.fn(),
    writeFile: jest.fn(),
    readFile: jest.fn(),
    openReadableFile: jest.fn(),
    openWritableFile: jest.fn(),
    openAppendableFile: jest.fn(),
    pathJoin: (...parts: string[]) => parts.join('/'),
    ...overrides
  } as ChaintracksFsApi
}

function manifest(firstHeight = 0, fileName = 'mainNet_0.headers'): Uint8Array {
  return asUint8Array(
    JSON.stringify({
      rootFolder: '/headers',
      jsonFilename: 'mainNetBlockHeaders.json',
      headersPerFile: 100,
      files: [
        {
          chain: 'main',
          count: 1,
          fileHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          fileName,
          firstHeight,
          lastChainWork: '01'.repeat(32),
          lastHash: '11'.repeat(32),
          prevChainWork: '00'.repeat(32),
          prevHash: '00'.repeat(32)
        }
      ]
    }),
    'utf8'
  )
}

describe('BulkFilesReader security boundaries', () => {
  test('does not replace oversized or unreadable manifests with an empty index', async () => {
    const oversized = mockFs({
      readFile: jest.fn(async () => ({ length: 16 * 1024 * 1024 + 1 }) as Uint8Array)
    })
    await expect(BulkFilesReaderFs.readJsonFile(oversized, '/headers', 'index.json')).rejects.toThrow('no larger')
    expect(oversized.writeFile).not.toHaveBeenCalled()

    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const unreadable = mockFs({ readFile: jest.fn(async () => await Promise.reject(denied)) })
    await expect(BulkFilesReaderFs.readJsonFile(unreadable, '/headers', 'index.json')).rejects.toBe(denied)
    expect(unreadable.writeFile).not.toHaveBeenCalled()
  })

  test('creates an empty index only for a definite missing-file error', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })
    const fs = mockFs({ readFile: jest.fn(async () => await Promise.reject(missing)) })

    await expect(BulkFilesReaderFs.readJsonFile(fs, '/headers', 'index.json')).resolves.toMatchObject({ files: [] })
    expect(fs.writeFile).toHaveBeenCalledTimes(1)
    await expect(BulkFilesReaderFs.readJsonFile(fs, '/headers', 'index.json', false)).rejects.toThrow('existing')
  })

  test('rejects path-bearing manifest and bulk filenames before opening data', async () => {
    const fs = mockFs({ readFile: jest.fn(async () => manifest(0, '../outside.headers')) })
    await expect(BulkFilesReaderFs.fromFs(fs, '/headers', '../index.json')).rejects.toThrow('path-free')
    expect(fs.readFile).not.toHaveBeenCalled()

    await expect(BulkFilesReaderFs.fromFs(fs, '/headers', 'index.json')).rejects.toThrow('path-free')
    expect(fs.openReadableFile).not.toHaveBeenCalled()
  })

  test('requires a bounded read buffer and a genesis-anchored contiguous file sequence', async () => {
    expect(() => new BulkFilesReader([], undefined, 0)).toThrow('maxBufferSize')
    expect(() => new BulkFilesReader([], undefined, 100_001 * 80)).toThrow('maxBufferSize')

    const fs = mockFs({ readFile: jest.fn(async () => manifest(1)) })
    await expect(BulkFilesReaderFs.fromFs(fs, '/headers', 'index.json')).rejects.toThrow('not contiguous')
    expect(fs.openReadableFile).not.toHaveBeenCalled()
  })

  test('routes storage-backed reads through complete-object validation and bounds slices', async () => {
    const getDataFromFile = jest.fn(async () => new Uint8Array(80))
    const storage = { bulkManager: { getDataFromFile } } as unknown as ChaintracksStorageBase
    const file = new BulkHeaderFileStorage(
      {
        chain: 'main',
        count: 1,
        fileHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        fileName: 'mainNet_0.headers',
        firstHeight: 0,
        lastChainWork: '01'.repeat(32),
        lastHash: '11'.repeat(32),
        prevChainWork: '00'.repeat(32),
        prevHash: '00'.repeat(32)
      },
      storage
    )

    await expect(file.readDataFromFile(81, 0)).rejects.toThrow('length and offset')
    await expect(file.readDataFromFile(80, 0)).resolves.toHaveLength(80)
    expect(getDataFromFile).toHaveBeenCalledWith(expect.objectContaining({ fileName: 'mainNet_0.headers' }), 0, 80)
  })

  test('bounds manager and direct-reader ranges, buffers, and data slices', async () => {
    const manager = new BulkFileDataManager({ chain: 'main', maxPerFile: 100 })
    const reader = await manager.createReader()
    expect(reader.maxBufferSize).toBe(100_000 * 80)
    await expect(manager.createReader(new HeightRange(0, -1), 0)).rejects.toThrow('maxBufferSize')
    expect(() => new BulkFileDataReader(manager, new HeightRange(-1, 0), 80)).toThrow('range')
    expect(() => new BulkFileDataReader(manager, new HeightRange(0, -1), 100_001 * 80)).toThrow('maxBufferSize')

    const descriptor = {
      chain: 'main' as const,
      count: 1,
      fileHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      fileName: 'mainNet_0.headers',
      firstHeight: 0,
      lastChainWork: '01'.repeat(32),
      lastHash: '11'.repeat(32),
      prevChainWork: '00'.repeat(32),
      prevHash: '00'.repeat(32)
    }
    await expect(manager.getDataFromFile(descriptor, -1, 1)).rejects.toThrow('offset')
    await expect(manager.getDataFromFile(descriptor, 0, 100_001 * 80)).rejects.toThrow('length')
  })
})
