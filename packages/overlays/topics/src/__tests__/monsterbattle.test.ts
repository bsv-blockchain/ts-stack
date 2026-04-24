/**
 * Integration tests for MonsterBattleTopicManager.
 *
 * MonsterBattleTopicManager admits outputs in two formats:
 *
 * 1. OrderLock script: any output whose ASM contains the orderLockASM prefix:
 *    hex = '2097dfd76851bf465e8f715593b217714858bbe9570ff3bd5e33840a34e20ff0262102ba79df5f8ae7604a9830f03c7933028186aede0675a16f025dc4f8be8eec0382201008ce7480da41702918d1ec8e6849ba32b4d65b1e40dc669c31a1e6306b266c0000'
 *
 * 2. BSV-20 ordinal script (same transfer-token format as MonsterBattle's checkScriptFormat):
 *    formatStart  = '0063036f726451126170706c69636174696f6e2f6273762d323000' (chunks[0..5])
 *    chunks[6]    = JSON: { p: 'bsv-20', op: 'transfer'|'deploy+mint', amt, id? }
 *    formatMiddle = '6876a9' (chunks[7..9])
 *    chunks[10]   = 20-byte pubkey hash
 *    formatEnd    = '88ac' (chunks[11..12])
 *    chunks[13]   = OP_RETURN (0x6a) with non-empty data
 *
 * P2PKH scripts are silently skipped (not admitted, not an error).
 */

import { LockingScript, Transaction, Script, Utils } from '@bsv/sdk'
import MonsterBattleTopicManager from '../monsterbattle/MonsterBattleTopicManager.js'

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
 * Build a valid BSV-20 transfer-token script (MonsterBattle checkScriptFormat path).
 *
 * Template (from MonsterBattleTopicManager.ts TEMPLATES):
 *   formatStart  = '0063036f726451126170706c69636174696f6e2f6273762d323000'
 *   chunks[6]    = BSV-20 JSON payload (transfer or deploy+mint)
 *   formatMiddle = '6876a9'
 *   chunks[10]   = 20-byte pubkey hash
 *   formatEnd    = '88ac'
 *   chunks[13]   = OP_RETURN (0x6a) with non-empty data
 */
function buildMonsterBattleTransferScript(): LockingScript {
  const formatStart = Utils.toArray('0063036f726451126170706c69636174696f6e2f6273762d323000', 'hex')
  const jsonPayload = JSON.stringify({ p: 'bsv-20', op: 'transfer', id: 'monster_token_001', amt: '100' })
  const jsonBytes = Utils.toArray(jsonPayload, 'utf8')
  const formatMiddle = Utils.toArray('6876a9', 'hex')
  const pubkeyHash = new Array(20).fill(0xcd)
  const formatEnd = Utils.toArray('88ac', 'hex')
  const opReturnData = Utils.toArray('deadbeef', 'hex')

  const raw: number[] = [
    ...formatStart,
    // Push jsonPayload: PUSHDATA1 (0x4c) if > 75 bytes, else direct length prefix
    ...(jsonBytes.length <= 75
      ? [jsonBytes.length, ...jsonBytes]
      : [0x4c, jsonBytes.length, ...jsonBytes]),
    ...formatMiddle,
    // 20-byte pubkey hash push
    0x14, ...pubkeyHash,
    ...formatEnd,
    // OP_RETURN with data
    0x6a, opReturnData.length, ...opReturnData
  ]

  return LockingScript.fromHex(Utils.toHex(raw))
}

/**
 * Build a valid BSV-20 deploy+mint script (deploy+mint variant — no 'id' required).
 */
function buildMonsterBattleDeployMintScript(): LockingScript {
  const formatStart = Utils.toArray('0063036f726451126170706c69636174696f6e2f6273762d323000', 'hex')
  const jsonPayload = JSON.stringify({ p: 'bsv-20', op: 'deploy+mint', tick: 'MSTR', amt: '10000' })
  const jsonBytes = Utils.toArray(jsonPayload, 'utf8')
  const formatMiddle = Utils.toArray('6876a9', 'hex')
  const pubkeyHash = new Array(20).fill(0xef)
  const formatEnd = Utils.toArray('88ac', 'hex')
  const opReturnData = [0x01, 0x02, 0x03]

  const raw: number[] = [
    ...formatStart,
    ...(jsonBytes.length <= 75
      ? [jsonBytes.length, ...jsonBytes]
      : [0x4c, jsonBytes.length, ...jsonBytes]),
    ...formatMiddle,
    0x14, ...pubkeyHash,
    ...formatEnd,
    0x6a, opReturnData.length, ...opReturnData
  ]

  return LockingScript.fromHex(Utils.toHex(raw))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MonsterBattleTopicManager', () => {
  let manager: MonsterBattleTopicManager

  beforeEach(() => {
    manager = new MonsterBattleTopicManager()
  })

  // --- Valid script formats ---

  it('admits a valid BSV-20 transfer-token script', async () => {
    const lockingScript = buildMonsterBattleTransferScript()
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('admits a valid BSV-20 deploy+mint script', async () => {
    const lockingScript = buildMonsterBattleDeployMintScript()
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  // --- Invalid script formats ---

  it('rejects a trivially invalid script (OP_1)', async () => {
    const badScript = new LockingScript([{ op: 0x51 }])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a script with wrong JSON payload (p !== bsv-20)', async () => {
    const formatStart = Utils.toArray('0063036f726451126170706c69636174696f6e2f6273762d323000', 'hex')
    const badJson = Utils.toArray(JSON.stringify({ p: 'not-bsv-20', op: 'transfer', id: 'x', amt: '1' }), 'utf8')
    const formatMiddle = Utils.toArray('6876a9', 'hex')
    const pubkeyHash = new Array(20).fill(0)
    const formatEnd = Utils.toArray('88ac', 'hex')
    const opReturnData = [0x01]

    const raw: number[] = [
      ...formatStart,
      ...(badJson.length <= 75 ? [badJson.length, ...badJson] : [0x4c, badJson.length, ...badJson]),
      ...formatMiddle,
      0x14, ...pubkeyHash,
      ...formatEnd,
      0x6a, opReturnData.length, ...opReturnData
    ]
    const script = LockingScript.fromHex(Utils.toHex(raw))
    const tx = buildTxWithInput([script])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a script with wrong formatStart (insufficient chunks)', async () => {
    // Script with only 3 chunks — checkScriptFormat requires >= 14
    const badScript = new LockingScript([
      { op: 0x00 },
      { op: 0x6a },
      { op: 4, data: [0xde, 0xad, 0xbe, 0xef] }
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('does not admit a P2PKH script (it is silently skipped)', async () => {
    const pubkeyHash = new Array(20).fill(0xab)
    const p2pkh = new LockingScript([
      { op: 0x76 },                       // OP_DUP
      { op: 0xa9 },                       // OP_HASH160
      { op: 20, data: pubkeyHash },       // <20-byte hash>
      { op: 0x88 },                       // OP_EQUALVERIFY
      { op: 0xac }                        // OP_CHECKSIG
    ])
    const tx = buildTxWithInput([p2pkh])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('admits only valid outputs when mixed with invalid ones', async () => {
    const validScript = buildMonsterBattleTransferScript()
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
    expect(meta.name).toBe('MonsterBattle Topic Manager')
  })
})
