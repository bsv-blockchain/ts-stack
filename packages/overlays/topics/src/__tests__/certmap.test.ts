/**
 * Integration tests for CertMapTopicManager.
 *
 * CertMapTopicManager expects a PushDrop locking script with 8 fields:
 *   [type, name, iconURL, description, documentationURL, certFields (JSON object), registryOperator, signature]
 *
 * Validation:
 *   - All 7 string/object fields must be present and valid types
 *   - certFields (fields[5]) must parse as a valid JSON object
 *   - The locking public key must equal keyDeriver.derivePublicKey([1,'certmap'],'1',registryOperator)
 *   - anyoneWallet.verifySignature({
 *       data: concat(fields[0..6]),
 *       signature: fields.pop(),
 *       counterparty: registryOperator,
 *       protocolID: [1, 'certmap'],
 *       keyID: '1'
 *     }) must be valid
 *
 * The transaction must have at least 1 input.
 *
 * To build a valid token:
 *   - registryOperator = registryWallet's public key hex
 *   - Sign with registryWallet.createSignature({counterparty:'anyone', protocolID:[1,'certmap'], keyID:'1'})
 *   - Locking key = anyoneWallet.getPublicKey({counterparty: registryOperator, protocolID, keyID})
 */

import { LockingScript, PrivateKey, PublicKey, Script, Transaction, Utils, ProtoWallet, WalletProtocol } from '@bsv/sdk'
import CertMapTopicManager from '../certmap/CertMapTopicManager.js'

// ---------------------------------------------------------------------------
// Helpers
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
    unlockingScript: new Script()
  })

  for (const ls of outputScripts) {
    tx.addOutput({ lockingScript: ls, satoshis: 1000 })
  }

  return tx
}

const PROTOCOL_ID: WalletProtocol = [1, 'certmap']
const KEY_ID = '1'

async function buildValidCertMapScript(registryPrivKey: PrivateKey): Promise<LockingScript> {
  const registryOperator = registryPrivKey.toPublicKey().toString()

  const certFields = { name: { type: 'string' }, email: { type: 'string' }, age: { type: 'number' } }

  const dataFields = [
    Utils.toArray('identity-cert-v1', 'utf8'),                   // type
    Utils.toArray('Identity Certificate', 'utf8'),                // name
    Utils.toArray('https://example.com/icon.png', 'utf8'),       // iconURL
    Utils.toArray('An identity certificate for testing', 'utf8'), // description
    Utils.toArray('https://docs.example.com/cert', 'utf8'),      // documentationURL
    Utils.toArray(JSON.stringify(certFields), 'utf8'),            // certFields (JSON)
    Utils.toArray(registryOperator, 'utf8'),                     // registryOperator
  ]

  const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

  const registryWallet = new ProtoWallet(registryPrivKey)
  const { signature } = await registryWallet.createSignature({
    data,
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: 'anyone'
  })

  const anyoneWallet = new ProtoWallet('anyone')
  const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: registryOperator
  })
  const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

  return buildPushDropScript(lockingPubKey, [...dataFields, Array.from(signature)])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CertMapTopicManager', () => {
  let manager: CertMapTopicManager

  beforeEach(() => {
    manager = new CertMapTopicManager()
  })

  it('admits a valid certmap token with all 7 fields', async () => {
    const registryPrivKey = PrivateKey.fromRandom()
    const lockingScript = await buildValidCertMapScript(registryPrivKey)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('rejects a token with invalid certFields JSON (not an object)', async () => {
    const registryPrivKey = PrivateKey.fromRandom()
    const registryOperator = registryPrivKey.toPublicKey().toString()

    const dataFields = [
      Utils.toArray('identity-cert-v1', 'utf8'),
      Utils.toArray('Identity Certificate', 'utf8'),
      Utils.toArray('https://example.com/icon.png', 'utf8'),
      Utils.toArray('Description', 'utf8'),
      Utils.toArray('https://docs.example.com/cert', 'utf8'),
      Utils.toArray('not-valid-json', 'utf8'),                   // invalid certFields — not JSON
      Utils.toArray(registryOperator, 'utf8'),
    ]
    const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

    const registryWallet = new ProtoWallet(registryPrivKey)
    const { signature } = await registryWallet.createSignature({
      data,
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: 'anyone'
    })

    const anyoneWallet = new ProtoWallet('anyone')
    const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: registryOperator
    })
    const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

    const lockingScript = buildPushDropScript(lockingPubKey, [...dataFields, Array.from(signature)])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with missing fields (only 3 provided)', async () => {
    const key = PrivateKey.fromRandom()
    const f1 = Utils.toArray('identity-cert-v1', 'utf8')
    const f2 = Utils.toArray('Identity Certificate', 'utf8')
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [f1, f2, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with an invalid signature (wrong signer)', async () => {
    const registryPrivKey = PrivateKey.fromRandom()
    const registryOperator = registryPrivKey.toPublicKey().toString()

    const certFields = { name: { type: 'string' } }
    const dataFields = [
      Utils.toArray('identity-cert-v1', 'utf8'),
      Utils.toArray('Identity Certificate', 'utf8'),
      Utils.toArray('https://example.com/icon.png', 'utf8'),
      Utils.toArray('An identity certificate for testing', 'utf8'),
      Utils.toArray('https://docs.example.com/cert', 'utf8'),
      Utils.toArray(JSON.stringify(certFields), 'utf8'),
      Utils.toArray(registryOperator, 'utf8'),
    ]
    const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

    const wrongKey = PrivateKey.fromRandom()
    const wrongWallet = new ProtoWallet(wrongKey)
    const { signature } = await wrongWallet.createSignature({
      data,
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: 'anyone'
    })

    const anyoneWallet = new ProtoWallet('anyone')
    const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: registryOperator
    })
    const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

    const lockingScript = buildPushDropScript(lockingPubKey, [...dataFields, Array.from(signature)])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('returns empty results for malformed BEEF', async () => {
    const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('returns empty for a transaction with no inputs', async () => {
    const registryPrivKey = PrivateKey.fromRandom()
    const lockingScript = await buildValidCertMapScript(registryPrivKey)

    const tx = new Transaction()
    tx.addOutput({ lockingScript, satoshis: 1000 })

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('getDocumentation returns a string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('CertMap Topic Manager')
  })
})
