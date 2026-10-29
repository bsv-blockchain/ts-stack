import express from 'express'
import request from 'supertest'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'

import Capability from '../capability/capability.js'
import ProfileLookupCapability from '../capability/profileLookupCapability.js'
import ProfileReverseLookupCapability from '../capability/profileReverseLookupCapability.js'
import { PaymailServerResponseError } from '../errors/index.js'
import HttpClient from '../paymailClient/httpClient.js'
import PaymailClient from '../paymailClient/paymailClient.js'
import type { DnsResolver } from '../paymailClient/resolver/dnsResolver.js'
import PaymailRouter from '../paymailRouter/paymailRouter.js'
import PublicProfileRoute from '../paymailRouter/paymailRoutes/publicProfileRoute.js'
import ProfileLookupRoute from '../paymailRouter/paymailRoutes/profileLookupRoute.js'
import ProfileReverseLookupRoute from '../paymailRouter/paymailRoutes/profileReverseLookupRoute.js'
import {
  PROFILE_CERTIFICATE_TYPE,
  type ProfileCertificateJson,
  checkProfileCertificate,
  createProfileCertificate,
  normalizeProfileLookupQuery,
  verifyProfileCertificate
} from '../profileCertificate.js'

/** The BRC-235 test vector. */
const VECTOR_KEY = '025ad43a22ac38d0bc1f8bacaabb323b5d634703b7a774c4268f6a09e4ddf79097'
const VECTOR: ProfileCertificateJson = Object.freeze({
  type: 'SbatVXXssDW3AO0J9bxIljkHGbPBGCVAXg94gXFf0cE=',
  serialNumber: 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=',
  subject: VECTOR_KEY,
  certifier: VECTOR_KEY,
  revocationOutpoint: '0000000000000000000000000000000000000000000000000000000000000000.0',
  fields: Object.freeze({
    displayName: 'Alice',
    issuedAt: '2026-10-29T12:00:00.000Z',
    paymail: 'alice@example.com'
  }) as Record<string, string>,
  signature:
    '304402201433492b6713a2f210bbd75c5d57de1085b92193f868e1add7785d35e55fc602022032ee8493f6e7d2273164c22c9ae8d8e59419e56d7ba0445663a17a9513c84c19'
})

function withFields(fields: Record<string, string>): ProfileCertificateJson {
  return { ...VECTOR, fields: { ...VECTOR.fields, ...fields } }
}

function wallet(seed: string): ProtoWallet {
  return new ProtoWallet(PrivateKey.fromString(seed.padStart(64, '0'), 16))
}

describe('BRC-235 capabilities', () => {
  it('derive their BRFC ids from title, author and version', () => {
    expect(ProfileLookupCapability.getCode()).toBe('0ace65da5987')
    expect(ProfileReverseLookupCapability.getCode()).toBe('43dcf83ddc5f')
    const derive = (title: string): string =>
      new Capability({ title, authors: ['Deggen'], version: 'v1.0.0' }).getCode()
    expect(derive('public profile lookup')).toBe('0ace65da5987')
    expect(derive('public profile reverse lookup')).toBe('43dcf83ddc5f')
    expect(ProfileLookupCapability.getMethod()).toBe('GET')
  })
})

describe('profile certificates', () => {
  it('verify the BRC-235 test vector', async () => {
    const profile = await verifyProfileCertificate(VECTOR, { domain: 'example.com' })
    expect(profile).toEqual({
      identityKey: VECTOR_KEY,
      paymail: 'alice@example.com',
      handle: 'alice',
      domain: 'example.com',
      displayName: 'Alice',
      issuedAt: '2026-10-29T12:00:00.000Z',
      certificate: VECTOR
    })
    await expect(
      verifyProfileCertificate(VECTOR, {
        domain: 'example.com',
        paymail: 'Alice@Example.com',
        identityKey: VECTOR_KEY.toUpperCase()
      })
    ).resolves.toBeDefined()
  })

  it.each<[string, unknown, { domain: string; paymail?: string; identityKey?: string }]>([
    ['another domain', VECTOR, { domain: 'example.org' }],
    ['another exact paymail', VECTOR, { domain: 'example.com', paymail: 'bob@example.com' }],
    ['another reverse key', VECTOR, { domain: 'example.com', identityKey: `03${'1'.repeat(64)}` }],
    ['a changed field', withFields({ displayName: 'Mallory' }), { domain: 'example.com' }],
    ['a tombstone', withFields({ released: 'true' }), { domain: 'example.com' }],
    [
      'a different type',
      { ...VECTOR, type: PROFILE_CERTIFICATE_TYPE.replace('S', 'T') },
      { domain: 'example.com' }
    ],
    [
      'subject not certifier',
      { ...VECTOR, certifier: `03${'1'.repeat(64)}` },
      { domain: 'example.com' }
    ],
    [
      'a revocation outpoint',
      { ...VECTOR, revocationOutpoint: `${'1'.repeat(64)}.0` },
      { domain: 'example.com' }
    ],
    ['a short serial', { ...VECTOR, serialNumber: 'AQID' }, { domain: 'example.com' }],
    [
      'no issuedAt',
      { ...VECTOR, fields: { paymail: 'alice@example.com' } },
      { domain: 'example.com' }
    ],
    [
      'an uppercase paymail',
      withFields({ paymail: 'Alice@example.com' }),
      { domain: 'example.com' }
    ],
    ['a non-string field', withFields({ bio: 1 as unknown as string }), { domain: 'example.com' }],
    ['a missing signature', { ...VECTOR, signature: undefined }, { domain: 'example.com' }],
    ['an array', [VECTOR], { domain: 'example.com' }],
    ['null', null, { domain: 'example.com' }]
  ])('reject %s', async (_label, certificate, expect_) => {
    await expect(verifyProfileCertificate(certificate, expect_)).resolves.toBeUndefined()
  })

  it('enforce field and size limits', () => {
    const many = Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`f${i}`, 'x']))
    expect(checkProfileCertificate(withFields(many), 'example.com')).toBeUndefined()
    expect(
      checkProfileCertificate(withFields({ bio: 'x'.repeat(1025) }), 'example.com')
    ).toBeUndefined()
    expect(
      checkProfileCertificate(withFields({ ['n'.repeat(50)]: 'x' }), 'example.com')
    ).toBeUndefined()
    expect(
      checkProfileCertificate(withFields({ bio: 'x'.repeat(1024) }), 'example.com')
    ).toBeDefined()
  })

  it('are created self-signed and verify', async () => {
    const signer = wallet('2')
    const { publicKey } = await signer.getPublicKey({ identityKey: true })
    const certificate = await createProfileCertificate({
      signer,
      paymail: ' Bob@Example.com ',
      issuedAt: new Date('2026-10-29T12:00:00Z'),
      displayName: ' Bob ',
      fields: { avatar: 'https://example.com/bob.png', released: 'true' }
    })
    expect(certificate.subject).toBe(publicKey)
    expect(certificate.certifier).toBe(publicKey)
    expect(certificate.fields).toEqual({
      avatar: 'https://example.com/bob.png',
      paymail: 'bob@example.com',
      issuedAt: '2026-10-29T12:00:00.000Z',
      displayName: 'Bob'
    })
    const profile = await verifyProfileCertificate(certificate, { domain: 'example.com' })
    expect(profile?.identityKey).toBe(publicKey)

    const tombstone = await createProfileCertificate({
      signer,
      paymail: 'bob@example.com',
      released: true
    })
    expect(tombstone.fields.released).toBe('true')
    await expect(
      verifyProfileCertificate(tombstone, { domain: 'example.com' })
    ).resolves.toBeUndefined()
  })

  it('refuse to create an invalid profile', async () => {
    const signer = wallet('3')
    await expect(createProfileCertificate({ signer, paymail: '-bob@example.com' })).rejects.toThrow(
      'Invalid profile paymail'
    )
    await expect(createProfileCertificate({ signer, paymail: 'bob@localhost' })).rejects.toThrow(
      'Invalid profile paymail'
    )
    await expect(
      createProfileCertificate({
        signer,
        paymail: 'bob@example.com',
        issuedAt: new Date(Number.NaN)
      })
    ).rejects.toThrow('issuedAt')
    await expect(
      createProfileCertificate({
        signer,
        paymail: 'bob@example.com',
        fields: { bio: 'x'.repeat(1025) }
      })
    ).rejects.toThrow('limits')
    await expect(
      createProfileCertificate({
        signer,
        paymail: 'bob@example.com',
        fields: JSON.parse('{"__proto__":"x"}')
      })
    ).rejects.toThrow('Invalid profile field name')
  })
})

describe('normalizeProfileLookupQuery', () => {
  it.each<[string, string | undefined]>([
    ['al', 'al'],
    [' Alice ', 'alice'],
    ['alice@example.com', 'alice'],
    ['alice@exa', 'alice'],
    ['alice@', 'alice'],
    ['alice@example.org', undefined],
    ['a', undefined],
    ['x'.repeat(33), undefined],
    ['al ice', undefined],
    ['..', undefined],
    ['a@b@example.com', undefined]
  ])('%s -> %s', (query, expected) => {
    expect(normalizeProfileLookupQuery(query, 'example.com')).toBe(expected)
  })
})

describe('profile lookup routes', () => {
  function host(
    options: { lookup?: unknown[]; reverse?: unknown; legacy?: boolean } = {}
  ): express.Express {
    const app = express()
    const routes = [
      new ProfileLookupRoute({
        domain: 'example.com',
        domainLogicHandler: async query =>
          query.startsWith('al') ? (options.lookup ?? [VECTOR]) : []
      }),
      new ProfileReverseLookupRoute({
        domain: 'example.com',
        domainLogicHandler: key => (key === VECTOR_KEY ? (options.reverse ?? VECTOR) : undefined)
      })
    ]
    if (options.legacy === true) {
      routes.push(
        new PublicProfileRoute({
          domainLogicHandler: () => ({ name: 'a', avatar: 'https://a.example/a' })
        }) as never
      )
    }
    app.use(
      new PaymailRouter({
        baseUrl: 'https://paymail.example.com',
        basePath: '/api',
        routes
      }).getRouter()
    )
    return app
  }

  it('host only the two BRC-235 capabilities', async () => {
    const response = await request(host()).get('/.well-known/bsvalias')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      bsvalias: '1.0',
      capabilities: {
        '0ace65da5987': 'https://paymail.example.com/api/handle/{query}',
        '43dcf83ddc5f': 'https://paymail.example.com/api/identityKey/{pubkey}'
      }
    })
  })

  it('keep advertising sender validation beside a legacy route', async () => {
    const response = await request(host({ legacy: true })).get('/.well-known/bsvalias')
    expect(response.body.capabilities['6745385c3fc0']).toBe(false)
  })

  it('answer a lookup with servable certificates, capped at ten', async () => {
    const lookup = [
      withFields({ released: 'true' }),
      { ...VECTOR, fields: { ...VECTOR.fields, paymail: 'al@other.com' } },
      'junk',
      ...Array(12).fill(VECTOR)
    ]
    const response = await request(host({ lookup })).get('/api/handle/Alice@example.com')
    expect(response.status).toBe(200)
    expect(response.body).toHaveLength(10)
    expect(response.body[0]).toEqual(VECTOR)
  })

  it('answer an empty array for queries that match nothing', async () => {
    for (const query of ['a', 'bob', 'alice@example.org', 'al%20ice']) {
      const response = await request(host()).get(`/api/handle/${query}`)
      expect(response.status).toBe(200)
      expect(response.body).toEqual([])
    }
  })

  it('answer a reverse lookup, 404 for an unknown key and 400 for a malformed one', async () => {
    const found = await request(host()).get(`/api/identityKey/${VECTOR_KEY.toUpperCase()}`)
    expect(found.status).toBe(200)
    expect(found.body).toEqual(VECTOR)

    const missing = await request(host()).get(`/api/identityKey/03${'1'.repeat(64)}`)
    expect(missing.status).toBe(404)
    expect(missing.body).toMatchObject({ status: 'error', code: 'ERR_HANDLE_NOT_FOUND' })

    const malformed = await request(host()).get('/api/identityKey/not-a-key')
    expect(malformed.status).toBe(400)
    expect(malformed.body).toMatchObject({ code: 'ERR_INVALID_LOOKUP' })
  })

  it('refuse to serve a reverse certificate for another key', async () => {
    const response = await request(host({ reverse: withFields({ released: 'true' }) })).get(
      `/api/identityKey/${VECTOR_KEY}`
    )
    expect(response.status).toBe(500)
  })

  it('validate their configuration', () => {
    const handler = (): unknown[] => []
    expect(() => new ProfileLookupRoute({ domain: '', domainLogicHandler: handler })).toThrow(
      'domain'
    )
    expect(
      () =>
        new ProfileLookupRoute({
          domain: 'example.com',
          domainLogicHandler: handler,
          endpoint: '/x/:paymail'
        })
    ).toThrow(':query')
    expect(
      () =>
        new ProfileReverseLookupRoute({
          domain: 'example.com',
          domainLogicHandler: handler,
          endpoint: '/x'
        })
    ).toThrow(':pubkey')
    expect(
      () => new ProfileReverseLookupRoute({ domain: ' ', domainLogicHandler: handler })
    ).toThrow('domain')
    expect(
      () =>
        new ProfileLookupRoute({ domain: 'example.com', domainLogicHandler: undefined as never })
    ).toThrow(TypeError)
  })
})

describe('PaymailClient profile lookup', () => {
  const dns: DnsResolver = {
    resolveSrv(domain, callback) {
      callback(null, [{ name: domain.replace('_bsvalias._tcp.', ''), port: 443 }])
    }
  }

  function client(
    answers: Record<string, unknown>,
    capabilities?: Record<string, string>
  ): {
    client: PaymailClient
    request: jest.Mock
  } {
    const requestMock = jest.fn(async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/bsvalias')) {
        return {
          json: async () => ({
            bsvalias: '1.0',
            capabilities: capabilities ?? {
              '0ace65da5987': 'https://paymail.example.com/api/handle/{query}',
              '43dcf83ddc5f': 'https://paymail.example.com/api/identityKey/{pubkey}'
            }
          })
        } as Response
      }
      if (!(url in answers)) throw new PaymailServerResponseError('not found', 404)
      return { json: async () => answers[url] } as Response
    })
    return {
      client: new PaymailClient({ request: requestMock } as unknown as HttpClient, { dns }),
      request: requestMock
    }
  }

  it('looks up suggestions, dropping certificates that fail verification', async () => {
    const tampered = withFields({ displayName: 'Mallory' })
    const { client: c, request: r } = client({
      'https://paymail.example.com/api/handle/al': [tampered, VECTOR]
    })
    const profiles = await c.lookupProfiles('example.com', 'Al')
    expect(profiles.map(p => p.paymail)).toEqual(['alice@example.com'])
    expect(r).toHaveBeenLastCalledWith('https://paymail.example.com/api/handle/al')
  })

  it('returns only the exact paymail for a complete one, and resolves it', async () => {
    const other = await createProfileCertificate({
      signer: wallet('4'),
      paymail: 'alicea@example.com'
    })
    const { client: c } = client({
      'https://paymail.example.com/api/handle/alice': [other, VECTOR]
    })
    await expect(c.lookupProfiles('example.com', 'alice@example.com')).resolves.toHaveLength(1)
    await expect(c.resolveProfile('Alice@Example.com')).resolves.toMatchObject({
      identityKey: VECTOR_KEY
    })
    await expect(c.lookupProfiles('example.com', 'alice')).resolves.toHaveLength(2)
  })

  it('does not ask for a query the host would not search', async () => {
    const { client: c, request: r } = client({})
    await expect(c.lookupProfiles('example.com', 'a')).resolves.toEqual([])
    expect(r).not.toHaveBeenCalled()
    await expect(c.resolveProfile('not a paymail')).rejects.toThrow('Invalid Paymail address')
  })

  it('processes at most ten lookup results', async () => {
    const { client: c } = client({
      'https://paymail.example.com/api/handle/al': Array(25).fill(VECTOR)
    })
    await expect(c.lookupProfiles('example.com', 'al')).resolves.toHaveLength(10)
  })

  it('rejects a lookup body that is not an array', async () => {
    const { client: c } = client({ 'https://paymail.example.com/api/handle/al': VECTOR })
    await expect(c.lookupProfiles('example.com', 'al')).rejects.toThrow('must return an array')
  })

  it('reverse-looks up a key, answering undefined on 404 or a mismatched certificate', async () => {
    const other = `03${'1'.repeat(64)}`
    const { client: c } = client({
      [`https://paymail.example.com/api/identityKey/${VECTOR_KEY}`]: VECTOR,
      [`https://paymail.example.com/api/identityKey/${other}`]: VECTOR
    })
    await expect(
      c.reverseLookupProfile('example.com', VECTOR_KEY.toUpperCase())
    ).resolves.toMatchObject({
      paymail: 'alice@example.com'
    })
    await expect(c.reverseLookupProfile('example.com', other)).resolves.toBeUndefined()
    await expect(
      c.reverseLookupProfile('example.com', `02${'2'.repeat(64)}`)
    ).resolves.toBeUndefined()
    await expect(c.reverseLookupProfile('example.com', 'nope')).rejects.toThrow(
      'Invalid compressed public key'
    )
  })

  it('works against a host advertising no other capability, and refuses unusable templates', async () => {
    const { client: c } = client({}, { '0ace65da5987': 'https://paymail.example.com/api/handle' })
    await expect(c.lookupProfiles('example.com', 'al')).rejects.toThrow('without {query}')
    await expect(c.reverseLookupProfile('example.com', VECTOR_KEY)).rejects.toThrow(
      'does not support'
    )
    const unsafe = client({}, { '0ace65da5987': 'https://127.0.0.1/api/handle/{query}' })
    await expect(unsafe.client.lookupProfiles('example.com', 'al')).rejects.toThrow('unsafe')
  })

  it('propagates host errors other than 404 from reverse lookup', async () => {
    const requestMock = jest.fn(async (url: string): Promise<Response> => {
      if (url.endsWith('/.well-known/bsvalias')) {
        return {
          json: async () => ({
            bsvalias: '1.0',
            capabilities: { '43dcf83ddc5f': 'https://p.example.com/k/{pubkey}' }
          })
        } as Response
      }
      throw new PaymailServerResponseError('busy', 503)
    })
    const c = new PaymailClient({ request: requestMock } as unknown as HttpClient, { dns })
    await expect(c.reverseLookupProfile('example.com', VECTOR_KEY)).rejects.toThrow('busy')
  })
})
