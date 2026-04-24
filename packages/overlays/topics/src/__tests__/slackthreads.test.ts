/**
 * Integration tests for SlackThreadsTopicManager.
 *
 * SlackThreadsTopicManager validates each output by checking the raw script chunks:
 *   chunks.length === 3
 *   chunks[0].op === OP_SHA256 (0xa8)
 *   chunks[1].op === 32        (push exactly 32 bytes — a SHA-256 hash)
 *   chunks[2].op === OP_EQUAL  (0x87)
 *
 * This is a hash-puzzle locking script: OP_SHA256 <32-byte-hash> OP_EQUAL
 * It is spent by providing a preimage whose SHA-256 equals the stored hash.
 */

import { LockingScript, Transaction } from '@bsv/sdk'
import SlackThreadsTopicManager from '../slackthreads/SlackThreadsTopicManager.js'

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
 * Build a valid SlackThreads hash-puzzle locking script.
 *
 * Script: OP_SHA256 (0xa8) + push(32-byte hash) + OP_EQUAL (0x87)
 * The op of the push chunk must equal exactly 32 (the byte count),
 * which is what the topic manager checks for (chunks[1].op === 32).
 */
function buildHashPuzzleScript(hash: Uint8Array | number[]): LockingScript {
  const hashBytes = Array.from(hash)
  if (hashBytes.length !== 32) throw new Error('Hash must be exactly 32 bytes')
  return new LockingScript([
    { op: 0xa8 },                          // OP_SHA256
    { op: 32, data: hashBytes },           // push 32 bytes (op === 32 ✓)
    { op: 0x87 }                           // OP_EQUAL
  ])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackThreadsTopicManager', () => {
  let manager: SlackThreadsTopicManager

  beforeEach(() => {
    manager = new SlackThreadsTopicManager()
  })

  it('admits a valid hash-puzzle output (32-byte hash of zeros)', async () => {
    const hash = new Uint8Array(32) // 32 zero bytes
    const lockingScript = buildHashPuzzleScript(hash)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('admits a valid hash-puzzle output (non-trivial hash)', async () => {
    const hash = new Uint8Array(32)
    for (let i = 0; i < 32; i++) hash[i] = (i * 7 + 13) % 256
    const lockingScript = buildHashPuzzleScript(hash)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits multiple valid hash-puzzle outputs in one transaction', async () => {
    const hash1 = new Uint8Array(32).fill(0x11)
    const hash2 = new Uint8Array(32).fill(0x22)
    const tx = buildTxWithInput([
      buildHashPuzzleScript(hash1),
      buildHashPuzzleScript(hash2)
    ])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.outputsToAdmit).toContain(1)
  })

  it('rejects a script with wrong first opcode (not OP_SHA256)', async () => {
    const hash = new Uint8Array(32)
    const badScript = new LockingScript([
      { op: 0xa9 },                    // OP_HASH160 (wrong — should be OP_SHA256 0xa8)
      { op: 32, data: Array.from(hash) },
      { op: 0x87 }
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a script where hash is not 32 bytes (chunks[1].op !== 32)', async () => {
    // Use a 20-byte hash instead of 32 bytes — op will be 20, not 32
    const hash20 = new Array(20).fill(0xab)
    const badScript = new LockingScript([
      { op: 0xa8 },                     // OP_SHA256 ✓
      { op: 20, data: hash20 },         // op === 20 (wrong — should be 32)
      { op: 0x87 }
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a script with wrong last opcode (not OP_EQUAL)', async () => {
    const hash = new Uint8Array(32)
    const badScript = new LockingScript([
      { op: 0xa8 },
      { op: 32, data: Array.from(hash) },
      { op: 0x88 }   // OP_EQUALVERIFY (wrong — should be OP_EQUAL 0x87)
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a script with 4 chunks (wrong length)', async () => {
    const hash = new Uint8Array(32)
    const badScript = new LockingScript([
      { op: 0xa8 },
      { op: 32, data: Array.from(hash) },
      { op: 0x87 },
      { op: 0x51 }  // extra chunk
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a 2-chunk script (too short)', async () => {
    const hash = new Uint8Array(32)
    const badScript = new LockingScript([
      { op: 0xa8 },
      { op: 32, data: Array.from(hash) }
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

  it('admits only valid outputs when mixed with invalid ones', async () => {
    const hash = new Uint8Array(32).fill(0xff)
    const validScript = buildHashPuzzleScript(hash)
    const invalidScript = new LockingScript([{ op: 0x51 }]) // OP_1

    const tx = buildTxWithInput([invalidScript, validScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
    expect(result.outputsToAdmit).toContain(1)
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
    expect(meta.name).toBe('SlackThreads Topic Manager')
  })
})
