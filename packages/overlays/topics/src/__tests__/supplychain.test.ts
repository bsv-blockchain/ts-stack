/**
 * Integration tests for SupplyChainTopicManager.
 *
 * SupplyChainTopicManager validates each output by inspecting the raw script chunks:
 *   chunks.length === 5
 *   chunks[0].op > 0          (push: data chunk 1 — e.g. some hash/data)
 *   chunks[1].op > 0          (push: data chunk 2)
 *   chunks[2].op === OP_2DROP (0x6d)
 *   chunks[3].op === 33       (push 33 bytes — compressed pubkey)
 *   chunks[4].op === OP_CHECKSIG (0xac)
 *
 * coinsToRetain is always set to previousCoins.
 */

import { LockingScript, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import SupplyChainTopicManager from '../supplychain/SupplyChainTopicManager.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/**
 * Build a valid SupplyChain locking script.
 *
 * Structure: <data1> <data2> OP_2DROP <33-byte-pubkey> OP_CHECKSIG
 *   - chunks[0]: push non-empty data (e.g. a 32-byte hash)
 *   - chunks[1]: push non-empty data (e.g. another 32-byte hash)
 *   - chunks[2]: OP_2DROP (0x6d)
 *   - chunks[3]: push exactly 33 bytes (compressed pubkey) → op === 33
 *   - chunks[4]: OP_CHECKSIG (0xac)
 */
function buildSupplyChainScript(privKey: PrivateKey): LockingScript {
  const hash1 = new Array(32).fill(0xaa)  // 32-byte placeholder
  const hash2 = new Array(32).fill(0xbb)  // 32-byte placeholder
  const pubKeyBytes = Utils.toArray(privKey.toPublicKey().toString(), 'hex') // 33 bytes compressed

  return new LockingScript([
    { op: hash1.length, data: hash1 },  // push 32 bytes — op = 32 (> 0) ✓
    { op: hash2.length, data: hash2 },  // push 32 bytes — op = 32 (> 0) ✓
    { op: 0x6d },                        // OP_2DROP ✓
    { op: pubKeyBytes.length, data: pubKeyBytes }, // op = 33 ✓
    { op: 0xac }                         // OP_CHECKSIG ✓
  ])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SupplyChainTopicManager', () => {
  let manager: SupplyChainTopicManager

  beforeEach(() => {
    manager = new SupplyChainTopicManager()
  })

  it('admits a valid 5-chunk SupplyChain output', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildSupplyChainScript(privKey)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits multiple valid SupplyChain outputs in a single tx', async () => {
    const key1 = PrivateKey.fromRandom()
    const key2 = PrivateKey.fromRandom()
    const tx = buildTxWithInput([
      buildSupplyChainScript(key1),
      buildSupplyChainScript(key2)
    ])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.outputsToAdmit).toContain(1)
  })

  it('rejects a script with only 4 chunks (missing OP_CHECKSIG)', async () => {
    const privKey = PrivateKey.fromRandom()
    const hash1 = new Array(32).fill(0xaa)
    const hash2 = new Array(32).fill(0xbb)
    const pubKeyBytes = Utils.toArray(privKey.toPublicKey().toString(), 'hex')

    const badScript = new LockingScript([
      { op: hash1.length, data: hash1 },
      { op: hash2.length, data: hash2 },
      { op: 0x6d },  // OP_2DROP
      { op: pubKeyBytes.length, data: pubKeyBytes }
      // missing OP_CHECKSIG
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a script where chunks[2] is not OP_2DROP', async () => {
    const privKey = PrivateKey.fromRandom()
    const hash1 = new Array(32).fill(0xaa)
    const hash2 = new Array(32).fill(0xbb)
    const pubKeyBytes = Utils.toArray(privKey.toPublicKey().toString(), 'hex')

    const badScript = new LockingScript([
      { op: hash1.length, data: hash1 },
      { op: hash2.length, data: hash2 },
      { op: 0x75 },  // OP_DROP (wrong — should be OP_2DROP)
      { op: pubKeyBytes.length, data: pubKeyBytes },
      { op: 0xac }
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a script where chunks[3] is not a 33-byte push', async () => {
    const hash1 = new Array(32).fill(0xaa)
    const hash2 = new Array(32).fill(0xbb)
    const shortPubkey = new Array(20).fill(0xcc)  // only 20 bytes (wrong)

    const badScript = new LockingScript([
      { op: hash1.length, data: hash1 },
      { op: hash2.length, data: hash2 },
      { op: 0x6d },  // OP_2DROP
      { op: shortPubkey.length, data: shortPubkey },  // op = 20 (not 33)
      { op: 0xac }
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a P2PKH script', async () => {
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

  it('retains previousCoins when outputs are admitted', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildSupplyChainScript(privKey)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [3, 7, 11])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([3, 7, 11])
  })

  it('retains previousCoins even when no outputs are admitted', async () => {
    const badScript = new LockingScript([{ op: 0x51 }]) // OP_1
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [42])
    expect(result.outputsToAdmit).toHaveLength(0)
    expect(result.coinsToRetain).toEqual([42])
  })

  it('returns empty results for malformed BEEF', async () => {
    const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('getDocumentation returns a non-empty string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('SupplyChain Topic Manager')
  })
})
