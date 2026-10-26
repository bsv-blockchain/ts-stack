import {
  WhatsOnChainServices,
  WocGetHeadersHeader,
  parseFileLink,
  wocGetHeadersHeaderToBlockHeader
} from '../WhatsOnChainServices'
import { HeightRange } from '../../util/HeightRange'
import { genesisHeader } from '../../util/blockHeaderUtilities'

describe('WhatsOnChain header file links', () => {
  test('coalesces concurrent chain-height reads into one rate-limited request', async () => {
    const options = WhatsOnChainServices.createWhatsOnChainServicesOptions('test')
    options.chainInfoMsecs = 0
    options.minRequestIntervalMsecs = 0
    const service = new WhatsOnChainServices(options)
    const result = {
      chain: 'test',
      blocks: 123,
      headers: 123,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    const getChainInfo = jest.spyOn(service.woc, 'getChainInfo').mockResolvedValue(result)

    await expect(Promise.all([service.getChainTipHeight(), service.getChainTipHeight()])).resolves.toEqual([123, 123])
    expect(getChainInfo).toHaveBeenCalledTimes(1)
  })

  test('snapshots bounded options and isolates shared chain-info cache values', async () => {
    const options = WhatsOnChainServices.createWhatsOnChainServicesOptions('test')
    options.minRequestIntervalMsecs = 0
    const service = new WhatsOnChainServices(options)
    options.minRequestIntervalMsecs = -1
    expect(service.options.minRequestIntervalMsecs).toBe(0)
    expect(Object.isFrozen(service.options)).toBe(true)

    const result = {
      chain: 'test',
      blocks: 123,
      headers: 123,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    ;(WhatsOnChainServices.chainInfo as unknown as Record<string, unknown>).test = undefined
    jest.spyOn(service.woc, 'getChainInfo').mockResolvedValue(result)
    const first = await service.getChainInfo()
    first.blocks = 999
    await expect(service.getChainTipHeight()).resolves.toBe(123)

    expect(
      () =>
        new WhatsOnChainServices({
          ...WhatsOnChainServices.createWhatsOnChainServicesOptions('main'),
          userAgent: 'bad\r\nheader'
        })
    ).toThrow('userAgent')
  })

  test('parses latest and bounded header resources', () => {
    expect(parseFileLink('https://cdn.example/headers/latest')).toEqual({
      range: 'latest',
      sourceUrl: 'https://cdn.example/headers',
      fileName: 'latest'
    })
    expect(parseFileLink('https://cdn.example/headers/100_199_headers')).toEqual({
      range: { fromHeight: 100, toHeight: 199 },
      sourceUrl: 'https://cdn.example/headers',
      fileName: '100_199_headers'
    })
    expect(parseFileLink('https://fixture.invalid/blockheaders/400_499_headers')).toEqual({
      range: { fromHeight: 400, toHeight: 499 },
      sourceUrl: 'https://fixture.invalid/blockheaders',
      fileName: '400_499_headers'
    })
    expect(parseFileLink('https://cdn.example/headers/0_10000_headers.bin')).toEqual({
      range: { fromHeight: 0, toHeight: 10000 },
      sourceUrl: 'https://cdn.example/headers',
      fileName: '0_10000_headers.bin'
    })
  })

  test('rejects links without a supported file name or numeric bounds', () => {
    expect(parseFileLink('https://cdn.example/headers/')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/not_a_range')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/100_200')).toBeUndefined()
    expect(parseFileLink('not a URL')).toBeUndefined()
    expect(parseFileLink('http://cdn.example/headers/latest')).toBeUndefined()
    expect(parseFileLink('https://user:pass@cdn.example/headers/latest')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/latest?count=1')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/latest#fragment')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/200_100_headers')).toBeUndefined()
    expect(parseFileLink(`https://cdn.example/headers/0_${0x80000000}_headers`)).toBeUndefined()
  })

  test('downloads a latest resource after the preceding bounded range', async () => {
    const service = new WhatsOnChainServices(WhatsOnChainServices.createWhatsOnChainServicesOptions('main'))
    const data = new Uint8Array(160)
    const fetch = {
      fetchJson: jest.fn().mockResolvedValue({
        files: ['https://cdn.example/headers/100_199_headers', 'https://cdn.example/headers/latest']
      }),
      download: jest.fn().mockResolvedValue(data)
    }

    const files = await service.getHeaderByteFileLinks(new HeightRange(199, 201), fetch as any)

    expect(fetch.download).toHaveBeenCalledWith('https://cdn.example/headers/latest', 160, {
      publicNetworkOnly: true
    })
    expect(files).toEqual([
      expect.objectContaining({
        fileName: '100_199_headers',
        range: expect.objectContaining({ minHeight: 100, maxHeight: 199 })
      }),
      expect.objectContaining({
        fileName: 'latest',
        range: expect.objectContaining({ minHeight: 200, maxHeight: 201 }),
        data,
        publicNetworkOnly: true
      })
    ])
  })

  test('rejects unsafe manifests and malformed latest resources', async () => {
    const service = new WhatsOnChainServices(WhatsOnChainServices.createWhatsOnChainServicesOptions('main'))
    const fetch = {
      fetchJson: jest.fn().mockResolvedValue({ files: ['http://127.0.0.1/headers/0_1_headers'] }),
      download: jest.fn()
    }
    await expect(service.getHeaderByteFileLinks(new HeightRange(0, 1), fetch as any)).rejects.toThrow('unsafe')

    fetch.fetchJson.mockResolvedValue({
      files: ['https://cdn.example/headers/0_1_headers', 'https://cdn.example/headers/latest']
    })
    fetch.download.mockResolvedValue(new Uint8Array(81))
    await expect(service.getHeaderByteFileLinks(new HeightRange(1, 2), fetch as any)).rejects.toThrow('multiple of 80')
  })

  test('rejects accessor manifests without invoking them', async () => {
    const service = new WhatsOnChainServices(WhatsOnChainServices.createWhatsOnChainServicesOptions('main'))
    const getter = jest.fn(() => ['https://cdn.example/headers/latest'])
    const manifest = Object.defineProperty({}, 'files', { enumerable: true, get: getter })
    const fetch = { fetchJson: jest.fn().mockResolvedValue(manifest) }

    await expect(service.getHeaderByteFileLinks(new HeightRange(0, 1), fetch as any)).rejects.toThrow('data properties')
    expect(getter).not.toHaveBeenCalled()
  })

  test('validates and copies recent headers without mutating upstream data', async () => {
    const service = new WhatsOnChainServices(WhatsOnChainServices.createWhatsOnChainServicesOptions('main'))
    const source = wocGenesisHeader()
    const fetch = { fetchJson: jest.fn().mockResolvedValue([source]) }

    const headers = await service.getHeaders(fetch as any)
    expect(headers).toEqual([source])
    expect(headers[0]).not.toBe(source)
    expect(wocGetHeadersHeaderToBlockHeader(source)).toEqual(genesisHeader('main'))
    expect(source.previousblockhash).toBe('0'.repeat(64))

    fetch.fetchJson.mockResolvedValue([{ ...source, hash: '11'.repeat(32) }])
    await expect(service.getHeaders(fetch as any)).rejects.toThrow('hash is invalid')
  })
})

function wocGenesisHeader(): WocGetHeadersHeader {
  const header = genesisHeader('main')
  return {
    hash: header.hash,
    confirmations: 1,
    size: 80,
    height: header.height,
    version: header.version,
    versionHex: header.version.toString(16).padStart(8, '0'),
    merkleroot: header.merkleRoot,
    time: header.time,
    mediantime: header.time,
    nonce: header.nonce,
    bits: header.bits.toString(16).padStart(8, '0'),
    difficulty: 1,
    chainwork: '00'.repeat(32),
    previousblockhash: header.previousHash,
    nextblockhash: '',
    nTx: 1,
    num_tx: 1
  }
}
