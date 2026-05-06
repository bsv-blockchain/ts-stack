/**
 * Integration tests for DIDTopicManager.
 *
 * DIDTopicManager decodes each output with PushDrop.decode and expects
 * exactly 2 fields: [serialNumber, signature]. Any output without exactly
 * 2 fields is rejected.
 *
 * The transaction must also have at least 1 input; otherwise it is rejected
 * globally before per-output checks.
 */

import { LockingScript, PrivateKey, PublicKey, Script, Transaction, Utils } from '@bsv/sdk'
import DIDTopicManager from '../did/DIDTopicManager.js'

// ---------------------------------------------------------------------------
// Helpers — same PushDrop-format script builder used in other test files
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

/**
 * Build a transaction with at least 1 input (required by DIDTopicManager) and
 * the given output locking scripts.
 */
function buildTxWithInput(outputScripts: LockingScript[]): Transaction {
  const sourceTx = new Transaction()
  const key = PrivateKey.fromRandom()
  sourceTx.addOutput({
    lockingScript: new LockingScript([]),
    satoshis: 10000
  })

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DIDTopicManager', () => {
  let manager: DIDTopicManager

  beforeEach(() => {
    manager = new DIDTopicManager()
  })

  it('admits a valid 2-field PushDrop output [serialNumber, signature]', async () => {
    const privKey = PrivateKey.fromRandom()
    const serialNumber = Utils.toArray('did:bsv:abc123', 'utf8')
    const sigBytes = (privKey.sign(serialNumber).toDER()) as number[]

    const lockingScript = buildPushDropScript(privKey.toPublicKey(), [serialNumber, sigBytes])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('rejects a 1-field PushDrop output (wrong field count)', async () => {
    const privKey = PrivateKey.fromRandom()
    const serialNumber = Utils.toArray('did:bsv:abc123', 'utf8')

    const lockingScript = buildPushDropScript(privKey.toPublicKey(), [serialNumber])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a 3-field PushDrop output (too many fields)', async () => {
    const privKey = PrivateKey.fromRandom()
    const f1 = Utils.toArray('field1', 'utf8')
    const f2 = Utils.toArray('field2', 'utf8')
    const f3 = Utils.toArray('field3', 'utf8')

    const lockingScript = buildPushDropScript(privKey.toPublicKey(), [f1, f2, f3])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('admits multiple valid outputs in a single transaction', async () => {
    const privKey = PrivateKey.fromRandom()

    const makeScript = (serial: string) => {
      const sn = Utils.toArray(serial, 'utf8')
      const sig = (privKey.sign(sn).toDER()) as number[]
      return buildPushDropScript(privKey.toPublicKey(), [sn, sig])
    }

    const tx = buildTxWithInput([
      makeScript('did:bsv:001'),
      makeScript('did:bsv:002')
    ])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.outputsToAdmit).toContain(1)
  })

  it('returns empty results for malformed BEEF', async () => {
    const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('returns empty results for a transaction with no inputs', async () => {
    // DIDTopicManager requires at least 1 input
    const privKey = PrivateKey.fromRandom()
    const sn = Utils.toArray('did:bsv:noinput', 'utf8')
    const sig = (privKey.sign(sn).toDER()) as number[]
    const lockingScript = buildPushDropScript(privKey.toPublicKey(), [sn, sig])

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
    expect(meta.name).toBe('DID Topic Manager')
  })
})
