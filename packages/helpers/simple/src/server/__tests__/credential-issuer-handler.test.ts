import { CredentialIssuer } from '../../modules/credentials'
import { createCredentialIssuerHandler } from '../credential-issuer-handler'

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
    expectedBody: { success: false, error: 'Unknown action: unknown' }
  }
]

const testIssuer = {
  issue: jest.fn(async (subject: string, schemaId: string, fields: Record<string, string>) => ({
    _bsv: {
      certificate: {
        subject,
        schemaId,
        fields
      }
    }
  })),
  verify: jest.fn(async (credential: unknown) => ({ valid: true, credential })),
  revoke: jest.fn(async (serialNumber: string) => ({ txid: `revoke-${serialNumber}` }))
}

describe('createCredentialIssuerHandler POST routing', () => {
  const envVar = 'SIMPLE_CREDENTIAL_ISSUER_HANDLER_TEST_KEY'
  const privateKey = '1'.repeat(64)
  const handler = createCredentialIssuerHandler({
    envVar,
    schemas: [{ id: 'test-schema', name: 'Test Schema', fields: [] }]
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
      body: { identityKey: 'legacy-subject', fields: { name: 'Legacy' } },
      expectedBody: {
        subject: 'legacy-subject',
        schemaId: 'test-schema',
        fields: { name: 'Legacy' }
      }
    },
    {
      name: 'query-parameter certify',
      url: 'https://issuer.example/api/credential-issuer?action=certify',
      body: { identityKey: 'query-subject', schemaId: 'custom-schema', fields: { name: 'Query' } },
      expectedBody: {
        subject: 'query-subject',
        schemaId: 'custom-schema',
        fields: { name: 'Query' }
      }
    },
    {
      name: 'issue',
      url: 'https://issuer.example/api/credential-issuer?action=issue',
      body: { subjectKey: 'issue-subject', fields: { name: 'Issue' } },
      expectedBody: {
        success: true,
        credential: {
          _bsv: {
            certificate: {
              subject: 'issue-subject',
              schemaId: 'test-schema',
              fields: { name: 'Issue' }
            }
          }
        }
      }
    },
    {
      name: 'verify',
      url: 'https://issuer.example/api/credential-issuer?action=verify',
      body: { credential: { id: 'credential-1' } },
      expectedBody: {
        success: true,
        verification: { valid: true, credential: { id: 'credential-1' } }
      }
    },
    {
      name: 'revoke',
      url: 'https://issuer.example/api/credential-issuer?action=revoke',
      body: { serialNumber: 'serial-1' },
      expectedBody: { success: true, txid: 'revoke-serial-1' }
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
      error: 'Failed: invalid JSON'
    })
  })
})
