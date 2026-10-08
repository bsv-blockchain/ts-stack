import HTTPWalletJSON from '../HTTPWalletJSON'
import { WERR_INVALID_PARAMETER } from '../../WERR_INVALID_PARAMETER'
import { WERR_INSUFFICIENT_FUNDS } from '../../WERR_INSUFFICIENT_FUNDS'
import { WERR_REVIEW_ACTIONS } from '../../WERR_REVIEW_ACTIONS'
import Transaction from '../../../transaction/Transaction'
import UnlockingScript from '../../../script/UnlockingScript'
import { withDoubleSpendRetry } from '../../../overlay-tools/withDoubleSpendRetry'
import Beef from '../../../transaction/Beef'
import type TopicBroadcaster from '../../../overlay-tools/SHIPBroadcaster'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_ORIGINATOR = 'example.com'
const TEST_ORIGIN_HEADER = 'http://example.com'
const BASE_URL = 'http://localhost:3321'
const VALID_TXID = 'ab'.repeat(32)
const VALID_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const VALID_CERT_TYPE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const VALID_CERT_SERIAL = 'AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI='
const VALID_DER_SIGNATURE = [0x30, 0x06, 0x02, 0x01, 1, 0x02, 0x01, 1]
const MINIMAL_TRANSACTION = new Transaction()
const MINIMAL_BEEF = MINIMAL_TRANSACTION.toAtomicBEEF()
const MINIMAL_TXID = MINIMAL_TRANSACTION.id('hex')
const VALID_BEEF = new Transaction().toBEEF()

/** Build a minimal fetch mock that resolves with a JSON-shaped Response. */
function makeFetch(
  body: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {}
): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(body)
  } as unknown as Response)
}

/** Build a fetch mock that rejects (network-level failure). */
function makeNetworkErrorFetch(message = 'Network failure'): jest.Mock {
  return jest.fn().mockRejectedValue(new Error(message))
}

function makeClient(mockFetch: jest.Mock): HTTPWalletJSON {
  return new HTTPWalletJSON(TEST_ORIGINATOR, BASE_URL, mockFetch as unknown as typeof fetch)
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – constructor', () => {
  it('stores the provided baseUrl', () => {
    const client = new HTTPWalletJSON(TEST_ORIGINATOR, 'https://my-server.example:9000/')
    expect(client.baseUrl).toBe('https://my-server.example:9000')
  })

  it.each([
    'http://wallet.example:9000',
    'https://user:password@wallet.example',
    'https://wallet.example/rpc',
    'https://wallet.example?tenant=alice'
  ])('rejects unsafe base URL %s', baseUrl => {
    expect(() => new HTTPWalletJSON(TEST_ORIGINATOR, baseUrl)).toThrow()
  })

  it('uses http://localhost:3321 as the default baseUrl', () => {
    const client = new HTTPWalletJSON(TEST_ORIGINATOR)
    expect(client.baseUrl).toBe(BASE_URL)
  })

  it('stores the originator', () => {
    const client = new HTTPWalletJSON('  Wallet.Example.COM  ')
    expect(client.originator).toBe('wallet.example.com')
  })

  it('rejects a non-hostname originator', () => {
    expect(() => new HTTPWalletJSON('https://wallet.example.com')).toThrow(WERR_INVALID_PARAMETER)
  })

  it('stores the custom httpClient', () => {
    const mockFetch = jest.fn()
    const client = new HTTPWalletJSON(
      TEST_ORIGINATOR,
      BASE_URL,
      mockFetch as unknown as typeof fetch
    )
    expect(client.httpClient).toBe(mockFetch)
  })
})

// ---------------------------------------------------------------------------
// api() – happy-path deserialization
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – api() successful responses', () => {
  it('POSTs to the correct URL and returns the parsed body', async () => {
    const mockFetch = makeFetch({ version: '1.0.0.0.0.0.0' })
    const client = makeClient(mockFetch)

    const result = await client.getVersion({})

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE_URL}/getVersion`)
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('error')
    expect(JSON.parse(init.body as string)).toEqual({})
    expect(result).toEqual({ version: '1.0.0.0.0.0.0' })
  })

  it('sets Accept and Content-Type headers', async () => {
    const mockFetch = makeFetch({ height: 800000 })
    const client = makeClient(mockFetch)

    await client.getHeight({})

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['Accept']).toBe('application/json')
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Origin']).toBe(TEST_ORIGIN_HEADER)
    expect(headers['Originator']).toBe(TEST_ORIGIN_HEADER)
  })

  it('serialises args as JSON in the request body', async () => {
    const mockFetch = makeFetch({ actions: [], totalActions: 0 })
    const client = makeClient(mockFetch)

    await client.listActions({ labels: ['test-label'] })

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({ labels: ['test-label'] })
  })

  it('throws before making a request in Node when originator is missing', async () => {
    const mockFetch = makeFetch({ version: '1.0.0.0.0.0.0' })
    const client = new HTTPWalletJSON(undefined, BASE_URL, mockFetch as unknown as typeof fetch)

    await expect(client.getVersion({})).rejects.toThrow('HTTPWalletJSON: originator is required')
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('rejects an oversized response before reading its body', async () => {
    const response = new Response('{}', {
      headers: { 'content-length': String(256 * 1024 * 1024 + 1) }
    })
    const mockFetch = jest.fn().mockResolvedValue(response)
    const client = makeClient(mockFetch)

    await expect(client.getVersion({})).rejects.toThrow('exceeds the maximum permitted size')
  })

  it('rejects malformed UTF-8 JSON', async () => {
    const response = new Response(Uint8Array.from([0xff]))
    const mockFetch = jest.fn().mockResolvedValue(response)
    const client = makeClient(mockFetch)

    await expect(client.getVersion({})).rejects.toThrow(/valid.*utf-8/i)
  })

  it('rejects prototype-sensitive response keys', async () => {
    const mockFetch = makeFetch(
      JSON.parse('{"version":"wallet-1.0.0","nested":{"__proto__":{"admin":true}}}')
    )
    const client = makeClient(mockFetch)

    await expect(client.getVersion({})).rejects.toThrow('safe record key')
  })

  it('rejects compatibility-response accessors before byte-field normalization', async () => {
    const versionGetter = jest.fn(() => 'wallet-1.0.0')
    const body = Object.create(null)
    Object.defineProperty(body, 'version', { enumerable: true, get: versionGetter })
    const client = makeClient(makeFetch(body))

    await expect(client.getVersion({})).rejects.toThrow('data property')
    expect(versionGetter).not.toHaveBeenCalled()
  })

  it('rejects list results larger than the requested page', async () => {
    const outputs = Array.from({ length: 11 }, (_, index) => ({
      outpoint: `${index.toString(16).padStart(64, '0')}.0`,
      satoshis: 1,
      spendable: true
    }))
    const client = makeClient(makeFetch({ totalOutputs: outputs.length, outputs }))

    await expect(client.listOutputs({ basket: 'default' })).rejects.toThrow('requested limit of 10')
  })

  it('rejects a non-affirmative authentication result', async () => {
    const client = makeClient(makeFetch({ authenticated: false }))
    await expect(client.isAuthenticated({})).rejects.toThrow('authenticated')
  })
})

// ---------------------------------------------------------------------------
// api() – error response deserialization
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – api() error responses', () => {
  it('throws WERR_INVALID_PARAMETER (code 6) when the server returns it', async () => {
    const errorBody = {
      isError: true,
      code: 6,
      parameter: 'description',
      message: 'The description parameter must be at least 5 length.'
    }
    const mockFetch = makeFetch(errorBody, { ok: false, status: 400 })
    const client = makeClient(mockFetch)

    await expect(client.createAction({ description: 'x' })).rejects.toThrow(WERR_INVALID_PARAMETER)

    try {
      await client.createAction({ description: 'x' })
    } catch (e: unknown) {
      const err = e as WERR_INVALID_PARAMETER
      expect(err.name).toBe('WERR_INVALID_PARAMETER')
      expect(err.parameter).toBe('description')
      expect(err.code).toBe(6)
    }
  })

  it('WERR_INVALID_PARAMETER carries the server message verbatim', async () => {
    const errorBody = {
      isError: true,
      code: 6,
      parameter: 'lockingScript',
      message: 'Custom server message for lockingScript.'
    }
    const mockFetch = makeFetch(errorBody, { ok: false, status: 400 })
    const client = makeClient(mockFetch)

    try {
      await client.createAction({ description: 'hello world' })
    } catch (e: unknown) {
      const err = e as WERR_INVALID_PARAMETER
      expect(err.message).toBe('Custom server message for lockingScript.')
    }
  })

  it('throws WERR_INSUFFICIENT_FUNDS (code 7) when the server returns it', async () => {
    const errorBody = {
      isError: true,
      code: 7,
      totalSatoshisNeeded: 5000,
      moreSatoshisNeeded: 2000
    }
    const mockFetch = makeFetch(errorBody, { ok: false, status: 400 })
    const client = makeClient(mockFetch)

    await expect(client.createAction({ description: 'hello world' })).rejects.toThrow(
      WERR_INSUFFICIENT_FUNDS
    )

    try {
      await client.createAction({ description: 'hello world' })
    } catch (e: unknown) {
      const err = e as WERR_INSUFFICIENT_FUNDS
      expect(err.totalSatoshisNeeded).toBe(5000)
      expect(err.moreSatoshisNeeded).toBe(2000)
      expect(err.code).toBe(7)
    }
  })

  it('throws WERR_REVIEW_ACTIONS (code 5) when the server returns it', async () => {
    const errorBody = {
      isError: true,
      code: 5,
      reviewActionResults: [{ txid: VALID_TXID, status: 'invalidTx' }],
      sendWithResults: [],
      txid: VALID_TXID
    }
    const mockFetch = makeFetch(errorBody, { ok: false, status: 400 })
    const client = makeClient(mockFetch)

    await expect(client.createAction({ description: 'hello world' })).rejects.toThrow(
      WERR_REVIEW_ACTIONS
    )

    try {
      await client.createAction({ description: 'hello world' })
    } catch (e: unknown) {
      const err = e as WERR_REVIEW_ACTIONS
      expect(err.code).toBe(5)
      expect(err.txid).toBe(VALID_TXID)
      expect(err.reviewActionResults).toEqual([{ txid: VALID_TXID, status: 'invalidTx' }])
    }
  })

  it.each([
    [{ isError: 'true', code: 6, parameter: 'x', message: 'bad' }, 'envelope'],
    [{ isError: true, code: 6, parameter: { nested: true }, message: 'bad' }, 'parameter'],
    [
      {
        isError: true,
        code: 7,
        totalSatoshisNeeded: 1,
        moreSatoshisNeeded: 2
      },
      'moreSatoshisNeeded'
    ],
    [
      {
        isError: true,
        code: 5,
        reviewActionResults: [{ txid: 'short', status: 'invalidTx' }],
        sendWithResults: [],
        txid: VALID_TXID
      },
      'reviewActionResults'
    ]
  ])('rejects malformed wallet error data %#', async (errorBody, message) => {
    const client = makeClient(makeFetch(errorBody, { ok: false, status: 400 }))
    await expect(client.createAction({ description: 'hello world' })).rejects.toThrow(message)
  })

  it('rejects a review error for a wallet method that cannot produce one', async () => {
    const errorBody = {
      isError: true,
      code: 5,
      reviewActionResults: [{ txid: VALID_TXID, status: 'invalidTx' }],
      sendWithResults: [],
      txid: VALID_TXID
    }
    const client = makeClient(makeFetch(errorBody, { ok: false, status: 400 }))

    await expect(client.getVersion({})).rejects.toThrow('Invalid getVersion wallet error code')
  })

  it('binds reviewed transaction IDs to the returned action and requested batch', async () => {
    const errorBody = {
      isError: true,
      code: 5,
      reviewActionResults: [{ txid: 'cd'.repeat(32), status: 'invalidTx' }],
      sendWithResults: [],
      txid: VALID_TXID
    }
    const client = makeClient(makeFetch(errorBody, { ok: false, status: 400 }))

    await expect(client.createAction({ description: 'hello world' })).rejects.toThrow(
      'reviewActionResults[0].txid'
    )
  })

  it('preserves pre-construction double-spend evidence bound to an explicit requested input', async () => {
    const winner = new Transaction(
      1,
      [
        {
          sourceTXID: VALID_TXID,
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )
    const body = {
      isError: true,
      code: 5,
      reviewActionResults: [
        {
          txid: '',
          status: 'doubleSpend',
          competingTxs: [winner.id('hex')],
          competingBeef: winner.toBEEF(true)
        }
      ],
      sendWithResults: []
    }
    const client = makeClient(makeFetch(body, { ok: false, status: 400 }))
    const error = await client
      .createAction({
        description: 'hello world',
        inputs: [
          {
            outpoint: `${VALID_TXID}.0`,
            unlockingScript: '00',
            inputDescription: 'existing shared checkpoint'
          }
        ]
      })
      .catch(error => error)
    expect(error).toBeInstanceOf(WERR_REVIEW_ACTIONS)
    expect(error.reviewActionResults).toEqual(body.reviewActionResults)
    expect(error.txid).toBeUndefined()
  })

  it('synchronizes proven conflict evidence before invoking a fresh save attempt', async () => {
    const winner = new Transaction(
      1,
      [
        {
          sourceTXID: VALID_TXID,
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )
    const client = makeClient(
      makeFetch(
        {
          isError: true,
          code: 5,
          reviewActionResults: [
            {
              txid: '',
              status: 'doubleSpend',
              competingTxs: [winner.id('hex')],
              competingBeef: winner.toBEEF(true)
            }
          ],
          sendWithResults: []
        },
        { ok: false, status: 400 }
      )
    )
    const events: string[] = []
    const broadcast = jest.fn(async (tx: Transaction) => {
      events.push('synchronize')
      expect(tx.id('hex')).toBe(winner.id('hex'))
      return { status: 'success', txid: tx.id('hex'), message: 'accepted' }
    })
    let attempts = 0
    const result = await withDoubleSpendRetry(
      async () => {
        events.push('read latest checkpoint')
        if (++attempts === 1)
          return await client.createAction({
            description: 'hello world',
            inputs: [
              {
                outpoint: `${VALID_TXID}.0`,
                unlockingScript: '00',
                inputDescription: 'existing checkpoint'
              }
            ]
          })
        return 'saved'
      },
      { broadcast } as unknown as TopicBroadcaster
    )
    expect(result).toBe('saved')
    expect(events).toEqual(['read latest checkpoint', 'synchronize', 'read latest checkpoint'])
    expect(broadcast).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['missing inputs', { inputs: [] }, {}],
    [
      'different input',
      {
        inputs: [
          {
            outpoint: `${VALID_TXID}.1`,
            unlockingScript: '00',
            inputDescription: 'existing checkpoint'
          }
        ]
      },
      {}
    ],
    ['constructed transaction', {}, { txid: VALID_TXID }],
    ['returned envelope', {}, { tx: MINIMAL_BEEF }],
    ['change outputs', {}, { noSendChange: [] }],
    ['batch results', {}, { sendWithResults: [{ txid: VALID_TXID, status: 'success' }] }],
    [
      'missing proof',
      {},
      { reviewActionResults: [{ txid: '', status: 'doubleSpend', competingTxs: [MINIMAL_TXID] }] }
    ],
    [
      'unrelated proof',
      {},
      {
        reviewActionResults: [
          {
            txid: '',
            status: 'doubleSpend',
            competingTxs: [MINIMAL_TXID],
            competingBeef: VALID_BEEF
          }
        ]
      }
    ],
    ['non-conflict status', {}, { reviewActionResults: [{ txid: '', status: 'serviceError' }] }],
    [
      'multiple reviews',
      {},
      {
        reviewActionResults: [
          { txid: '', status: 'doubleSpend' },
          { txid: VALID_TXID, status: 'success' }
        ]
      }
    ]
  ])('rejects pre-construction review with %s', async (_name, requestChanges, responseChanges) => {
    const winner = new Transaction(
      1,
      [
        {
          sourceTXID: VALID_TXID,
          sourceOutputIndex: 0,
          unlockingScript: new UnlockingScript(),
          sequence: 0xffffffff
        }
      ],
      [],
      0
    )
    const body = {
      isError: true,
      code: 5,
      reviewActionResults: [
        {
          txid: '',
          status: 'doubleSpend',
          competingTxs: [winner.id('hex')],
          competingBeef: winner.toBEEF(true)
        }
      ],
      sendWithResults: [],
      ...responseChanges
    }
    const client = makeClient(makeFetch(body, { ok: false, status: 400 }))
    const error = await client
      .createAction({
        description: 'hello world',
        inputs: [
          {
            outpoint: `${VALID_TXID}.0`,
            unlockingScript: '00',
            inputDescription: 'existing checkpoint'
          }
        ],
        ...requestChanges
      })
      .catch(error => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(WERR_REVIEW_ACTIONS)
  })

  it('rejects ID-only competing evidence without a transaction to bind', async () => {
    const proof = new Beef()
    proof.mergeTxidOnly(VALID_TXID)
    const client = makeClient(
      makeFetch(
        {
          isError: true,
          code: 5,
          reviewActionResults: [
            {
              txid: '',
              status: 'doubleSpend',
              competingTxs: [VALID_TXID],
              competingBeef: proof.toBinary()
            }
          ],
          sendWithResults: []
        },
        { ok: false, status: 400 }
      )
    )
    await expect(
      client.createAction({
        description: 'hello world',
        inputs: [
          {
            outpoint: `${VALID_TXID}.0`,
            unlockingScript: '00',
            inputDescription: 'existing checkpoint'
          }
        ]
      })
    ).rejects.toThrow('competingBeef')
  })

  it('does not accept a pre-construction review for signAction', async () => {
    const client = makeClient(
      makeFetch(
        {
          isError: true,
          code: 5,
          reviewActionResults: [{ txid: '', status: 'doubleSpend' }],
          sendWithResults: []
        },
        { ok: false, status: 400 }
      )
    )
    await expect(client.signAction({ reference: 'AQ==', spends: {} })).rejects.toThrow(
      'pre-construction review'
    )
  })

  it('rejects malformed competing BEEF before constructing a review error', async () => {
    const errorBody = {
      isError: true,
      code: 5,
      reviewActionResults: [
        {
          txid: VALID_TXID,
          status: 'doubleSpend',
          competingTxs: ['cd'.repeat(32)],
          competingBeef: [1, 2, 3]
        }
      ],
      sendWithResults: [],
      txid: VALID_TXID
    }
    const client = makeClient(makeFetch(errorBody, { ok: false, status: 400 }))

    await expect(client.createAction({ description: 'hello world' })).rejects.toThrow(
      'reviewActionResults[0].competingBeef'
    )
  })

  it.each([
    ['conflict evidence on a successful result', { status: 'success' }, 'competingTxs'],
    ['non-array competitors', { competingTxs: 'invalid' }, 'competingTxs'],
    [
      'too many competitors',
      { competingTxs: Array.from({ length: 1001 }, () => MINIMAL_TXID) },
      'competingTxs'
    ],
    ['non-string competitor', { competingTxs: [42] }, 'competingTxs[0]'],
    ['malformed competitor', { competingTxs: ['not-a-txid'] }, 'competingTxs[0]'],
    ['self competitor', { competingTxs: [VALID_TXID] }, 'competingTxs'],
    [
      'duplicate competitors',
      { competingTxs: [MINIMAL_TXID, MINIMAL_TXID.toUpperCase()] },
      'competingTxs'
    ],
    ['proof without competitor IDs', { competingTxs: [] }, 'competingBeef'],
    ['invalid proof byte', { competingBeef: [-1] }, 'competingBeef'],
    ['missing competitor transaction', { competingTxs: ['cd'.repeat(32)] }, 'competingBeef']
  ])('rejects a constructed review containing %s', async (_name, changes, field) => {
    const client = makeClient(
      makeFetch(
        {
          isError: true,
          code: 5,
          txid: VALID_TXID,
          sendWithResults: [],
          reviewActionResults: [
            {
              txid: VALID_TXID,
              status: 'doubleSpend',
              competingTxs: [MINIMAL_TXID],
              competingBeef: VALID_BEEF,
              ...changes
            }
          ]
        },
        { ok: false, status: 400 }
      )
    )
    const error = await client.createAction({ description: 'hello world' }).catch(error => error)
    expect(error).not.toBeInstanceOf(WERR_REVIEW_ACTIONS)
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toContain(`reviewActionResults[0].${field}`)
  })

  it('preserves constructed review compatibility without pre-construction input binding', async () => {
    const review = {
      txid: VALID_TXID,
      status: 'doubleSpend',
      competingTxs: [MINIMAL_TXID],
      competingBeef: VALID_BEEF
    }
    const client = makeClient(
      makeFetch(
        {
          isError: true,
          code: 5,
          txid: VALID_TXID,
          sendWithResults: [],
          reviewActionResults: [review]
        },
        { ok: false, status: 400 }
      )
    )
    const error = await client.createAction({ description: 'hello world' }).catch(error => error)
    expect(error).toBeInstanceOf(WERR_REVIEW_ACTIONS)
    expect(error.reviewActionResults).toEqual([review])
  })

  it('bounds review-action collections before iterating their entries', async () => {
    const errorBody = {
      isError: true,
      code: 5,
      reviewActionResults: Array.from({ length: 1002 }, () => ({
        txid: VALID_TXID,
        status: 'invalidTx'
      })),
      sendWithResults: [],
      txid: VALID_TXID
    }
    const client = makeClient(makeFetch(errorBody, { ok: false, status: 400 }))

    await expect(client.createAction({ description: 'hello world' })).rejects.toThrow(
      'reviewActionResults'
    )
  })

  it('throws a generic Error when the server returns a non-400 error status', async () => {
    const mockFetch = makeFetch({ message: 'Internal Server Error' }, { ok: false, status: 500 })
    const client = makeClient(mockFetch)

    await expect(client.getVersion({})).rejects.toThrow(Error)

    try {
      await client.getVersion({})
    } catch (e: unknown) {
      const err = e as Error
      expect(err.message).toContain('getVersion')
      expect(err.message).toContain('HTTP status 500')
      expect(err.message).not.toContain('Internal Server Error')
    }
  })

  it('returns a stable status error when the 500 body has no message', async () => {
    const mockFetch = makeFetch({}, { ok: false, status: 503 })
    const client = makeClient(mockFetch)

    try {
      await client.getVersion({})
    } catch (e: unknown) {
      const err = e as Error
      expect(err.message).toContain('HTTP status 503')
    }
  })

  it('does not copy request secrets or remote diagnostics into HTTP errors', async () => {
    const client = makeClient(
      makeFetch(
        { message: 'sqlite /private/wallet.db exposed secret_key' },
        { ok: false, status: 500 }
      )
    )

    await expect(
      client.encrypt({
        plaintext: [115, 101, 99, 114, 101, 116],
        protocolID: [0, 'tests'],
        keyID: 'private-key-id'
      })
    ).rejects.toThrow('HTTPWalletJSON encrypt failed with HTTP status 500')

    try {
      await client.encrypt({
        plaintext: [115, 101, 99, 114, 101, 116],
        protocolID: [0, 'tests'],
        keyID: 'private-key-id'
      })
    } catch (error) {
      const message = String((error as Error).message)
      expect(message).not.toContain('private-key-id')
      expect(message).not.toContain('/private/wallet.db')
      expect(message).not.toContain('secret_key')
    }
  })

  it('does NOT throw for an unknown error code when isError is true', async () => {
    // code 99 is unrecognised – falls through to the generic error path
    const errorBody = { isError: true, code: 99, message: 'Unknown problem' }
    const mockFetch = makeFetch(errorBody, { ok: false, status: 400 })
    const client = makeClient(mockFetch)

    await expect(client.getVersion({})).rejects.toThrow(Error)
  })
})

// ---------------------------------------------------------------------------
// Network errors
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – network errors', () => {
  it('propagates a fetch rejection as-is', async () => {
    const mockFetch = makeNetworkErrorFetch('Failed to fetch')
    const client = makeClient(mockFetch)

    await expect(client.getVersion({})).rejects.toThrow('Failed to fetch')
  })
})

// ---------------------------------------------------------------------------
// All wallet interface methods delegate to api()
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – method routing', () => {
  let client: HTTPWalletJSON
  let mockFetch: jest.Mock

  beforeEach(() => {
    mockFetch = makeFetch({})
    client = makeClient(mockFetch)
  })

  const expectCallName = async (method: () => Promise<unknown>, expectedPath: string) => {
    await method().catch(() => {
      /* ignore deserialization quirks */
    })
    const url: string = mockFetch.mock.calls[mockFetch.mock.calls.length - 1][0]
    expect(url).toContain(expectedPath)
  }

  it('createAction calls /createAction', async () => {
    await expectCallName(() => client.createAction({ description: 'hello world' }), '/createAction')
  })

  it('signAction calls /signAction', async () => {
    await expectCallName(() => client.signAction({ spends: {}, reference: 'cmVm' }), '/signAction')
  })

  it('abortAction calls /abortAction', async () => {
    await expectCallName(() => client.abortAction({ reference: 'cmVm' }), '/abortAction')
  })

  it('listActions calls /listActions', async () => {
    await expectCallName(() => client.listActions({ labels: [] }), '/listActions')
  })

  it('internalizeAction calls /internalizeAction', async () => {
    await expectCallName(
      () =>
        client.internalizeAction({
          tx: MINIMAL_BEEF,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                derivationPrefix: 'AQ==',
                derivationSuffix: 'Ag==',
                senderIdentityKey: VALID_PUBLIC_KEY
              }
            }
          ],
          description: 'hello world'
        }),
      '/internalizeAction'
    )
  })

  it('listOutputs calls /listOutputs', async () => {
    await expectCallName(() => client.listOutputs({ basket: 'default' }), '/listOutputs')
  })

  it('relinquishOutput calls /relinquishOutput', async () => {
    await expectCallName(
      () => client.relinquishOutput({ basket: 'default', output: `${VALID_TXID}.0` }),
      '/relinquishOutput'
    )
  })

  it('getPublicKey calls /getPublicKey', async () => {
    await expectCallName(() => client.getPublicKey({ identityKey: true }), '/getPublicKey')
  })

  it('revealCounterpartyKeyLinkage calls /revealCounterpartyKeyLinkage', async () => {
    await expectCallName(
      () =>
        client.revealCounterpartyKeyLinkage({
          counterparty: VALID_PUBLIC_KEY,
          verifier: VALID_PUBLIC_KEY
        }),
      '/revealCounterpartyKeyLinkage'
    )
  })

  it('revealSpecificKeyLinkage calls /revealSpecificKeyLinkage', async () => {
    await expectCallName(
      () =>
        client.revealSpecificKeyLinkage({
          counterparty: VALID_PUBLIC_KEY,
          verifier: VALID_PUBLIC_KEY,
          protocolID: [0, 'proto'],
          keyID: 'k1'
        }),
      '/revealSpecificKeyLinkage'
    )
  })

  it('encrypt calls /encrypt', async () => {
    await expectCallName(
      () => client.encrypt({ plaintext: [1, 2], protocolID: [0, 'proto'], keyID: 'k1' }),
      '/encrypt'
    )
  })

  it('decrypt calls /decrypt', async () => {
    await expectCallName(
      () => client.decrypt({ ciphertext: [1, 2], protocolID: [0, 'proto'], keyID: 'k1' }),
      '/decrypt'
    )
  })

  it('createHmac calls /createHmac', async () => {
    await expectCallName(
      () => client.createHmac({ data: [1], protocolID: [0, 'proto'], keyID: 'k1' }),
      '/createHmac'
    )
  })

  it('verifyHmac calls /verifyHmac', async () => {
    await expectCallName(
      () =>
        client.verifyHmac({
          data: [1],
          hmac: Array(32).fill(2),
          protocolID: [0, 'proto'],
          keyID: 'k1'
        }),
      '/verifyHmac'
    )
  })

  it('createSignature calls /createSignature', async () => {
    await expectCallName(
      () => client.createSignature({ data: [1], protocolID: [0, 'proto'], keyID: 'k1' }),
      '/createSignature'
    )
  })

  it('verifySignature calls /verifySignature', async () => {
    await expectCallName(
      () =>
        client.verifySignature({
          data: [1],
          signature: VALID_DER_SIGNATURE,
          protocolID: [0, 'proto'],
          keyID: 'k1'
        }),
      '/verifySignature'
    )
  })

  it('acquireCertificate calls /acquireCertificate', async () => {
    await expectCallName(
      () =>
        client.acquireCertificate({
          type: VALID_CERT_TYPE,
          certifier: VALID_PUBLIC_KEY,
          acquisitionProtocol: 'issuance',
          fields: {},
          certifierUrl: 'https://certifier.example.com'
        } as any),
      '/acquireCertificate'
    )
  })

  it('listCertificates calls /listCertificates', async () => {
    await expectCallName(
      () => client.listCertificates({ certifiers: [], types: [] }),
      '/listCertificates'
    )
  })

  it('proveCertificate calls /proveCertificate', async () => {
    await expectCallName(
      () =>
        client.proveCertificate({
          certificate: {} as any,
          fieldsToReveal: [],
          verifier: VALID_PUBLIC_KEY
        }),
      '/proveCertificate'
    )
  })

  it('relinquishCertificate calls /relinquishCertificate', async () => {
    await expectCallName(
      () =>
        client.relinquishCertificate({
          type: VALID_CERT_TYPE,
          serialNumber: VALID_CERT_SERIAL,
          certifier: VALID_PUBLIC_KEY
        }),
      '/relinquishCertificate'
    )
  })

  it('discoverByIdentityKey calls /discoverByIdentityKey', async () => {
    await expectCallName(
      () => client.discoverByIdentityKey({ identityKey: VALID_PUBLIC_KEY }),
      '/discoverByIdentityKey'
    )
  })

  it('discoverByAttributes calls /discoverByAttributes', async () => {
    await expectCallName(
      () => client.discoverByAttributes({ attributes: { name: 'Alice' } }),
      '/discoverByAttributes'
    )
  })

  it('isAuthenticated calls /isAuthenticated', async () => {
    await expectCallName(() => client.isAuthenticated({}), '/isAuthenticated')
  })

  it('waitForAuthentication calls /waitForAuthentication', async () => {
    await expectCallName(() => client.waitForAuthentication({}), '/waitForAuthentication')
  })

  it('getHeight calls /getHeight', async () => {
    await expectCallName(() => client.getHeight({}), '/getHeight')
  })

  it('getHeaderForHeight calls /getHeaderForHeight', async () => {
    await expectCallName(() => client.getHeaderForHeight({ height: 1 }), '/getHeaderForHeight')
  })

  it('getNetwork calls /getNetwork', async () => {
    await expectCallName(() => client.getNetwork({}), '/getNetwork')
  })

  it('getVersion calls /getVersion', async () => {
    await expectCallName(() => client.getVersion({}), '/getVersion')
  })
})

// ---------------------------------------------------------------------------
// Response body passthrough
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – response body passthrough', () => {
  it('returns the exact JSON body from a successful getVersion call', async () => {
    const expected = { version: '1.0.0.0.0.0.0' }
    const mockFetch = makeFetch(expected)
    const client = makeClient(mockFetch)

    const result = await client.getVersion({})
    expect(result).toEqual(expected)
  })

  it('returns the exact JSON body from a successful listActions call', async () => {
    const expected = {
      totalActions: 2,
      actions: [
        {
          txid: VALID_TXID,
          satoshis: 1,
          status: 'completed',
          isOutgoing: false,
          description: 'test action',
          version: 1,
          lockTime: 0
        }
      ]
    }
    const mockFetch = makeFetch(expected)
    const client = makeClient(mockFetch)

    const result = await client.listActions({ labels: [] })
    expect(result).toEqual(expected)
  })

  it('returns the exact JSON body from a successful getNetwork call', async () => {
    const expected = { network: 'mainnet' as const }
    const mockFetch = makeFetch(expected)
    const client = makeClient(mockFetch)

    const result = await client.getNetwork({})
    expect(result).toEqual(expected)
  })
})

// ---------------------------------------------------------------------------
// Byte-field wire compatibility (Uint8Array JSON mangling)
// ---------------------------------------------------------------------------

describe('HTTPWalletJSON – byte-field wire compatibility', () => {
  it('repairs a createAction tx returned as a numeric-keyed object', async () => {
    // Wallets that JSON.stringify a Uint8Array result serialize tx as
    // {"0":1,"1":1,...} instead of an array (observed in the wild).
    const mangledTx = JSON.parse(JSON.stringify(new Uint8Array(MINIMAL_BEEF)))
    const mockFetch = makeFetch({ txid: MINIMAL_TXID, tx: mangledTx })
    const client = makeClient(mockFetch)

    const result = await client.createAction({ description: 'test action' })
    expect(result.tx).toEqual(MINIMAL_BEEF)
  })

  it('repairs a signAction tx returned as a numeric-keyed object', async () => {
    const mangledTx = JSON.parse(JSON.stringify(new Uint8Array(MINIMAL_BEEF)))
    const mockFetch = makeFetch({ txid: MINIMAL_TXID, tx: mangledTx })
    const client = makeClient(mockFetch)

    const result = await client.signAction({ spends: {}, reference: 'cmVm' })
    expect(result.tx).toEqual(MINIMAL_BEEF)
  })

  it('repairs a nested createAction signableTransaction tx', async () => {
    const mangledTx = JSON.parse(JSON.stringify(new Uint8Array(MINIMAL_BEEF)))
    const mockFetch = makeFetch({
      signableTransaction: { tx: mangledTx, reference: 'cmVm' }
    })
    const client = makeClient(mockFetch)

    const result = await client.createAction({
      description: 'test action',
      options: { signAndProcess: false }
    })
    expect(result.signableTransaction?.tx).toEqual(MINIMAL_BEEF)
  })

  it('repairs listOutputs BEEF and cryptographic byte results', async () => {
    const mangled = (bytes: number[]): Record<string, number> =>
      JSON.parse(JSON.stringify(new Uint8Array(bytes)))
    const listClient = makeClient(
      makeFetch({ totalOutputs: 0, outputs: [], BEEF: mangled(VALID_BEEF) })
    )
    const cryptoClient = makeClient(makeFetch({ hmac: mangled(Array(32).fill(4)) }))

    await expect(listClient.listOutputs({ basket: 'test' })).resolves.toMatchObject({
      BEEF: VALID_BEEF
    })
    await expect(
      cryptoClient.createHmac({
        data: [],
        protocolID: [1, 'test protocol'],
        keyID: '1'
      })
    ).resolves.toEqual({ hmac: Array(32).fill(4) })
  })

  it('leaves a healthy number[] tx untouched', async () => {
    const tx = MINIMAL_BEEF
    const mockFetch = makeFetch({ txid: MINIMAL_TXID, tx })
    const client = makeClient(mockFetch)

    const result = await client.createAction({ description: 'test action' })
    expect(result.tx).toEqual(tx)
  })

  it('serializes Uint8Array request args (inputBEEF) as JSON arrays', async () => {
    const mockFetch = makeFetch({ txid: VALID_TXID })
    const client = makeClient(mockFetch)

    await client.createAction({
      description: 'test action',
      inputBEEF: new Uint8Array(VALID_BEEF),
      options: { returnTXIDOnly: true }
    })

    const body = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(body.inputBEEF).toEqual(VALID_BEEF)
  })
})
