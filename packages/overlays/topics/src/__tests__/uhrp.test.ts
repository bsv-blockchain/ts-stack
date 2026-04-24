/**
 * Integration tests for UHRPTopicManager.
 *
 * UHRPTopicManager expects a PushDrop locking script with at least 5 fields:
 *   [hostIdentityKey (hex pubkey bytes), fileHash (32 bytes), url (https), expiryTime (varint), fileSize (varint), signature]
 *
 * The signature is validated by isTokenSignatureCorrectlyLinked, which:
 *   1. Pops the last field (signature) from fields
 *   2. Uses counterparty = identityKey (field[0] as hex)
 *   3. protocolID: [2, 'uhrp advertisement'], keyID: '1'
 *   4. Verifies the signature and checks that lockingPublicKey matches derived key
 *
 * To create a valid token:
 *   - Create a host wallet (ProtoWallet from a PrivateKey)
 *   - Call createSignature with counterparty='anyone', protocolID=[2,'uhrp advertisement'], keyID='1'
 *   - The locking public key is derived by anyoneWallet.getPublicKey({counterparty: hostPubKey, protocolID, keyID})
 */

import { LockingScript, PrivateKey, PublicKey, Script, Transaction, Utils, ProtoWallet, WalletProtocol } from '@bsv/sdk'
import UHRPTopicManager from '../uhrp/UHRPTopicManager.js'

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

const PROTOCOL_ID: WalletProtocol = [2, 'uhrp advertisement']
const KEY_ID = '1'

function writeVarInt(n: number): number[] {
  if (n < 0xfd) return [n]
  if (n <= 0xffff) return [0xfd, n & 0xff, (n >> 8) & 0xff]
  return [0xfe, n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]
}

/**
 * Build a valid UHRP locking script.
 *
 * Fields (before signature):
 *   [0] hostIdentityKey — compressed pubkey bytes
 *   [1] fileHash — 32 bytes
 *   [2] url — UTF-8 bytes of an https URL
 *   [3] expiryTime — varint
 *   [4] fileSize — varint
 *   [5] signature — ProtoWallet signature over fields[0..4]
 *
 * Locking key: anyoneWallet.getPublicKey({counterparty: hostPubKeyHex, protocolID, keyID})
 */
async function buildValidUHRPScript(hostPrivKey: PrivateKey): Promise<LockingScript> {
  const hostPubKeyHex = hostPrivKey.toPublicKey().toString()
  const hostPubKeyBytes = Utils.toArray(hostPubKeyHex, 'hex')

  const fileHash = Array.from({ length: 32 }, (_, i) => i + 1) // 32 non-zero bytes
  const url = Utils.toArray('https://example.com/file.bin', 'utf8')
  const expiryTime = writeVarInt(Math.floor(Date.now() / 1000) + 3600)
  const fileSize = writeVarInt(1024)

  const dataFields = [hostPubKeyBytes, fileHash, url, expiryTime, fileSize]
  const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

  const hostWallet = new ProtoWallet(hostPrivKey)
  const { signature } = await hostWallet.createSignature({
    data,
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: 'anyone'
  })

  const anyoneWallet = new ProtoWallet('anyone')
  const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: hostPubKeyHex
  })
  const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

  return buildPushDropScript(lockingPubKey, [...dataFields, Array.from(signature)])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UHRPTopicManager', () => {
  let manager: UHRPTopicManager

  beforeEach(() => {
    manager = new UHRPTopicManager()
  })

  it('admits a valid 5-field UHRP token', async () => {
    const hostPrivKey = PrivateKey.fromRandom()
    const lockingScript = await buildValidUHRPScript(hostPrivKey)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('rejects a 4-field token (missing fileSize)', async () => {
    const key = PrivateKey.fromRandom()
    const pubKeyBytes = Utils.toArray(key.toPublicKey().toString(), 'hex')
    const fileHash = Array.from({ length: 32 }, () => 0xab)
    const url = Utils.toArray('https://example.com/file.bin', 'utf8')
    const expiryTime = writeVarInt(9999999)
    // Only 4 data fields — fileSize is missing
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [pubKeyBytes, fileHash, url, expiryTime, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with a non-HTTPS URL', async () => {
    const hostPrivKey = PrivateKey.fromRandom()
    const hostPubKeyHex = hostPrivKey.toPublicKey().toString()
    const hostPubKeyBytes = Utils.toArray(hostPubKeyHex, 'hex')

    const fileHash = Array.from({ length: 32 }, (_, i) => i + 1)
    const url = Utils.toArray('http://example.com/file.bin', 'utf8') // http, not https
    const expiryTime = writeVarInt(9999999)
    const fileSize = writeVarInt(1024)

    const dataFields = [hostPubKeyBytes, fileHash, url, expiryTime, fileSize]
    const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

    const hostWallet = new ProtoWallet(hostPrivKey)
    const { signature } = await hostWallet.createSignature({
      data,
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: 'anyone'
    })

    const anyoneWallet = new ProtoWallet('anyone')
    const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: hostPubKeyHex
    })
    const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

    const lockingScript = buildPushDropScript(lockingPubKey, [...dataFields, Array.from(signature)])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with an invalid signature (wrong signer)', async () => {
    const hostPrivKey = PrivateKey.fromRandom()
    const hostPubKeyHex = hostPrivKey.toPublicKey().toString()
    const hostPubKeyBytes = Utils.toArray(hostPubKeyHex, 'hex')

    const fileHash = Array.from({ length: 32 }, (_, i) => i + 1)
    const url = Utils.toArray('https://example.com/file.bin', 'utf8')
    const expiryTime = writeVarInt(9999999)
    const fileSize = writeVarInt(1024)

    const dataFields = [hostPubKeyBytes, fileHash, url, expiryTime, fileSize]
    const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

    // Sign with a DIFFERENT key than the identity key
    const wrongKey = PrivateKey.fromRandom()
    const wrongWallet = new ProtoWallet(wrongKey)
    const { signature } = await wrongWallet.createSignature({
      data,
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: 'anyone'
    })

    // Locking key derived from the declared identity (hostPubKeyHex)
    const anyoneWallet = new ProtoWallet('anyone')
    const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
      protocolID: PROTOCOL_ID,
      keyID: KEY_ID,
      counterparty: hostPubKeyHex
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

  it('getDocumentation returns a string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('Universal Hash Resolution Protocol')
  })
})
