import { ChaintracksClientApi } from '../../Api/ChaintracksClientApi'
import { ChaintracksStorageBase } from '../../Storage/ChaintracksStorageBase'
import { HeightRange } from '../../util/HeightRange'
import { serializeBaseBlockHeader } from '../../util/blockHeaderUtilities'
import { BulkIngestorChaintracks } from '../BulkIngestorChaintracks'

const toHex = (bytes: number[]): string => bytes.map(byte => byte.toString(16).padStart(2, '0')).join('')

describe('BulkIngestorChaintracks', () => {
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
})
