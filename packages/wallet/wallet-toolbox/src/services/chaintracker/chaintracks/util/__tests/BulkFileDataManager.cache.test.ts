import { Hash } from '@bsv/sdk'
import type { ChaintracksFetchApi } from '../../Api/ChaintracksFetchApi'
import type { BulkFileDataCacheApi } from '../../Api/BulkFileDataCacheApi'
import type { BulkHeaderFileInfo } from '../BulkHeaderFile'
import { BulkFileDataManager } from '../BulkFileDataManager'
import { asArray, asString } from '../../../../../utility/utilityHelpers.noBuffer'
import { convertBitsToWork, deserializeBlockHeader, genesisBuffer } from '../blockHeaderUtilities'

function fixtureFile(data: Uint8Array): BulkHeaderFileInfo {
  const header = deserializeBlockHeader(data, 0)
  return {
    chain: 'main',
    count: data.length / 80,
    fileHash: asString(Hash.sha256(asArray(data)), 'base64'),
    fileName: 'mainNet_0.headers',
    firstHeight: 0,
    lastChainWork: convertBitsToWork(header.bits),
    lastHash: header.hash,
    prevChainWork: '00'.repeat(32),
    prevHash: '00'.repeat(32),
    sourceUrl: 'https://headers.example.test',
    validated: true
  }
}

function fixtureFetch(download: jest.Mock<Promise<Uint8Array>, [string]>): ChaintracksFetchApi {
  return {
    download,
    fetchJson: jest.fn(),
    httpClient: {} as ChaintracksFetchApi['httpClient'],
    pathJoin: (base, subpath) => `${base}/${subpath}`
  }
}

function memoryCache(): BulkFileDataCacheApi & { values: Map<string, Uint8Array> } {
  const values = new Map<string, Uint8Array>()
  return {
    values,
    get: async file => values.get(file.fileName),
    set: async (file, data) => {
      values.set(file.fileName, data)
    },
    delete: async file => {
      values.delete(file.fileName)
    }
  }
}

async function managerWith(
  file: BulkHeaderFileInfo,
  fetch: ChaintracksFetchApi,
  cache: BulkFileDataCacheApi,
  downloadBudget?: { consume(byteCount: number): void | Promise<void> }
): Promise<BulkFileDataManager> {
  const manager = new BulkFileDataManager({
    chain: 'main',
    maxPerFile: 100,
    maxRetained: 1,
    fetch,
    cache,
    downloadBudget
  })
  await manager.merge([file])
  return manager
}

describe('BulkFileDataManager persistent cache and miss coalescing', () => {
  const data = Uint8Array.from(genesisBuffer('main'))
  const file = fixtureFile(data)

  test('coalesces concurrent misses and reuses the persisted object after restart', async () => {
    let resolveDownload!: (value: Uint8Array) => void
    const download = jest.fn(
      async () =>
        await new Promise<Uint8Array>(resolve => {
          resolveDownload = resolve
        })
    )
    const cache = memoryCache()
    const manager = await managerWith(file, fixtureFetch(download), cache)

    const requests = Array.from({ length: 20 }, async () => await manager.findHeaderForHeightOrUndefined(0))
    await new Promise(resolve => setImmediate(resolve))
    expect(download).toHaveBeenCalledTimes(1)
    resolveDownload(data)
    await expect(Promise.all(requests)).resolves.toHaveLength(20)
    expect(manager.getStats()).toMatchObject({ downloads: 1, coalescedLoads: 19, downloadedBytes: 80 })
    expect(cache.values.get(file.fileName)).toEqual(data)

    const restartedDownload = jest.fn(async () => data)
    const restarted = await managerWith(file, fixtureFetch(restartedDownload), cache)
    await expect(restarted.findHeaderForHeightOrUndefined(0)).resolves.toBeDefined()
    expect(restartedDownload).not.toHaveBeenCalled()
    expect(restarted.getStats()).toMatchObject({ persistentCacheHits: 1, downloads: 0 })
  })

  test('deletes a corrupt cache entry and replaces it only with validated bytes', async () => {
    const cache = memoryCache()
    cache.values.set(file.fileName, new Uint8Array(79))
    const deleteSpy = jest.spyOn(cache, 'delete')
    const setSpy = jest.spyOn(cache, 'set')
    const download = jest.fn(async () => data)
    const manager = await managerWith(file, fixtureFetch(download), cache)

    await expect(manager.findHeaderForHeightOrUndefined(0)).resolves.toBeDefined()

    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(download).toHaveBeenCalledTimes(1)
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ fileName: file.fileName }), data)
    expect(manager.getStats()).toMatchObject({ persistentCacheRejects: 1, downloads: 1 })
  })

  test('reserves the full immutable object before starting a remote download', async () => {
    const consume = jest.fn(() => {
      throw new Error('download budget exhausted')
    })
    const download = jest.fn(async () => data)
    const manager = await managerWith(file, fixtureFetch(download), memoryCache(), { consume })

    await expect(manager.findHeaderForHeightOrUndefined(0)).rejects.toThrow('download budget exhausted')
    expect(consume).toHaveBeenCalledWith(80)
    expect(download).not.toHaveBeenCalled()
  })

  test('does not trust a remote validated flag to bypass proof-of-work checks', async () => {
    const invalidProof = data.slice()
    invalidProof[72] = 1
    invalidProof[73] = 0
    invalidProof[74] = 0
    invalidProof[75] = 3
    const assertedValidFile = { ...fixtureFile(invalidProof), validated: true }
    const cache = memoryCache()
    const download = jest.fn(async () => invalidProof)
    const manager = await managerWith(assertedValidFile, fixtureFetch(download), cache)

    await expect(manager.findHeaderForHeightOrUndefined(0)).rejects.toThrow(
      'Block hash is not less than specified target.'
    )
    expect(cache.values.size).toBe(0)
  })

  test('validates the complete storage object before serving a requested slice', async () => {
    const corrupt = data.slice()
    corrupt[0] ^= 1
    const storageGet = jest.fn(async () => corrupt)
    const download = jest.fn(async () => data)
    const storageBacked = { ...file, fileId: 7, sourceUrl: undefined }
    const manager = await managerWith(storageBacked, fixtureFetch(download), memoryCache())
    manager['storage'] = { getBulkFileData: storageGet } as never

    await expect(manager.getDataFromFile(storageBacked, 0, 80)).rejects.toThrow(
      'a match for retrieved data'
    )
    expect(storageGet).toHaveBeenCalledWith(7)
    expect(download).not.toHaveBeenCalled()
  })
})
