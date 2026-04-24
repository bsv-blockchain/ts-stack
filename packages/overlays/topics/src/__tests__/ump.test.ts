/**
 * Integration tests for UMPTopicManager (tm_users).
 *
 * UMPTopicManager expects a PushDrop locking script with ≥ 11 fields.
 * If ≥ 12 fields are present and field[11] or field[12] has length 1, it
 * treats the token as v3 and additionally validates:
 *   - field[v3VersionIndex][0] === 3
 *   - field[kdfAlgIndex] is 'argon2id' or 'pbkdf2-sha512'
 *   - field[kdfParamsIndex] is JSON with { iterations: number > 0 }
 *
 * Any output that passes these checks is admitted.
 */

import { LockingScript, PrivateKey, PublicKey, Transaction, Utils } from '@bsv/sdk'
import UMPTopicManager from '../ump/UMPTopicManager.js'

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
    unlockingScript: new LockingScript([])
  })

  for (const ls of outputScripts) {
    tx.addOutput({ lockingScript: ls, satoshis: 1000 })
  }

  return tx
}

/** Make n arbitrary non-empty data fields */
function makeFields(n: number): number[][] {
  return Array.from({ length: n }, (_, i) => [i + 1, 0xaa, 0xbb])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UMPTopicManager', () => {
  let manager: UMPTopicManager

  beforeEach(() => {
    manager = new UMPTopicManager()
  })

  it('admits a valid ≥11-field PushDrop (non-v3)', async () => {
    const key = PrivateKey.fromRandom()
    // 11 fields — exactly the minimum
    const fields = makeFields(11)
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits a valid 13-field PushDrop (non-v3, field[11] length > 1)', async () => {
    const key = PrivateKey.fromRandom()
    // 13 fields where field[11] has length > 1 (not a v3 version byte)
    const fields = makeFields(11)
    fields.push([0x01, 0x02, 0x03]) // field[11]: length 3, not a v3 marker
    fields.push([0x04, 0x05])       // field[12]
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('rejects a PushDrop with only 10 fields (insufficient)', async () => {
    const key = PrivateKey.fromRandom()
    const fields = makeFields(10)
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
    expect(result.outputsToAdmit).toHaveLength(0)
  })

  it('rejects a PushDrop with 0 fields', async () => {
    const key = PrivateKey.fromRandom()
    // An empty PushDrop — no fields
    const lockingScript = buildPushDropScript(key.toPublicKey(), [[0x01]])
    // Build it with only 1 field — still < 11
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('admits a valid v3 PushDrop (field[11] = [3], valid kdfAlgorithm, valid kdfParams)', async () => {
    const key = PrivateKey.fromRandom()
    // 11 base fields + field[11]=[3] (version byte) + field[12]=kdfAlg + field[13]=kdfParams
    const fields = makeFields(11)
    fields.push([3])  // field[11]: v3 version byte
    fields.push(Array.from(new TextEncoder().encode('argon2id')))
    fields.push(Array.from(new TextEncoder().encode(JSON.stringify({ iterations: 3 }))))
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('rejects a v3 PushDrop with unsupported kdfAlgorithm', async () => {
    const key = PrivateKey.fromRandom()
    const fields = makeFields(11)
    fields.push([3])  // version byte at index 11
    fields.push(Array.from(new TextEncoder().encode('md5')))  // unsupported
    fields.push(Array.from(new TextEncoder().encode(JSON.stringify({ iterations: 3 }))))
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a v3 PushDrop with invalid kdfParams (iterations=0)', async () => {
    const key = PrivateKey.fromRandom()
    const fields = makeFields(11)
    fields.push([3])
    fields.push(Array.from(new TextEncoder().encode('pbkdf2-sha512')))
    fields.push(Array.from(new TextEncoder().encode(JSON.stringify({ iterations: 0 }))))
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a P2PKH script (not a PushDrop)', async () => {
    const badScript = new LockingScript([
      { op: 0x76 }, // OP_DUP
      { op: 0xa9 }, // OP_HASH160
      { op: 0x88 }, // OP_EQUALVERIFY
      { op: 0xac }  // OP_CHECKSIG
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toHaveLength(0)
  })

  it('passes previousCoins through to coinsToRetain', async () => {
    const key = PrivateKey.fromRandom()
    const fields = makeFields(11)
    const lockingScript = buildPushDropScript(key.toPublicKey(), fields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [5, 10])
    expect(result.coinsToRetain).toEqual([5, 10])
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
    expect(meta.name).toBe('User Management Protocol')
  })
})
