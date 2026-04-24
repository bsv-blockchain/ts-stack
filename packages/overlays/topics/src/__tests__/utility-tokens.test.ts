/**
 * Integration tests for TokenDemoTopicManager.
 *
 * TokenDemoTopicManager admits PushDrop outputs where:
 *   chunks[1].op === OP_CHECKSIG (0xac)
 *   PushDrop.decode succeeds, yielding at least 3 fields:
 *     fields[0] = tokenId (UTF-8 string)
 *     fields[1] = amount as uint64LE (8-byte little-endian BigInt)
 *     fields[2] = customFields as JSON string
 *
 * A PushDrop script layout (as built by buildPushDropScript):
 *   chunks[0] = <pubkey>   (compressed pubkey push)
 *   chunks[1] = OP_CHECKSIG (0xac)
 *   chunks[2..N] = data fields (each a push chunk)
 *   chunks[N+1..] = OP_2DROP / OP_DROP cleanup opcodes
 *
 * Mint transactions: tokenId === '___mint___' → isMint flag set → balance mismatch ignored.
 * Transfer transactions: require previousCoins referencing inputs with matching tokenId.
 *
 * identifyNeededInputs: returns outpoints for inputs that lack a sourceTransaction.
 */

import { LockingScript, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import TokenDemoTopicManager from '../utility-tokens/TokenDemoTopicManager.js'

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
 * Build a PushDrop-style locking script compatible with PushDrop.decode.
 *
 * Layout (from PushDrop convention):
 *   chunks[0] = <pubkey bytes>
 *   chunks[1] = OP_CHECKSIG (0xac)
 *   chunks[2..N] = data fields (each a standard push)
 *   chunks[N+1..] = OP_2DROP (0x6d) for each pair, OP_DROP (0x75) for remainder
 */
function buildPushDropScript(
  pubKeyHex: string,
  fields: number[][]
): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = []
  const pubKeyBytes = Utils.toArray(pubKeyHex, 'hex')

  // chunks[0]: pubkey push
  chunks.push({ op: pubKeyBytes.length, data: pubKeyBytes })
  // chunks[1]: OP_CHECKSIG
  chunks.push({ op: 0xac })

  // chunks[2..N]: data fields
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

  // cleanup: OP_2DROP for each pair, OP_DROP for odd remainder
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
 * Encode a JavaScript number as uint64 little-endian (8 bytes).
 */
function encodeUInt64LE(value: number): number[] {
  const buf = new Array(8).fill(0)
  let v = value
  for (let i = 0; i < 8; i++) {
    buf[i] = v & 0xff
    v = Math.floor(v / 256)
  }
  return buf
}

/**
 * Build a valid TokenDemo PushDrop locking script (mint token).
 *
 * For a standalone mint (no previousCoins needed), use tokenId = '___mint___'.
 * The balance check sets isMint=true so the amount mismatch is ignored.
 */
function buildMintTokenScript(
  pubKeyHex: string,
  amount: number,
  customFields: Record<string, unknown> = {}
): LockingScript {
  const tokenId = Utils.toArray('___mint___', 'utf8')
  const amountBytes = encodeUInt64LE(amount)
  const customFieldsBytes = Utils.toArray(JSON.stringify(customFields), 'utf8')

  return buildPushDropScript(pubKeyHex, [tokenId, amountBytes, customFieldsBytes])
}

/**
 * Build a valid TokenDemo PushDrop locking script (non-mint token).
 * Used when we have previousCoins providing the input balance.
 */
function buildTransferTokenScript(
  pubKeyHex: string,
  tokenId: string,
  amount: number,
  customFields: Record<string, unknown> = {}
): LockingScript {
  const tokenIdBytes = Utils.toArray(tokenId, 'utf8')
  const amountBytes = encodeUInt64LE(amount)
  const customFieldsBytes = Utils.toArray(JSON.stringify(customFields), 'utf8')

  return buildPushDropScript(pubKeyHex, [tokenIdBytes, amountBytes, customFieldsBytes])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TokenDemoTopicManager', () => {
  let manager: TokenDemoTopicManager
  let pubKeyHex: string

  beforeEach(() => {
    manager = new TokenDemoTopicManager()
    pubKeyHex = PrivateKey.fromRandom().toPublicKey().toString()
  })

  // --- Valid mint token scripts ---

  it('admits a valid mint token output (tokenId = ___mint___)', async () => {
    const lockingScript = buildMintTokenScript(pubKeyHex, 1000, { name: 'TestToken' })
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('admits multiple valid mint token outputs in one transaction', async () => {
    const script1 = buildMintTokenScript(pubKeyHex, 500, { batch: 1 })
    const script2 = buildMintTokenScript(pubKeyHex, 250, { batch: 2 })
    const tx = buildTxWithInput([script1, script2])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.outputsToAdmit).toContain(1)
  })

  it('admits a mint token with zero amount', async () => {
    const lockingScript = buildMintTokenScript(pubKeyHex, 0, {})
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits a mint token with complex customFields JSON', async () => {
    const customFields = { color: 'red', level: 5, tags: ['rare', 'unique'] }
    const lockingScript = buildMintTokenScript(pubKeyHex, 42, customFields)
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  // --- Rejection cases ---

  it('rejects a P2PKH script (chunks[1].op is not OP_CHECKSIG at index 1)', async () => {
    const pubkeyHash = new Array(20).fill(0xab)
    const badScript = new LockingScript([
      { op: 0x76 },                       // OP_DUP (chunks[0])
      { op: 0xa9 },                       // OP_HASH160 (chunks[1] — not OP_CHECKSIG)
      { op: 20, data: pubkeyHash },
      { op: 0x88 },
      { op: 0xac }
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a trivially invalid 1-chunk script', async () => {
    const badScript = new LockingScript([{ op: 0x51 }]) // OP_1
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects an OP_FALSE OP_RETURN script (not a PushDrop)', async () => {
    const badScript = new LockingScript([
      { op: 0x00 }, // OP_FALSE (chunks[0])
      { op: 0x6a }  // OP_RETURN (chunks[1] — not OP_CHECKSIG)
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('rejects a PushDrop with invalid (non-JSON) customFields', async () => {
    // Manually construct: valid pubkey + OP_CHECKSIG + 3 fields where fields[2] is not JSON
    const tokenIdBytes = Utils.toArray('___mint___', 'utf8')
    const amountBytes = encodeUInt64LE(100)
    const badCustomFieldsBytes = Utils.toArray('not-valid-json!!!', 'utf8')

    const lockingScript = buildPushDropScript(pubKeyHex, [tokenIdBytes, amountBytes, badCustomFieldsBytes])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toEqual([])
  })

  it('admits only valid outputs when mixed with invalid ones', async () => {
    const validScript = buildMintTokenScript(pubKeyHex, 777, { test: true })
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

  // --- identifyNeededInputs tests ---

  it('identifyNeededInputs returns empty array when all inputs have sourceTransaction', async () => {
    const lockingScript = buildMintTokenScript(pubKeyHex, 1, {})
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyNeededInputs(tx.toBEEF())
    // buildTxWithInput sets sourceTransaction on all inputs
    expect(result).toEqual([])
  })

  it('identifyNeededInputs throws when transaction has no inputs', async () => {
    // A transaction with outputs but no inputs
    const sourceTx = new Transaction()
    sourceTx.addOutput({ lockingScript: new LockingScript([]), satoshis: 10000 })

    const tx = new Transaction()
    tx.addOutput({ lockingScript: buildMintTokenScript(pubKeyHex, 1, {}), satoshis: 1000 })

    await expect(manager.identifyNeededInputs(tx.toBEEF())).rejects.toThrow('Missing parameter: inputs')
  })

  // --- Metadata ---

  it('getDocumentation returns a non-empty string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('TokenDemo Topic Manager')
  })
})
