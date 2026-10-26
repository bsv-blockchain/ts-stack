import { normalizeWalletHttpBaseUrl, toOriginHeader } from '../utils/toOriginHeader'

afterEach(() => jest.resetAllMocks())

type _FetchMockCall = Parameters<typeof fetch> // alias for readability

function _okJson(body: unknown = {}) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body)
  } as Response)
}

describe('toOriginHeader()', () => {
  const vectors: Array<[originator: string, baseUrl: string, expected: string | undefined]> = [
    /* originator,                     baseUrl,                      expected */
    ['localhost', 'http://localhost:3321', 'http://localhost'],
    ['localhost:3000', 'http://localhost:3321', 'http://localhost:3000'],
    ['example.com', 'https://api.example.com', 'https://example.com'],
    ['https://example.com:8443', 'http://localhost:3321', 'https://example.com:8443']
  ]

  it.each(vectors)('originator=%p, baseUrl=%p → %p', (originator, baseUrl, expected) => {
    const schemeFromBase = new URL(baseUrl).protocol.replace(':', '')
    const result = toOriginHeader(originator, schemeFromBase)
    expect(result).toBe(expected)
  })

  it('throws on clearly malformed input', () => {
    expect(() => toOriginHeader('bad url^%', 'http')).toThrow()
  })
})

describe('normalizeWalletHttpBaseUrl()', () => {
  it.each([
    ['http://localhost:3301/', 'http://localhost:3301'],
    ['http://wallet.localhost:3301', 'http://wallet.localhost:3301'],
    ['http://127.0.0.1:3301', 'http://127.0.0.1:3301'],
    ['http://[::1]:3301', 'http://[::1]:3301'],
    ['https://wallet.example:443/', 'https://wallet.example']
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeWalletHttpBaseUrl(input)).toBe(expected)
  })

  it.each([
    'http://wallet.example',
    'https://user:password@wallet.example',
    'https://wallet.example/rpc',
    'https://wallet.example?tenant=alice',
    'https://wallet.example#rpc',
    'file:///tmp/wallet.sock',
    'wallet.example',
    ' https://wallet.example'
  ])('rejects unsafe endpoint %s', input => {
    expect(() => normalizeWalletHttpBaseUrl(input)).toThrow()
  })
})
