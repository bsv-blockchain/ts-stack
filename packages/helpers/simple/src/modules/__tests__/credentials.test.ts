import { MasterCertificate, PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { CertificateData, CredentialIssuerConfig, VerifiableCredential } from '../../core/types'
import legacyCredentialFixture from '../../core/__tests__/fixtures/pre-0.6-credential.json'
import { Certifier, createCertificationMethods } from '../certification'
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
const CERTIFIER_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const ZERO_OUTPOINT = `${'00'.repeat(32)}.0`
const CERTIFICATE_TYPE = Utils.toBase64(Array.from({ length: 32 }, () => 1))
const CERTIFICATE_SERIAL = Utils.toBase64(Array.from({ length: 32 }, () => 2))
const EXPLICIT_CERTIFICATE_TYPE = Utils.toBase64(Array.from({ length: 32 }, () => 3))
const OLD_CERTIFICATE_SERIAL = Utils.toBase64(Array.from({ length: 32 }, () => 4))
const LEGACY_CERTIFIER_TYPE = Utils.toBase64(Utils.toArray('certification', 'utf8'))

const certificate = {
  type: CERTIFICATE_TYPE,
  serialNumber: CERTIFICATE_SERIAL,
  subject: SUBJECT_KEY,
  certifier: CERTIFIER_KEY,
  revocationOutpoint: ZERO_OUTPOINT,
  fields: { name: 'QWxpY2U=', role: 'YWRtaW4=' },
  signature: 'signature',
  keyringForSubject: {
    name: 'encrypted-name'
  }
}

async function signedCertificate(outpoint = ZERO_OUTPOINT): Promise<CertificateData> {
  const master = new MasterCertificate(
    certificate.type,
    certificate.serialNumber,
    certificate.subject,
    certificate.certifier,
    outpoint,
    certificate.fields,
    { name: 'AA==', role: 'AQ==' }
  )
  await master.sign(new ProtoWallet(new PrivateKey(PRIVATE_KEY, 'hex')))
  return {
    type: master.type,
    serialNumber: master.serialNumber,
    subject: master.subject,
    certifier: master.certifier,
    revocationOutpoint: master.revocationOutpoint,
    fields: { ...master.fields },
    signature: master.signature as string,
    keyringForSubject: { ...master.masterKeyring }
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
    const validationPrototypes: Array<object | null> = []
    const schema = new CredentialSchema({
      id: 'employee',
      name: 'Employee',
      fields: [{ key: 'name', label: 'Name', type: 'text', required: true }],
      validate: values => {
        validationPrototypes.push(Object.getPrototypeOf(values))
        return values.name === 'blocked' ? 'Name is blocked' : null
      },
      computedFields: values => {
        validationPrototypes.push(Object.getPrototypeOf(values))
        return { slug: values.name.toLowerCase() }
      }
    })

    expect(schema.validate({ name: 'blocked' })).toBe('Name is blocked')
    expect(schema.computeFields({ name: 'Alice' })).toEqual({
      name: 'Alice',
      slug: 'alice'
    })
    expect(validationPrototypes).toEqual([null, null])
  })

  it('does not obtain optional schema policy or required flags from Object.prototype', () => {
    const ambientValidate = jest.fn(() => 'ambient rejection')
    const ambientComputed = jest.fn(() => ({ ambient: 'true' }))
    Object.defineProperties(Object.prototype, {
      required: { value: true, configurable: true },
      validate: { value: ambientValidate, configurable: true },
      computedFields: { value: ambientComputed, configurable: true }
    })
    try {
      const schema = new CredentialSchema({
        id: 'employee',
        name: 'Employee',
        fields: [{ key: 'name', label: 'Name', type: 'text' }]
      })
      expect(schema.validate({})).toBeNull()
      expect(schema.computeFields({ name: 'Alice' })).toEqual({ name: 'Alice' })
      expect(ambientValidate).not.toHaveBeenCalled()
      expect(ambientComputed).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'required')
      Reflect.deleteProperty(Object.prototype, 'validate')
      Reflect.deleteProperty(Object.prototype, 'computedFields')
    }
  })

  it('rejects coercive field types and malformed optional field metadata', () => {
    const coercion = jest.fn(() => 'text')
    const type = { toString: coercion }
    expect(
      () =>
        new CredentialSchema({
          id: 'coercive',
          name: 'Coercive',
          fields: [{ key: 'name', label: 'Name', type } as never]
        })
    ).toThrow('Invalid credential field type')
    expect(coercion).not.toHaveBeenCalled()

    expect(
      () =>
        new CredentialSchema({
          id: 'required',
          name: 'Required',
          fields: [{ key: 'name', label: 'Name', type: 'text', required: 'true' as never }]
        })
    ).toThrow('Invalid credential required flag')
    expect(
      () =>
        new CredentialSchema({
          id: 'placeholder',
          name: 'Placeholder',
          fields: [{ key: 'name', label: 'Name', type: 'text', placeholder: {} as never }]
        })
    ).toThrow('Invalid credential schema field placeholder')
  })

  it('preserves empty and whitespace in optional display metadata', () => {
    const schema = new CredentialSchema({
      id: 'display',
      name: '  ',
      description: '  ',
      fields: [
        {
          key: 'name',
          label: '',
          type: 'select',
          placeholder: '',
          format: '  ',
          helpText: '',
          group: ' ',
          options: [{ value: '', label: '  ' }]
        }
      ],
      fieldGroups: [{ key: 'display', label: '' }]
    })

    expect(schema.getConfig()).toMatchObject({
      name: '  ',
      description: '  ',
      fields: [
        expect.objectContaining({
          label: '',
          placeholder: '',
          format: '  ',
          helpText: '',
          group: ' ',
          options: [{ value: '', label: '  ' }]
        })
      ],
      fieldGroups: [{ key: 'display', label: '' }]
    })
  })

  it('rejects undeclared and out-of-domain field values and owns its configuration', () => {
    const field = {
      key: 'role',
      label: 'Role',
      type: 'select' as const,
      options: [{ value: 'member', label: 'Member' }]
    }
    const schema = new CredentialSchema({ id: 'membership', name: 'Membership', fields: [field] })
    field.options[0].value = 'admin'

    expect(schema.validate({ role: 'admin' })).toBe('Role must be one of the declared options')
    expect(schema.validate({ role: 'member', privilege: 'admin' })).toBe(
      'Credential field privilege is not declared by the schema'
    )
    const exported = schema.getConfig()
    exported.fields[0].options?.splice(0)
    expect(schema.validate({ role: 'member' })).toBeNull()
  })

  it('exposes schema metadata and preserves explicit certificate type', () => {
    const schema = new CredentialSchema({
      id: 'employee',
      name: 'Employee',
      description: 'Employee credential',
      certificateTypeBase64: EXPLICIT_CERTIFICATE_TYPE,
      fields: [{ key: 'name', label: 'Name', type: 'text' }]
    })

    expect(schema.getInfo()).toEqual({
      id: 'employee',
      name: 'Employee',
      description: 'Employee credential',
      certificateTypeBase64: EXPLICIT_CERTIFICATE_TYPE,
      fieldCount: 1
    })
    expect(schema.getConfig().certificateTypeBase64).toBe(EXPLICIT_CERTIFICATE_TYPE)
  })

  it('exposes canonical and pre-upgrade default types for offline migration', () => {
    const schema = new CredentialSchema({ id: 'employee', name: 'Employee', fields: [] })

    expect(schema.getInfo().certificateTypeBase64).toBe(
      CredentialSchema.getCanonicalCertificateType('employee')
    )
    expect(schema.getCertificateTypeMigration()).toEqual({
      canonical: CredentialSchema.getCanonicalCertificateType('employee'),
      legacy: [CredentialSchema.getLegacyCertificateType('employee')]
    })
  })

  it('accepts bounded canonical-base64 legacy type overrides', () => {
    const legacyType = Utils.toBase64(Utils.toArray('custom-legacy-type', 'utf8'))
    const schema = new CredentialSchema({
      id: 'employee',
      name: 'Employee',
      certificateTypeBase64: legacyType,
      fields: []
    })

    expect(Utils.toArray(schema.getInfo().certificateTypeBase64, 'base64')).toHaveLength(32)
    expect(schema.getCertificateTypeMigration()).toEqual({
      canonical: schema.getInfo().certificateTypeBase64,
      legacy: [legacyType]
    })
    expect(
      () =>
        new CredentialSchema({
          id: 'employee',
          name: 'Employee',
          certificateTypeBase64: 'not canonical base64',
          fields: []
        })
    ).toThrow('Invalid certificate type')
  })

  it('rejects malformed schema containers, identifiers, and bounded text', () => {
    expect(() => new CredentialSchema(null as never)).toThrow('at most 100 declared fields')
    expect(
      () => new CredentialSchema({ id: 'schema', name: 'Schema', fields: null } as never)
    ).toThrow('at most 100 declared fields')
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: Array.from({ length: 101 }, (_, index) => ({
            key: `field-${index}`,
            label: `Field ${index}`,
            type: 'text'
          }))
        })
    ).toThrow('at most 100 declared fields')
    expect(() => new CredentialSchema({ id: '', name: 'Schema', fields: [] })).toThrow(
      'Invalid credential schema identifier'
    )
    expect(() => new CredentialSchema({ id: 'schema', name: 'n'.repeat(129), fields: [] })).toThrow(
      'Invalid credential schema name'
    )
  })

  it('rejects sparse, unsafe, duplicate, and invalid field declarations', () => {
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: [new Date() as never]
        })
    ).toThrow('Invalid credential field schema')
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: [
            { key: 'role', label: 'Role', type: 'text' },
            { key: 'role', label: 'Other role', type: 'text' }
          ]
        })
    ).toThrow('safe and unique')
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: [{ key: 'constructor', label: 'Unsafe', type: 'text' }]
        })
    ).toThrow('safe and unique')
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: [{ key: 'role', label: 'Role', type: 'unknown' as never }]
        })
    ).toThrow('Invalid credential field type')
  })

  it('rejects malformed and duplicate select options and owns field groups', () => {
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: [{ key: 'role', label: 'Role', type: 'select', options: [new Date() as never] }]
        })
    ).toThrow('Invalid credential field options')
    expect(
      () =>
        new CredentialSchema({
          id: 'schema',
          name: 'Schema',
          fields: [
            {
              key: 'role',
              label: 'Role',
              type: 'select',
              options: [
                { value: 'member', label: 'Member' },
                { value: 'member', label: 'Duplicate' }
              ]
            }
          ]
        })
    ).toThrow('bounded and unique')

    const fieldGroups = [{ key: 'identity', label: 'Identity' }]
    const schema = new CredentialSchema({
      id: 'schema',
      name: 'Schema',
      fields: [{ key: 'name', label: 'Name', type: 'text' }],
      fieldGroups
    })
    fieldGroups[0].label = 'Mutated'
    expect(schema.getConfig().fieldGroups).toEqual([{ key: 'identity', label: 'Identity' }])
  })

  it.each([
    [{ email: 'not-an-email' }, 'Email must be a valid email address'],
    [{ date: '21/09/2026' }, 'Date must be a YYYY-MM-DD date'],
    [{ number: '01' }, 'Number must be a finite number'],
    [{ checkbox: 'yes' }, 'Checkbox must be true or false']
  ])('validates typed credential field values %#', (values, expected) => {
    const schema = new CredentialSchema({
      id: 'typed',
      name: 'Typed',
      fields: [
        { key: 'email', label: 'Email', type: 'email' },
        { key: 'date', label: 'Date', type: 'date' },
        { key: 'number', label: 'Number', type: 'number' },
        { key: 'checkbox', label: 'Checkbox', type: 'checkbox' }
      ]
    })

    expect(schema.validate(values)).toBe(expected)
  })

  it('normalizes malformed values and custom validator outcomes', () => {
    const schema = new CredentialSchema({
      id: 'custom',
      name: 'Custom',
      fields: [{ key: 'name', label: 'Name', type: 'text' }],
      validate: values => {
        if (values.name === 'valid') return null
        if (values.name === 'empty') return ''
        return 'x'.repeat(513)
      }
    })
    const accessor = Object.defineProperty({}, 'name', { get: () => 'hidden' })

    expect(schema.validate(accessor as Record<string, string>)).toBe(
      'Credential fields are malformed'
    )
    expect(schema.validate({ name: 'valid' })).toBeNull()
    expect(schema.validate({ name: 'empty' })).toBe('Credential schema validation failed')
    expect(schema.validate({ name: 'long' })).toBe('Credential schema validation failed')
  })
})

describe('Certifier', () => {
  it('uses a canonical default while exposing and accepting its legacy identifier', async () => {
    const certifier = await Certifier.create()
    const legacy = await Certifier.create({ certificateType: LEGACY_CERTIFIER_TYPE })

    expect(certifier.getInfo().certificateType).toBe(Certifier.getCanonicalCertificateType())
    expect(certifier.getCertificateTypeMigration()).toEqual({
      canonical: Certifier.getCanonicalCertificateType(),
      legacy: [Certifier.getLegacyCertificateType()]
    })
    expect(legacy.getInfo().certificateType).toBe(Certifier.getCanonicalCertificateType())
    expect(legacy.getCertificateTypeMigration()).toEqual({
      canonical: Certifier.getCanonicalCertificateType(),
      legacy: [LEGACY_CERTIFIER_TYPE]
    })
    await expect(Certifier.create({ certificateType: 'not canonical base64' })).rejects.toThrow(
      'Invalid certificate type'
    )
  })

  it('requires the wallet to affirm the exact acquired certificate', async () => {
    const certifier = await Certifier.create({ privateKey: PRIVATE_KEY })
    const acquireCertificate = jest.fn().mockResolvedValue({})
    const wallet = {
      getIdentityKey: () => SUBJECT_KEY,
      getClient: () => ({ acquireCertificate })
    }

    await expect(certifier.certify(wallet as never)).rejects.toThrow('Certification failed')
  })

  it('rejects accessor-backed additional fields without invoking them', async () => {
    const certifier = await Certifier.create({ privateKey: PRIVATE_KEY })
    const getter = jest.fn(() => 'secret')
    const additionalFields = Object.defineProperty({}, 'secret', {
      get: getter,
      enumerable: true
    })
    const wallet = {
      getIdentityKey: () => SUBJECT_KEY,
      getClient: () => ({ acquireCertificate: jest.fn() })
    }

    await expect(
      certifier.certify(wallet as never, additionalFields as Record<string, string>)
    ).rejects.toThrow('Certification failed')
    expect(getter).not.toHaveBeenCalled()
  })

  it('validates certificate list and relinquishment wallet verdicts', async () => {
    const listedCertificate = await signedCertificate()
    const client = {
      listCertificates: jest.fn().mockResolvedValue({
        totalCertificates: 1,
        certificates: [listedCertificate]
      }),
      relinquishCertificate: jest.fn().mockResolvedValue({})
    }
    const methods = createCertificationMethods({ getClient: () => client } as never)

    await expect(
      methods.listCertificatesFrom({
        certifiers: [CERTIFIER_KEY],
        types: [listedCertificate.type]
      })
    ).resolves.toMatchObject({ totalCertificates: 1 })

    Object.defineProperty(Object.prototype, 'relinquished', {
      value: true,
      configurable: true
    })
    try {
      await expect(
        methods.relinquishCert({
          type: listedCertificate.type,
          serialNumber: listedCertificate.serialNumber,
          certifier: listedCertificate.certifier
        })
      ).rejects.toThrow('Failed to relinquish certificate')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'relinquished')
    }
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

    record.beef[0] = 255

    const loaded = await store.load('serial-1')
    expect(loaded).toEqual({ ...record, beef: [1, 2, 3] })
    loaded?.beef.splice(0, loaded.beef.length)
    await expect(store.load('serial-1')).resolves.toMatchObject({ beef: [1, 2, 3] })
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
      name: 'QWxpY2U=',
      role: 'YWRtaW4='
    })
    expect(vc.credentialStatus).toBeUndefined()
    expect(vc.proof.signatureValue).toBe('signature')
    expect(vc._bsv.certificate).toEqual(certificate)
  })

  it('adds credential status when the revocation outpoint is non-zero', () => {
    const vc = toVerifiableCredential(
      {
        ...certificate,
        revocationOutpoint: 'abc.0'
      },
      CERTIFIER_KEY
    )

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

  it('ignores inherited VC options and rejects certificate accessors without invoking them', () => {
    Object.defineProperty(Object.prototype, 'credentialType', {
      value: 'AmbientCredential',
      configurable: true
    })
    try {
      expect(toVerifiableCredential(certificate, CERTIFIER_KEY, {}).type).toEqual([
        'VerifiableCredential',
        'BSVCertificate'
      ])
    } finally {
      Reflect.deleteProperty(Object.prototype, 'credentialType')
    }

    const getter = jest.fn(() => certificate.fields)
    const accessorCertificate = Object.defineProperty({ ...certificate }, 'fields', {
      get: getter,
      enumerable: true
    })
    expect(() => toVerifiableCredential(accessorCertificate, CERTIFIER_KEY)).toThrow(
      'Invalid certificate data'
    )
    expect(getter).not.toHaveBeenCalled()
  })

  it('copies presentation credentials without using inherited indices or iterators', () => {
    const vc = toVerifiableCredential(certificate, CERTIFIER_KEY)
    const iterator = jest.fn(() => [vc][Symbol.iterator]())
    const credentials = [vc]
    Object.defineProperty(credentials, Symbol.iterator, { get: iterator })

    const presentation = toVerifiablePresentation(credentials, SUBJECT_KEY)
    expect(presentation.verifiableCredential).toHaveLength(1)
    expect(iterator).not.toHaveBeenCalled()

    const sparse: VerifiableCredential[] = []
    sparse.length = 1
    Object.setPrototypeOf(sparse, Object.assign(Object.create(Array.prototype), { 0: vc }))
    expect(() => toVerifiablePresentation(sparse, SUBJECT_KEY)).toThrow('dense own-data array')
  })
})

describe('CredentialIssuer', () => {
  it('uses only dense own issuer and revocation configuration data', async () => {
    const inheritedConfig = Object.create({ privateKey: PRIVATE_KEY }) as CredentialIssuerConfig
    await expect(CredentialIssuer.create(inheritedConfig)).rejects.toThrow(
      'Invalid credential issuer configuration'
    )

    const sparseSchemas: CredentialIssuerConfig['schemas'] = []
    sparseSchemas.length = 1
    await expect(
      CredentialIssuer.create({ privateKey: PRIVATE_KEY, schemas: sparseSchemas })
    ).rejects.toThrow('dense array')

    Object.defineProperty(Object.prototype, 'wallet', {
      value: { createAction: jest.fn() },
      configurable: true
    })
    try {
      await expect(
        CredentialIssuer.create({
          privateKey: PRIVATE_KEY,
          revocation: { enabled: true }
        })
      ).rejects.toThrow('Revocation enabled but no wallet provided')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'wallet')
    }
  })

  it('requires a wallet when revocation is enabled', async () => {
    await expect(
      CredentialIssuer.create({
        privateKey: PRIVATE_KEY,
        revocation: { enabled: true }
      })
    ).rejects.toThrow('Revocation enabled but no wallet provided')
  })

  it('reports issuer metadata and schema names', async () => {
    const issuer = await CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      schemas: [
        {
          id: 'employee',
          name: 'Employee',
          fields: [{ key: 'name', label: 'Name', type: 'text' }]
        }
      ]
    })

    const info = issuer.getInfo()

    expect(info.publicKey).toBeDefined()
    expect(info.did).toBe(`did:bsv:${info.publicKey}`)
    expect(info.schemas).toEqual([
      {
        id: 'employee',
        name: 'Employee',
        certificateTypeBase64: expect.any(String)
      }
    ])
  })

  it('issues certificates only for declared schema fields and cryptographically verifies them', async () => {
    const issuer = await CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      schemas: [
        {
          id: 'employee',
          name: 'Employee',
          fields: [
            { key: 'name', label: 'Name', type: 'text', required: true },
            { key: 'email', label: 'Email', type: 'email', required: true }
          ]
        }
      ]
    })

    await expect(
      issuer.issue(SUBJECT_KEY, 'employee', {
        name: 'Alice',
        email: 'alice@example.com',
        privilege: 'admin'
      })
    ).rejects.toThrow('not declared by the schema')
    const vc = await issuer.issue(SUBJECT_KEY, 'employee', {
      name: 'Alice',
      email: 'alice@example.com'
    })
    await expect(issuer.verify(vc)).resolves.toMatchObject({
      valid: true,
      revoked: false,
      errors: []
    })
    const finalByte = vc.proof.signatureValue.slice(-2)
    vc.proof.signatureValue = `${vc.proof.signatureValue.slice(0, -2)}${finalByte === '00' ? '01' : '00'}`
    await expect(issuer.verify(vc)).resolves.toMatchObject({
      valid: false,
      errors: ['Credential structure or signature is invalid']
    })
  })

  it('verifies a genuinely signed credential issued with the pre-upgrade schema default', async () => {
    const issuer = await CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      schemas: [
        {
          id: 'employee',
          name: 'Employee',
          fields: [
            { key: 'name', label: 'Name', type: 'text' },
            { key: 'role', label: 'Role', type: 'text' }
          ]
        }
      ]
    })
    const legacyCertificate = legacyCredentialFixture.certificate as CertificateData
    const vc = toVerifiableCredential(legacyCertificate, CERTIFIER_KEY, {
      credentialType: 'Employee'
    })

    await expect(issuer.verify(vc)).resolves.toMatchObject({
      valid: true,
      revoked: false,
      errors: []
    })
  })

  it('verifies valid and malformed credentials', async () => {
    const issuer = await CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      schemas: [
        {
          id: 'employee',
          name: 'Employee',
          certificateTypeBase64: CERTIFICATE_TYPE,
          fields: []
        }
      ]
    })
    const vc = toVerifiableCredential(await signedCertificate(), CERTIFIER_KEY, {
      credentialType: 'Employee'
    })

    await expect(issuer.verify(vc)).resolves.toMatchObject({
      valid: true,
      revoked: false,
      errors: [],
      issuer: `did:bsv:${CERTIFIER_KEY}`,
      subject: `did:bsv:${SUBJECT_KEY}`
    })

    const withoutOwnCertificate: Partial<typeof vc> = { ...vc }
    delete withoutOwnCertificate._bsv
    Object.defineProperty(Object.prototype, '_bsv', {
      value: vc._bsv,
      configurable: true
    })
    try {
      await expect(issuer.verify(withoutOwnCertificate as typeof vc)).resolves.toMatchObject({
        valid: false,
        errors: ['Credential structure or signature is invalid']
      })
    } finally {
      Reflect.deleteProperty(Object.prototype, '_bsv')
    }

    await expect(
      issuer.verify({
        ...vc,
        '@context': [],
        type: [],
        proof: undefined,
        _bsv: undefined
      } as any)
    ).resolves.toMatchObject({
      valid: false,
      errors: ['Credential structure or signature is invalid']
    })

    for (const deceptiveContext of [
      `https://evil.example/${vc['@context'][0]}`,
      `${vc['@context'][0]}.evil.example`
    ]) {
      await expect(
        issuer.verify({
          ...vc,
          '@context': [deceptiveContext]
        })
      ).resolves.toMatchObject({
        valid: false,
        errors: ['Credential structure or signature is invalid']
      })
    }

    await expect(
      issuer.verify({
        ...vc,
        '@context': 'https://www.w3.org/2018/credentials/v1'
      } as any)
    ).resolves.toMatchObject({
      valid: false,
      errors: ['Credential structure or signature is invalid']
    })

    const tampered = structuredClone(vc)
    tampered._bsv.certificate.fields.name = 'QXR0YWNrZXI='
    tampered.credentialSubject.name = 'QXR0YWNrZXI='
    await expect(issuer.verify(tampered)).resolves.toMatchObject({
      valid: false,
      errors: ['Credential structure or signature is invalid']
    })

    const reorderedSubject: typeof vc.credentialSubject = { id: vc.credentialSubject.id }
    for (const key of Object.keys(vc.credentialSubject).reverse()) {
      reorderedSubject[key] = vc.credentialSubject[key]
    }
    const originalSort = Array.prototype.sort
    Array.prototype.sort = function (compareFn?: (left: string, right: string) => number) {
      if (typeof compareFn !== 'function') {
        throw new Error('Array.prototype.sort was called without a comparator')
      }
      return originalSort.call(this, compareFn)
    }
    try {
      await expect(
        issuer.verify({ ...vc, credentialSubject: reorderedSubject })
      ).resolves.toMatchObject({
        valid: true,
        errors: []
      })
    } finally {
      Array.prototype.sort = originalSort
    }
  })

  it('detects revoked credentials when revocation records are missing', async () => {
    const issuer = await CredentialIssuer.create({
      privateKey: PRIVATE_KEY,
      schemas: [
        {
          id: 'employee',
          name: 'Employee',
          certificateTypeBase64: CERTIFICATE_TYPE,
          fields: []
        }
      ]
    })
    const vc = toVerifiableCredential(
      await signedCertificate(`${'11'.repeat(32)}.0`),
      CERTIFIER_KEY,
      { credentialType: 'Employee' }
    )

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

  it('ignores inherited revocation transaction evidence and retains secrets after a malformed spend result', async () => {
    const store = new MemoryRevocationStore()
    const wallet = {
      createAction: jest
        .fn()
        .mockResolvedValueOnce({ txid: '11'.repeat(32) })
        .mockResolvedValueOnce({})
    }
    Object.defineProperties(Object.prototype, {
      tx: { value: [9, 9, 9], configurable: true },
      txid: { value: '22'.repeat(32), configurable: true }
    })
    try {
      const issuer = await CredentialIssuer.create({
        privateKey: PRIVATE_KEY,
        schemas: [{ id: 'employee', name: 'Employee', fields: [] }],
        revocation: { enabled: true, wallet, store }
      })
      const credential = await issuer.issue(SUBJECT_KEY, 'employee', {})
      const serial = credential._bsv.certificate.serialNumber
      await expect(store.load(serial)).resolves.toMatchObject({ beef: [] })

      await expect(issuer.revoke(serial)).rejects.toThrow(
        'Revocation transaction failed: no txid returned'
      )
      await expect(store.has(serial)).resolves.toBe(true)
    } finally {
      Reflect.deleteProperty(Object.prototype, 'tx')
      Reflect.deleteProperty(Object.prototype, 'txid')
    }
  })
})

describe('createCredentialMethods', () => {
  let originalFetch: typeof global.fetch
  let fetchMock: jest.Mock
  let client: any
  let core: any
  let remoteCertificate: CertificateData

  beforeAll(async () => {
    remoteCertificate = await signedCertificate()
  })

  beforeEach(() => {
    originalFetch = global.fetch
    fetchMock = jest.fn()
    global.fetch = fetchMock as unknown as typeof fetch
    client = {
      listCertificates: jest.fn().mockResolvedValue({
        certificates: [
          {
            type: remoteCertificate.type,
            serialNumber: OLD_CERTIFICATE_SERIAL,
            certifier: CERTIFIER_KEY
          }
        ]
      }),
      relinquishCertificate: jest.fn().mockResolvedValue({ relinquished: true }),
      acquireCertificate: jest.fn().mockImplementation(async () => ({
        type: remoteCertificate.type,
        serialNumber: remoteCertificate.serialNumber,
        subject: remoteCertificate.subject,
        certifier: remoteCertificate.certifier,
        revocationOutpoint: remoteCertificate.revocationOutpoint,
        fields: remoteCertificate.fields,
        signature: remoteCertificate.signature
      }))
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
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            certifierPublicKey: CERTIFIER_KEY,
            certificateType: remoteCertificate.type
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(remoteCertificate)))

    const methods = createCredentialMethods(core)
    const vc = await methods.acquireCredential({
      serverUrl: 'https://issuer.example',
      schemaId: 'employee',
      fields: { name: 'Alice' },
      fetch: fetchMock as typeof fetch
    })

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://issuer.example/?action=info',
      expect.objectContaining({ redirect: 'error' })
    )
    expect(client.listCertificates).toHaveBeenCalledWith({
      certifiers: [CERTIFIER_KEY],
      types: [remoteCertificate.type],
      limit: 100
    })
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://issuer.example/?action=certify',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identityKey: SUBJECT_KEY,
          schemaId: 'employee',
          fields: { name: 'Alice' }
        })
      })
    )
    expect(client.acquireCertificate).toHaveBeenCalledWith(
      expect.objectContaining({
        type: remoteCertificate.type,
        certifier: remoteCertificate.certifier,
        acquisitionProtocol: 'direct'
      })
    )
    expect(client.relinquishCertificate).toHaveBeenCalledWith({
      type: remoteCertificate.type,
      serialNumber: OLD_CERTIFICATE_SERIAL,
      certifier: CERTIFIER_KEY
    })
    expect(vc.issuer).toBe(`did:bsv:${CERTIFIER_KEY}`)
  })

  it('accepts acquired certificate fields when only their key insertion order differs', async () => {
    const reversedFields: Record<string, string> = {}
    for (const key of Object.keys(remoteCertificate.fields).reverse()) {
      reversedFields[key] = remoteCertificate.fields[key]
    }
    client.acquireCertificate.mockImplementation(async () => ({
      type: remoteCertificate.type,
      serialNumber: remoteCertificate.serialNumber,
      subject: remoteCertificate.subject,
      certifier: remoteCertificate.certifier,
      revocationOutpoint: remoteCertificate.revocationOutpoint,
      fields: reversedFields,
      signature: remoteCertificate.signature
    }))
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            certifierPublicKey: CERTIFIER_KEY,
            certificateType: remoteCertificate.type
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(remoteCertificate)))
    const originalSort = Array.prototype.sort
    Array.prototype.sort = function (compareFn?: (left: string, right: string) => number) {
      if (typeof compareFn !== 'function') {
        throw new Error('Array.prototype.sort was called without a comparator')
      }
      return originalSort.call(this, compareFn)
    }
    try {
      const methods = createCredentialMethods(core)
      await expect(
        methods.acquireCredential({
          serverUrl: 'https://issuer.example',
          schemaId: 'employee',
          fields: { name: 'Alice' },
          fetch: fetchMock as typeof fetch
        })
      ).resolves.toMatchObject({ issuer: `did:bsv:${CERTIFIER_KEY}` })
    } finally {
      Array.prototype.sort = originalSort
    }
  })

  it('does not revoke existing credentials when replaceExisting is false', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            certifierPublicKey: CERTIFIER_KEY,
            certificateType: remoteCertificate.type
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(remoteCertificate)))

    const methods = createCredentialMethods(core)
    await methods.acquireCredential({
      serverUrl: 'https://issuer.example',
      replaceExisting: false,
      fetch: fetchMock as typeof fetch
    })

    expect(client.listCertificates).not.toHaveBeenCalled()
    expect(client.relinquishCertificate).not.toHaveBeenCalled()
  })

  it('wraps acquisition failures in CredentialError messages', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 503 }))

    const methods = createCredentialMethods(core)

    await expect(
      methods.acquireCredential({
        serverUrl: 'https://issuer.example',
        fetch: fetchMock as typeof fetch
      })
    ).rejects.toThrow('Credential acquisition failed: Certificate service returned HTTP 503')
  })

  it('surfaces issuer errors from rejected certification requests', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            certifierPublicKey: CERTIFIER_KEY,
            certificateType: remoteCertificate.type
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Certification denied' }), { status: 403 })
      )

    const methods = createCredentialMethods(core)

    await expect(
      methods.acquireCredential({
        serverUrl: 'https://issuer.example',
        replaceExisting: false,
        fetch: fetchMock as typeof fetch
      })
    ).rejects.toThrow('Credential acquisition failed: Certification denied')
  })

  it('rejects a certificate that is not bound to the advertised subject before changing wallet state', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            certifierPublicKey: CERTIFIER_KEY,
            certificateType: remoteCertificate.type
          })
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ...remoteCertificate, subject: CERTIFIER_KEY }))
      )

    const methods = createCredentialMethods(core)
    await expect(
      methods.acquireCredential({
        serverUrl: 'https://issuer.example',
        fetch: fetchMock as typeof fetch
      })
    ).rejects.toThrow('does not match the requested issuer, subject, and type')
    expect(client.acquireCertificate).not.toHaveBeenCalled()
    expect(client.relinquishCertificate).not.toHaveBeenCalled()
  })

  it('retains existing credentials when the replacement cannot be authenticated or acquired', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            certifierPublicKey: CERTIFIER_KEY,
            certificateType: remoteCertificate.type
          })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(remoteCertificate)))
    client.acquireCertificate.mockResolvedValueOnce({ acquired: 'true' })

    const methods = createCredentialMethods(core)
    await expect(
      methods.acquireCredential({
        serverUrl: 'https://issuer.example',
        fetch: fetchMock as typeof fetch
      })
    ).rejects.toThrow('did not affirmatively acquire')
    expect(client.relinquishCertificate).not.toHaveBeenCalled()
  })

  it('rejects insecure service URLs and oversized responses before parsing them', async () => {
    const methods = createCredentialMethods(core)
    await expect(
      methods.acquireCredential({
        serverUrl: 'http://issuer.example',
        fetch: fetchMock as typeof fetch
      })
    ).rejects.toThrow('credential-free HTTPS')
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockResolvedValueOnce(
      new Response('{}', { headers: { 'content-length': String(513 * 1024) } })
    )
    await expect(
      methods.acquireCredential({
        serverUrl: 'https://issuer.example',
        fetch: fetchMock as typeof fetch
      })
    ).rejects.toThrow('response exceeds the configured limit')
  })

  it('does not inherit an ambient trusted transport override', async () => {
    const ambientFetch = jest.fn(async () => new Response('{}'))
    Object.defineProperty(Object.prototype, 'fetch', {
      value: ambientFetch,
      configurable: true
    })
    try {
      const methods = createCredentialMethods(core)
      await expect(methods.acquireCredential({ serverUrl: 'https://127.0.0.1' })).rejects.toThrow()
      expect(ambientFetch).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'fetch')
    }
  })

  it('lists wallet certificates as verifiable credentials', async () => {
    client.listCertificates.mockResolvedValueOnce({
      totalCertificates: 1,
      certificates: [remoteCertificate]
    })

    const methods = createCredentialMethods(core)
    const credentials = await methods.listCredentials({
      certifiers: [CERTIFIER_KEY],
      types: [remoteCertificate.type]
    })

    expect(client.listCertificates).toHaveBeenCalledWith({
      certifiers: [CERTIFIER_KEY],
      types: [remoteCertificate.type],
      limit: 100
    })
    expect(credentials).toHaveLength(1)
    expect(credentials[0].issuer).toBe(`did:bsv:${CERTIFIER_KEY}`)
  })

  it('fails closed for malformed, inherited, sparse, or out-of-scope certificate lists', async () => {
    const methods = createCredentialMethods(core)
    client.listCertificates.mockResolvedValueOnce({ totalCertificates: 0, certificates: [] })
    await expect(
      methods.listCredentials({ certifiers: [CERTIFIER_KEY], types: [remoteCertificate.type] })
    ).resolves.toEqual([])

    Object.defineProperty(Object.prototype, 'certificates', {
      value: [remoteCertificate],
      configurable: true
    })
    try {
      client.listCertificates.mockResolvedValueOnce({ totalCertificates: 1 })
      await expect(
        methods.listCredentials({ certifiers: [CERTIFIER_KEY], types: [remoteCertificate.type] })
      ).rejects.toThrow('Failed to list credentials')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'certificates')
    }

    const sparse: CertificateData[] = []
    sparse.length = 1
    client.listCertificates.mockResolvedValueOnce({ totalCertificates: 1, certificates: sparse })
    await expect(
      methods.listCredentials({ certifiers: [CERTIFIER_KEY], types: [remoteCertificate.type] })
    ).rejects.toThrow('Failed to list credentials')

    client.listCertificates.mockResolvedValueOnce({
      totalCertificates: 1,
      certificates: [{ ...remoteCertificate, certifier: SUBJECT_KEY }]
    })
    await expect(
      methods.listCredentials({ certifiers: [CERTIFIER_KEY], types: [remoteCertificate.type] })
    ).rejects.toThrow('Failed to list credentials')
  })

  it('wraps list credential failures', async () => {
    client.listCertificates.mockRejectedValueOnce(new Error('wallet offline'))

    const methods = createCredentialMethods(core)

    await expect(
      methods.listCredentials({
        certifiers: [CERTIFIER_KEY],
        types: [remoteCertificate.type]
      })
    ).rejects.toThrow('Failed to list credentials: wallet offline')
  })

  it('creates presentations for the wallet identity key', () => {
    const vc = toVerifiableCredential(certificate, CERTIFIER_KEY)
    const methods = createCredentialMethods(core)

    expect(methods.createPresentation([vc]).holder).toBe(`did:bsv:${SUBJECT_KEY}`)
  })
})
