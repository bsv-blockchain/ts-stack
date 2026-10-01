import envelope from '../../modules/__tests__/fixtures/brc203-envelope.json'
import { CredentialIssuer } from '../../modules/credentials'
import { createCredentialIssuerHandler } from '../credential-issuer-handler'

// Public fixed test scalar and pre-existing synthetic envelope. No issuance,
// persistence, provider calls, wallet actions, or production credentials.
const ENV_VAR = 'SIMPLE_OFFLINE_VERIFIER_TRANSPORT_KEY'
const envelopeJson = JSON.stringify(envelope)
const url = 'https://issuer.example/api/credential-issuer?action=verify'

describe('credential HTTP verifier preserves strict envelope transport', () => {
  beforeEach(() => {
    process.env[ENV_VAR] = '0'.repeat(63) + '1'
  })

  afterEach(() => {
    delete process.env[ENV_VAR]
    jest.restoreAllMocks()
  })

  function handler() {
    return createCredentialIssuerHandler({
      envVar: ENV_VAR,
      schemas: [{ id: 'offline-test', name: 'Offline test', fields: [] }]
    })
  }

  async function verifyText(credential: string) {
    return await handler().POST!(
      new Request(url, { method: 'POST', body: JSON.stringify({ credential }) })
    )
  }

  it('verifies the original fixture through the real issuer verifier', async () => {
    const response = await verifyText(envelopeJson)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      verification: { verified: true, verifiedDocument: envelope.credential }
    })
  })

  it('rejects envelope objects before issuer initialization', async () => {
    const create = jest.spyOn(CredentialIssuer, 'create')
    const response = await handler().POST!(
      new Request(url, { method: 'POST', body: JSON.stringify({ credential: envelope }) })
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      success: false,
      error: 'Credential must be original JSON text'
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects duplicate envelope members instead of collapsing them', async () => {
    const duplicate = '{"certificateBinary":"invalid",' + envelopeJson.slice(1)
    const response = await verifyText(duplicate)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      success: true,
      verification: { verified: false }
    })
  })

  it('rejects unsigned wrapper claims through the real verifier', async () => {
    const response = await verifyText(JSON.stringify({ ...envelope, trusted: true }))
    expect(await response.json()).toMatchObject({ verification: { verified: false } })
  })

  it('rejects duplicate HTTP credential members before issuer initialization', async () => {
    const create = jest.spyOn(CredentialIssuer, 'create')
    const body = '{"credential":"invalid","credential":' + JSON.stringify(envelopeJson) + '}'
    const response = await handler().POST!(new Request(url, { method: 'POST', body }))
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({
      success: false,
      error: 'Credential issuer operation failed'
    })
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects invalid HTTP UTF-8 instead of replacing bytes', async () => {
    const create = jest.spyOn(CredentialIssuer, 'create')
    const prefix = new TextEncoder().encode('{"unused":"')
    const suffix = new TextEncoder().encode('","credential":' + JSON.stringify(envelopeJson) + '}')
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length)
    bytes.set(prefix)
    bytes[prefix.length] = 0xff
    bytes.set(suffix, prefix.length + 1)
    const response = await handler().POST!(new Request(url, { method: 'POST', body: bytes }))
    expect(response.status).toBe(500)
    expect(create).not.toHaveBeenCalled()
  })

  it.each([262_144, 262_145])('enforces the explicit outer JSON budget at %i bytes', async size => {
    const create = jest.spyOn(CredentialIssuer, 'create')
    const initial = JSON.stringify({ credential: envelopeJson, padding: '' })
    const padding = 'x'.repeat(size - new TextEncoder().encode(initial).length)
    const body = JSON.stringify({ credential: envelopeJson, padding })
    expect(new TextEncoder().encode(body)).toHaveLength(size)
    const response = await handler().POST!(new Request(url, { method: 'POST', body }))
    if (size === 262_144) {
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ verification: { verified: true } })
    } else {
      expect(response.status).toBe(500)
      expect(create).not.toHaveBeenCalled()
    }
  })
})
