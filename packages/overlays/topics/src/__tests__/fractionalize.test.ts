/**
 * Integration tests for FractionalizeTopicManager.
 *
 * FractionalizeTopicManager looks for 3 output types:
 *
 * 1. 'server-token': OP_0 OP_IF OP_3 '0x6f726451' '0x6170706c69636174696f6e2f6273762d3230' OP_0 <json> OP_ENDIF OP_NIP OP_OVER OP_HASH160
 *    Chunk templates:
 *      formatStart = '0063036f726451126170706c69636174696f6e2f6273762d323000' (chunks[0..5])
 *      chunks[6] = BSV-20 JSON payload
 *      formatMiddle = '686e7ea9' (chunks[7..10])
 *      chunks[11] = 20-byte hash
 *      formatEnd = '886b6b516c6c52ae' (chunks[12..19])
 *      chunks[20] = OP_RETURN with data
 *
 * 2. 'transfer-token': same formatStart, same JSON (chunks[6]),
 *    formatMiddle = '6876a9' (chunks[7..9])
 *    chunks[10] = 20-byte pubkey hash
 *    formatEnd = '88ac' (chunks[11..12])
 *    chunks[13] = OP_RETURN with data
 *
 * 3. 'payment': no OP_IF, has OP_CHECKMULTISIG
 *    formatStart = '6e7ea9' (chunks[0..2])
 *    chunks[3] = 20-byte hash
 *    formatEnd = '886b6b516c6c52ae' (chunks[4..11])
 *
 * Scripts must contain both OP_IF and OP_CHECKMULTISIG for server-token,
 * only OP_IF for transfer-token, only OP_CHECKMULTISIG for payment.
 *
 * Building a fully valid ordinal/multisig script from scratch is complex.
 * The minimum-viable tests are:
 *   - Invalid/wrong-format script → not admitted
 *   - A P2PKH → not admitted
 *   - Valid server-token, transfer-token, and payment scripts → admitted (built from hex)
 */

import { LockingScript, Transaction, Utils } from '@bsv/sdk'
import FractionalizeTopicManager from '../fractionalize/FractionalizeTopicManager.js'

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
 * Build a valid 'server-token' script from the known hex templates.
 *
 * Template breakdown (from FractionalizeTopicManager.ts TEMPLATES):
 *   formatStart  = '0063036f726451126170706c69636174696f6e2f6273762d323000'
 *   chunks[6]    = BSV-20 JSON payload (deploy+mint or transfer)
 *   formatMiddle = '686e7ea9'
 *   chunks[11]   = 20-byte hash
 *   formatEnd    = '886b6b516c6c52ae'
 *   chunks[20]   = OP_RETURN (0x6a) with non-empty data
 */
function buildServerTokenScript(): LockingScript {
  const formatStart = Utils.toArray('0063036f726451126170706c69636174696f6e2f6273762d323000', 'hex')
  const jsonPayload = JSON.stringify({ p: 'bsv-20', op: 'deploy+mint', tick: 'TEST', amt: '1000' })
  const jsonBytes = Utils.toArray(jsonPayload, 'utf8')
  const formatMiddle = Utils.toArray('686e7ea9', 'hex')
  const hash20 = new Array(20).fill(0xab)   // 20-byte placeholder hash
  const formatEnd = Utils.toArray('886b6b516c6c52ae', 'hex')
  const opReturnData = Utils.toArray('deadbeef', 'hex')  // non-empty OP_RETURN data

  // Encode as a raw script by concatenating all pieces with appropriate push opcodes.
  // We reconstruct the exact chunk sequence the checkScriptFormat function expects.
  // We use Script.fromASM-style raw concatenation.
  const raw: number[] = [
    ...formatStart,
    // Push jsonPayload (chunk[6]): use PUSHDATA1 if > 75 bytes
    ...(jsonBytes.length <= 75
      ? [jsonBytes.length, ...jsonBytes]
      : [0x4c, jsonBytes.length, ...jsonBytes]),
    ...formatMiddle,
    // chunk[11]: 20-byte data push
    0x14, ...hash20,
    ...formatEnd,
    // chunk[20]: OP_RETURN (0x6a) + data length + data
    0x6a, opReturnData.length, ...opReturnData
  ]

  return LockingScript.fromHex(Utils.toHex(raw))
}

/**
 * Build a valid 'transfer-token' script.
 *   formatStart  = '0063036f726451126170706c69636174696f6e2f6273762d323000'
 *   chunks[6]    = BSV-20 JSON (transfer with id)
 *   formatMiddle = '6876a9'
 *   chunks[10]   = 20-byte pubkey hash
 *   formatEnd    = '88ac'
 *   chunks[13]   = OP_RETURN with data
 */
function buildTransferTokenScript(): LockingScript {
  const formatStart = Utils.toArray('0063036f726451126170706c69636174696f6e2f6273762d323000', 'hex')
  const jsonPayload = JSON.stringify({ p: 'bsv-20', op: 'transfer', id: 'abcdef1234', amt: '500' })
  const jsonBytes = Utils.toArray(jsonPayload, 'utf8')
  const formatMiddle = Utils.toArray('6876a9', 'hex')
  const pubkeyHash = new Array(20).fill(0xcd)
  const formatEnd = Utils.toArray('88ac', 'hex')
  const opReturnData = Utils.toArray('cafebabe', 'hex')

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

/**
 * Build a valid 'payment' script (multisig, no ordinal).
 *   formatStart = '6e7ea9'
 *   chunks[3]   = 20-byte hash
 *   formatEnd   = '886b6b516c6c52ae'
 */
function buildPaymentScript(): LockingScript {
  const formatStart = Utils.toArray('6e7ea9', 'hex')
  const hash20 = new Array(20).fill(0xef)
  const formatEnd = Utils.toArray('886b6b516c6c52ae', 'hex')

  const raw: number[] = [
    ...formatStart,
    0x14, ...hash20,
    ...formatEnd
  ]

  return LockingScript.fromHex(Utils.toHex(raw))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FractionalizeTopicManager', () => {
  let manager: FractionalizeTopicManager

  beforeEach(() => {
    manager = new FractionalizeTopicManager()
  })

  it('rejects a P2PKH script (not a fractionalize format)', async () => {
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

  it('rejects a trivially invalid script (OP_1)', async () => {
    const badScript = new LockingScript([{ op: 0x51 }])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a malformed server-token script (wrong JSON payload)', async () => {
    // formatStart is correct but JSON payload is invalid BSV-20
    const formatStart = Utils.toArray('0063036f726451126170706c69636174696f6e2f6273762d323000', 'hex')
    const badJson = Utils.toArray(JSON.stringify({ p: 'not-bsv-20', op: 'deploy+mint', amt: '1' }), 'utf8')
    const formatMiddle = Utils.toArray('686e7ea9', 'hex')
    const hash20 = new Array(20).fill(0)
    const formatEnd = Utils.toArray('886b6b516c6c52ae', 'hex')
    const opReturnData = [0xde, 0xad]

    const raw: number[] = [
      ...formatStart,
      ...(badJson.length <= 75 ? [badJson.length, ...badJson] : [0x4c, badJson.length, ...badJson]),
      ...formatMiddle,
      0x14, ...hash20,
      ...formatEnd,
      0x6a, opReturnData.length, ...opReturnData
    ]
    const script = LockingScript.fromHex(Utils.toHex(raw))
    const tx = buildTxWithInput([script])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('returns empty results for malformed BEEF', async () => {
    const result = await manager.identifyAdmissibleOutputs([0x00, 0x01], [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('admits a valid server-token script', async () => {
    // test.skip if constructing the script is too fragile — but we attempt it
    const lockingScript = buildServerTokenScript()
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits a valid transfer-token script', async () => {
    const lockingScript = buildTransferTokenScript()
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits a valid payment (multisig) script', async () => {
    const lockingScript = buildPaymentScript()
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('getDocumentation returns a non-empty string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('Fractionalize Topic Manager')
  })
})
