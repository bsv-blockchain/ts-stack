import { parseFileLink } from '../WhatsOnChainServices'

describe('WhatsOnChain header file links', () => {
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
})
