import { PrivateKey } from '@bsv/sdk'

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
  it('discovers, caches, and aliases capabilities for localhost', async () => {
    const { client, request } = createClientFixture()

    const discovered = await client.getCapabilities('localhost')
    const cached = await client.getDomainCapabilities('localhost')

    expect(discovered[PublicProfileCapability.getCode()]).toContain(
      PublicProfileCapability.getCode()
    )
    expect(cached).toBe(discovered)
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
  })

  it('validates PKI responses', async () => {
    const { client, responses } = createClientFixture()
    responses.set(PublicKeyInfrastructureCapability.getCode(), {
      bsvalias: '1.0',
      handle: 'alice@localhost',
      pubkey: '02abc'
    })
    await expect(client.getPki('alice@localhost')).resolves.toMatchObject({
      handle: 'alice@localhost',
      pubkey: '02abc'
    })

    responses.set(PublicKeyInfrastructureCapability.getCode(), { handle: 'alice@localhost' })
    await expect(client.getPki('bob@localhost')).rejects.toThrow('Validation error')
  })

  it('validates P2P payment destinations and exact satoshi totals', async () => {
    const { client, responses } = createClientFixture()
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
  })

  it.each([
    ['raw', ReceiveTransactionCapability, 'sendTransactionP2P', 'hex'],
    ['ordinal', SimpleP2pOrdinalReceiveCapability, 'sendOrdinalTransactionP2P', 'hex'],
    ['BEEF', P2pReceiveBeefTransactionCapability, 'sendBeefTransactionP2P', 'beef']
  ] as const)(
    'validates %s transaction responses',
    async (_label, capability, method, transactionField) => {
      const { client, request, responses } = createClientFixture()
      responses.set(capability.getCode(), { txid: 'abc123', note: null, ignored: true })

      await expect(
        client[method]('alice@localhost', 'transaction-data', 'reference')
      ).resolves.toEqual({ txid: 'abc123', note: null })
      expect(request).toHaveBeenLastCalledWith(expect.stringContaining(capability.getCode()), {
        method: 'POST',
        body: {
          [transactionField]: 'transaction-data',
          reference: 'reference',
          metadata: undefined
        }
      })

      responses.set(capability.getCode(), { note: 'missing txid' })
      await expect(client[method]('bob@localhost', 'bad', 'reference')).rejects.toThrow(
        'Validation error'
      )
    }
  )

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
  })

  it('validates public-key ownership responses and substitutes the public key', async () => {
    const { client, request, responses } = createClientFixture()
    responses.set(VerifyPublicKeyOwnerCapability.getCode(), {
      bsvalias: '1.0',
      handle: 'alice@localhost',
      pubkey: '02abc',
      match: true
    })

    await expect(client.verifyPublicKey('alice@localhost', '02abc')).resolves.toMatchObject({
      match: true
    })
    expect(request.mock.calls.at(-1)?.[0]).toContain('/02abc')

    responses.set(VerifyPublicKeyOwnerCapability.getCode(), { match: true })
    await expect(client.verifyPublicKey('bob@localhost', '02def')).rejects.toThrow(
      'Validation error'
    )
    await expect(client.verifyPublicKey('invalid', '02def')).rejects.toThrow(
      'Invalid Paymail address'
    )
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
  })
})
