import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PrivateKey } from '@bsv/sdk'
import { CredentialIssuer } from '../../modules/credentials'
import * as KeyGenerator from '../generate-private-key'
import { createCredentialIssuerHandler } from '../credential-issuer-handler'

const ENV_VAR = 'SIMPLE_CREDENTIAL_ISSUER_BOUNDARY_KEY'
const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const SERIAL_NUMBER = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU='
const CERTIFICATE_TYPE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='
const SCHEMAS = [{ id: 'test-schema', name: 'Test Schema', fields: [] }]

function issuer(publicKey = SUBJECT_KEY): any {
  return {
    getInfo: jest.fn(() => ({
      publicKey,
      schemas: [{ id: 'test-schema', name: 'Test Schema', certificateTypeBase64: CERTIFICATE_TYPE }]
    })),
    isRevoked: jest.fn(async () => false),
    issue: jest.fn(async () => ({ _bsv: { certificate: { serialNumber: SERIAL_NUMBER } } })),
    verify: jest.fn(async () => ({ valid: true })),
    revoke: jest.fn(async () => ({ txid: 'revoke-txid' }))
  }
}

describe('credential issuer key lifecycle and revocation wiring', () => {
  let directory: string
  let keyFile: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'simple-credential-issuer-'))
    keyFile = join(directory, 'issuer.json')
    delete process.env[ENV_VAR]
  })

  afterEach(() => {
    delete process.env[ENV_VAR]
    jest.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  it.each([
    ['an empty schema list', []],
    [
      'more than 100 schemas',
      Array.from({ length: 101 }, (_, i) => ({ id: `s-${i}`, name: `Schema ${i}`, fields: [] }))
    ]
  ])('rejects %s at construction', (_name, schemas) => {
    expect(() => createCredentialIssuerHandler({ schemas })).toThrow('between 1 and 100 schemas')
  })

  it('rejects sparse or inherited schema configuration', () => {
    const sparseSchemas: typeof SCHEMAS = []
    sparseSchemas.length = 1
    expect(() => createCredentialIssuerHandler({ schemas: sparseSchemas })).toThrow(
      'dense own-data array'
    )
    expect(() =>
      createCredentialIssuerHandler(
        Object.create({ schemas: SCHEMAS }) as { schemas: typeof SCHEMAS }
      )
    ).toThrow('between 1 and 100 schemas')
  })

  it('generates and persists a key whose public half comes from the initialized issuer', async () => {
    const privateKey = PrivateKey.fromRandom().toHex()
    const publicKey = PrivateKey.fromHex(privateKey).toPublicKey().toString()
    jest.spyOn(KeyGenerator, 'generatePrivateKey').mockReturnValue(privateKey)
    jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer(publicKey))
    const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, keyFile })

    const response = await handler.GET?.({ url: 'https://issuer.example/api?action=info' })

    expect(response.status).toBe(200)
    expect(JSON.parse(readFileSync(keyFile, 'utf8'))).toEqual({ privateKey, publicKey })
  })

  it('loads a persisted issuer key whose properties sort as privateKey, publicKey', async () => {
    const privateKey = PrivateKey.fromRandom().toHex()
    const publicKey = PrivateKey.fromHex(privateKey).toPublicKey().toString()
    const stored: Record<string, string> = {}
    stored.publicKey = publicKey
    stored.privateKey = privateKey
    writeFileSync(keyFile, JSON.stringify(stored), { mode: 0o600 })
    const create = jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer(publicKey))
    const originalSort = Array.prototype.sort
    Array.prototype.sort = function (compareFn?: (left: string, right: string) => number) {
      if (typeof compareFn !== 'function') {
        throw new Error('Array.prototype.sort was called without a comparator')
      }
      return originalSort.call(this, compareFn)
    }
    try {
      const response = await createCredentialIssuerHandler({ schemas: SCHEMAS, keyFile }).GET?.({
        url: 'https://issuer.example/api?action=info'
      })
      expect(response?.status).toBe(200)
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ privateKey }))
    } finally {
      Array.prototype.sort = originalSort
    }
  })

  it('loads a strictly bound persisted key and caches the issuer', async () => {
    const privateKey = PrivateKey.fromRandom().toHex()
    const publicKey = PrivateKey.fromHex(privateKey).toPublicKey().toString()
    writeFileSync(keyFile, JSON.stringify({ privateKey, publicKey }), { mode: 0o600 })
    const create = jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer(publicKey))
    const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, keyFile })

    await handler.GET?.({ url: 'https://issuer.example/api?action=info' })
    await handler.GET?.({ url: 'https://issuer.example/api?action=info' })

    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ privateKey, revocation: { enabled: false } })
    )
  })

  it.each([
    ['non-record state', []],
    ['extra properties', { privateKey: '1'.repeat(64), publicKey: SUBJECT_KEY, extra: true }],
    ['invalid private key', { privateKey: 'z'.repeat(64), publicKey: SUBJECT_KEY }],
    ['zero private key', { privateKey: '0'.repeat(64), publicKey: '00' }],
    ['out-of-range private key', { privateKey: 'f'.repeat(64), publicKey: SUBJECT_KEY }],
    [
      'mismatched public key',
      { privateKey: PrivateKey.fromRandom().toHex(), publicKey: SUBJECT_KEY }
    ]
  ])('fails closed for persisted issuer key state with %s', async (_name, value) => {
    writeFileSync(keyFile, JSON.stringify(value), { mode: 0o600 })
    const response = await createCredentialIssuerHandler({ schemas: SCHEMAS, keyFile }).GET?.({
      url: 'https://issuer.example/api?action=info'
    })
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Credential issuer operation failed'
    })
  })

  it('wires a configured server wallet into revocation and does not silently downgrade failure', async () => {
    const privateKey = PrivateKey.fromRandom().toHex()
    process.env[ENV_VAR] = privateKey
    const walletClient = { listOutputs: jest.fn() }
    const serverWalletManager = {
      getWallet: jest.fn().mockResolvedValue({ getClient: () => walletClient })
    }
    const create = jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer())
    const handler = createCredentialIssuerHandler({
      schemas: SCHEMAS,
      envVar: ENV_VAR,
      keyFile,
      serverWalletManager,
      revocationStorePath: join(directory, 'revocations.json')
    })

    expect((await handler.GET?.({ url: 'https://issuer.example/api?action=info' }))?.status).toBe(
      200
    )
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        revocation: expect.objectContaining({ enabled: true, wallet: walletClient })
      })
    )

    serverWalletManager.getWallet.mockRejectedValueOnce(new Error('wallet unavailable'))
    const failing = createCredentialIssuerHandler({
      schemas: SCHEMAS,
      envVar: ENV_VAR,
      keyFile: join(directory, 'other.json'),
      serverWalletManager
    })
    expect((await failing.GET?.({ url: 'https://issuer.example/api?action=info' }))?.status).toBe(
      500
    )
  })

  it('rejects a non-canonical environment key before constructing an issuer', async () => {
    process.env[ENV_VAR] = 'f'.repeat(64)
    const create = jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer())
    const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, envVar: ENV_VAR, keyFile })

    expect((await handler.GET?.({ url: 'https://issuer.example/api?action=info' }))?.status).toBe(
      500
    )
    expect(create).not.toHaveBeenCalled()
  })
})

describe('credential issuer GET and authorization boundaries', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = PrivateKey.fromRandom().toHex()
  })

  afterEach(() => {
    delete process.env[ENV_VAR]
    jest.restoreAllMocks()
  })

  it('serves legacy info, schema lookup, canonical revocation status, and method guidance', async () => {
    const testIssuer = issuer()
    jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(testIssuer)
    const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, envVar: ENV_VAR })

    const legacy = await handler.GET?.({ url: 'https://issuer.example/api/info' })
    await expect(legacy.json()).resolves.toEqual({
      certifierPublicKey: SUBJECT_KEY,
      certificateType: CERTIFICATE_TYPE
    })

    const schema = await handler.GET?.({
      url: 'https://issuer.example/api/credential-issuer?action=schema&id=test-schema'
    })
    await expect(schema.json()).resolves.toMatchObject({
      success: true,
      schema: { id: 'test-schema', certificateTypeBase64: CERTIFICATE_TYPE }
    })

    const missingSchema = await handler.GET?.({
      url: 'https://issuer.example/api/credential-issuer?action=schema&id=missing'
    })
    expect(missingSchema.status).toBe(404)

    const status = await handler.GET?.({
      url: `https://issuer.example/api/credential-issuer?action=status&serialNumber=${encodeURIComponent(SERIAL_NUMBER)}`
    })
    await expect(status.json()).resolves.toEqual({
      success: true,
      serialNumber: SERIAL_NUMBER,
      revoked: false
    })
    expect(testIssuer.isRevoked).toHaveBeenCalledWith(SERIAL_NUMBER)

    const certify = await handler.GET?.({
      url: 'https://issuer.example/api/credential-issuer?action=certify'
    })
    expect(certify.status).toBe(405)

    const unknown = await handler.GET?.({
      url: 'https://issuer.example/api/credential-issuer?action=unknown'
    })
    expect(unknown.status).toBe(400)
  })

  it.each([null, '', 'AA==', `${SERIAL_NUMBER}A`, SERIAL_NUMBER.replace(/=$/, '')])(
    'rejects non-canonical status serial number %p',
    async serialNumber => {
      jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer())
      const value = serialNumber == null ? '' : `&serialNumber=${encodeURIComponent(serialNumber)}`
      const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, envVar: ENV_VAR })
      const response = await handler.GET?.({
        url: `https://issuer.example/api/credential-issuer?action=status${value}`
      })
      expect(response.status).toBe(serialNumber == null || serialNumber === '' ? 400 : 500)
    }
  )

  it('passes owned validated authorization context and contains policy exceptions', async () => {
    const authorize = jest.fn(async () => {
      throw new Error('policy details must stay private')
    })
    jest.spyOn(CredentialIssuer, 'create').mockResolvedValue(issuer())
    const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, envVar: ENV_VAR, authorize })
    const headers = new Headers({ authorization: 'Bearer test' })
    const response = await handler.POST?.({
      url: 'https://issuer.example/api/credential-issuer?action=certify',
      headers,
      json: async () => ({ identityKey: SUBJECT_KEY, fields: { name: 'Alice' } })
    })

    expect(response.status).toBe(403)
    expect(authorize).toHaveBeenCalledWith({
      action: 'certify',
      subjectIdentityKey: SUBJECT_KEY,
      schemaId: 'test-schema',
      fields: { name: 'Alice' },
      url: 'https://issuer.example/api/credential-issuer?action=certify',
      headers
    })
  })

  it('does not inherit an ambient authorization callback', async () => {
    const ambientAuthorize = jest.fn(async () => true)
    Object.defineProperty(Object.prototype, 'authorize', {
      value: ambientAuthorize,
      configurable: true
    })
    try {
      const handler = createCredentialIssuerHandler({ schemas: SCHEMAS, envVar: ENV_VAR })
      const response = await handler.POST?.({
        url: 'https://issuer.example/api/credential-issuer?action=certify',
        json: async () => ({ identityKey: SUBJECT_KEY, fields: { name: 'Alice' } })
      })

      expect(response.status).toBe(403)
      expect(ambientAuthorize).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'authorize')
    }
  })

  it('passes a null-prototype revoke policy context without ambient optional fields', async () => {
    const authorize = jest.fn(async request => {
      expect(Object.getPrototypeOf(request)).toBeNull()
      expect('fields' in request).toBe(false)
      expect('schemaId' in request).toBe(false)
      expect('headers' in request).toBe(false)
      return false
    })
    Object.defineProperties(Object.prototype, {
      fields: { value: { role: 'ambient' }, configurable: true },
      schemaId: { value: 'ambient-schema', configurable: true },
      headers: { value: new Headers({ authorization: 'ambient' }), configurable: true }
    })
    try {
      const handler = createCredentialIssuerHandler({
        schemas: SCHEMAS,
        envVar: ENV_VAR,
        authorize
      })
      const response = await handler.POST?.({
        url: 'https://issuer.example/api/credential-issuer?action=revoke',
        json: async () => ({ serialNumber: SERIAL_NUMBER })
      })

      expect(response.status).toBe(403)
      expect(authorize).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'fields')
      Reflect.deleteProperty(Object.prototype, 'schemaId')
      Reflect.deleteProperty(Object.prototype, 'headers')
    }
  })
})
