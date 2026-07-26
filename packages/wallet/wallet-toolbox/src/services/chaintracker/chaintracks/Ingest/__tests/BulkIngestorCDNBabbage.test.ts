import type { HttpClient } from '@bsv/sdk'
import type { Chain } from '../../../../../sdk'
import type { ChaintracksFetchApi } from '../../Api/ChaintracksFetchApi'
import type { ChaintracksStorageBase } from '../../Storage/ChaintracksStorageBase'
import type { BulkHeaderFileInfo, BulkHeaderFilesInfo } from '../../util/BulkHeaderFile'
import { HeightRange, type HeightRanges } from '../../util/HeightRange'
import { BulkIngestorCDNBabbage } from '../BulkIngestorCDNBabbage'

const cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/'

function file(firstHeight: number, count: number, overrides: Partial<BulkHeaderFileInfo> = {}): BulkHeaderFileInfo {
  return {
    fileName: `${firstHeight}-${count}.headers`,
    firstHeight,
    count,
    prevChainWork: '01',
    lastChainWork: '02',
    prevHash: '00'.repeat(32),
    lastHash: '11'.repeat(32),
    fileHash: 'test-file-hash',
    chain: 'main',
    ...overrides
  }
}

function manifest(files: BulkHeaderFileInfo[]): BulkHeaderFilesInfo {
  return {
    rootFolder: cdnUrl,
    jsonFilename: 'mainNetBlockHeaders.json',
    files,
    headersPerFile: 1_000
  }
}

function harness(available: BulkHeaderFilesInfo | null) {
  const fetchJson = jest.fn().mockResolvedValue(available)
  const fetch: ChaintracksFetchApi = {
    httpClient: {} as HttpClient,
    download: jest.fn(),
    fetchJson,
    pathJoin: (baseUrl, subpath) => new URL(subpath, baseUrl).toString()
  }
  const mergeResult = {
    unchanged: [file(0, 1, { fileId: 1 })],
    inserted: [file(1, 1, { fileId: 2 })],
    updated: [file(2, 1, { fileId: 3 })],
    dropped: []
  }
  const getHeightRange = jest
    .fn()
    .mockResolvedValueOnce(new HeightRange(0, 0))
    .mockResolvedValueOnce(new HeightRange(0, 2))
  const merge = jest.fn().mockResolvedValue(mergeResult)
  const storage = {
    bulkManager: { getHeightRange, merge }
  } as unknown as ChaintracksStorageBase
  const log = jest.fn()
  const options = BulkIngestorCDNBabbage.createBulkIngestorCDNBabbageOptions('main', fetch)
  const cdn = new BulkIngestorCDNBabbage(options)

  return { cdn, fetchJson, getHeightRange, log, merge, options, storage }
}

const before: HeightRanges = {
  bulk: HeightRange.empty,
  live: HeightRange.empty
}
const requestedRange = new HeightRange(0, 2)

describe('BulkIngestorCDNBabbage', () => {
  test.each<Chain>(['main', 'test'])('uses the public Babbage CDN contract for %snet', chain => {
    const fetch: ChaintracksFetchApi = {
      httpClient: {} as HttpClient,
      download: jest.fn(),
      fetchJson: jest.fn(),
      pathJoin: jest.fn()
    }

    expect(BulkIngestorCDNBabbage.createBulkIngestorCDNBabbageOptions(chain, fetch)).toMatchObject({
      chain,
      cdnUrl,
      jsonResource: `${chain}NetBlockHeaders.json`,
      fetch
    })
  })

  test('selects a contiguous best-fit file set and merges it into storage', async () => {
    const files = [
      file(0, 500),
      file(0, 1_000),
      file(1_000, 1_000, { sourceUrl: 'https://stale.example/' }),
      file(2_000, 1_000, { chain: 'test' }),
      file(3_000, 1_000)
    ]
    const { cdn, fetchJson, getHeightRange, log, merge, storage } = harness(manifest(files))
    await cdn.setStorage(storage, log)
    const priorLiveHeaders = [{ height: 2_001 }] as never[]

    const result = await cdn.fetchHeaders(before, requestedRange, requestedRange, priorLiveHeaders)

    expect(result).toBe(priorLiveHeaders)
    expect(fetchJson).toHaveBeenCalledWith(`${cdnUrl}mainNetBlockHeaders.json`)
    expect(cdn.selectedFiles).toEqual([
      expect.objectContaining({ firstHeight: 0, count: 1_000, sourceUrl: cdnUrl }),
      expect.objectContaining({ firstHeight: 1_000, count: 1_000, sourceUrl: cdnUrl })
    ])
    expect(merge).toHaveBeenCalledWith(cdn.selectedFiles)
    expect(getHeightRange).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bulk range before: 0-0'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('bulk range after:  0-2'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('inserted: 1-1.headers, fileId=2'))
  })

  test.each([
    ['a null manifest', null],
    ['a selected file without a hash', manifest([file(0, 1, { fileHash: null })])]
  ])('rejects %s', async (_case, available) => {
    const { cdn, merge, storage } = harness(available)
    await cdn.setStorage(storage, jest.fn())

    await expect(cdn.fetchHeaders(before, requestedRange, requestedRange, [])).rejects.toThrow()
    expect(merge).not.toHaveBeenCalled()
  })

  test('ignores files for another or unspecified chain', async () => {
    const available = manifest([file(0, 1, { chain: 'test' }), file(0, 1, { chain: undefined })])
    const { cdn, merge, storage } = harness(available)
    await cdn.setStorage(storage, jest.fn())

    await cdn.fetchHeaders(before, requestedRange, requestedRange, [])

    expect(cdn.selectedFiles).toEqual([])
    expect(merge).toHaveBeenCalledWith([])
  })
})
