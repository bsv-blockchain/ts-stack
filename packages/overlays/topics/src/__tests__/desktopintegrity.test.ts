/**
 * Integration tests for DesktopIntegrityTopicManager.
 *
 * DesktopIntegrityTopicManager validates each output by checking the raw script chunks:
 *   chunks.length === 2
 *   chunks[0].op === OP_FALSE (0x00)
 *   chunks[1].op === OP_RETURN (0x6a)
 *
 * This is an OP_FALSE OP_RETURN locking script (bare data carrier).
 * Any output with exactly these 2 opcodes is admitted.
 */

import { LockingScript, Transaction } from '@bsv/sdk'
import DesktopIntegrityTopicManager from '../desktopintegrity/DesktopIntegrityTopicManager.js'

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
 * Build a valid DesktopIntegrity locking script.
 *
 * Script: OP_FALSE (0x00) + OP_RETURN (0x6a)
 * The source checks exactly 2 chunks: chunks[0].op === OP_FALSE, chunks[1].op === OP_RETURN.
 */
function buildDesktopIntegrityScript(): LockingScript {
  return new LockingScript([
    { op: 0x00 }, // OP_FALSE
    { op: 0x6a }  // OP_RETURN
  ])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DesktopIntegrityTopicManager', () => {
  let manager: DesktopIntegrityTopicManager

  beforeEach(() => {
    manager = new DesktopIntegrityTopicManager()
  })

  it('admits a valid OP_FALSE OP_RETURN output (bare 2-chunk script)', async () => {
    const lockingScript = buildDesktopIntegrityScript()
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('admits multiple valid OP_FALSE OP_RETURN outputs in one transaction', async () => {
    const tx = buildTxWithInput([
      buildDesktopIntegrityScript(),
      buildDesktopIntegrityScript()
    ])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.outputsToAdmit).toContain(1)
  })

  it('rejects a script with wrong first opcode (not OP_FALSE)', async () => {
    // OP_1 (0x51) + OP_RETURN — wrong first opcode
    const badScript = new LockingScript([
      { op: 0x51 }, // OP_1
      { op: 0x6a }  // OP_RETURN
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a script with wrong second opcode (not OP_RETURN)', async () => {
    // OP_FALSE + OP_EQUAL — wrong second opcode
    const badScript = new LockingScript([
      { op: 0x00 }, // OP_FALSE
      { op: 0x87 }  // OP_EQUAL (wrong)
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a script where the second opcode is not OP_RETURN (uses OP_DROP instead)', async () => {
    // OP_FALSE + OP_DROP (0x75) — second opcode is not OP_RETURN
    const badScript = new LockingScript([
      { op: 0x00 }, // OP_FALSE
      { op: 0x75 }  // OP_DROP (wrong)
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a 1-chunk script (too short)', async () => {
    const badScript = new LockingScript([
      { op: 0x6a } // OP_RETURN only
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a P2PKH script', async () => {
    const pubkeyHash = new Array(20).fill(0xab)
    const badScript = new LockingScript([
      { op: 0x76 },                           // OP_DUP
      { op: 0xa9 },                           // OP_HASH160
      { op: 20, data: pubkeyHash },           // <20-byte hash>
      { op: 0x88 },                           // OP_EQUALVERIFY
      { op: 0xac }                            // OP_CHECKSIG
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('admits only valid outputs when mixed with invalid ones', async () => {
    const validScript = buildDesktopIntegrityScript()
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
    expect(meta.name).toBe('DesktopIntegrity Topic Manager')
  })
})
