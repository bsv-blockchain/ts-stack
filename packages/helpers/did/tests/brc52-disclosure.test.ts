import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import PrivateKey from '@bsv/sdk/primitives/PrivateKey'
import SymmetricKey from '@bsv/sdk/primitives/SymmetricKey'
import { toArray, toBase64 } from '@bsv/sdk/primitives/utils'
import ProtoWallet from '@bsv/sdk/wallet/ProtoWallet'
import {
  BRC52MemoryNonceStore,
  produceBRC52Disclosure,
  receiveBRC52Disclosure,
  type BRC52AuthenticationPort,
  type BRC52AuthenticatedRequest,
  type BRC52NonceStore,
  type ProduceBRC52DisclosureOptions,
  type ReceiveBRC52DisclosureOptions
} from '../src/brc52/disclosure.js'
import type { BRC52StatusResult } from '../src/brc52/status.js'
import type { BRC52CertificateCore, BRC52Envelope } from '../src/brc52/types.js'

// Frozen proposed BRC-189/BRC-203 synthetic vector; no credential issuance/signing.
const fixture = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/fixtures/brc203-envelope.json'), 'utf8')
) as BRC52Envelope
const subject = new PrivateKey(2).toPublicKey().toString()
const verifier = new PrivateKey(4).toPublicKey().toString()
const privateNameKeyring =
  'cXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXFxcXGMm+yffJMsUvp6/+TM6ou3MI05v+fhM3j3Lj2ODJrpVNEtawBoIT+ZrArRr1xQjwE='
const purpose = 'display the name with user permission'
const operation = 'POST /certificate/name'
const now = 100_000

function status(): BRC52StatusResult {
  return {
    status: 'unknown',
    outpoint: fixture.credential.revocationOutpoint,
    network: 'synthetic-offline',
    privacy: {
      mode: 'local-chain-view',
      retrievalAttempted: false,
      protection: 'Offline fixture; no query',
      thirdPartyCorrelation: 'none'
    }
  }
}

function disclosedEnvelope(
  keyring: Record<string, string> = { name: privateNameKeyring }
): BRC52Envelope {
  return { ...structuredClone(fixture), disclosure: { subject, verifier, keyring } }
}

function walletCertificate(): BRC52CertificateCore {
  return {
    type: fixture.credential.certificateType,
    serialNumber: fixture.credential.serialNumber,
    subject,
    certifier: '02f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
    revocationOutpoint: fixture.credential.revocationOutpoint,
    fields: { ...fixture.credential.credentialSubject.encryptedFields },
    signature:
      '3045022100d31674450017aa3eb449ea890a97694f2141ba34aa037c8d77c4d3e1ff9a348b02201633ad9389b69856b6c46d5d704a7471a7c91286d11db9a094766aee74edbcbf'
  }
}

function holderOptions(
  overrides: Partial<ProduceBRC52DisclosureOptions> = {}
): ProduceBRC52DisclosureOptions {
  return {
    certificateBinary: toArray(fixture.certificateBinary, 'base64'),
    verifier,
    purpose,
    fieldsToReveal: ['name'],
    authorize: jest.fn(async () => true),
    wallet: {
      getPublicKey: jest.fn(async () => ({ publicKey: subject })),
      proveCertificate: jest.fn(async () => ({ keyringForVerifier: { name: privateNameKeyring } }))
    },
    ...overrides
  }
}

function receiverOptions(
  overrides: Partial<ReceiveBRC52DisclosureOptions> = {}
): ReceiveBRC52DisclosureOptions {
  const wallet = new ProtoWallet(new PrivateKey(4))
  return {
    inputData: JSON.stringify(disclosedEnvelope()),
    wallet: {
      getPublicKey: jest.fn(wallet.getPublicKey.bind(wallet)),
      decrypt: jest.fn(wallet.decrypt.bind(wallet))
    },
    receivingVerifier: verifier,
    operation,
    purpose,
    now: () => now,
    maxRequestAgeMs: 5_000,
    nonceStore: new BRC52MemoryNonceStore(),
    // Explicitly mocked integration boundary, not evidence of BRC-103 interoperability.
    authentication: {
      authenticate: jest.fn<BRC52AuthenticationPort['authenticate']>(async request => ({
        ...request,
        peer: subject,
        nonce: 'synthetic-unique-request',
        authenticatedAt: now - 1_000,
        sessionId: 'synthetic-session'
      }))
    },
    // This display policy explicitly accepts unknown synthetic status; no current-status reliance.
    assessReliance: jest.fn(async () => ({ authorized: true, status: status() })),
    ...overrides
  }
}

describe('BRC-203 holder disclosure producer', () => {
  test('requires exact permission before wallet calls and preserves source/signature/ciphertexts', async () => {
    const options = holderOptions()
    const events: string[] = []
    options.authorize = jest.fn(async request => {
      events.push('authorization')
      expect(request).toEqual({
        certificateBinary: fixture.certificateBinary,
        subject,
        verifier,
        purpose,
        fieldsToReveal: ['name']
      })
      return true
    })
    options.wallet.getPublicKey = jest.fn(async args => {
      events.push('wallet identity')
      expect(args).toEqual({ identityKey: true })
      return { publicKey: subject }
    })
    const result = await produceBRC52Disclosure(options)
    expect(events).toEqual(['authorization', 'wallet identity'])
    expect(result.certificateBinary).toBe(fixture.certificateBinary)
    expect(result.credential).toEqual(fixture.credential)
    expect(result.disclosure).toEqual({ subject, verifier, keyring: { name: privateNameKeyring } })
    expect(options.wallet.proveCertificate).toHaveBeenCalledWith({
      certificate: expect.objectContaining({
        subject,
        serialNumber: fixture.credential.serialNumber,
        fields: fixture.credential.credentialSubject.encryptedFields
      }),
      fieldsToReveal: ['name'],
      verifier
    })
  })

  test('denial invokes no wallet operation', async () => {
    const options = holderOptions({ authorize: async () => false })
    await expect(produceBRC52Disclosure(options)).rejects.toThrow('authorization denied')
    expect(options.wallet.getPublicKey).not.toHaveBeenCalled()
    expect(options.wallet.proveCertificate).not.toHaveBeenCalled()
  })

  test.each([['name', 'name'], ['unknown']])(
    'rejects invalid selection %j before permission',
    async (...fields: string[]) => {
      const options = holderOptions({ fieldsToReveal: fields })
      await expect(produceBRC52Disclosure(options)).rejects.toThrow()
      expect(options.authorize).not.toHaveBeenCalled()
    }
  )

  test('rejects wrong wallet subject and unexpected wallet-selected fields', async () => {
    const wrongSubject = holderOptions()
    wrongSubject.wallet.getPublicKey = async () => ({ publicKey: verifier })
    await expect(produceBRC52Disclosure(wrongSubject)).rejects.toThrow('subject')
    expect(wrongSubject.wallet.proveCertificate).not.toHaveBeenCalled()
    const wrongSelection = holderOptions()
    wrongSelection.wallet.proveCertificate = async () => ({ keyringForVerifier: {} })
    await expect(produceBRC52Disclosure(wrongSelection)).rejects.toThrow('selection')
  })

  test('rejects wallet certificate substitution, wrong recipient and master-keyring response', async () => {
    const wrongCert = holderOptions()
    wrongCert.wallet.proveCertificate = async () => ({
      keyringForVerifier: { name: privateNameKeyring },
      certificate: {
        type: 'changed',
        serialNumber: fixture.credential.serialNumber,
        subject,
        certifier: new PrivateKey(3).toPublicKey().toString(),
        revocationOutpoint: fixture.credential.revocationOutpoint,
        fields: fixture.credential.credentialSubject.encryptedFields,
        signature: '00'
      }
    })
    await expect(produceBRC52Disclosure(wrongCert)).rejects.toThrow('different certificate')
    const wrongRecipient = holderOptions()
    wrongRecipient.wallet.proveCertificate = async () => ({
      keyringForVerifier: { name: privateNameKeyring },
      verifier: subject
    })
    await expect(produceBRC52Disclosure(wrongRecipient)).rejects.toThrow('different verifier')
    const master = holderOptions()
    master.wallet.proveCertificate = async () => ({
      keyringForVerifier: { masterKeyring: privateNameKeyring }
    })
    await expect(produceBRC52Disclosure(master)).rejects.toThrow('unknown property')
  })

  test('accepts the exact wallet-returned certificate despite JSON member ordering', async () => {
    const core = walletCertificate()
    const certificate = { ...core, fields: { name: core.fields.name, email: core.fields.email } }
    const options = holderOptions()
    options.wallet.proveCertificate = async () => ({
      certificate,
      verifier,
      keyringForVerifier: { name: privateNameKeyring }
    })
    expect((await produceBRC52Disclosure(options)).credential).toEqual(fixture.credential)
  })

  test.each([
    'field-value',
    'missing-field',
    'missing-member',
    'null-field',
    'wrong-primitive',
    'wrong-field-type'
  ])('rejects wallet-returned certificate %s as substitution', async mode => {
    const certificate = walletCertificate() as unknown as Record<string, unknown>
    if (mode === 'field-value')
      certificate.fields = { ...walletCertificate().fields, name: 'Different' }
    if (mode === 'missing-field') certificate.fields = { email: walletCertificate().fields.email }
    if (mode === 'missing-member') delete certificate.signature
    if (mode === 'null-field') certificate.fields = { ...walletCertificate().fields, name: null }
    if (mode === 'wrong-primitive') certificate.type = 17
    if (mode === 'wrong-field-type') certificate.fields = walletCertificate().fields.name
    const options = holderOptions()
    options.wallet.proveCertificate = async () => ({
      certificate: certificate as unknown as BRC52CertificateCore,
      keyringForVerifier: { name: privateNameKeyring }
    })
    await expect(produceBRC52Disclosure(options)).rejects.toThrow(
      'Wallet returned a different certificate'
    )
  })

  test('rejects a same-count wallet keyring for the wrong authorized subset', async () => {
    const options = holderOptions()
    options.wallet.proveCertificate = async () => ({
      keyringForVerifier: { email: privateNameKeyring }
    })
    await expect(produceBRC52Disclosure(options)).rejects.toThrow(
      'Wallet keyring does not match authorized field selection'
    )
  })

  test('supports selecting every existing field without expanding its permission selection', async () => {
    const options = holderOptions({ fieldsToReveal: ['name', 'email'] })
    options.wallet.proveCertificate = async () => ({
      keyringForVerifier: { email: privateNameKeyring, name: privateNameKeyring }
    })
    const result = await produceBRC52Disclosure(options)
    expect(Object.keys(result.disclosure!.keyring).sort()).toEqual(['email', 'name'])
    expect(options.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ fieldsToReveal: ['name', 'email'] })
    )
  })

  test.each([
    ['non-array', { 0: 'name', length: 1 }, 'Invalid field selection'],
    ['too-many', ['name', 'email', 'unknown'], 'Invalid field selection'],
    ['non-string', [7], 'Field selection contains duplicate or unknown names'],
    [
      'sparse',
      Object.defineProperty([], 'length', { value: 1 }),
      'field selection[0] must be an enumerable own data property'
    ]
  ])('rejects malformed %s selection before permission', async (_mode, selection, error) => {
    const options = holderOptions({ fieldsToReveal: selection as readonly string[] })
    await expect(produceBRC52Disclosure(options)).rejects.toThrow(error as string)
    expect(options.authorize).not.toHaveBeenCalled()
  })

  test('does not invoke getters in a selected-field array', async () => {
    const getter = jest.fn(() => 'name')
    const selection: string[] = []
    Object.defineProperty(selection, '0', { get: getter, enumerable: true })
    const options = holderOptions({ fieldsToReveal: selection })
    await expect(produceBRC52Disclosure(options)).rejects.toThrow(
      'field selection[0] must be an enumerable own data property'
    )
    expect(getter).not.toHaveBeenCalled()
    expect(options.authorize).not.toHaveBeenCalled()
  })

  test.each([
    ['invalid recipient length', { verifier: '' }, 'verifier has an invalid length'],
    [
      'invalid recipient case',
      { verifier: verifier.toUpperCase() },
      'verifier must be a valid compressed lowercase identity key'
    ],
    ['invalid purpose', { purpose: '' }, 'purpose has an invalid length'],
    ['oversized UTF-8 purpose', { purpose: 'é'.repeat(1_025) }, 'purpose has an invalid length'],
    [
      'invalid certificate bytes',
      { certificateBinary: new Uint8Array(131_073) },
      'certificateBinary exceeds the byte limit'
    ]
  ])('provides a bounded %s diagnostic before permission', async (_mode, change, error) => {
    const options = holderOptions(change)
    await expect(produceBRC52Disclosure(options)).rejects.toThrow(error)
    expect(options.authorize).not.toHaveBeenCalled()
  })

  test('requires literal user permission and rejects malformed wallet identity with its role', async () => {
    const options = holderOptions({ authorize: async () => 'yes' as unknown as boolean })
    await expect(produceBRC52Disclosure(options)).rejects.toThrow('Disclosure authorization denied')
    const malformed = holderOptions()
    malformed.wallet.getPublicKey = async () => ({ publicKey: '' })
    await expect(produceBRC52Disclosure(malformed)).rejects.toThrow(
      'wallet identity has an invalid length'
    )
    expect(malformed.wallet.proveCertificate).not.toHaveBeenCalled()
  })
})

describe('BRC-203 authenticated disclosure receiver integration port', () => {
  test('decrypts frozen BRC verifier keyring with real ProtoWallet derivation and original field GCM', async () => {
    const options = receiverOptions()
    const result = await receiveBRC52Disclosure(options)
    expect(result.disclosedFields).toEqual({ name: 'Alice Example' })
    expect(result.verifiedDocument).toEqual(fixture.credential)
    expect(result.source.certificateBinary).toBe(fixture.certificateBinary)
    expect(result.source.revocationOutpoint).toBe(result.status.outpoint)
    expect(result.recipient).toBe(verifier)
    expect(result.authenticatedRequest).toMatchObject({
      peer: subject,
      operation,
      purpose,
      nonce: 'synthetic-unique-request'
    })
    expect(JSON.stringify(result.verifiedDocument)).not.toContain('Alice Example')
    expect(options.wallet.decrypt).toHaveBeenCalledWith({
      protocolID: [2, 'certificate field encryption'],
      keyID: `${fixture.credential.serialNumber} name`,
      counterparty: subject,
      ciphertext: toArray(privateNameKeyring, 'base64')
    })
  })

  test('empty keyring reveals nothing while retaining authenticated source and policy', async () => {
    const options = receiverOptions({ inputData: JSON.stringify(disclosedEnvelope({})) })
    expect((await receiveBRC52Disclosure(options)).disclosedFields).toEqual({})
    expect(options.wallet.decrypt).not.toHaveBeenCalled()
  })

  test.each(['peer', 'receivingVerifier', 'operation', 'purpose', 'payload'] as const)(
    'rejects authenticated %s mismatch before decryption',
    async member => {
      const options = receiverOptions()
      const original = options.authentication.authenticate
      options.authentication.authenticate = async request => {
        const receipt = await original(request)
        return {
          ...receipt,
          [member]:
            member === 'payload'
              ? new TextEncoder().encode(`${options.inputData as string} `)
              : 'wrong'
        }
      }
      await expect(receiveBRC52Disclosure(options)).rejects.toThrow(/mismatch|exact incoming/)
      expect(options.wallet.decrypt).not.toHaveBeenCalled()
      expect(options.assessReliance).not.toHaveBeenCalled()
    }
  )

  test.each([now - 5_001, now + 1])(
    'rejects stale/future authenticated time %i',
    async authenticatedAt => {
      const options = receiverOptions()
      const original = options.authentication.authenticate
      options.authentication.authenticate = async request => ({
        ...(await original(request)),
        authenticatedAt
      })
      await expect(receiveBRC52Disclosure(options)).rejects.toThrow('stale or future')
      expect(options.wallet.decrypt).not.toHaveBeenCalled()
    }
  )

  test('rejects unauthenticated dispatch and replay across sessions and operations', async () => {
    const unauthenticated = receiverOptions({
      authentication: {
        authenticate: async () => {
          throw new Error('No BRC-103 authenticated request')
        }
      }
    })
    await expect(receiveBRC52Disclosure(unauthenticated)).rejects.toThrow('No BRC-103')
    expect(unauthenticated.wallet.decrypt).not.toHaveBeenCalled()
    const options = receiverOptions()
    await receiveBRC52Disclosure(options)
    options.operation = 'POST /another-operation'
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => ({
      ...(await original(request)),
      sessionId: 'different-session'
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('nonce repeated')
    expect(options.wallet.decrypt).toHaveBeenCalledTimes(1)
  })

  test('fails closed for bounded replay storage and clock regression; retains inclusive age boundary', () => {
    const store = new BRC52MemoryNonceStore(1)
    expect(store.consume('scope', 'one', 105, 100)).toBe(true)
    expect(store.consume('scope', 'two', 105, 100)).toBe(false)
    expect(store.consume('scope', 'one', 105, 105)).toBe(false)
    expect(store.consume('scope', 'two', 120, 106)).toBe(true)
    expect(store.consume('scope', 'three', 120, 105)).toBe(false)
  })

  test.each(['denied', 'wrong-outpoint', 'issuer-tracking', 'issuer-mode'])(
    'rejects %s relying policy before decryption',
    async reason => {
      const evidence = status()
      if (reason === 'wrong-outpoint') evidence.outpoint = `${'0'.repeat(64)}.0`
      if (reason === 'issuer-tracking') evidence.reason = 'issuer-tracking-prohibited'
      if (reason === 'issuer-mode') evidence.privacy.mode = 'issuer-per-presentation'
      const options = receiverOptions({
        assessReliance: async () => ({ authorized: reason !== 'denied', status: evidence })
      })
      const error =
        reason === 'denied'
          ? 'Disclosure reliance denied'
          : reason === 'wrong-outpoint'
            ? 'Status assessment outpoint mismatch'
            : 'Issuer-tracking status retrieval cannot authorize disclosure'
      await expect(receiveBRC52Disclosure(options)).rejects.toThrow(error)
      expect(options.wallet.decrypt).not.toHaveBeenCalled()
    }
  )

  test('refuses a receiver wallet that is not the authenticated recipient', async () => {
    const options = receiverOptions()
    options.wallet.getPublicKey = async () => ({ publicKey: subject })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('wallet identity mismatch')
    expect(options.wallet.decrypt).not.toHaveBeenCalled()
  })

  test('rechecks freshness after asynchronous policy and wallet identity work', async () => {
    const options = receiverOptions({
      now: jest
        .fn<ReceiveBRC52DisclosureOptions['now']>()
        .mockReturnValueOnce(now)
        .mockReturnValueOnce(now + 5_001)
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('expired during reliance')
    expect(options.wallet.decrypt).not.toHaveBeenCalled()
  })

  test('strictly rejects malformed UTF-8 after authenticated field decryption', async () => {
    const options = receiverOptions()
    options.wallet.decrypt = async () => ({ plaintext: Array.from({ length: 32 }, () => 0x42) })
    // Isolate the decoder boundary; this mock does not claim cryptographic interoperability.
    const decrypt = jest.spyOn(SymmetricKey.prototype, 'decrypt').mockReturnValueOnce([0xc0, 0xaf])
    try {
      await expect(receiveBRC52Disclosure(options)).rejects.toThrow()
    } finally {
      decrypt.mockRestore()
    }
  })

  test.each([31, 33])('rejects wallet field key length %i', async length => {
    const options = receiverOptions()
    options.wallet.decrypt = async () => ({ plaintext: Array.from({ length }, () => 0x42) })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('field revelation key')
  })

  test('rejects modified keyring GCM tag', async () => {
    const damaged = toArray(privateNameKeyring, 'base64')
    damaged[damaged.length - 1] ^= 1
    const options = receiverOptions({
      inputData: JSON.stringify(disclosedEnvelope({ name: toBase64(damaged) }))
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('Decryption failed')
  })

  test('returns no partial plaintext after one valid field and a wrong field revelation key', async () => {
    const options = receiverOptions({
      inputData: JSON.stringify(
        disclosedEnvelope({ name: privateNameKeyring, email: privateNameKeyring })
      )
    })
    options.wallet.decrypt = jest.fn(async () => ({
      plaintext: Array.from({ length: 32 }, () => 0x42)
    }))
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('Decryption failed')
    expect(options.wallet.decrypt).toHaveBeenCalledTimes(2)
  })

  test('aborts after the first failed field without starting the next wallet decryption', async () => {
    const options = receiverOptions({
      inputData: JSON.stringify(
        disclosedEnvelope({ name: privateNameKeyring, email: privateNameKeyring })
      )
    })
    options.wallet.decrypt = jest.fn(async () => {
      throw new Error('Synthetic first field failure')
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('Synthetic first field failure')
    expect(options.wallet.decrypt).toHaveBeenCalledTimes(1)
    expect(options.wallet.decrypt).toHaveBeenCalledWith(
      expect.objectContaining({ keyID: `${fixture.credential.serialNumber} name` })
    )
  })

  test.each([
    'unknown-field',
    'master-keyring',
    'duplicate-json',
    'short-keyring',
    'plaintext-graph',
    'wrong-recipient',
    'invalid-utf8',
    'oversized'
  ])('rejects malformed %s envelope before authentication', async kind => {
    const envelope = disclosedEnvelope()
    let input: string | Uint8Array
    if (kind === 'unknown-field') envelope.disclosure!.keyring = { unknown: privateNameKeyring }
    if (kind === 'master-keyring')
      (envelope.disclosure as unknown as Record<string, unknown>).masterKeyring = {
        name: privateNameKeyring
      }
    if (kind === 'short-keyring') envelope.disclosure!.keyring.name = 'AQ=='
    if (kind === 'plaintext-graph')
      (envelope.credential.credentialSubject as unknown as Record<string, unknown>).plaintext =
        'Unsigned'
    if (kind === 'wrong-recipient') envelope.disclosure!.verifier = subject
    input = JSON.stringify(envelope)
    if (kind === 'duplicate-json')
      input = input.replace('"disclosure":{', '"disclosure":{"subject":"duplicate",')
    if (kind === 'invalid-utf8') input = new Uint8Array([0xff])
    if (kind === 'oversized') input = ' '.repeat(262_145)
    const options = receiverOptions({ inputData: input })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow()
    expect(options.authentication.authenticate).not.toHaveBeenCalled()
    expect(options.wallet.decrypt).not.toHaveBeenCalled()
  })

  test('policy callback cannot mutate authenticated source consumed by decryption', async () => {
    const options = receiverOptions({
      assessReliance: async ({ certificate, authenticatedRequest }) => {
        certificate.fields.name = certificate.fields.email
        certificate.subject = verifier
        authenticatedRequest.operation = 'wrong operation'
        return { authorized: true, status: status() }
      }
    })
    const result = await receiveBRC52Disclosure(options)
    expect(result.disclosedFields.name).toBe('Alice Example')
    expect(result.authenticatedRequest.operation).toBe(operation)
    expect(result.source.subject).toBe(subject)
  })

  test('rejects receipt accessors without invoking them', async () => {
    const getter = jest.fn(() => subject)
    const options = receiverOptions()
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => {
      const receipt: BRC52AuthenticatedRequest = await original(request)
      Object.defineProperty(receipt, 'peer', { get: getter, enumerable: true })
      return receipt
    }
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow('own data property')
    expect(getter).not.toHaveBeenCalled()
  })

  test('rejects equal-length authenticated byte changes even when almost all bytes match', async () => {
    const options = receiverOptions()
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => {
      const receipt = await original(request)
      const payload = receipt.payload.slice()
      payload[payload.length - 1] ^= 1
      return { ...receipt, payload }
    }
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(
      'Authenticated payload does not match exact incoming envelope bytes'
    )
    expect(options.wallet.decrypt).not.toHaveBeenCalled()
  })

  test('isolates input ownership from mutation by trusted callbacks', async () => {
    const payload = new TextEncoder().encode(JSON.stringify(disclosedEnvelope()))
    const options = receiverOptions({ inputData: payload })
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => {
      const saved = request.payload.slice()
      request.payload.fill(0)
      payload.fill(0)
      return original({ ...request, payload: saved })
    }
    options.assessReliance = async ({ authenticatedRequest }) => {
      authenticatedRequest.payload.fill(0)
      return { authorized: true, status: status() }
    }
    expect((await receiveBRC52Disclosure(options)).disclosedFields.name).toBe('Alice Example')
  })

  test('rejects a transport BOM as strict JSON input without silently removing it', async () => {
    const inputData = `\ufeff${JSON.stringify(disclosedEnvelope())}`
    const options = receiverOptions({ inputData })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(
      'BRC-52 envelope is not canonical JSON'
    )
    expect(options.authentication.authenticate).not.toHaveBeenCalled()
  })

  test.each([
    ['nonce', '', 'authenticated nonce has an invalid length'],
    ['nonce', 'n'.repeat(2_049), 'authenticated nonce has an invalid length'],
    ['sessionId', '', 'sessionId has an invalid length'],
    ['authenticatedAt', 0.5, 'authenticatedAt must be a bounded non-negative integer']
  ])(
    'rejects malformed authenticated %s with a specific diagnostic',
    async (member, value, error) => {
      const options = receiverOptions()
      const original = options.authentication.authenticate
      options.authentication.authenticate = async request => ({
        ...(await original(request)),
        [member]: value
      })
      await expect(receiveBRC52Disclosure(options)).rejects.toThrow(error as string)
      expect(options.assessReliance).not.toHaveBeenCalled()
      expect(options.wallet.decrypt).not.toHaveBeenCalled()
    }
  )

  test('rejects nonbyte authenticated payload without interpreting the envelope', async () => {
    const options = receiverOptions()
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => ({
      ...(await original(request)),
      payload: 'unsigned JSON' as unknown as Uint8Array
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(
      'authenticated payload must be a bounded byte array'
    )
  })

  test('rejects unknown authentication receipt metadata', async () => {
    const options = receiverOptions()
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => ({
      ...(await original(request)),
      trusted: true
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(
      'authenticated receipt contains unknown property "trusted"'
    )
  })

  test.each([
    ['no disclosure', { inputData: JSON.stringify(fixture) }, 'Disclosure envelope required'],
    [
      'wrong recipient',
      { receivingVerifier: subject },
      'Disclosure subject or receiving verifier mismatch'
    ],
    [
      'empty receiving verifier',
      { receivingVerifier: '' },
      'receiving verifier has an invalid length'
    ],
    ['empty operation', { operation: '' }, 'operation has an invalid length'],
    ['empty purpose', { purpose: '' }, 'purpose has an invalid length'],
    ['zero maximum age', { maxRequestAgeMs: 0 }, 'maxRequestAgeMs must be positive'],
    [
      'excessive maximum age',
      { maxRequestAgeMs: 300_001 },
      'maxRequestAgeMs must be a bounded non-negative integer'
    ]
  ])('rejects %s receiver configuration before authenticating', async (_mode, change, error) => {
    const options = receiverOptions(change)
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(error)
    expect(options.authentication.authenticate).not.toHaveBeenCalled()
  })

  test.each([now, now - 5_000])(
    'accepts inclusive authenticated freshness boundary %i',
    async authenticatedAt => {
      const options = receiverOptions()
      const original = options.authentication.authenticate
      options.authentication.authenticate = async request => ({
        ...(await original(request)),
        authenticatedAt
      })
      expect((await receiveBRC52Disclosure(options)).disclosedFields.name).toBe('Alice Example')
    }
  )

  test.each([
    ['invalid clock', [NaN], 'now must be a bounded non-negative integer'],
    ['regressed clock', [now, now - 1], 'Authenticated request expired during reliance assessment'],
    ['invalid final clock', [now, 0.5], 'reliance time must be a bounded non-negative integer']
  ])('rejects %s without plaintext', async (_mode, times, error) => {
    const clock = jest.fn<ReceiveBRC52DisclosureOptions['now']>()
    for (const time of times as number[]) clock.mockReturnValueOnce(time)
    const options = receiverOptions({ now: clock })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(error as string)
    expect(options.wallet.decrypt).not.toHaveBeenCalled()
  })

  test('rejects an unrepresentable expiry with a diagnostic', async () => {
    const options = receiverOptions({ now: () => Number.MAX_SAFE_INTEGER })
    const original = options.authentication.authenticate
    options.authentication.authenticate = async request => ({
      ...(await original(request)),
      authenticatedAt: Number.MAX_SAFE_INTEGER
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(
      'nonce expiry must be a bounded non-negative integer'
    )
  })

  test('binds the consumed nonce to the exact authenticated peer/recipient and time window', async () => {
    const consume = jest.fn<BRC52NonceStore['consume']>(async () => true)
    const options = receiverOptions({ nonceStore: { consume } })
    await receiveBRC52Disclosure(options)
    expect(consume).toHaveBeenCalledWith(
      JSON.stringify([subject, verifier]),
      'synthetic-unique-request',
      now + 4_000,
      now
    )
  })

  test('fresh nonce store scopes preserve distinct receiving identities', async () => {
    const nonceStore = new BRC52MemoryNonceStore()
    for (const scalar of [4, 5]) {
      const recipient = new PrivateKey(scalar).toPublicKey().toString()
      const envelope = disclosedEnvelope({})
      envelope.disclosure!.verifier = recipient
      const options = receiverOptions({
        inputData: JSON.stringify(envelope),
        receivingVerifier: recipient,
        nonceStore
      })
      options.wallet.getPublicKey = async () => ({ publicKey: recipient })
      expect((await receiveBRC52Disclosure(options)).recipient).toBe(recipient)
    }
  })

  test.each([
    ['string envelope', ' '.repeat(262_145), 'envelope has an invalid length'],
    ['byte envelope', new Uint8Array(262_145), 'envelope exceeds the byte limit'],
    ['unpaired Unicode', '"\ud800"', 'Envelope is not well-formed UTF-8']
  ])('reports malformed %s before authentication', async (_mode, inputData, error) => {
    const options = receiverOptions({ inputData })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(error as string)
    expect(options.authentication.authenticate).not.toHaveBeenCalled()
  })

  test('preserves a leading BOM in revealed plaintext and clears temporary borrowed decryption bytes', async () => {
    const options = receiverOptions()
    const revelationKey = Array.from({ length: 32 }, () => 0x42)
    options.wallet.decrypt = async () => ({ plaintext: revelationKey })
    const plaintext = Array.from(new TextEncoder().encode('\ufeffAlice Example'))
    const decrypt = jest.spyOn(SymmetricKey.prototype, 'decrypt').mockReturnValueOnce(plaintext)
    try {
      expect((await receiveBRC52Disclosure(options)).disclosedFields.name).toBe(
        '\ufeffAlice Example'
      )
      expect(plaintext).toEqual(Array.from({ length: plaintext.length }, () => 0))
      expect(revelationKey).toEqual(Array.from({ length: 32 }, () => 0x42))
    } finally {
      decrypt.mockRestore()
    }
  })

  test('rejects status object accessors without obtaining wallet keys', async () => {
    const getter = jest.fn(() => status().outpoint)
    const evidence = status()
    Object.defineProperty(evidence, 'outpoint', { get: getter, enumerable: true })
    const options = receiverOptions({
      assessReliance: async () => ({ authorized: true, status: evidence })
    })
    await expect(receiveBRC52Disclosure(options)).rejects.toThrow(
      'status assessment.outpoint must be an enumerable own data property'
    )
    expect(getter).not.toHaveBeenCalled()
    expect(options.wallet.getPublicKey).not.toHaveBeenCalled()
  })
})

describe('BRC-203 nonce storage configuration and accounting', () => {
  test.each([0, -1, 100_001, 0.5])('rejects invalid capacity %s', capacity => {
    expect(() => new BRC52MemoryNonceStore(capacity)).toThrow(
      capacity === 0
        ? 'nonce capacity must be positive'
        : 'nonce capacity must be a bounded non-negative integer'
    )
  })

  test.each([
    ['', 'nonce', 100, 100, 'nonce scope has an invalid length'],
    ['scope', '', 100, 100, 'nonce has an invalid length'],
    ['scope', 'nonce', 100, -1, 'now must be a bounded non-negative integer'],
    ['scope', 'nonce', -1, 100, 'nonce expiry must be a bounded non-negative integer']
  ])('diagnoses invalid nonce storage inputs', (scope, nonce, expiresAt, time, error) => {
    const store = new BRC52MemoryNonceStore()
    expect(() =>
      store.consume(scope as string, nonce as string, expiresAt as number, time as number)
    ).toThrow(error as string)
  })

  test('does not reserve an expired nonce and accepts a newly reserved inclusive expiry', () => {
    const store = new BRC52MemoryNonceStore(1)
    expect(store.consume('scope', 'one', 99, 100)).toBe(false)
    expect(store.consume('scope', 'one', 100, 100)).toBe(true)
    expect(store.consume('scope', 'one', 100, 100)).toBe(false)
    expect(store.consume('scope', 'two', 101, 101)).toBe(true)
  })

  test('rejects clock regression even for a new nonce that has not expired', () => {
    const store = new BRC52MemoryNonceStore(2)
    expect(store.consume('scope', 'one', 200, 100)).toBe(true)
    expect(store.consume('scope', 'two', 200, 99)).toBe(false)
    expect(store.consume('scope', 'two', 200, 100)).toBe(true)
  })
})
