/**
 * Integration tests for MessageBoxTopicManager.
 *
 * MessageBoxTopicManager expects a PushDrop locking script with 3 fields:
 *   [identityKey (compressed pubkey bytes), host (UTF-8 string bytes), signature]
 *
 * Validation:
 *   - fields[0] = identityKey bytes (non-empty)
 *   - fields[1] = host bytes (non-empty, valid UTF-8)
 *   - fields[2] = signature (popped off before verification)
 *   - anyoneWallet.verifySignature({
 *       data: concat(fields[0], fields[1]),
 *       signature,
 *       counterparty: identityKey (as hex string),
 *       protocolID: [1, 'messagebox advertisement'],
 *       keyID: '1'
 *     }) must be valid
 *
 * No minimum input requirement (MessageBoxTopicManager does not check inputs).
 *
 * To build a valid token:
 *   - identityKey = identityWallet's public key hex
 *   - Sign data with identityWallet.createSignature({counterparty:'anyone', protocolID:[1,'messagebox advertisement'], keyID:'1'})
 *   - The locking public key can be any key (MessageBoxTopicManager uses the
 *     identity key for signature verification, not the locking key for key derivation check)
 *   - For the locking key, use anyoneWallet.getPublicKey({counterparty: identityKey, protocolID, keyID})
 */

import { LockingScript, PrivateKey, PublicKey, Script, Transaction, Utils, ProtoWallet, WalletProtocol } from '@bsv/sdk'
import MessageBoxTopicManager from '../message-box/MessageBoxTopicManager.js'

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

const PROTOCOL_ID: WalletProtocol = [1, 'messagebox advertisement']
const KEY_ID = '1'

async function buildValidMessageBoxScript(identityPrivKey: PrivateKey): Promise<LockingScript> {
  const identityPubKeyHex = identityPrivKey.toPublicKey().toString()
  const identityKeyBytes = Utils.toArray(identityPubKeyHex, 'hex')
  const hostBytes = Utils.toArray('https://msgbox.example.com', 'utf8')

  // data = identityKeyBytes + hostBytes (fields[0] + fields[1])
  const data = [...identityKeyBytes, ...hostBytes]

  const identityWallet = new ProtoWallet(identityPrivKey)
  const { signature } = await identityWallet.createSignature({
    data,
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: 'anyone'
  })

  // Locking public key derived from the identity key
  const anyoneWallet = new ProtoWallet('anyone')
  const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
    protocolID: PROTOCOL_ID,
    keyID: KEY_ID,
    counterparty: identityPubKeyHex
  })
  const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

  return buildPushDropScript(lockingPubKey, [identityKeyBytes, hostBytes, Array.from(signature)])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageBoxTopicManager', () => {
  let manager: MessageBoxTopicManager

  beforeEach(() => {
    manager = new MessageBoxTopicManager()
  })

  it('admits a valid messagebox advertisement token', async () => {
    const identityPrivKey = PrivateKey.fromRandom()
    const lockingScript = await buildValidMessageBoxScript(identityPrivKey)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('rejects a token with empty identity key field', async () => {
    const key = PrivateKey.fromRandom()
    const emptyIdentity: number[] = []
    const hostBytes = Utils.toArray('https://msgbox.example.com', 'utf8')
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [emptyIdentity, hostBytes, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with empty host field', async () => {
    const key = PrivateKey.fromRandom()
    const identityKeyBytes = Utils.toArray(key.toPublicKey().toString(), 'hex')
    const emptyHost: number[] = []
    const fakeSignature = Array.from({ length: 71 }, (_, i) => i % 256)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [identityKeyBytes, emptyHost, fakeSignature])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a token with an invalid signature (wrong signer)', async () => {
    const identityPrivKey = PrivateKey.fromRandom()
    const identityPubKeyHex = identityPrivKey.toPublicKey().toString()
    const identityKeyBytes = Utils.toArray(identityPubKeyHex, 'hex')
    const hostBytes = Utils.toArray('https://msgbox.example.com', 'utf8')

    const data = [...identityKeyBytes, ...hostBytes]

    // Sign with a DIFFERENT key
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
      counterparty: identityPubKeyHex
    })
    const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

    const lockingScript = buildPushDropScript(lockingPubKey, [identityKeyBytes, hostBytes, Array.from(signature)])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('returns empty results (or throws) for malformed BEEF', async () => {
    // MessageBoxTopicManager does not wrap Transaction.fromBEEF in a try/catch,
    // so malformed BEEF causes it to throw. Either way no outputs are admitted.
    let outputsToAdmit: number[] = []
    try {
      const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
      outputsToAdmit = result.outputsToAdmit
    } catch {
      // Expected: manager throws on invalid BEEF
    }
    expect(outputsToAdmit).toEqual([])
  })

  it('getDocumentation returns a string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('MessageBox Topic Manager')
  })
})
