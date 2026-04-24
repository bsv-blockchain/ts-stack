import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Utils } from '@bsv/sdk'
import type { WalletInterface } from '@bsv/sdk'
import { create402Fetch, constructPaymentHeaders } from './client.js'
import { HEADERS, BRC29_PROTOCOL_ID } from './constants.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_URL = 'https://example.com/articles/foo'
// Real valid compressed public keys (required by PublicKey.fromString inside client.ts)
const SERVER_KEY = '03f8104e2b313136ef1b84fcd9c8aadb775beb89a8207c942b31ab89e160ba4c86'
const DERIVED_KEY = '03f8104e2b313136ef1b84fcd9c8aadb775beb89a8207c942b31ab89e160ba4c86'
const SENDER_KEY = '03f8104e2b313136ef1b84fcd9c8aadb775beb89a8207c942b31ab89e160ba4c86'
const FAKE_TX_BYTES = [1, 2, 3, 4, 5]
const FAKE_TX_BASE64 = Utils.toBase64(FAKE_TX_BYTES)

/** A Response factory — easier than constructing Response objects inline */
function makeResponse(status: number, body = '', headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: new Headers(headers) })
}

/** A 402 response with valid BSV payment headers */
function make402Response(sats = 100, serverKey = SERVER_KEY): Response {
  return makeResponse(402, '', {
    [HEADERS.SATS]: String(sats),
    [HEADERS.SERVER]: serverKey
  })
}

/** Builds a wallet mock with all required methods for the client flow */
function makeWallet(): WalletInterface {
  return {
    getPublicKey: vi.fn().mockImplementation(async (args: any) => {
      if (args.identityKey) return { publicKey: SENDER_KEY }
      return { publicKey: DERIVED_KEY }
    }),
    createAction: vi.fn().mockResolvedValue({ tx: FAKE_TX_BYTES }),
    // Unused but required by interface
    internalizeAction: vi.fn(),
    abortAction: vi.fn(),
    getVersion: vi.fn(),
    isAuthenticated: vi.fn(),
    waitForAuthentication: vi.fn(),
    getHeaderForHeight: vi.fn(),
    getHeight: vi.fn(),
    getNetwork: vi.fn(),
    signAction: vi.fn(),
    listActions: vi.fn(),
    internalizeOutput: vi.fn(),
    listOutputs: vi.fn(),
    relinquishOutput: vi.fn(),
    revealCounterpartyKeyLinkage: vi.fn(),
    revealSpecificKeyLinkage: vi.fn(),
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    createHmac: vi.fn(),
    verifyHmac: vi.fn(),
    createSignature: vi.fn(),
    verifySignature: vi.fn(),
    acquireCertificate: vi.fn(),
    listCertificates: vi.fn(),
    proveCertificate: vi.fn(),
    relinquishCertificate: vi.fn(),
    discoverByIdentityKey: vi.fn(),
    discoverByAttributes: vi.fn(),
  } as unknown as WalletInterface
}

// ---------------------------------------------------------------------------
// constructPaymentHeaders
// ---------------------------------------------------------------------------

describe('constructPaymentHeaders', () => {
  it('returns all five payment headers', async () => {
    const wallet = makeWallet()
    const headers = await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    expect(headers[HEADERS.BEEF]).toBeDefined()
    expect(headers[HEADERS.SENDER]).toBeDefined()
    expect(headers[HEADERS.NONCE]).toBeDefined()
    expect(headers[HEADERS.TIME]).toBeDefined()
    expect(headers[HEADERS.VOUT]).toBeDefined()
  })

  it('always sets vout to "0"', async () => {
    const wallet = makeWallet()
    const headers = await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    expect(headers[HEADERS.VOUT]).toBe('0')
  })

  it('sets the sender to the wallet identity key', async () => {
    const wallet = makeWallet()
    const headers = await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    expect(headers[HEADERS.SENDER]).toBe(SENDER_KEY)
  })

  it('sets beef to the base64-encoded tx from createAction', async () => {
    const wallet = makeWallet()
    const headers = await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    expect(headers[HEADERS.BEEF]).toBe(FAKE_TX_BASE64)
  })

  it('sets time to a numeric string (unix ms)', async () => {
    const wallet = makeWallet()
    const before = Date.now()
    const headers = await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    const after = Date.now()
    const t = Number(headers[HEADERS.TIME])
    expect(Number.isNaN(t)).toBe(false)
    expect(t).toBeGreaterThanOrEqual(before)
    expect(t).toBeLessThanOrEqual(after)
  })

  it('derives timeSuffixB64 using Utils.toBase64(Utils.toArray(time, "utf8"))', async () => {
    const wallet = makeWallet()
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    const expectedSuffix = Utils.toBase64(Utils.toArray(String(fixedNow), 'utf8'))
    await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({
        keyID: expect.stringContaining(expectedSuffix)
      }),
      expect.any(String)
    )
    vi.restoreAllMocks()
  })

  it('uses the URL origin as the originator for all wallet calls', async () => {
    const wallet = makeWallet()
    await constructPaymentHeaders(wallet, 'https://pay.example.com/item/1', 50, SERVER_KEY)
    for (const call of (wallet.getPublicKey as ReturnType<typeof vi.fn>).mock.calls) {
      expect(call[1]).toBe('https://pay.example.com')
    }
    expect((wallet.createAction as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe('https://pay.example.com')
  })

  it('passes the correct satoshi amount to createAction', async () => {
    const wallet = makeWallet()
    await constructPaymentHeaders(wallet, TEST_URL, 777, SERVER_KEY)
    expect(wallet.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: expect.arrayContaining([
          expect.objectContaining({ satoshis: 777 })
        ])
      }),
      expect.any(String)
    )
  })

  it('derives the recipient key using BRC29_PROTOCOL_ID and the server key as counterparty', async () => {
    const wallet = makeWallet()
    await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    const derivationCall = (wallet.getPublicKey as ReturnType<typeof vi.fn>).mock.calls.find(
      ([args]) => args.protocolID !== undefined
    )
    expect(derivationCall).toBeDefined()
    expect(derivationCall![0].protocolID).toEqual(BRC29_PROTOCOL_ID)
    expect(derivationCall![0].counterparty).toBe(SERVER_KEY)
  })

  it('does not call fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const wallet = makeWallet()
    await constructPaymentHeaders(wallet, TEST_URL, 100, SERVER_KEY)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

// ---------------------------------------------------------------------------
// create402Fetch — non-payment paths
// ---------------------------------------------------------------------------

describe('create402Fetch', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  describe('non-402 responses', () => {
    it('returns a 200 response directly without any wallet interaction', async () => {
      const wallet = makeWallet()
      fetchMock.mockResolvedValue(makeResponse(200, 'hello'))
      const fetch402 = create402Fetch({ wallet })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(200)
      expect(wallet.createAction).not.toHaveBeenCalled()
    })

    it('returns a 404 response directly', async () => {
      fetchMock.mockResolvedValue(makeResponse(404))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(404)
    })

    it('returns a 500 response directly', async () => {
      fetchMock.mockResolvedValue(makeResponse(500))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(500)
    })

    it('only calls fetch once for a non-402 response', async () => {
      fetchMock.mockResolvedValue(makeResponse(200))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      await fetch402(TEST_URL)
      expect(fetchMock).toHaveBeenCalledOnce()
    })
  })

  // ---------------------------------------------------------------------------
  // 402 with invalid / missing payment headers
  // ---------------------------------------------------------------------------

  describe('402 with malformed payment headers', () => {
    it('returns the 402 directly when x-bsv-sats is missing', async () => {
      fetchMock.mockResolvedValue(makeResponse(402, '', { [HEADERS.SERVER]: SERVER_KEY }))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(402)
    })

    it('returns the 402 directly when x-bsv-server is missing', async () => {
      fetchMock.mockResolvedValue(makeResponse(402, '', { [HEADERS.SATS]: '100' }))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(402)
    })

    it('returns the 402 directly when sats is not a valid number', async () => {
      fetchMock.mockResolvedValue(makeResponse(402, '', {
        [HEADERS.SATS]: 'not-a-number',
        [HEADERS.SERVER]: SERVER_KEY
      }))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(402)
    })

    it('returns the 402 directly when sats is zero', async () => {
      fetchMock.mockResolvedValue(makeResponse(402, '', {
        [HEADERS.SATS]: '0',
        [HEADERS.SERVER]: SERVER_KEY
      }))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(402)
    })

    it('returns the 402 directly when sats is negative', async () => {
      fetchMock.mockResolvedValue(makeResponse(402, '', {
        [HEADERS.SATS]: '-10',
        [HEADERS.SERVER]: SERVER_KEY
      }))
      const fetch402 = create402Fetch({ wallet: makeWallet() })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(402)
    })

    it('does not call wallet when 402 headers are malformed', async () => {
      fetchMock.mockResolvedValue(makeResponse(402, '', { [HEADERS.SERVER]: SERVER_KEY }))
      const wallet = makeWallet()
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      expect(wallet.createAction).not.toHaveBeenCalled()
      expect(wallet.getPublicKey).not.toHaveBeenCalled()
    })
  })

  // ---------------------------------------------------------------------------
  // Payment construction (happy path)
  // ---------------------------------------------------------------------------

  describe('payment construction', () => {
    it('calls wallet.getPublicKey for BRC-42 key derivation', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid content'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      const derivationCall = (wallet.getPublicKey as ReturnType<typeof vi.fn>).mock.calls.find(
        ([args]) => args.protocolID !== undefined
      )
      expect(derivationCall).toBeDefined()
      expect(derivationCall![0].protocolID).toEqual(BRC29_PROTOCOL_ID)
      expect(derivationCall![0].counterparty).toBe(SERVER_KEY)
    })

    it('calls wallet.getPublicKey for sender identity key', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      const identityCall = (wallet.getPublicKey as ReturnType<typeof vi.fn>).mock.calls.find(
        ([args]) => args.identityKey === true
      )
      expect(identityCall).toBeDefined()
    })

    it('calls wallet.createAction with the correct satoshi amount', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(250))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      expect(wallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: expect.arrayContaining([
            expect.objectContaining({ satoshis: 250 })
          ])
        }),
        expect.any(String)
      )
    })

    it('builds a P2PKH locking script from the derived public key hash', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      const [[createArgs]] = (wallet.createAction as ReturnType<typeof vi.fn>).mock.calls
      const { lockingScript } = createArgs.outputs[0]
      expect(lockingScript).toMatch(/^76a914[0-9a-f]{40}88ac$/)
    })

    it('uses randomizeOutputs: false', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      expect(wallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ options: { randomizeOutputs: false } }),
        expect.any(String)
      )
    })

    it('uses the URL origin as the originator', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402('https://example.com/articles/foo')
      expect(wallet.createAction).toHaveBeenCalledWith(
        expect.anything(),
        'https://example.com'
      )
    })

    it('tags the output with 402-payment', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      expect(wallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: expect.arrayContaining([
            expect.objectContaining({ tags: ['402-payment'] })
          ]),
          labels: expect.arrayContaining(['402-payment'])
        }),
        expect.any(String)
      )
    })

    it('sends the payment headers on the retransmitted request', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)

      const [, [, retransmitInit]] = fetchMock.mock.calls
      const headers = retransmitInit.headers as Record<string, string>
      expect(headers[HEADERS.BEEF]).toBe(FAKE_TX_BASE64)
      expect(headers[HEADERS.SENDER]).toBe(SENDER_KEY)
      expect(headers[HEADERS.NONCE]).toBeDefined()
      expect(headers[HEADERS.TIME]).toBeDefined()
      expect(headers[HEADERS.VOUT]).toBe('0')
    })

    it('preserves existing init headers on the retransmit', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL, { headers: { Authorization: 'Bearer token' } })

      const [, [, retransmitInit]] = fetchMock.mock.calls
      const headers = retransmitInit.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer token')
    })

    it('includes the URL pathname in the createAction description', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402('https://example.com/articles/my-post')
      expect(wallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'Paid Content: /articles/my-post' }),
        expect.any(String)
      )
    })
  })

  // ---------------------------------------------------------------------------
  // Paid response handling
  // ---------------------------------------------------------------------------

  describe('paid response handling', () => {
    it('returns a 200 response after successful payment', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'paid content'))
      const fetch402 = create402Fetch({ wallet })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('paid content')
    })

    it('returns the raw paid response when it is not ok (e.g. still 402)', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(402, 'still no'))
      const fetch402 = create402Fetch({ wallet })
      const res = await fetch402(TEST_URL)
      expect(res.status).toBe(402)
    })

    it('does not cache a non-ok paid response', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(403, 'forbidden'))
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'ok now'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL) // first attempt: 403
      await fetch402(TEST_URL) // second attempt: should hit network again
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  })

  // ---------------------------------------------------------------------------
  // Caching
  // ---------------------------------------------------------------------------

  describe('cache', () => {
    it('serves subsequent requests from cache without calling fetch again', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'cached body'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)         // populates cache
      const cached = await fetch402(TEST_URL) // should hit cache
      expect(fetchMock).toHaveBeenCalledTimes(2) // only the 2 calls from the first request
      expect(await cached.text()).toBe('cached body')
    })

    it('cached response has the same status as the original', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'body'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      const cached = await fetch402(TEST_URL)
      expect(cached.status).toBe(200)
    })

    it('re-fetches after cache entry expires', async () => {
      vi.useFakeTimers()
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'fresh'))
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'refetched'))
      const CACHE_MS = 5_000
      const fetch402 = create402Fetch({ wallet, cacheTimeoutMs: CACHE_MS })
      await fetch402(TEST_URL) // populate cache
      vi.advanceTimersByTime(CACHE_MS + 1) // expire it
      await fetch402(TEST_URL) // should re-fetch
      expect(fetchMock).toHaveBeenCalledTimes(4)
      vi.useRealTimers()
    })

    it('clearCache() forces a fresh request on next call', async () => {
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'first'))
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'second'))
      const fetch402 = create402Fetch({ wallet })
      await fetch402(TEST_URL)
      fetch402.clearCache()
      await fetch402(TEST_URL) // cache was cleared — must re-fetch
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })

    it('respects a custom cacheTimeoutMs', async () => {
      vi.useFakeTimers()
      const wallet = makeWallet()
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'body'))
        .mockResolvedValueOnce(makeResponse(200, 'body2'))
      const fetch402 = create402Fetch({ wallet, cacheTimeoutMs: 1_000 })
      await fetch402(TEST_URL)
      vi.advanceTimersByTime(999) // still within window
      await fetch402(TEST_URL)   // should hit cache
      expect(fetchMock).toHaveBeenCalledTimes(2) // no additional fetch calls
      vi.useRealTimers()
    })

    it('cache is per-URL (different URLs are cached independently)', async () => {
      const wallet = makeWallet()
      const URL2 = 'https://example.com/articles/bar'
      fetchMock
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'foo content'))
        .mockResolvedValueOnce(make402Response(100))
        .mockResolvedValueOnce(makeResponse(200, 'bar content'))
      const fetch402 = create402Fetch({ wallet })
      const r1 = await fetch402(TEST_URL)
      const r2 = await fetch402(URL2)
      expect(await r1.text()).toBe('foo content')
      expect(await r2.text()).toBe('bar content')
      expect(fetchMock).toHaveBeenCalledTimes(4)
    })
  })
})
