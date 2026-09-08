import { jest } from '@jest/globals'
import { parseKnownTxidsHeader, AuthFetch } from '../AuthFetch.js'
import { Utils, PrivateKey } from '../../../primitives/index.js'
import type { CreateActionOptions, WalletInterface } from '../../../wallet/Wallet.interfaces.js'
import type { Peer } from '../../Peer.js'

jest.mock('../../utils/createNonce.js', () => ({
  createNonce: jest.fn()
}))

import { createNonce } from '../../utils/createNonce.js'

const createNonceMock = createNonce as jest.MockedFunction<typeof createNonce>
type FetchOptions = NonNullable<Parameters<AuthFetch['fetch']>[1]>
type PaymentContext = NonNullable<FetchOptions['paymentContext']>
type TestWallet = jest.Mocked<Pick<WalletInterface, 'getPublicKey' | 'createAction' | 'createHmac'>>

interface PaymentInternals {
  handlePaymentAndRetry: (
    url: string,
    config: FetchOptions,
    response: Response
  ) => Promise<Response | null>
  logPaymentAttempt: () => void
  wait: (ms: number) => Promise<void>
}

/**
 * The known-txids header is an optimisation: it lets a payer omit ancestry the recipient
 * already holds. It must therefore fail SOFT. A malformed or hostile header should cost
 * bytes on the wire, never a failed payment — so every invalid case must degrade to
 * "send everything", which is exactly the behaviour that exists today.
 */
describe('parseKnownTxidsHeader', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  it('returns undefined when the header is absent, so behaviour is unchanged', () => {
    expect(parseKnownTxidsHeader(null)).toBeUndefined()
  })

  it('returns undefined for an empty or whitespace header rather than an empty list', () => {
    // An empty array would still be passed to createAction; undefined omits the option entirely.
    expect(parseKnownTxidsHeader('')).toBeUndefined()
    expect(parseKnownTxidsHeader('   ')).toBeUndefined()
    expect(parseKnownTxidsHeader(',,,')).toBeUndefined()
  })

  it('parses a single txid', () => {
    expect(parseKnownTxidsHeader(A)).toEqual([A])
  })

  it('parses a comma-separated list and tolerates surrounding whitespace', () => {
    expect(parseKnownTxidsHeader(` ${A} , ${B} `)).toEqual([A, B])
  })

  it('lowercases so callers can compare without normalising', () => {
    expect(parseKnownTxidsHeader(A.toUpperCase())).toEqual([A])
  })

  it('de-duplicates repeated txids', () => {
    expect(parseKnownTxidsHeader(`${A},${A},${B}`)).toEqual([A, B])
  })

  it('drops malformed entries but keeps the valid ones', () => {
    // Wrong length, non-hex, and empty segments must not discard a usable txid.
    expect(parseKnownTxidsHeader(`${A},nothex,${'c'.repeat(63)},,${B}`)).toEqual([A, B])
  })

  it('returns undefined when every entry is malformed', () => {
    expect(parseKnownTxidsHeader('nope,also-nope')).toBeUndefined()
  })

  it('caps the list so a hostile server cannot inflate the createAction call', () => {
    const many = Array.from({ length: 400 }, (_, i) => i.toString(16).padStart(64, '0'))
    const parsed = parseKnownTxidsHeader(many.join(','))
    expect(parsed).toHaveLength(256)
  })

  it('keeps the first 256 distinct valid txids in declaration order', () => {
    const distinct = Array.from({ length: 257 }, (_, i) => (256 - i).toString(16).padStart(64, '0'))
    const entries = distinct.flatMap(txid => ['invalid', txid.toUpperCase(), txid, ''])

    expect(parseKnownTxidsHeader(entries.join(','))).toEqual(distinct.slice(0, 256))
  })
})

// ---------------------------------------------------------------------------
// Wiring: the parsed list has to reach createAction on EVERY path that builds
// a payment, not just the first one.
// ---------------------------------------------------------------------------

function buildWallet(): TestWallet {
  const identityKey = new PrivateKey(10).toPublicKey().toString()
  const derivedKey = new PrivateKey(11).toPublicKey().toString()
  return {
    getPublicKey: jest
      .fn<WalletInterface['getPublicKey']>()
      .mockImplementation(async opts =>
        opts?.identityKey === true ? { publicKey: identityKey } : { publicKey: derivedKey }
      ),
    createAction: jest.fn<WalletInterface['createAction']>().mockResolvedValue({
      tx: Utils.toArray('mock-tx', 'utf8')
    }),
    createHmac: jest.fn<WalletInterface['createHmac']>().mockResolvedValue({
      hmac: Array.from({ length: 32 }, () => 0)
    })
  }
}

function make402Response(overrides: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    'x-bsv-payment-version': '1.0',
    'x-bsv-payment-satoshis-required': '10',
    'x-bsv-auth-identity-key': 'srv-key',
    'x-bsv-payment-derivation-prefix': 'pfx',
    ...overrides
  }
  return new Response('', { status: 402, headers })
}

function existingContext(satoshisRequired: number): PaymentContext {
  return {
    satoshisRequired,
    transactionBase64: Utils.toBase64([1, 2, 3]),
    derivationPrefix: 'pfx',
    derivationSuffix: 'old-suffix',
    serverIdentityKey: 'srv-key',
    clientIdentityKey: 'client-key',
    attempts: 0,
    maxAttempts: 3,
    errors: [],
    requestSummary: {
      url: 'https://example.com',
      method: 'GET',
      headers: {},
      bodyType: 'none',
      bodyByteLength: 0
    }
  }
}

describe('AuthFetch.handlePaymentAndRetry – known-txids wiring', () => {
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)

  function harness(): { authFetch: AuthFetch; wallet: TestWallet; internals: PaymentInternals } {
    const wallet = buildWallet()
    const authFetch = new AuthFetch(wallet as unknown as WalletInterface)
    const internals = authFetch as unknown as PaymentInternals
    jest.spyOn(internals, 'logPaymentAttempt').mockImplementation(() => {})
    jest.spyOn(internals, 'wait').mockResolvedValue(undefined)
    jest.spyOn(authFetch, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    createNonceMock.mockResolvedValue('suffix')
    return { authFetch, wallet, internals }
  }

  function optionsOfLastCreateAction(wallet: TestWallet): CreateActionOptions {
    const options = wallet.createAction.mock.calls.at(-1)?.[0].options
    if (options === undefined) throw new Error('Expected createAction options')
    return options
  }

  afterEach(() => {
    jest.restoreAllMocks()
    createNonceMock.mockReset()
  })

  it('forwards the declared txids to createAction when building a fresh payment', async () => {
    const { internals, wallet } = harness()

    await internals.handlePaymentAndRetry(
      'https://example.com',
      {},
      make402Response({ 'x-bsv-payment-known-txids': `${A},${B}` })
    )

    expect(optionsOfLastCreateAction(wallet).knownTxids).toEqual([A, B])
  })

  it('omits the option entirely when the server declares nothing', async () => {
    const { internals, wallet } = harness()

    await internals.handlePaymentAndRetry('https://example.com', {}, make402Response())

    // Not `[]` — the key must be absent so the createAction call is byte-identical
    // to what the SDK sent before this feature existed.
    expect(optionsOfLastCreateAction(wallet)).not.toHaveProperty('knownTxids')
  })

  it('omits knownTxids without failing payment when every declaration is malformed', async () => {
    const { internals, wallet } = harness()

    const response = await internals.handlePaymentAndRetry(
      'https://example.com',
      {},
      make402Response({ 'x-bsv-payment-known-txids': `invalid,${'a'.repeat(63)},,` })
    )

    expect(response?.status).toBe(200)
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(optionsOfLastCreateAction(wallet)).toEqual({ randomizeOutputs: false })
  })

  it.each([
    ['changes', { 'x-bsv-payment-known-txids': B }],
    ['disappears', {}]
  ] satisfies Array<[string, Record<string, string>]>)(
    'reuses the same payment when the known-txids declaration %s during a retry',
    async (_description, retryHeaders) => {
      const { authFetch, internals, wallet } = harness()
      const fetchSpy = jest.mocked(authFetch.fetch)
      fetchSpy.mockImplementationOnce(async (url, config = {}) => {
        const response = await internals.handlePaymentAndRetry(
          url,
          config,
          make402Response(retryHeaders)
        )
        if (response === null) throw new Error('Expected a paid response')
        return response
      })

      const response = await internals.handlePaymentAndRetry(
        'https://example.com',
        {},
        make402Response({ 'x-bsv-payment-known-txids': A })
      )

      expect(response?.status).toBe(200)
      expect(wallet.createAction).toHaveBeenCalledTimes(1)
      expect(optionsOfLastCreateAction(wallet).knownTxids).toEqual([A])
      expect(createNonceMock).toHaveBeenCalledTimes(1)
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const firstConfig = fetchSpy.mock.calls[0][1]
      const retryConfig = fetchSpy.mock.calls[1][1]
      expect(firstConfig?.headers?.['x-bsv-payment']).toEqual(expect.any(String))
      expect(retryConfig?.headers?.['x-bsv-payment']).toBe(firstConfig?.headers?.['x-bsv-payment'])
      expect(retryConfig?.paymentContext).toBe(firstConfig?.paymentContext)
      expect(retryConfig?.paymentContext?.attempts).toBe(2)
    }
  )

  it('forwards the authenticated peer response hint through fetch and its paid retry', async () => {
    const { authFetch, wallet } = harness()
    jest.mocked(authFetch.fetch).mockRestore()
    const serverIdentityKey = new PrivateKey(12).toPublicKey().toString()
    const responses = [
      make402Response({ 'x-bsv-payment-known-txids': ` ${A.toUpperCase()},invalid,${B},${A}` }),
      new Response('', { status: 200 })
    ]
    let listener: Parameters<Peer['listenForGeneralMessages']>[0] | undefined
    const peer = {
      listenForGeneralMessages: jest.fn((callback: typeof listener) => {
        listener = callback
        return 1
      }),
      stopListeningForGeneralMessages: jest.fn(),
      toPeer: jest.fn(async (request: number[]) => {
        const response = responses.shift()
        if (response === undefined || listener === undefined) {
          throw new Error('Unexpected authenticated request')
        }
        const writer = new Utils.Writer()
        writer.write(request.slice(0, 32))
        writer.writeVarIntNum(response.status)
        const headers = Array.from(response.headers.entries())
        writer.writeVarIntNum(headers.length)
        for (const [key, value] of headers) {
          const keyBytes = Utils.toArray(key, 'utf8')
          const valueBytes = Utils.toArray(value, 'utf8')
          writer.writeVarIntNum(keyBytes.length)
          writer.write(keyBytes)
          writer.writeVarIntNum(valueBytes.length)
          writer.write(valueBytes)
        }
        writer.writeVarIntNum(0)
        await listener(serverIdentityKey, writer.toArray())
      })
    }
    // Peer invokes this callback only after authenticating the response. Exercise
    // AuthFetch's real parsing and payment flow at that established boundary.
    authFetch.peers['https://example.com'] = {
      peer: peer as unknown as Peer,
      pendingCertificateRequests: []
    }

    const response = await authFetch.fetch('https://example.com/resource')

    expect(response.status).toBe(200)
    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(optionsOfLastCreateAction(wallet)).toEqual({
      randomizeOutputs: false,
      knownTxids: [A, B]
    })
    expect(wallet.getPublicKey).toHaveBeenCalledWith(
      expect.objectContaining({ counterparty: serverIdentityKey }),
      undefined
    )
    expect(peer.toPeer).toHaveBeenCalledTimes(2)
    expect(peer.stopListeningForGeneralMessages).toHaveBeenCalledTimes(2)
  })

  it('forwards the declared txids when the server changes its price mid-flight', async () => {
    // The regeneration branch builds a SECOND transaction. It is the path that matters most:
    // a repriced retry is already the largest request in the exchange, so dropping the
    // optimisation here would re-ship full ancestry at exactly the wrong moment.
    const { internals, wallet } = harness()

    await internals.handlePaymentAndRetry(
      'https://example.com',
      { paymentContext: existingContext(5) }, // server now asks for 10
      make402Response({
        'x-bsv-payment-satoshis-required': '10',
        'x-bsv-payment-known-txids': A
      })
    )

    expect(wallet.createAction).toHaveBeenCalledTimes(1)
    expect(optionsOfLastCreateAction(wallet).knownTxids).toEqual([A])
  })
})
