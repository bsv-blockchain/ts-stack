import { jest } from '@jest/globals'
import {
  LockingScript,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  PushDrop,
  Utils,
  VerifiableCertificate
} from '@bsv/sdk'
import { validateIdentityOutput } from '../identity/identityTokenValidation.js'

function pushDropScript(publicKey: PublicKey, fields: number[][]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = [
    { op: 33, data: Utils.toArray(publicKey.toString(), 'hex') },
    { op: 0xac }
  ]
  for (const field of fields) {
    const op =
      field.length <= 75
        ? field.length
        : field.length <= 0xff
          ? 0x4c
          : field.length <= 0xffff
            ? 0x4d
            : 0x4e
    chunks.push({ op, data: field })
  }
  let remaining = fields.length
  while (remaining > 1) {
    chunks.push({ op: 0x6d })
    remaining -= 2
  }
  if (remaining === 1) chunks.push({ op: 0x75 })
  return new LockingScript(chunks)
}

const subject = PrivateKey.fromRandom().toPublicKey().toString()
const lockingKey = PrivateKey.fromRandom().toPublicKey()

function certificate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: Buffer.alloc(32, 1).toString('base64'),
    serialNumber: Buffer.alloc(32, 2).toString('base64'),
    subject,
    certifier: PrivateKey.fromRandom().toPublicKey().toString(),
    revocationOutpoint: `${'ab'.repeat(32)}.0`,
    fields: { name: 'encrypted-name' },
    keyring: { name: 'encrypted-key' },
    signature: 'certificate-signature',
    ...overrides
  }
}

function output(
  encodedCertificate: number[],
  fieldSignature: number[] = Array.from({ length: 8 }, (_, index) => index)
) {
  return {
    lockingScript: pushDropScript(lockingKey, [encodedCertificate, fieldSignature]),
    satoshis: 0
  }
}

function encoded(value: unknown): number[] {
  return Utils.toArray(JSON.stringify(value), 'utf8')
}

function wallet(valid = true): ProtoWallet {
  return {
    getPublicKey: jest.fn(async () => ({ publicKey: lockingKey.toString() })),
    verifySignature: jest.fn(async () => ({ valid }))
  } as unknown as ProtoWallet
}

describe('identity output validation boundaries', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([null, [], 'certificate'])('rejects non-object certificate JSON: %p', async value => {
    await expect(validateIdentityOutput(output(encoded(value)), wallet())).rejects.toThrow(
      'Identity certificate must be a plain object'
    )
  })

  it('rejects missing and unexpected certificate properties', async () => {
    const missing = certificate()
    delete missing.signature
    await expect(validateIdentityOutput(output(encoded(missing)), wallet())).rejects.toThrow(
      'missing or unexpected fields'
    )
    await expect(
      validateIdentityOutput(output(encoded(certificate({ extra: true }))), wallet())
    ).rejects.toThrow('missing or unexpected fields')
  })

  it.each([
    ['null fields', { fields: null }, 'fields must be a plain object'],
    ['array fields', { fields: [] }, 'fields must be a plain object'],
    ['null keyring', { keyring: null }, 'keyring must be a plain object'],
    ['array keyring', { keyring: [] }, 'keyring must be a plain object'],
    ['empty fields', { fields: {} }, 'invalid cardinality'],
    ['empty keyring', { keyring: {} }, 'invalid cardinality'],
    ['an unbound keyring entry', { keyring: { absent: 'key' } }, 'absent certificate field']
  ])('rejects %s', async (_label, overrides, message) => {
    await expect(
      validateIdentityOutput(output(encoded(certificate(overrides))), wallet())
    ).rejects.toThrow(message as string)
  })

  it('rejects excessive field and keyring cardinality', async () => {
    const fields = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`field${index}`, 'value'])
    )
    const keyring = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`field${index}`, 'key'])
    )
    await expect(
      validateIdentityOutput(output(encoded(certificate({ fields, keyring }))), wallet())
    ).rejects.toThrow('invalid cardinality')
  })

  it('requires the certificate subject to be a string before wallet operations', async () => {
    const anyoneWallet = wallet()
    await expect(
      validateIdentityOutput(output(encoded(certificate({ subject: 1 }))), anyoneWallet)
    ).rejects.toThrow('subject must be a string')
    expect(anyoneWallet.getPublicKey).not.toHaveBeenCalled()
  })

  it.each([
    ['a short field signature', encoded(certificate()), [1, 2, 3], '8-80 bytes'],
    ['an oversized field signature', encoded(certificate()), Array(81).fill(1), '8-80 bytes'],
    ['an oversized certificate', Array(256 * 1024 + 1).fill(1), Array(8).fill(1), '1-262144 bytes']
  ])('rejects %s', async (_label, certificateBytes, signature, message) => {
    await expect(
      validateIdentityOutput(output(certificateBytes, signature), wallet())
    ).rejects.toThrow(message as string)
  })

  it.each([
    ['a non-array certificate field', 'not-bytes'],
    ['a sparse certificate field', Object.assign([], { length: 2, 1: 1 })],
    ['a fractional byte', [1.5]],
    ['a negative byte', [-1]],
    ['an excessive byte', [256]]
  ])('rejects %s returned by the decoder', async (_label, malformed) => {
    const script = output(encoded(certificate())).lockingScript
    jest.spyOn(PushDrop, 'decode').mockReturnValue({
      fields: [malformed, Array(8).fill(1)],
      lockingPublicKey: lockingKey
    } as never)

    await expect(
      validateIdentityOutput({ lockingScript: script, satoshis: 0 }, wallet())
    ).rejects.toThrow(/contain 1-262144 bytes|dense byte array/)
  })

  it('rejects a semantically decodable but non-canonical PushDrop script', async () => {
    const malformed = output(encoded(certificate()))
    malformed.lockingScript.chunks[4].op = 0x75

    await expect(validateIdentityOutput(malformed, wallet())).rejects.toThrow(
      'canonical signed PushDrop script'
    )
  })

  it('requires an exact true verdict for the signed field payload', async () => {
    const certificateVerify = jest.spyOn(VerifiableCertificate.prototype, 'verify')

    await expect(
      validateIdentityOutput(output(encoded(certificate())), wallet(false))
    ).rejects.toThrow('Invalid identity field signature')
    expect(certificateVerify).not.toHaveBeenCalled()
  })
})
