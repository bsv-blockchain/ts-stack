import { WhatsOnChainServices, parseFileLink } from '../WhatsOnChainServices'
import { HeightRange } from '../../util/HeightRange'

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
  })

  test('rejects links without a supported file name or numeric bounds', () => {
    expect(parseFileLink('https://cdn.example/headers/')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/not_a_range')).toBeUndefined()
    expect(parseFileLink('https://cdn.example/headers/100_200')).toBeUndefined()
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

    expect(fetch.download).toHaveBeenCalledWith('https://cdn.example/headers/latest')
    expect(files).toEqual([
      expect.objectContaining({
        fileName: '100_199_headers',
        range: expect.objectContaining({ minHeight: 100, maxHeight: 199 })
      }),
      expect.objectContaining({
        fileName: 'latest',
        range: expect.objectContaining({ minHeight: 200, maxHeight: 201 }),
        data
      })
    ])
  })
})
