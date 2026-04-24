import {
  Certificate,
  KeyDeriver,
  MasterCertificate,
  PrivateKey,
  ProtoWallet,
  Utils,
  VerifiableCertificate,
  WalletCertificate
} from '@bsv/sdk'
import { sdk } from '../../index.all'

describe('CertificateLifeCycle tests', () => {
  jest.setTimeout(99999999)

  test('2a complete flow MasterCertificate and VerifiableCertificate', async () => {
    // Issuer beging with an un-encrypted (decrypted) raw certificate template:
    // The public keys of both the certifier (the authority issuing the certificate),
    // and the subject (who the certificate pertains to) are included in the certificate.
    const { cert: wcert, certifier, subject } = makeSampleCert('1'.repeat(64), '2'.repeat(64), '3'.repeat(64))

    const cert = new Certificate(
      wcert.type,
      wcert.serialNumber,
      wcert.subject,
      wcert.certifier,
      wcert.revocationOutpoint,
      wcert.fields
    )

    // Next the certifier must encrypt the field values for privacy and sign the certificate
    // such that the values it contains can be attributed to the certifier through its public key.
    // Encryption is done with random symmetric keys and the keys are then encrypted by the certifier
    // such that each key can also be decrypted by the subject:
    const certifierWallet = new ProtoWallet(certifier)

    // encrypt the fields as the certifier for the subject
    const r1 = await MasterCertificate.createCertificateFields(
      certifierWallet,
      subject.toPublicKey().toString(),
      cert.fields
    )

    // sign the certificate with encrypted fields as the certifier
    const signedCert = new Certificate(
      wcert.type,
      wcert.serialNumber,
      wcert.subject,
      wcert.certifier,
      wcert.revocationOutpoint,
      r1.certificateFields
    )
    await signedCert.sign(certifierWallet)

    // The subject imports their copy of the new certificate:
    const subjectWallet = new ProtoWallet(subject)

    // The subject's imported certificate should verify
    expect(await signedCert.verify()).toBe(true)

    // Confirm subject can decrypt the certifier's copy of the cert:
    const r2 = await MasterCertificate.decryptFields(
      subjectWallet,
      r1.masterKeyring,
      signedCert.fields,
      signedCert.certifier
    )

    // Prepare to send certificate to third party veifier of the 'name' and 'email' fields.
    // The verifier must be able to confirm the signature on the original certificate's encrypted values.
    // And then use a keyRing that their public key will work to reveal decrypted values for 'name' and 'email' only.
    const verifier = PrivateKey.fromRandom()
    // subject makes a keyring for the verifier
    const r3 = await MasterCertificate.createKeyringForVerifier(
      subjectWallet,
      certifier.toPublicKey().toString(),
      verifier.toPublicKey().toString(),
      signedCert.fields,
      ['name', 'email'],
      r1.masterKeyring,
      signedCert.serialNumber
    )

    // The verifier uses their own wallet to import the certificate, verify it, and decrypt their designated fields.
    const verifierWallet = new ProtoWallet(verifier)

    const veriCert = new VerifiableCertificate(
      signedCert.type,
      signedCert.serialNumber,
      signedCert.subject,
      signedCert.certifier,
      signedCert.revocationOutpoint,
      signedCert.fields,
      r3,
      signedCert.signature
    )

    const r4 = await veriCert.decryptFields(verifierWallet)
    expect(r4['name']).toBe('Alice')
    expect(r4['email']).toBe('alice@example.com')
    expect(r4['organization']).not.toBe('Example Corp')
  })
})

function makeSampleCert(
  subjectRootKeyHex?: string,
  certifierKeyHex?: string,
  verifierKeyHex?: string
): {
  cert: WalletCertificate
  subject: PrivateKey
  certifier: PrivateKey
} {
  const subject = subjectRootKeyHex ? PrivateKey.fromString(subjectRootKeyHex) : PrivateKey.fromRandom()
  const certifier = certifierKeyHex ? PrivateKey.fromString(certifierKeyHex) : PrivateKey.fromRandom()
  const verifier = verifierKeyHex ? PrivateKey.fromString(verifierKeyHex) : PrivateKey.fromRandom()
  const cert: WalletCertificate = {
    type: Utils.toBase64(new Array(32).fill(1)),
    serialNumber: Utils.toBase64(new Array(32).fill(2)),
    revocationOutpoint: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.1',
    subject: subject.toPublicKey().toString(),
    certifier: certifier.toPublicKey().toString(),
    fields: {
      name: 'Alice',
      email: 'alice@example.com',
      organization: 'Example Corp'
    },
    signature: ''
  }
  return { cert, subject, certifier }
}
