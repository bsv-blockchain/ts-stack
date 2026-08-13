import { jest } from '@jest/globals'
import { parseKnownTxidsHeader, AuthFetch } from '../AuthFetch.js'
import { Utils, PrivateKey } from '../../../primitives/index.js'

jest.mock('../../utils/createNonce.js', () => ({
  createNonce: jest.fn()
}))

import { createNonce } from '../../utils/createNonce.js'

const createNonceMock = createNonce as jest.MockedFunction<typeof createNonce>

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
})

// ---------------------------------------------------------------------------
// Wiring: the parsed list has to reach createAction on EVERY path that builds
// a payment, not just the first one.
// ---------------------------------------------------------------------------

function buildWallet(): any {
  const identityKey = new PrivateKey(10).toPublicKey().toString()
  const derivedKey = new PrivateKey(11).toPublicKey().toString()
  return {
    getPublicKey: jest.fn(async (opts: any) =>
      opts?.identityKey === true ? { publicKey: identityKey } : { publicKey: derivedKey }
    ),
    createAction: jest.fn(async () => ({
      tx: Utils.toArray('mock-tx', 'utf8')
    })),
    createHmac: jest.fn(async () => ({ hmac: Array.from({ length: 32 }).fill(0) }))
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

function existingContext(satoshisRequired: number): any {
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

  function harness(): { authFetch: AuthFetch, wallet: any } {
    const wallet = buildWallet()
    const authFetch = new AuthFetch(wallet)
    jest.spyOn(authFetch as any, 'logPaymentAttempt').mockImplementation(() => {})
    jest.spyOn(authFetch as any, 'wait').mockResolvedValue(undefined)
    jest.spyOn(authFetch, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }))
    createNonceMock.mockResolvedValue('suffix')
    return { authFetch, wallet }
  }

  function optionsOfLastCreateAction(wallet: any): any {
    const calls = wallet.createAction.mock.calls
    return calls[calls.length - 1][0].options
  }

  afterEach(() => {
    jest.restoreAllMocks()
    createNonceMock.mockReset()
  })

  it('forwards the declared txids to createAction when building a fresh payment', async () => {
    const { authFetch, wallet } = harness()

    await (authFetch as any).handlePaymentAndRetry(
      'https://example.com',
      {},
      make402Response({ 'x-bsv-payment-known-txids': `${A},${B}` })
    )

    expect(optionsOfLastCreateAction(wallet).knownTxids).toEqual([A, B])
  })

  it('omits the option entirely when the server declares nothing', async () => {
    const { authFetch, wallet } = harness()

    await (authFetch as any).handlePaymentAndRetry('https://example.com', {}, make402Response())

    // Not `[]` — the key must be absent so the createAction call is byte-identical
    // to what the SDK sent before this feature existed.
    expect(optionsOfLastCreateAction(wallet)).not.toHaveProperty('knownTxids')
  })

  it('forwards the declared txids when the server changes its price mid-flight', async () => {
    // The regeneration branch builds a SECOND transaction. It is the path that matters most:
    // a repriced retry is already the largest request in the exchange, so dropping the
    // optimisation here would re-ship full ancestry at exactly the wrong moment.
    const { authFetch, wallet } = harness()

    await (authFetch as any).handlePaymentAndRetry(
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
