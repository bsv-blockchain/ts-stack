import { CredentialIssuer } from '../../modules/credentials'
import { createCredentialIssuerHandler } from '../credential-issuer-handler'

const SUBJECT_KEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const SERIAL_NUMBER = 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU='
const CERTIFICATE_TYPE = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='

interface TestCase {
  name: string
  url: string
  body: Record<string, unknown>
  expectedBody: Record<string, unknown>
}

const cases: TestCase[] = [
  {
    name: 'preserves legacy certify routing precedence',
    url: 'https://issuer.example/api/certify?action=unknown',
    body: {},
    expectedBody: { error: 'Missing identityKey or fields' }
  },
  {
    name: 'preserves query-parameter certify validation',
    url: 'https://issuer.example/api/credential-issuer?action=certify',
    body: {},
    expectedBody: { error: 'Missing identityKey or fields' }
  },
  {
    name: 'preserves issue validation',
    url: 'https://issuer.example/api/credential-issuer?action=issue',
    body: {},
    expectedBody: { success: false, error: 'Missing subjectKey or fields' }
  },
  {
    name: 'preserves verify validation',
    url: 'https://issuer.example/api/credential-issuer?action=verify',
    body: {},
    expectedBody: { success: false, error: 'Missing credential' }
  },
  {
    name: 'preserves revoke validation',
    url: 'https://issuer.example/api/credential-issuer?action=revoke',
    body: {},
    expectedBody: { success: false, error: 'Missing serialNumber' }
  },
  {
    name: 'preserves unknown-action reporting',
    url: 'https://issuer.example/api/credential-issuer?action=unknown',
    body: {},
    expectedBody: { success: false, error: 'Unknown credential issuer action' }
  }
]

const testIssuer = {
  getInfo: jest.fn(() => ({
    publicKey: SUBJECT_KEY,
    did: 'did:key:mock',
    schemas: [{ id: 'test-schema', name: 'Test Schema', certificateTypeBase64: CERTIFICATE_TYPE }]
  })),
  getRevocationRecordStatus: jest.fn(async () => 'unknown'),
  issueCertificate: jest.fn(
    async (subject: string, schemaId: string, fields: Record<string, string>) => ({
      subject,
      schemaId,
      fields
    })
  ),
  issue: jest.fn(async (subject: string, schemaId: string, fields: Record<string, string>) => ({
    credential: { subject, schemaId, fields },
    keyringForSubject: {}
  })),
  verify: jest.fn(async (input: string) => ({ verified: true, credential: JSON.parse(input) })),
  revoke: jest.fn(async (serialNumber: string) => ({ txid: `revoke-${serialNumber}` }))
}

describe('createCredentialIssuerHandler POST routing', () => {
  const envVar = 'SIMPLE_CREDENTIAL_ISSUER_HANDLER_TEST_KEY'
  const privateKey = '1'.repeat(64)
  const handler = createCredentialIssuerHandler({
    envVar,
    schemas: [{ id: 'test-schema', name: 'Test Schema', fields: [] }],
    authorize: async () => true
  })

  beforeAll(() => {
    process.env[envVar] = privateKey
    jest
      .spyOn(CredentialIssuer, 'create')
      .mockResolvedValue(testIssuer as unknown as CredentialIssuer)
  })

  afterAll(() => {
    delete process.env[envVar]
    jest.restoreAllMocks()
  })

  test.each(cases)('$name', async ({ url, body, expectedBody }) => {
    const response = await handler.POST?.({
      url,
      json: async () => body
    })

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual(expectedBody)
  })

  test.each([
    {
      name: 'legacy certify',
      url: 'https://issuer.example/api/certify?action=unknown',
      body: { identityKey: SUBJECT_KEY, fields: { name: 'Legacy' } },
      expectedBody: {
        subject: SUBJECT_KEY,
        schemaId: 'test-schema',
        fields: { name: 'Legacy' }
      }
    },
    {
      name: 'query-parameter certify',
      url: 'https://issuer.example/api/credential-issuer?action=certify',
      body: { identityKey: SUBJECT_KEY, schemaId: 'custom-schema', fields: { name: 'Query' } },
      expectedBody: {
        subject: SUBJECT_KEY,
        schemaId: 'custom-schema',
        fields: { name: 'Query' }
      }
    },
    {
      name: 'issue',
      url: 'https://issuer.example/api/credential-issuer?action=issue',
      body: { subjectKey: SUBJECT_KEY, fields: { name: 'Issue' } },
      expectedBody: {
        success: true,
        credential: { subject: SUBJECT_KEY, schemaId: 'test-schema', fields: { name: 'Issue' } },
        keyringForSubject: {}
      }
    },
    {
      name: 'verify',
      url: 'https://issuer.example/api/credential-issuer?action=verify',
      body: { credential: '{"id":"credential-1"}' },
      expectedBody: {
        success: true,
        verification: { verified: true, credential: { id: 'credential-1' } }
      }
    },
    {
      name: 'revoke',
      url: 'https://issuer.example/api/credential-issuer?action=revoke',
      body: { serialNumber: SERIAL_NUMBER },
      expectedBody: { success: true, txid: `revoke-${SERIAL_NUMBER}` }
    }
  ])('dispatches successful $name requests', async ({ url, body, expectedBody }) => {
    const response = await handler.POST?.({
      url,
      json: async () => body
    })

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expectedBody)
  })

  it('preserves failure responses when request JSON cannot be read', async () => {
    const response = await handler.POST?.({
      url: 'https://issuer.example/api/credential-issuer?action=issue',
      json: async () => {
        throw new Error('invalid JSON')
      }
    })

    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Credential issuer operation failed'
    })
  })

  it('keeps certificate requests above the envelope JSON limit supported', async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`field${index}`, 'x'.repeat(60_000)])
    )
    const response = await handler.POST?.(
      new Request('https://issuer.example/api/credential-issuer?action=certify', {
        method: 'POST',
        body: JSON.stringify({ identityKey: SUBJECT_KEY, fields })
      })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      subject: SUBJECT_KEY,
      schemaId: 'test-schema',
      fields
    })
  })

  it('publishes the canonical configured certificate type', async () => {
    const response = await handler.GET?.({
      url: 'https://issuer.example/api/credential-issuer?action=info'
    })

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      certifierPublicKey: SUBJECT_KEY,
      certificateType: CERTIFICATE_TYPE,
      schemas: [{ certificateTypeBase64: CERTIFICATE_TYPE }]
    })
  })

  it('does not disclose issuer implementation errors', async () => {
    testIssuer.issue.mockRejectedValueOnce(
      new Error('sqlite /private/issuer.db failed: select secret from credentials')
    )
    const response = await handler.POST?.({
      url: 'https://issuer.example/api/credential-issuer?action=issue',
      json: async () => ({ subjectKey: SUBJECT_KEY, fields: {} })
    })

    expect(response.status).toBe(500)
    const body = await response.text()
    expect(body).toContain('Credential issuer operation failed')
    expect(body).not.toContain('/private/issuer.db')
    expect(body).not.toContain('select secret')
  })

  it('denies state changes when no authorization policy is configured', async () => {
    const denied = createCredentialIssuerHandler({
      envVar,
      schemas: [{ id: 'test-schema', name: 'Test Schema', fields: [] }]
    })
    const response = await denied.POST?.({
      url: 'https://issuer.example/api/credential-issuer?action=issue',
      json: async () => ({ subjectKey: SUBJECT_KEY, fields: {} })
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Credential issuance is not authorized'
    })
  })

  it('requires an exact boolean authorization verdict', async () => {
    const denied = createCredentialIssuerHandler({
      envVar,
      schemas: [{ id: 'test-schema', name: 'Test Schema', fields: [] }],
      authorize: async () => 'true' as unknown as boolean
    })
    const response = await denied.POST?.({
      url: 'https://issuer.example/api/credential-issuer?action=revoke',
      json: async () => ({ serialNumber: SERIAL_NUMBER })
    })

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Credential revocation is not authorized'
    })
  })
})
