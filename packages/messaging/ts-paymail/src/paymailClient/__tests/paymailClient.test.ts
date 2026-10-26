import { BEEF_V2, Beef, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk'

import {
  NegotiationCapability,
  P2pPaymentDestinationCapability,
  P2pReceiveBeefTransactionCapability,
  PublicKeyInfrastructureCapability,
  PublicProfileCapability,
  ReceiveTransactionCapability,
  SimpleP2pOrdinalDestinationsCapability,
  SimpleP2pOrdinalReceiveCapability,
  TransactionNegotiationCapability,
  VerifyPublicKeyOwnerCapability
} from '../../capability/index.js'
import { PaymailServerResponseError } from '../../errors/index.js'
import { verifyP2PSignature } from '../../p2pSignature.js'
import type { TransactionNegotiationBody } from '../../capability/transactionNegotiationCapability.js'
import HttpClient, { type RequestOptions } from '../httpClient.js'
import PaymailClient from '../paymailClient.js'
import type { DnsResolver } from '../resolver/dnsResolver.js'

const capabilities = [
  PublicProfileCapability,
  PublicKeyInfrastructureCapability,
  P2pPaymentDestinationCapability,
  ReceiveTransactionCapability,
  VerifyPublicKeyOwnerCapability,
  P2pReceiveBeefTransactionCapability,
  NegotiationCapability,
  TransactionNegotiationCapability,
  SimpleP2pOrdinalDestinationsCapability,
  SimpleP2pOrdinalReceiveCapability
]
const VALID_PUBLIC_KEY = PrivateKey.fromString('1'.padStart(64, '0'), 16).toPublicKey().toString()
const INVALID_CURVE_PUBLIC_KEY = `02${'ff'.repeat(32)}`

function jsonResponse(value: unknown): Response {
  return { json: async () => value } as Response
}

interface ClientFixture {
  client: PaymailClient
  request: jest.MockedFunction<(url: string, options?: RequestOptions) => Promise<Response>>
  responses: Map<string, unknown>
}

function createClientFixture(): ClientFixture {
  const responses = new Map<string, unknown>()
  const request = jest.fn(async (url: string): Promise<Response> => {
    if (url.endsWith('/.well-known/bsvalias')) {
      return jsonResponse({
        bsvalias: '1.0',
        capabilities: Object.fromEntries(
          capabilities.map(capability => [
            capability.getCode(),
            `http://localhost:4100/service/${capability.getCode()}/{alias}@{domain.tld}/{pubkey}`
          ])
        )
      })
    }

    const capability = capabilities.find(candidate =>
      url.includes(`/service/${candidate.getCode()}/`)
    )
    return jsonResponse(capability ? responses.get(capability.getCode()) : undefined)
  })
  const client = new PaymailClient({ request } as unknown as HttpClient, undefined, 4100)
  return { client, request, responses }
}

describe('PaymailClient', () => {
  it.each([0, -1, 1.5, 65_536, Number.NaN])(
    'rejects an invalid localhost port before discovery: %s',
    localhostPort => {
      expect(() => new PaymailClient(undefined, undefined, localhostPort)).toThrow(
        'localhostPort must be an integer'
      )
    }
  )

  it('discovers, caches, and aliases method names without sharing mutable results', async () => {
    const { client, request } = createClientFixture()

    const discovered = await client.getCapabilities('localhost')
    const originalProfile = discovered[PublicProfileCapability.getCode()]
    discovered[PublicProfileCapability.getCode()] = 'http://localhost:4100/attacker-controlled'
    const cached = await client.getDomainCapabilities('localhost')

    expect(originalProfile).toContain(PublicProfileCapability.getCode())
    expect(cached[PublicProfileCapability.getCode()]).toBe(originalProfile)
    expect(cached).not.toBe(discovered)
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('http://localhost:4100/.well-known/bsvalias')
  })

  it('discovers an externally resolved HTTPS service', async () => {
    const request = jest.fn(async () =>
      jsonResponse({ bsvalias: '1.0', capabilities: { profile: 'https://profile.test' } })
    )
    const dns: DnsResolver = {
      resolveSrv(_domain, callback) {
        callback(null, [{ name: 'paymail.example.test', port: 8443 }])
      }
    }
    const client = new PaymailClient({ request } as unknown as HttpClient, { dns })

    await expect(client.getCapabilities('example.test')).resolves.toEqual({
      profile: 'https://profile.test'
    })
    expect(request).toHaveBeenCalledWith('https://paymail.example.test:8443/.well-known/bsvalias')
  })

  it('rejects a DNSSEC-authenticated literal SRV target before discovery transport', async () => {
    const request = jest.fn(async () =>
      jsonResponse({
        Status: 0,
        AD: true,
        Answer: [
          {
            name: '_bsvalias._tcp.example.test.',
            type: 33,
            data: '10 10 443 127.0.0.1.'
          }
        ]
      })
    )
    const client = new PaymailClient({ request } as unknown as HttpClient)

    await expect(client.getCapabilities('example.test')).rejects.toThrow(
      'capability endpoint host is unsafe'
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed discovery documents and unsupported capabilities', async () => {
    const malformedRequest = jest.fn(async () => jsonResponse({ bsvalias: '1.0' }))
    const malformedClient = new PaymailClient(
      { request: malformedRequest } as unknown as HttpClient,
      undefined,
      4100
    )

    await expect(malformedClient.getCapabilities('localhost')).rejects.toThrow(
      PaymailServerResponseError
    )

    const { client } = createClientFixture()
    await expect(client.ensureCapabilityFor('localhost', 'missing')).rejects.toThrow(
      'does not support capability'
    )
  })

  it('accepts only bounded own-data string or boolean capability values', async () => {
    const cases: unknown[] = [
      { bsvalias: '2.0', capabilities: { profile: 'https://profile.example' } },
      { bsvalias: '1.0', capabilities: [] },
      { bsvalias: '1.0', capabilities: { nested: { endpoint: 'https://profile.example' } } },
      {
        bsvalias: '1.0',
        capabilities: Object.fromEntries(
          Array.from({ length: 257 }, (_, index) => [`capability-${index}`, true])
        )
      },
      {
        bsvalias: '1.0',
        capabilities: { profile: 'x'.repeat(8193) }
      },
      JSON.parse('{"bsvalias":"1.0","capabilities":{"__proto__":"unsafe"}}')
    ]

    for (const document of cases) {
      const request = jest.fn(async () => jsonResponse(document))
      const client = new PaymailClient({ request } as unknown as HttpClient, undefined, 4100)
      await expect(client.getCapabilities('localhost')).rejects.toThrow('Validation error')
    }

    const capabilityGetter = jest.fn(() => 'https://profile.example')
    const capabilities = {}
    Object.defineProperty(capabilities, 'profile', {
      enumerable: true,
      get: capabilityGetter
    })
    const request = jest.fn(async () => jsonResponse({ bsvalias: '1.0', capabilities }))
    const client = new PaymailClient({ request } as unknown as HttpClient, undefined, 4100)

    await expect(client.getCapabilities('localhost')).rejects.toThrow('own-data')
    expect(capabilityGetter).not.toHaveBeenCalled()
  })

  it.each([
    'https://127.0.0.1/service/{alias}',
    'http://internal.example/service/{alias}',
    'https://user:password@example.test/service/{alias}',
    'https://example.test/service/{alias}#fragment'
  ])('rejects an unsafe capability endpoint %s', async endpoint => {
    const request = jest.fn(async () =>
      jsonResponse({
        bsvalias: '1.0',
        capabilities: { [PublicProfileCapability.getCode()]: endpoint }
      })
    )
    const client = new PaymailClient({ request } as unknown as HttpClient, undefined, 4100)

    await expect(client.request('alice@localhost', PublicProfileCapability)).rejects.toThrow(
      PaymailServerResponseError
    )
    expect(request).toHaveBeenCalledTimes(1)
  })

  it.each(['alice@127.0.0.1', 'alice@2130706433', 'alice@internal', 'alice@host.local'])(
    'rejects a private or non-public Paymail domain %s before discovery',
    async paymail => {
      const request = jest.fn(async () => jsonResponse({}))
      const client = new PaymailClient({ request } as unknown as HttpClient)

      await expect(client.request(paymail, PublicProfileCapability)).rejects.toThrow(
        PaymailServerResponseError
      )
      expect(request).not.toHaveBeenCalled()
    }
  )

  it('coalesces discovery and bounds the capability cache', async () => {
    const request = jest.fn(async () =>
      jsonResponse({ bsvalias: '1.0', capabilities: { profile: 'https://profile.example' } })
    )
    const dns: DnsResolver = {
      resolveSrv(domain, callback) {
        callback(null, [{ name: domain.replace('_bsvalias._tcp.', ''), port: 443 }])
      }
    }
    const client = new PaymailClient({ request } as unknown as HttpClient, { dns })

    const concurrent = await Promise.all([
      client.getCapabilities('same.example'),
      client.getCapabilities('same.example')
    ])
    expect(request).toHaveBeenCalledTimes(1)
    expect(concurrent[0]).not.toBe(concurrent[1])
    concurrent[0].profile = 'https://attacker.example'
    expect(concurrent[1].profile).toBe('https://profile.example')
    await expect(client.getCapabilities('same.example')).resolves.toEqual({
      profile: 'https://profile.example'
    })

    for (let index = 0; index < 260; index++) {
      await client.getCapabilities(`tenant-${index}.example`)
    }
    expect((client as any)._domainCapabilityCache.size).toBeLessThanOrEqual(256)
  })

  it('builds capability URLs and rejects invalid Paymail addresses', async () => {
    const { client, request, responses } = createClientFixture()
    responses.set(PublicProfileCapability.getCode(), { ok: true })

    await expect(
      client.request('alice@localhost', PublicProfileCapability, { requested: true })
    ).resolves.toEqual({ ok: true })
    expect(request).toHaveBeenLastCalledWith(
      `http://localhost:4100/service/${PublicProfileCapability.getCode()}/alice@localhost/{pubkey}`,
      {
        method: 'GET',
        body: { requested: true }
      }
    )
    await expect(client.request('not-a-paymail', PublicProfileCapability)).rejects.toThrow(
      'Invalid Paymail address'
    )
    await expect(
      client.request('alice@localhost@attacker.test', PublicProfileCapability)
    ).rejects.toThrow('Invalid Paymail address')
    await expect(client.request('alice@bad domain', PublicProfileCapability)).rejects.toThrow(
      'Invalid Paymail address'
    )
    await expect(client.request('alice/../../@localhost', PublicProfileCapability)).rejects.toThrow(
      'Invalid Paymail address'
    )
    await expect(
      client.request(`${'a'.repeat(65)}@localhost`, PublicProfileCapability)
    ).rejects.toThrow('Invalid Paymail address')

    await client.request('alice+tag%value@localhost', PublicProfileCapability)
    expect(request.mock.calls.at(-1)?.[0]).toContain('alice%2Btag%25value@localhost')
  })

  it('validates public profiles and strips unknown fields', async () => {
    const { client, responses } = createClientFixture()
    responses.set(PublicProfileCapability.getCode(), {
      name: 'Alice',
      avatar: 'https://example.test/alice.png',
      ignored: true
    })

    await expect(client.getPublicProfile('alice@localhost')).resolves.toEqual({
      name: 'Alice',
      avatar: 'https://example.test/alice.png'
    })

    responses.set(PublicProfileCapability.getCode(), { name: 'Alice', avatar: 'not-a-url' })
    await expect(client.getPublicProfile('bob@localhost')).rejects.toThrow('Validation error')

    for (const avatar of [
      'javascript:alert(document.domain)',
      'data:text/html,<script>alert(1)</script>',
      'http://example.test/alice.png',
      'https://user:secret@example.test/alice.png',
      'https://127.0.0.1/alice.png',
      'https://[::1]/alice.png'
    ]) {
      responses.set(PublicProfileCapability.getCode(), { name: 'Alice', avatar })
      await expect(client.getPublicProfile('mallory@localhost')).rejects.toThrow(
        PaymailServerResponseError
      )
    }
  })

  it('validates PKI responses', async () => {
    const { client, responses } = createClientFixture()
    responses.set(PublicKeyInfrastructureCapability.getCode(), {
      bsvalias: '1.0',
      handle: 'alice@localhost',
      pubkey: VALID_PUBLIC_KEY
    })
    await expect(client.getPki('alice@localhost')).resolves.toMatchObject({
      handle: 'alice@localhost',
      pubkey: VALID_PUBLIC_KEY
    })

    responses.set(PublicKeyInfrastructureCapability.getCode(), { handle: 'alice@localhost' })
    await expect(client.getPki('bob@localhost')).rejects.toThrow('Validation error')

    responses.set(PublicKeyInfrastructureCapability.getCode(), {
      handle: 'carol@localhost',
      pubkey: INVALID_CURVE_PUBLIC_KEY
    })
    await expect(client.getPki('carol@localhost')).rejects.toThrow(PaymailServerResponseError)
  })

  it('validates P2P payment destinations and exact satoshi totals', async () => {
    const { client, request, responses } = createClientFixture()
    responses.set(P2pPaymentDestinationCapability.getCode(), {
      outputs: [
        { script: '51', satoshis: 400 },
        { script: '52', satoshis: 600 }
      ],
      reference: 'payment-ref'
    })
    await expect(client.getP2pPaymentDestination('alice@localhost', 1000)).resolves.toMatchObject({
      reference: 'payment-ref'
    })

    await expect(client.getP2pPaymentDestination('bob@localhost', 999)).rejects.toThrow(
      'expected amount of satoshis'
    )
    responses.set(P2pPaymentDestinationCapability.getCode(), {
      outputs: [],
      reference: 'empty'
    })
    await expect(client.getP2pPaymentDestination('carol@localhost', 1)).rejects.toThrow(
      'Validation error'
    )

    responses.set(P2pPaymentDestinationCapability.getCode(), {
      outputs: [
        { script: '51', satoshis: -1 },
        { script: '52', satoshis: 1001 }
      ],
      reference: 'negative-output'
    })
    await expect(client.getP2pPaymentDestination('dave@localhost', 1000)).rejects.toThrow(
      'Validation error'
    )

    const requestsBeforeInvalidAmount = request.mock.calls.length
    await expect(client.getP2pPaymentDestination('erin@localhost', 1.5)).rejects.toThrow(
      'positive safe integer'
    )
    expect(request).toHaveBeenCalledTimes(requestsBeforeInvalidAmount)
  })

  it('validates ordinal destinations', async () => {
    const { client, responses } = createClientFixture()
    responses.set(SimpleP2pOrdinalDestinationsCapability.getCode(), {
      outputs: [{ script: '51' }],
      reference: 'ordinal-ref'
    })
    await expect(client.getP2pOrdinalDestinations('alice@localhost', 1)).resolves.toEqual({
      outputs: [{ script: '51' }],
      reference: 'ordinal-ref'
    })

    responses.set(SimpleP2pOrdinalDestinationsCapability.getCode(), {
      outputs: [],
      reference: 'empty'
    })
    await expect(client.getP2pOrdinalDestinations('bob@localhost', 1)).rejects.toThrow(
      'Validation error'
    )

    responses.set(SimpleP2pOrdinalDestinationsCapability.getCode(), {
      outputs: [{ script: 'not-hex' }],
      reference: 'invalid-script'
    })
    await expect(client.getP2pOrdinalDestinations('carol@localhost', 1)).rejects.toThrow(
      'Validation error'
    )

    responses.set(SimpleP2pOrdinalDestinationsCapability.getCode(), {
      outputs: [{ script: '51' }],
      reference: 'wrong-count'
    })
    await expect(client.getP2pOrdinalDestinations('dave@localhost', 2)).rejects.toThrow(
      'requested count'
    )
  })

  it.each([
    ['raw', ReceiveTransactionCapability, 'sendTransactionP2P', 'hex'],
    ['ordinal', SimpleP2pOrdinalReceiveCapability, 'sendOrdinalTransactionP2P', 'hex'],
    ['BEEF', P2pReceiveBeefTransactionCapability, 'sendBeefTransactionP2P', 'beef']
  ] as const)(
    'validates %s transaction responses',
    async (_label, capability, method, transactionField) => {
      const { client, request, responses } = createClientFixture()
      const transaction = new Transaction()
      transaction.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
      const transactionData =
        transactionField === 'beef' ? Utils.toHex(transaction.toAtomicBEEF()) : transaction.toHex()
      const transactionId = transaction.id('hex')
      responses.set(capability.getCode(), { txid: transactionId, note: null, ignored: true })

      await expect(
        client[method]('alice@localhost', transactionData, 'reference')
      ).resolves.toEqual({ txid: transactionId, note: null })
      expect(request).toHaveBeenLastCalledWith(expect.stringContaining(capability.getCode()), {
        method: 'POST',
        body: {
          [transactionField]: transactionData,
          reference: 'reference',
          metadata: undefined
        }
      })

      if (transactionField === 'beef') {
        const legacyBeef = transaction.toHexBEEF()
        await expect(
          client.sendBeefTransactionP2P('alice@localhost', legacyBeef, 'legacy-reference')
        ).resolves.toEqual({ txid: transactionId, note: null })
      }

      responses.set(capability.getCode(), { note: 'missing txid' })
      await expect(client[method]('bob@localhost', transactionData, 'reference')).rejects.toThrow(
        'Validation error'
      )

      responses.set(capability.getCode(), { txid: '00'.repeat(32) })
      await expect(client[method]('carol@localhost', transactionData, 'reference')).rejects.toThrow(
        'acknowledged a different transaction'
      )
    }
  )

  it('accepts canonical BEEF v2 and rejects malformed transaction envelopes before transport', async () => {
    const { client, request, responses } = createClientFixture()
    const transaction = new Transaction()
    transaction.addOutput({ satoshis: 1, lockingScript: Script.fromASM('OP_TRUE') })
    const beefV2 = new Beef(BEEF_V2)
    beefV2.mergeRawTx(Utils.toArray(transaction.toHex(), 'hex'))
    responses.set(P2pReceiveBeefTransactionCapability.getCode(), {
      txid: transaction.id('hex')
    })

    await expect(
      client.sendBeefTransactionP2P('alice@localhost', beefV2.toHex(), 'v2-reference')
    ).resolves.toEqual({ txid: transaction.id('hex') })

    const callsBeforeMalformed = request.mock.calls.length
    const malformedRaw = [
      '',
      '0',
      'zz',
      '00000000fd0100',
      '00000000feffff0000',
      '00000000ff0100000001000000',
      '00000000ffffffffffff1f00',
      `${transaction.toHex()}00`,
      '0000000001'
    ]
    for (const raw of malformedRaw) {
      await expect(
        client.sendTransactionP2P('mallory@localhost', raw, 'invalid-raw')
      ).rejects.toThrow('Invalid transaction encoding')
    }

    const malformedBeef = [
      '0100beef0000',
      '0200beeffd010000',
      '0200beef0000',
      '0200beef000103',
      `0200beef000102${'00'.repeat(32)}`,
      `${beefV2.toHex()}00`,
      `01010101${'00'.repeat(32)}${beefV2.toHex()}`
    ]
    for (const beef of malformedBeef) {
      await expect(
        client.sendBeefTransactionP2P('mallory@localhost', beef, 'invalid-beef')
      ).rejects.toThrow('Invalid transaction encoding')
    }
    expect(request).toHaveBeenCalledTimes(callsBeforeMalformed)
  })

  it('creates a compact P2P signature that the receiver verifier accepts', () => {
    const { client } = createClientFixture()
    const privateKey = PrivateKey.fromString('1'.padStart(64, '0'), 16)
    const signature = client.createP2PSignature('transaction-id', privateKey)
    const longMessage = 'a'.repeat(65_536)
    const longMessageSignature = client.createP2PSignature(longMessage, privateKey)

    expect(
      verifyP2PSignature('transaction-id', signature, privateKey.toPublicKey().toString())
    ).toEqual({
      publicKeyMatches: true,
      signatureValid: true
    })
    expect(
      verifyP2PSignature(
        'transaction-id',
        signature,
        PrivateKey.fromString('2'.padStart(64, '0'), 16).toPublicKey().toString()
      ).publicKeyMatches
    ).toBe(false)
    expect(
      verifyP2PSignature(longMessage, longMessageSignature, privateKey.toPublicKey().toString())
        .signatureValid
    ).toBe(true)
    expect(longMessageSignature).toBe(
      'IFdT7RWSoOJrs2AkhhmlT+b3ghMY8tdC857R2mZtFADAL6F9RGtD9cAueB7iOeoBRKHT3T/hmCl6ibbgfsQDnP8='
    )
  })

  it('rejects malformed compact P2P signatures before recovery', () => {
    const { client } = createClientFixture()
    const privateKey = PrivateKey.fromString('1'.padStart(64, '0'), 16)
    const signature = client.createP2PSignature('transaction-id', privateKey)
    const invalidHeaderBytes = Buffer.from(signature, 'base64')
    invalidHeaderBytes[0] = 26

    expect(() =>
      verifyP2PSignature('transaction-id', '', privateKey.toPublicKey().toString())
    ).toThrow('Invalid Compact Signature')
    expect(() =>
      verifyP2PSignature(
        'transaction-id',
        invalidHeaderBytes.toString('base64'),
        privateKey.toPublicKey().toString()
      )
    ).toThrow('Invalid Compact Signature')
    expect(() =>
      verifyP2PSignature('transaction-id', 'A'.repeat(100_000), privateKey.toPublicKey().toString())
    ).toThrow('Invalid Compact Signature')

    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const finalCharacter = signature[86]
    const finalIndex = alphabet.indexOf(finalCharacter)
    const nonCanonicalAlias = `${signature.slice(0, 86)}${alphabet[finalIndex ^ 1]}=`
    expect(() =>
      verifyP2PSignature('transaction-id', nonCanonicalAlias, privateKey.toPublicKey().toString())
    ).toThrow('Invalid Compact Signature')
    expect(() => verifyP2PSignature('transaction-id', signature, INVALID_CURVE_PUBLIC_KEY)).toThrow(
      'Invalid Public Key'
    )
  })

  it('validates public-key ownership responses and substitutes the public key', async () => {
    const { client, request, responses } = createClientFixture()
    responses.set(VerifyPublicKeyOwnerCapability.getCode(), {
      bsvalias: '1.0',
      handle: 'alice@localhost',
      pubkey: VALID_PUBLIC_KEY,
      match: true
    })

    await expect(
      client.verifyPublicKey('alice@localhost', VALID_PUBLIC_KEY)
    ).resolves.toMatchObject({
      match: true
    })
    expect(request.mock.calls.at(-1)?.[0]).toContain(`/${VALID_PUBLIC_KEY}`)

    responses.set(VerifyPublicKeyOwnerCapability.getCode(), { match: true })
    await expect(client.verifyPublicKey('bob@localhost', VALID_PUBLIC_KEY)).rejects.toThrow(
      'Validation error'
    )
    await expect(client.verifyPublicKey('invalid', VALID_PUBLIC_KEY)).rejects.toThrow(
      'Invalid Paymail address'
    )

    responses.set(VerifyPublicKeyOwnerCapability.getCode(), {
      handle: 'mallory@localhost',
      pubkey: VALID_PUBLIC_KEY,
      match: true
    })
    await expect(client.verifyPublicKey('alice@localhost', VALID_PUBLIC_KEY)).rejects.toThrow(
      'did not match the requested handle'
    )
    await expect(client.verifyPublicKey('alice@localhost', '02abc')).rejects.toThrow(
      'Invalid compressed public key'
    )
    const callsBeforeInvalidCurveKey = request.mock.calls.length
    await expect(
      client.verifyPublicKey('alice@localhost', INVALID_CURVE_PUBLIC_KEY)
    ).rejects.toThrow('Invalid compressed public key')
    expect(request).toHaveBeenCalledTimes(callsBeforeInvalidCurveKey)
  })

  it('applies negotiation defaults and forwards negotiation requests', async () => {
    const { client, request, responses } = createClientFixture()
    responses.set(NegotiationCapability.getCode(), { receive: true, ignored: 'value' })
    await expect(client.getTransactionNegotiationCapabilities('alice@localhost')).resolves.toEqual({
      send_disabled: false,
      auto_send_response: false,
      receive: true,
      three_step_exchange: false,
      four_step_exchange: false,
      auto_exchange_response: false
    })

    const body: TransactionNegotiationBody = {
      thread_id: 'thread',
      fees: [],
      expanded_tx: { tx: 'transaction', ancestors: [], spent_outputs: [] },
      expiry: 1,
      timestamp: 2,
      reply_to: { handle: 'alice@localhost' }
    }
    responses.set(TransactionNegotiationCapability.getCode(), { accepted: true })
    await expect(client.sendTransactionNegotiation('alice@localhost', body)).resolves.toEqual({
      accepted: true
    })
    expect(request).toHaveBeenLastCalledWith(
      expect.stringContaining(TransactionNegotiationCapability.getCode()),
      { method: 'POST', body }
    )

    responses.set(NegotiationCapability.getCode(), { receive: 'not-a-boolean' })
    await expect(client.getTransactionNegotiationCapabilities('bob@localhost')).rejects.toThrow(
      'Validation error'
    )

    responses.set(NegotiationCapability.getCode(), { receive: 'true' })
    await expect(client.getTransactionNegotiationCapabilities('carol@localhost')).rejects.toThrow(
      'Validation error'
    )
  })
})
