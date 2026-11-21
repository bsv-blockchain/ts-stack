import LivePolicy from '../LivePolicy.js'

describe('LivePolicy', () => {
  let consoleSpy: jest.SpyInstance

  const createMockTransaction = () =>
    ({
      inputs: [],
      outputs: []
    }) as any

  const createSuccessfulFetchMock = (satoshis: number, bytes: number = 1000) =>
    jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        policy: {
          miningFee: { satoshis, bytes }
        }
      })
    })

  const createErrorFetchMock = (status = 500, statusText = 'Internal Server Error') =>
    jest.fn().mockResolvedValue({
      ok: false,
      status,
      statusText
    })

  const createInvalidResponseMock = () =>
    jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ invalid: 'response' })
    })

  const createNetworkErrorMock = () => jest.fn().mockRejectedValue(new Error('Network error'))

  const expectDefaultFallback = (consoleSpy: jest.SpyInstance) => {
    expect(consoleSpy).toHaveBeenCalledWith(
      'Failed to fetch live fee rate; using default 100 sat/kb.'
    )
  }

  const expectCachedFallback = (consoleSpy: jest.SpyInstance) => {
    expect(consoleSpy).toHaveBeenCalledWith('Failed to fetch live fee rate; using cached value.')
  }

  beforeEach(() => {
    ;(LivePolicy as any).instance = null
    jest.clearAllMocks()
    consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  it('should return the same instance when getInstance is called multiple times', () => {
    const instance1 = LivePolicy.getInstance()
    const instance2 = LivePolicy.getInstance()

    expect(instance1).toBe(instance2)
    expect(instance1).toBeInstanceOf(LivePolicy)
  })

  it('should share cache between singleton instances', async () => {
    const instance1 = LivePolicy.getInstance()
    const instance2 = LivePolicy.getInstance()

    global.fetch = createSuccessfulFetchMock(5)
    const mockTx = createMockTransaction()

    const fee1 = await instance1.computeFee(mockTx)
    const fee2 = await instance2.computeFee(mockTx)

    expect(fee1).toBe(fee2)
    expect(fee1).toBe(1) // 5 sat/kb rate, minimum tx size gets 1 sat
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('should allow different cache validity when creating singleton', () => {
    const instance1 = LivePolicy.getInstance(10000)
    const instance2 = LivePolicy.getInstance(20000)

    expect(instance1).toBe(instance2)
    expect((instance1 as any).cacheValidityMs).toBe(10000)
  })

  it('should create instance with custom cache validity', () => {
    const instance = new LivePolicy(30000)
    expect((instance as any).cacheValidityMs).toBe(30000)
  })

  it('should handle HTTP error responses', async () => {
    const instance = LivePolicy.getInstance()
    global.fetch = createErrorFetchMock()
    const mockTx = createMockTransaction()

    const fee = await instance.computeFee(mockTx)

    expect(fee).toBe(1)
    expectDefaultFallback(consoleSpy)
  })

  it('should handle invalid API response format', async () => {
    const instance = LivePolicy.getInstance()
    global.fetch = createInvalidResponseMock()
    const mockTx = createMockTransaction()

    const fee = await instance.computeFee(mockTx)

    expect(fee).toBe(1)
    expectDefaultFallback(consoleSpy)
  })

  it('should use cached value when API fails after successful fetch', async () => {
    const instance = LivePolicy.getInstance()
    const mockTx = createMockTransaction()

    // First call - successful fetch
    global.fetch = createSuccessfulFetchMock(10)
    const fee1 = await instance.computeFee(mockTx)
    expect(fee1).toBe(1)

    // Expire cache and simulate API failure
    ;(instance as any).cacheTimestamp = Date.now() - 6 * 60 * 1000
    global.fetch = createNetworkErrorMock()

    const fee2 = await instance.computeFee(mockTx)

    expect(fee2).toBe(1)
    expectCachedFallback(consoleSpy)
  })

  it('should handle network errors with no cached value', async () => {
    const instance = LivePolicy.getInstance()
    global.fetch = createNetworkErrorMock()
    const mockTx = createMockTransaction()

    const fee = await instance.computeFee(mockTx)

    expect(fee).toBe(1)
    expectDefaultFallback(consoleSpy)
  })

  describe('configured policy endpoint and HTTP client', () => {
    const policyClient = (satoshis: number, bytes = 1000) => {
      const request = jest.fn(async (_url: string, _options: unknown) => ({
        ok: true as const,
        status: 200,
        statusText: 'OK',
        data: { policy: { miningFee: { satoshis, bytes } } }
      }))
      return { request }
    }

    it('reads the rate from the configured URL through the configured client', async () => {
      global.fetch = jest.fn(async () => {
        throw new Error('the global fetch must not be used')
      }) as any
      const httpClient = policyClient(50)
      const policy = new LivePolicy(60_000, {
        policyUrl: 'https://arc.example.test/v1/policy',
        httpClient
      })

      const fee = await policy.computeFee(createMockTransaction())

      expect(httpClient.request).toHaveBeenCalledTimes(1)
      expect(httpClient.request).toHaveBeenCalledWith('https://arc.example.test/v1/policy', {
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
      expect(policy.value).toBe(50)
      expect(fee).toBe(1)
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('keeps the GorillaPool endpoint when only a client is configured', async () => {
      const httpClient = policyClient(10)
      await new LivePolicy(0, { httpClient }).computeFee(createMockTransaction())
      expect(httpClient.request.mock.calls[0][0]).toBe('https://arc.gorillapool.io/v1/policy')
    })

    it('falls back as before when the configured client fails', async () => {
      const httpClient = { request: jest.fn(async () => await Promise.reject(new Error('down'))) }
      const fee = await new LivePolicy(0, { httpClient }).computeFee(createMockTransaction())
      expect(fee).toBe(1)
      expect(httpClient.request).toHaveBeenCalledTimes(1)
      expectDefaultFallback(consoleSpy)
    })

    it.each([
      ['a relative URL', { policyUrl: '/v1/policy' }],
      ['a non-HTTP URL', { policyUrl: 'ftp://arc.example.test/v1/policy' }],
      ['a non-string URL', { policyUrl: 42 }],
      ['a client without request()', { httpClient: {} }]
    ])('refuses %s at construction', (_case, options) => {
      expect(() => new LivePolicy(60_000, options as any)).toThrow(TypeError)
    })
  })
})
