/**
 * Integration tests for AppsTopicManager.
 *
 * AppsTopicManager expects a PushDrop locking script with exactly 2 fields:
 *   [metadataJSON (bytes), signature (bytes)]
 *
 * The metadata must parse as valid JSON with required fields:
 *   version, name, description, icon, httpURL or uhrpURL, domain, publisher, release_date
 *
 * The signature is validated by isTokenSignatureCorrectlyLinked, which:
 *   1. Pops the last field (signature) from fields
 *   2. Creates a ProtoWallet('anyone') and calls verifySignature({
 *        data: metadataBytes,
 *        signature,
 *        counterparty: publisher,   <-- publisher is the signer's public key hex
 *        protocolID: [1, 'metanet apps'],
 *        keyID: '1'
 *      })
 *   3. Derives the expected locking public key from the same params and checks it matches
 *
 * To create a valid token:
 *   - Create a publisher wallet (ProtoWallet from a PrivateKey)
 *   - Call createSignature with counterparty='anyone', protocolID=[1,'metanet apps'], keyID='1'
 *   - The locking public key is derived by anyoneWallet.getPublicKey({counterparty: publisherPubKey, protocolID, keyID})
 *
 * The transaction must also have at least 1 input.
 */

import { LockingScript, PrivateKey, PublicKey, Script, Transaction, Utils, ProtoWallet, WalletProtocol } from '@bsv/sdk'
import AppsTopicManager from '../apps/AppsTopicManager.js'
import { PublishedAppMetadata } from '../apps/types.js'

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

const PROTOCOL_ID: WalletProtocol = [1, 'metanet apps']
const KEY_ID = '1'

/**
 * Build a valid AppsTopicManager locking script.
 *
 * The signature is produced by the publisher's wallet over the metadata bytes,
 * with counterparty='anyone'. The locking public key is the key that
 * anyoneWallet derives using counterparty=publisherPubKey.
 */
async function buildValidAppScript(publisherPrivKey: PrivateKey): Promise<LockingScript> {
  const publisherPubKeyHex = publisherPrivKey.toPublicKey().toString()

  const metadata: PublishedAppMetadata = {
    version: '0.1.0',
    name: 'Test App',
    description: 'A test application',
    icon: 'https://example.com/icon.png',
    httpURL: 'https://example.com',
    domain: 'example.com',
    publisher: publisherPubKeyHex,
    release_date: '2026-01-01'
  }

  const metadataBytes = Utils.toArray(JSON.stringify(metadata), 'utf8')

  // Sign: publisherWallet creates signature with counterparty='anyone'
  const publisherWallet = new ProtoWallet(publisherPrivKey)
  const { signature } = await publisherWallet.createSignature({
    data: metadataBytes,
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: 'anyone'
  })

  // Derive the locking public key: anyoneWallet derives it using counterparty=publisher
  const anyoneWallet = new ProtoWallet('anyone')
  const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: publisherPubKeyHex
  })
  const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

  return buildPushDropScript(lockingPubKey, [metadataBytes, Array.from(signature)])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppsTopicManager', () => {
  let manager: AppsTopicManager

  beforeEach(() => {
    manager = new AppsTopicManager()
  })

  it('admits a valid app metadata token', async () => {
    const publisherPrivKey = PrivateKey.fromRandom()
    const lockingScript = await buildValidAppScript(publisherPrivKey)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('rejects an output with a P2PKH script (not a PushDrop)', async () => {
    const key = PrivateKey.fromRandom()
    // Use a trivially invalid script that PushDrop.decode will fail on
    const badScript = new LockingScript([{ op: 0x76 }, { op: 0xa9 }, { op: 0x88 }, { op: 0xac }])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a 1-field PushDrop (missing signature field)', async () => {
    const key = PrivateKey.fromRandom()
    const metadataBytes = Utils.toArray('{"name":"test"}', 'utf8')
    const lockingScript = buildPushDropScript(key.toPublicKey(), [metadataBytes])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with invalid JSON metadata', async () => {
    const key = PrivateKey.fromRandom()
    const badBytes = Utils.toArray('not-json', 'utf8')
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [badBytes, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token where metadata is valid JSON but missing required fields', async () => {
    const key = PrivateKey.fromRandom()
    // Missing most required fields
    const incompleteMetadata = { name: 'Incomplete App' }
    const metadataBytes = Utils.toArray(JSON.stringify(incompleteMetadata), 'utf8')
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [metadataBytes, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token where the signature is invalid (wrong signer)', async () => {
    const publisherPrivKey = PrivateKey.fromRandom()
    const publisherPubKeyHex = publisherPrivKey.toPublicKey().toString()

    const metadata: PublishedAppMetadata = {
      version: '0.1.0',
      name: 'Bad Sig App',
      description: 'Test',
      icon: 'https://example.com/icon.png',
      httpURL: 'https://example.com',
      domain: 'example.com',
      publisher: publisherPubKeyHex,
      release_date: '2026-01-01'
    }

    const metadataBytes = Utils.toArray(JSON.stringify(metadata), 'utf8')

    // Sign with a different (wrong) key
    const wrongKey = PrivateKey.fromRandom()
    const wrongWallet = new ProtoWallet(wrongKey)
    const { signature } = await wrongWallet.createSignature({
      data: metadataBytes,
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: 'anyone'
    })

    // Derive the correct locking public key (based on publisher, not the wrong key)
    const anyoneWallet = new ProtoWallet('anyone')
    const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: publisherPubKeyHex
    })
    const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

    const lockingScript = buildPushDropScript(lockingPubKey, [metadataBytes, Array.from(signature)])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('returns empty results for malformed BEEF', async () => {
    const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('returns empty results for a transaction with no inputs', async () => {
    // AppsTopicManager requires at least 1 input
    const publisherPrivKey = PrivateKey.fromRandom()
    const lockingScript = await buildValidAppScript(publisherPrivKey)

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
    expect(meta.name).toBe('Apps Topic Manager')
    expect(meta.version).toBe('0.1.0')
  })
})
