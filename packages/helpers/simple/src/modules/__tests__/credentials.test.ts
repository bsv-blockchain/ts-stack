import {
  CredentialIssuer,
  CredentialSchema,
  MemoryRevocationStore,
  createCredentialMethods,
  toVerifiableCredential,
  toVerifiablePresentation
} from '../credentials'

const PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const CERTIFIER_KEY = '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd'
const ZERO_OUTPOINT = `${'00'.repeat(32)}.0`

const certificate = {
  type: 'dGVzdC1jZXJ0',
  serialNumber: 'serial-1',
  subject: SUBJECT_KEY,
  certifier: CERTIFIER_KEY,
  revocationOutpoint: ZERO_OUTPOINT,
  fields: {
    name: 'Alice',
    role: 'admin'
  },
  signature: 'signature',
  keyringForSubject: {
    name: 'encrypted-name'
  }
}

describe('CredentialSchema', () => {
  it('validates required fields', () => {
    const schema = new CredentialSchema({
      id: 'employee',
      name: 'Employee',
      fields: [
        { key: 'name', label: 'Name', type: 'text', required: true },
        { key: 'department', label: 'Department', type: 'text' }
      ]
    })

    expect(schema.validate({ name: 'Alice' })).toBeNull()
    expect(schema.validate({ name: '   ' })).toBe('Name is required')
    expect(schema.validate({})).toBe('Name is required')
  })

  it('runs custom validation and computed fields', () => {
    const schema = new CredentialSchema({
      id: 'employee',
      name: 'Employee',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      validate: values => values.name === 'blocked' ? 'Name is blocked' : null,
      computedFields: values => ({ slug: values.name.toLowerCase() })
    })

    expect(schema.validate({ name: 'blocked' })).toBe('Name is blocked')
    expect(schema.computeFields({ name: 'Alice' })).toEqual({
      name: 'Alice',
      slug: 'alice'
    })
  })

  it('exposes schema metadata and preserves explicit certificate type', () => {
    const schema = new CredentialSchema({
      id: 'employee',
      name: 'Employee',
      description: 'Employee credential',
      certificateTypeBase64: 'ZXhwbGljaXQ=',
      fields: [{ key: 'name', label: 'Name', type: 'text' }]
    })

    expect(schema.getInfo()).toEqual({
      id: 'employee',
      name: 'Employee',
      description: 'Employee credential',
      certificateTypeBase64: 'ZXhwbGljaXQ=',
      fieldCount: 1
    })
    expect(schema.getConfig().certificateTypeBase64).toBe('ZXhwbGljaXQ=')
  })
})

describe('MemoryRevocationStore', () => {
  it('saves, loads, finds, and deletes revocation records', async () => {
    const store = new MemoryRevocationStore()
    const record = {
      secret: 'abcd',
      outpoint: 'txid.0',
      beef: [1, 2, 3]
    }

    await store.save('serial-1', record)

    await expect(store.load('serial-1')).resolves.toEqual(record)
    await expect(store.has('serial-1')).resolves.toBe(true)
    await expect(store.findByOutpoint('txid.0')).resolves.toBe(true)
    await expect(store.findByOutpoint('missing.0')).resolves.toBe(false)

    await store.delete('serial-1')
    await expect(store.load('serial-1')).resolves.toBeUndefined()
    await expect(store.has('serial-1')).resolves.toBe(false)
  })
})

describe('Verifiable credential helpers', () => {
  it('wraps certificate data as a W3C verifiable credential', () => {
    const vc = toVerifiableCredential(certificate, CERTIFIER_KEY, {
      credentialType: 'EmployeeCredential'
    })

    expect(vc['@context']).toContain('https://www.w3.org/2018/credentials/v1')
    expect(vc.type).toEqual(['VerifiableCredential', 'EmployeeCredential'])
    expect(vc.issuer).toBe(`did:bsv:${CERTIFIER_KEY}`)
    expect(vc.credentialSubject).toMatchObject({
      id: `did:bsv:${SUBJECT_KEY}`,
      name: 'Alice',
      role: 'admin'
    })
    expect(vc.credentialStatus).toBeUndefined()
    expect(vc.proof.signatureValue).toBe('signature')
    expect(vc._bsv.certificate).toEqual(certificate)
  })

  it('adds credential status when the revocation outpoint is non-zero', () => {
    const vc = toVerifiableCredential({
      ...certificate,
      revocationOutpoint: 'abc.0'
    }, CERTIFIER_KEY)

    expect(vc.credentialStatus).toEqual({
      id: 'bsv:abc.0',
      type: 'BSVHashLockRevocation2024'
    })
  })

  it('wraps credentials as a verifiable presentation', () => {
    const vc = toVerifiableCredential(certificate, CERTIFIER_KEY)
    const presentation = toVerifiablePresentation([vc], SUBJECT_KEY)

    expect(presentation.holder).toBe(`did:bsv:${SUBJECT_KEY}`)
    expect(presentation.verifiableCredential).toEqual([vc])
    expect(presentation.proof.verificationMethod).toBe(`did:bsv:${SUBJECT_KEY}#key-1`)
  })
})

describe('CredentialIssuer', () => {
  it('requires a wallet when revocation is enabled', async () => {
    await expect(CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      revocation: { enabled: true }
    })).rejects.toThrow('Revocation enabled but no wallet provided')
  })

  it('reports issuer metadata and schema names', async () => {
    const issuer = await CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      schemas: [{
        id: 'employee',
        name: 'Employee',
        fields: [{ key: 'name', label: 'Name', type: 'text' }]
      }]
    })

    const info = issuer.getInfo()

    expect(info.publicKey).toBeDefined()
    expect(info.did).toBe(`did:bsv:${info.publicKey}`)
    expect(info.schemas).toEqual([{ id: 'employee', name: 'Employee' }])
  })

  it('verifies valid and malformed credentials', async () => {
    const issuer = await CredentialIssuer.create({ privateKey: PRIVATE_KEY })
    const vc = toVerifiableCredential(certificate, CERTIFIER_KEY)

    await expect(issuer.verify(vc)).resolves.toMatchObject({
      valid: true,
      revoked: false,
      errors: [],
      issuer: `did:bsv:${CERTIFIER_KEY}`,
      subject: `did:bsv:${SUBJECT_KEY}`
    })

    await expect(issuer.verify({
      ...vc,
      '@context': [],
      type: [],
      proof: undefined,
      _bsv: undefined
    } as any)).resolves.toMatchObject({
      valid: false,
      errors: [
        'Missing W3C VC context',
        'Missing VerifiableCredential type',
        'Missing proof or signature',
        'Missing BSV certificate data'
      ]
    })
  })

  it('detects revoked credentials when revocation records are missing', async () => {
    const issuer = await CredentialIssuer.create({ privateKey: PRIVATE_KEY })
    const vc = toVerifiableCredential({
      ...certificate,
      revocationOutpoint: 'abc.0'
    }, CERTIFIER_KEY)

    await expect(issuer.verify(vc)).resolves.toMatchObject({
      valid: false,
      revoked: true,
      errors: ['Credential has been revoked']
    })
  })

  it('rejects revoke calls when revocation is disabled', async () => {
    const issuer = await CredentialIssuer.create({ privateKey: PRIVATE_KEY })

    await expect(issuer.revoke('serial-1')).rejects.toThrow('Revocation is not enabled')
    await expect(issuer.isRevoked('serial-1')).resolves.toBe(true)
  })
})

describe('createCredentialMethods', () => {
  let originalFetch: typeof global.fetch
  let fetchMock: jest.Mock
  let client: any
  let core: any

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    client = {
      listCertificates: jest.fn().mockResolvedValue({
        certificates: [{
          serialNumber: 'old-serial',
          certifier: CERTIFIER_KEY
        }]
      }),
      relinquishCertificate: jest.fn().mockResolvedValue({ relinquished: true }),
      acquireCertificate: jest.fn().mockResolvedValue(certificate)
    }
    core = {
      getClient: jest.fn(() => client),
      getIdentityKey: jest.fn(() => SUBJECT_KEY)
    }
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.restoreAllMocks()
  })

  it('acquires credentials from an issuer service and imports them into the wallet', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          certifierPublicKey: CERTIFIER_KEY,
          certificateType: certificate.type
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => certificate
      })

    const methods = createCredentialMethods(core)
    const vc = await methods.acquireCredential({
      serverUrl: 'https://issuer.example',
      schemaId: 'employee',
      fields: { name: 'Alice' }
    })

    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://issuer.example?action=info')
    expect(client.listCertificates).toHaveBeenCalledWith({
      certifiers: [CERTIFIER_KEY],
      types: [certificate.type],
      limit: 100
    })
    expect(client.relinquishCertificate).toHaveBeenCalledWith({
      type: certificate.type,
      serialNumber: 'old-serial',
      certifier: CERTIFIER_KEY
    })
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://issuer.example?action=certify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identityKey: SUBJECT_KEY,
        schemaId: 'employee',
        fields: { name: 'Alice' }
      })
    })
    expect(client.acquireCertificate).toHaveBeenCalledWith(expect.objectContaining({
      type: certificate.type,
      certifier: certificate.certifier,
      acquisitionProtocol: 'direct'
    }))
    expect(vc.issuer).toBe(`did:bsv:${CERTIFIER_KEY}`)
  })

  it('does not revoke existing credentials when replaceExisting is false', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          certifierPublicKey: CERTIFIER_KEY,
          certificateType: certificate.type
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => certificate
      })

    const methods = createCredentialMethods(core)
    await methods.acquireCredential({
      serverUrl: 'https://issuer.example',
      replaceExisting: false
    })

    expect(client.listCertificates).not.toHaveBeenCalled()
    expect(client.relinquishCertificate).not.toHaveBeenCalled()
  })

  it('wraps acquisition failures in CredentialError messages', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: async () => ({})
    })

    const methods = createCredentialMethods(core)

    await expect(methods.acquireCredential({
      serverUrl: 'https://issuer.example'
    })).rejects.toThrow('Credential acquisition failed: Server returned 503')
  })

  it('lists wallet certificates as verifiable credentials', async () => {
    client.listCertificates.mockResolvedValueOnce({
      certificates: [certificate]
    })

    const methods = createCredentialMethods(core)
    const credentials = await methods.listCredentials({
      certifiers: [CERTIFIER_KEY],
      types: [certificate.type]
    })

    expect(client.listCertificates).toHaveBeenCalledWith({
      certifiers: [CERTIFIER_KEY],
      types: [certificate.type],
      limit: 100
    })
    expect(credentials).toHaveLength(1)
    expect(credentials[0].issuer).toBe(`did:bsv:${CERTIFIER_KEY}`)
  })

  it('wraps list credential failures', async () => {
    client.listCertificates.mockRejectedValueOnce(new Error('wallet offline'))

    const methods = createCredentialMethods(core)

    await expect(methods.listCredentials({
      certifiers: [CERTIFIER_KEY],
      types: [certificate.type]
    })).rejects.toThrow('Failed to list credentials: wallet offline')
  })

  it('creates presentations for the wallet identity key', () => {
    const vc = toVerifiableCredential(certificate, CERTIFIER_KEY)
    const methods = createCredentialMethods(core)

    expect(methods.createPresentation([vc]).holder).toBe(`did:bsv:${SUBJECT_KEY}`)
  })
})
