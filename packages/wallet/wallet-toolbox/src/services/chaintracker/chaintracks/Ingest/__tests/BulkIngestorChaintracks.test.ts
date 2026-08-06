import { ChaintracksClientApi } from '../../Api/ChaintracksClientApi'
import { ChaintracksStorageBase } from '../../Storage/ChaintracksStorageBase'
import { ChaintracksStorageNoDb } from '../../Storage/ChaintracksStorageNoDb'
import { BulkFileDataManager } from '../../util/BulkFileDataManager'
import { ChaintracksFs } from '../../util/ChaintracksFs'
import { HeightRange } from '../../util/HeightRange'
import { serializeBaseBlockHeader } from '../../util/blockHeaderUtilities'
import { BulkIngestorChaintracks } from '../BulkIngestorChaintracks'

const toHex = (bytes: number[]): string => bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')

describe('BulkIngestorChaintracks', () => {
  test('rejects invalid batch limits and returns an empty range without contacting the upstream', async () => {
    const remote = { getChain: jest.fn() } as unknown as ChaintracksClientApi
    expect(
      () =>
        new BulkIngestorChaintracks({
          chain: 'main',
          jsonResource: 'mainNetBlockHeaders.json',
          chaintracks: remote,
          maxHeadersPerRequest: 0
        })
    ).toThrow('maxHeadersPerRequest must be a positive integer')

    const ingestor = new BulkIngestorChaintracks({
      chain: 'main',
      jsonResource: 'mainNetBlockHeaders.json',
      chaintracks: remote
    })
    const prior: any[] = []
    await expect(
      ingestor.fetchHeaders(
        { bulk: HeightRange.empty, live: HeightRange.empty },
        HeightRange.empty,
        HeightRange.empty,
        prior
      )
    ).resolves.toBe(prior)
    expect(remote.getChain).not.toHaveBeenCalled()
  })

  test('fetches bounded header batches and forwards them through local storage validation', async () => {
    const headers = [0, 1, 2].map(height =>
      serializeBaseBlockHeader({
        version: 1,
        previousHash: height.toString(16).padStart(64, '0'),
        merkleRoot: (height + 1).toString(16).padStart(64, '0'),
        time: height,
        bits: 0x1d00ffff,
        nonce: height
      })
    )
    const getHeaders = jest.fn(async (height: number, count: number) =>
      toHex(headers.slice(height, height + count).flat())
    )
    const remote = {
      getChain: jest.fn(async () => 'ttn'),
      getPresentHeight: jest.fn(async () => 2),
      getHeaders
    } as unknown as ChaintracksClientApi
    const addBulkHeaders = jest.fn(async (batch, _bulkRange, live) => [...live, ...batch])
    const storage = { addBulkHeaders } as unknown as ChaintracksStorageBase
    const ingestor = new BulkIngestorChaintracks({
      chain: 'ttn',
      jsonResource: 'ttnNetBlockHeaders.json',
      chaintracks: remote,
      maxHeadersPerRequest: 2
    })
    await ingestor.setStorage(storage, () => {})

    await expect(ingestor.getPresentHeight()).resolves.toBe(2)
    const result = await ingestor.fetchHeaders(
      { bulk: HeightRange.empty, live: HeightRange.empty },
      new HeightRange(0, 2),
      new HeightRange(0, 1),
      []
    )

    expect(getHeaders).toHaveBeenNthCalledWith(1, 0, 2)
    expect(getHeaders).toHaveBeenNthCalledWith(2, 2, 1)
    expect(addBulkHeaders).toHaveBeenCalledTimes(2)
    expect(result.map(header => header.height)).toEqual([0, 1, 2])
  })

  test('bootstraps real empty storage from a validated Arcade genesis batch', async () => {
    const data = await ChaintracksFs.readFile(
      './src/services/chaintracker/chaintracks/__tests/data/cdnTest499/mainNet_0.headers'
    )
    const getHeaders = jest.fn(async () => toHex([...data]))
    const remote = {
      getChain: jest.fn(async () => 'main'),
      getHeaders
    } as unknown as ChaintracksClientApi
    const storageOptions = ChaintracksStorageBase.createStorageBaseOptions('main')
    storageOptions.bulkFileDataManager = new BulkFileDataManager({
      chain: 'main',
      maxPerFile: 100,
      maxRetained: 2
    })
    const storage = new ChaintracksStorageNoDb(storageOptions)
    const ingestor = new BulkIngestorChaintracks({
      chain: 'main',
      jsonResource: 'mainNetBlockHeaders.json',
      chaintracks: remote,
      maxHeadersPerRequest: 100
    })
    await ingestor.setStorage(storage, () => {})

    await expect(
      ingestor.fetchHeaders(
        { bulk: HeightRange.empty, live: HeightRange.empty },
        new HeightRange(0, 99),
        new HeightRange(0, 99),
        []
      )
    ).resolves.toEqual([])

    expect(getHeaders).toHaveBeenCalledWith(0, 100)
    await expect(storage.getAvailableHeightRanges()).resolves.toMatchObject({
      bulk: { minHeight: 0, maxHeight: 99 }
    })
    await expect(storage.bulkManager.findHeaderForHeightOrUndefined(0)).resolves.toMatchObject({
      hash: '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
    })
  })

  test('rejects an upstream configured for another network', async () => {
    const remote = {
      getChain: jest.fn(async () => 'test')
    } as unknown as ChaintracksClientApi
    const ingestor = new BulkIngestorChaintracks({
      chain: 'ttn',
      jsonResource: 'ttnNetBlockHeaders.json',
      chaintracks: remote
    })

    await expect(ingestor.getPresentHeight()).rejects.toThrow("network 'test' does not match configured chain 'ttn'")
  })

  test('treats an incomplete upstream batch as a source failure', async () => {
    const remote = {
      getChain: jest.fn(async () => 'main'),
      getHeaders: jest.fn(async () => '')
    } as unknown as ChaintracksClientApi
    const ingestor = new BulkIngestorChaintracks({
      chain: 'main',
      jsonResource: 'mainNetBlockHeaders.json',
      chaintracks: remote
    })

    await expect(
      ingestor.fetchHeaders(
        { bulk: HeightRange.empty, live: HeightRange.empty },
        new HeightRange(0, 1),
        new HeightRange(0, 1),
        []
      )
    ).rejects.toThrow('returned no headers at height 0')
  })

  test('rejects malformed and short non-empty upstream batches', async () => {
    const header = serializeBaseBlockHeader({
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 0x1d00ffff,
      nonce: 1
    })
    const getHeaders = jest.fn().mockResolvedValueOnce('00').mockResolvedValueOnce(toHex(header))
    const remote = {
      getChain: jest.fn(async () => 'main'),
      getHeaders
    } as unknown as ChaintracksClientApi
    const storage = {
      addBulkHeaders: jest.fn(async (headers, _range, live) => [...live, ...headers])
    } as unknown as ChaintracksStorageBase
    const ingestor = new BulkIngestorChaintracks({
      chain: 'main',
      jsonResource: 'mainNetBlockHeaders.json',
      chaintracks: remote,
      maxHeadersPerRequest: 2
    })
    await ingestor.setStorage(storage, () => {})
    const args = [
      { bulk: HeightRange.empty, live: HeightRange.empty },
      new HeightRange(0, 1),
      new HeightRange(0, 1),
      []
    ] as const

    await expect(ingestor.fetchHeaders(...args)).rejects.toThrow('returned 1 bytes for 2 headers')
    await expect(ingestor.fetchHeaders(...args)).rejects.toThrow('returned 1 of 2 headers at height 0')
  })
})
