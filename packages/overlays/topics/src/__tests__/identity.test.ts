/**
 * Integration tests for IdentityTopicManager.
 *
 * IdentityTopicManager decodes each output with PushDrop.decode, then:
 *   1. Parses field[0] as JSON VerifiableCertificate
 *   2. Validates the PushDrop signature with ProtoWallet('anyone').verifySignature()
 *      using counterparty=parsedCert.subject, protocolID=[1,'identity'], keyID='1'
 *   3. Calls certificate.verify()
 *   4. Calls certificate.decryptFields(anyoneWallet) — requires at least one public field
 *
 * Full valid test requires constructing a real VerifiableCertificate signed by the
 * subject and certifier with the 'anyone' wallet derivation — skipped below.
 */

import {
  LockingScript,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  Transaction,
  Utils,
  VerifiableCertificate
} from '@bsv/sdk'
import { jest } from '@jest/globals'
import IdentityTopicManager from '../identity/IdentityTopicManager.js'

// ---------------------------------------------------------------------------
// Helpers (same PushDrop builder as other test files)
// ---------------------------------------------------------------------------

function buildPushDropScript(pubKey: PublicKey, fields: number[][]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = []

  const pubKeyBytes = Utils.toArray(pubKey.toString(), 'hex')
  chunks.push({ op: pubKeyBytes.length, data: pubKeyBytes })
  chunks.push({ op: 0xac }) // OP_CHECKSIG

  for (const field of fields) {
    if (field.length === 0) {
      chunks.push({ op: 0 })
    } else if (field.length <= 75) {
      chunks.push({ op: field.length, data: field })
    } else if (field.length <= 255) {
      chunks.push({ op: 0x4c, data: field })
    } else {
      chunks.push({ op: 0x4d, data: field })
    }
  }

  let remaining = fields.length
  while (remaining > 1) {
    chunks.push({ op: 0x6d }) // OP_2DROP
    remaining -= 2
  }
  if (remaining === 1) {
    chunks.push({ op: 0x75 }) // OP_DROP
  }

  return new LockingScript(chunks)
}

function buildTxWithInput(outputScripts: LockingScript[]): Transaction {
  const sourceTx = new Transaction()
  sourceTx.addOutput({ lockingScript: new LockingScript([]), satoshis: 10000 })

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScript: new LockingScript([])
  })

  for (const ls of outputScripts) {
    tx.addOutput({ lockingScript: ls, satoshis: 1000 })
  }

  return tx
}

function buildCertificateOutput(): Transaction {
  const key = PrivateKey.fromRandom()
  const subjectKey = PrivateKey.fromRandom()
  const certData = {
    type: 'deadbeef'.repeat(8),
    serialNumber: 'testserial123',
    subject: subjectKey.toPublicKey().toString(),
    certifier: key.toPublicKey().toString(),
    revocationOutpoint: 'deadbeef'.repeat(8) + '.0',
    fields: { name: 'encrypted-blob' },
    keyring: {},
    signature: 'invalidsig'
  }
  const certBytes = Utils.toArray(JSON.stringify(certData), 'utf8')
  const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
  return buildTxWithInput([buildPushDropScript(key.toPublicKey(), [certBytes, fakeSignature])])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdentityTopicManager', () => {
  let manager: IdentityTopicManager

  beforeEach(() => {
    manager = new IdentityTopicManager()
  })

  it('rejects a P2PKH script (not a PushDrop)', async () => {
    // OP_DUP OP_HASH160 OP_EQUALVERIFY OP_CHECKSIG — will fail PushDrop.decode
    const badScript = new LockingScript([
      { op: 0x76 }, // OP_DUP
      { op: 0xa9 }, // OP_HASH160
      { op: 0x88 }, // OP_EQUALVERIFY
      { op: 0xac }  // OP_CHECKSIG
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a 1-field PushDrop where field[0] is not valid JSON', async () => {
    const key = PrivateKey.fromRandom()
    const notJson = Utils.toArray('not-json-certificate', 'utf8')
    // Only 1 field — signature pop will leave 0 data fields, and JSON.parse will throw
    const lockingScript = buildPushDropScript(key.toPublicKey(), [notJson])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a 2-field PushDrop where field[0] is valid JSON but not a VerifiableCertificate', async () => {
    const key = PrivateKey.fromRandom()
    // Valid JSON but missing all certificate fields (type, subject, certifier, etc.)
    const badCert = Utils.toArray(JSON.stringify({ foo: 'bar' }), 'utf8')
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [badCert, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a PushDrop with a JSON certificate-shaped object but wrong signature', async () => {
    const tx = buildCertificateOutput()

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects an output whose certificate signature is invalid', async () => {
    jest.spyOn(ProtoWallet.prototype, 'verifySignature').mockResolvedValue({ valid: true })
    jest.spyOn(VerifiableCertificate.prototype, 'verify').mockResolvedValue(false)
    const decryptFields = jest.spyOn(VerifiableCertificate.prototype, 'decryptFields')

    const result = await manager.identifyAdmissibleOutputs(buildCertificateOutput().toBEEF(), [])

    expect(result.outputsToAdmit).toEqual([])
    expect(decryptFields).not.toHaveBeenCalled()
  })

  it('rejects an output without publicly revealed certificate attributes', async () => {
    jest.spyOn(ProtoWallet.prototype, 'verifySignature').mockResolvedValue({ valid: true })
    jest.spyOn(VerifiableCertificate.prototype, 'verify').mockResolvedValue(true)
    jest.spyOn(VerifiableCertificate.prototype, 'decryptFields').mockResolvedValue({})

    const result = await manager.identifyAdmissibleOutputs(buildCertificateOutput().toBEEF(), [])

    expect(result.outputsToAdmit).toEqual([])
  })

  it('admits an output with a valid signature and publicly revealed attributes', async () => {
    jest.spyOn(ProtoWallet.prototype, 'verifySignature').mockResolvedValue({ valid: true })
    jest.spyOn(VerifiableCertificate.prototype, 'verify').mockResolvedValue(true)
    jest.spyOn(VerifiableCertificate.prototype, 'decryptFields').mockResolvedValue({ name: 'Alice' })

    const result = await manager.identifyAdmissibleOutputs(buildCertificateOutput().toBEEF(), [])

    expect(result.outputsToAdmit).toEqual([0])
  })

  it('returns empty results for malformed BEEF bytes', async () => {
    const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('returns empty results for a transaction with no inputs', async () => {
    const key = PrivateKey.fromRandom()
    const certBytes = Utils.toArray(JSON.stringify({ type: 'test' }), 'utf8')
    const lockingScript = buildPushDropScript(key.toPublicKey(), [certBytes])

    const tx = new Transaction()
    tx.addOutput({ lockingScript, satoshis: 1000 })

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  // Full valid test: requires constructing a real VerifiableCertificate signed by the
  // subject's wallet with counterparty='anyone', then verified by ProtoWallet('anyone')
  // and certificate.verify() against the certifier's signature. This requires:
  //   - A real certifier wallet to sign the certificate fields
  //   - A real subject wallet to create the PushDrop signature
  //   - The certificate's decryptFields to return at least one public attribute
  // Skipping until ProtoWallet certificate construction utilities are available.
  test.skip('admits a valid IdentityTopicManager output with real VerifiableCertificate', async () => {
    // requires ProtoWallet certificate construction
  })

  it('getDocumentation returns a non-empty string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('Identity Topic Manager')
    expect(typeof meta.shortDescription).toBe('string')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })
})
