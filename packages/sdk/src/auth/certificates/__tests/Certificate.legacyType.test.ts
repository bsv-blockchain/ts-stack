/**
 * Certificates issued before @bsv/sdk 2.8.0 may carry a `type` shorter than
 * 32 bytes. Their signatures cover the historical serialization, which wrote
 * the decoded type bytes without padding or a length prefix. `verify()` must
 * keep accepting those signatures while `toBinary()`, `fromBinary()` and
 * `sign()` stay canonical (bsv-blockchain/ts-stack#1085).
 */
import { Certificate } from '../../../auth/index'
import { CompletedProtoWallet } from './CompletedProtoWallet'
import { Utils, PrivateKey } from '../../../primitives/index'

const legacyType = Utils.toBase64(Array.from({ length: 16 }, (_, index) => index + 1))
const serialNumber = Utils.toBase64(Array.from({ length: 32 }).fill(2) as number[])
const subjectPublicKey = PrivateKey.fromRandom().toPublicKey().toString()
const certifierPrivateKey = PrivateKey.fromRandom()
const certifierPublicKey = certifierPrivateKey.toPublicKey().toString()
const revocationOutpoint = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.1'
const fields = { email: 'ZW5jcnlwdGVk', name: 'QWxpY2U=' }

/**
 * The pre-2.8.0 `Certificate.toBinary(false)` layout: raw type bytes, 32-byte
 * serial number, both compressed public keys, revocation txid plus varint
 * index, then the locale-sorted fields.
 */
function historicalPreimage(certificate: Certificate, typeBytes: number[]): number[] {
  const writer = new Utils.Writer()
  writer.write(typeBytes)
  writer.write(Utils.toArray(certificate.serialNumber, 'base64'))
  writer.write(Utils.toArray(certificate.subject, 'hex'))
  writer.write(Utils.toArray(certificate.certifier, 'hex'))
  const [txid, outputIndex] = certificate.revocationOutpoint.split('.')
  writer.write(Utils.toArray(txid, 'hex'))
  writer.writeVarIntNum(Number(outputIndex))
  const fieldNames = Object.keys(certificate.fields).sort((a, b) => a.localeCompare(b))
  writer.writeVarIntNum(fieldNames.length)
  for (const fieldName of fieldNames) {
    const nameBytes = Utils.toArray(fieldName, 'utf8')
    writer.writeVarIntNum(nameBytes.length)
    writer.write(nameBytes)
    const valueBytes = Utils.toArray(certificate.fields[fieldName], 'utf8')
    writer.writeVarIntNum(valueBytes.length)
    writer.write(valueBytes)
  }
  return writer.toArray()
}

async function signHistorically(certificate: Certificate, typeBytes: number[]): Promise<void> {
  const certifierWallet = new CompletedProtoWallet(certifierPrivateKey)
  const { signature } = await certifierWallet.createSignature({
    data: historicalPreimage(certificate, typeBytes),
    protocolID: [2, 'certificate signature'],
    keyID: `${certificate.type} ${certificate.serialNumber}`
  })
  certificate.signature = Utils.toHex(signature)
}

function legacyCertificate(): Certificate {
  return new Certificate(
    legacyType,
    serialNumber,
    subjectPublicKey,
    certifierPublicKey,
    revocationOutpoint,
    { ...fields }
  )
}

describe('Certificate with a legacy (sub-32-byte) type', () => {
  it('verifies a signature made over the historical unpadded serialization', async () => {
    const certificate = legacyCertificate()
    await signHistorically(certificate, Utils.toArray(legacyType, 'base64'))

    await expect(certificate.verify()).resolves.toBe(true)
  })

  it('rejects a tampered field under the historical serialization', async () => {
    const certificate = legacyCertificate()
    await signHistorically(certificate, Utils.toArray(legacyType, 'base64'))
    certificate.fields.name = 'TWFsbG9yeQ=='

    await expect(certificate.verify()).resolves.toBe(false)
  })

  it('does not accept a signature made over a zero-padded type', async () => {
    const certificate = legacyCertificate()
    const padded = [...Utils.toArray(legacyType, 'base64'), ...Array.from({ length: 16 }, () => 0)]
    await signHistorically(certificate, padded)

    await expect(certificate.verify()).resolves.toBe(false)
  })

  it('cannot be newly signed, binary-serialized or binary-parsed', async () => {
    const certificate = legacyCertificate()
    const certifierWallet = new CompletedProtoWallet(certifierPrivateKey)

    await expect(certificate.sign(certifierWallet)).rejects.toThrow('type')
    expect(() => certificate.toBinary()).toThrow('type')
    const historical = historicalPreimage(certificate, Utils.toArray(legacyType, 'base64'))
    expect(() => Certificate.fromBinary(historical)).toThrow()
  })

  it.each([
    ['non-canonical base64', 'not*base64'],
    ['empty', ''],
    ['oversized', Utils.toBase64(Array.from({ length: 33 }, () => 7))]
  ])('reports an unusable %s type as unverified rather than throwing', async (_name, type) => {
    const certificate = legacyCertificate()
    await signHistorically(certificate, Utils.toArray(legacyType, 'base64'))
    certificate.type = type

    await expect(certificate.verify()).resolves.toBe(false)
  })
})
