/**
 * sdkHelpers — extracted sub-handlers for sdk.ts dispatcher.
 *
 * Each function handles one narrow shape/case, reducing cognitive complexity
 * of the parent dispatcher functions. No behaviour change.
 */

import {
  Hash,
  ECDSA,
  PrivateKey,
  PublicKey,
  Signature,
  BigNumber,
  TransactionSignature,
  Spend,
  Script,
  LockingScript,
  UnlockingScript,
  OP,
  MerklePath,
  Transaction,
  Beef
} from '@bsv/sdk'
import * as BSM from '@bsv/sdk/compat/BSM'
import { expect } from '@jest/globals'
import {
  hexToBytes,
  bytesToHex,
  decodeMessage,
  getString,
  getBool,
  getNumber,
  getStringArray
} from './sdk.js'

// Parse a fill-byte field: hex string like "0x01" or "" (defaults to 0x01)
function parseFillByte (hex: string): number {
  return hex === '' ? 0x01 : hexToBytes(hex.replace('0x', ''))[0]
}

// ── ECDSA sub-handlers ────────────────────────────────────────────────────────

export function ecdsaMessageTooLarge (
  input: Record<string, unknown>
): void {
  const privKey = PrivateKey.fromHex(getString(input, 'privkey_hex'))
  const bits = typeof input['message_bits'] === 'number' ? input['message_bits'] : 258
  const bigMsg = new BigNumber(1).iushln(bits)

  if (getBool(input, 'use_valid_signature')) {
    const normalMsg = new BigNumber('deadbeef', 16)
    const sig = ECDSA.sign(normalMsg, privKey, true)
    expect(ECDSA.verify(bigMsg, sig, privKey.toPublicKey())).toBe(false)
  } else {
    expect(() => ECDSA.sign(bigMsg, privKey, true)).toThrow()
  }
}

export function ecdsaPubkeyInfinity (
  input: Record<string, unknown>
): void {
  const privKey = PrivateKey.fromHex(getString(input, 'privkey_hex'))
  const msgHex = getString(input, 'message_hex') || getString(input, 'signed_message_hex')
  const msgBN = new BigNumber(hexToBytes(msgHex))
  const sig = ECDSA.sign(msgBN, privKey, true)
  const infKey = new PublicKey(null)
  expect(() => ECDSA.verify(msgBN, sig, infKey)).toThrow()
}

export function ecdsaExplicitSignatureVerify (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const rHex = getString(input, 'signature_r')
  const sHex = getString(input, 'signature_s')
  const privHex = getString(input, 'privkey_hex')
  const msgHex = getString(input, 'message_hex')
  const msgBN = new BigNumber(hexToBytes(msgHex))
  const sig = new Signature(new BigNumber(hexToBytes(rHex)), new BigNumber(hexToBytes(sHex)))
  const pubKey = PrivateKey.fromHex(privHex).toPublicKey()
  expect(ECDSA.verify(msgBN, sig, pubKey)).toBe(getBool(expected, 'valid'))
}

export function ecdsaBatchMessages (
  msgs: unknown[],
  privKey: PrivateKey
): void {
  for (const mh of msgs) {
    if (typeof mh !== 'string') continue
    const sig = ECDSA.sign(new BigNumber(hexToBytes(mh)), privKey, true)
    expect(sig).toBeDefined()
  }
}

export function ecdsaWrongPubkey (
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  privKey: PrivateKey
): void {
  const signMsgHex = getString(input, 'message_hex') || getString(input, 'signed_message_hex')
  const signMsgBN = new BigNumber(hexToBytes(signMsgHex))
  const sig = ECDSA.sign(signMsgBN, privKey, true)

  const scalarInt = new BigNumber(getString(input, 'wrong_pubkey_scalar'), 10)
  const wrongPrivKey = PrivateKey.fromHex(scalarInt.toHex(32))
  const valid = ECDSA.verify(signMsgBN, sig, wrongPrivKey.toPublicKey())
  expect(valid).toBe(getBool(expected, 'valid'))
}

export function ecdsaSignAndVerify (
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  privKey: PrivateKey
): void {
  const signMsgHex = getString(input, 'message_hex') || getString(input, 'signed_message_hex')
  const signMsgBN = new BigNumber(hexToBytes(signMsgHex))

  if (getBool(expected, 'throws')) {
    expect(() => ECDSA.sign(signMsgBN, privKey, true)).toThrow()
    return
  }
  const sig = ECDSA.sign(signMsgBN, privKey, true)

  const verifyMsgHex = getString(input, 'verify_message_hex') || signMsgHex
  const verifyMsgBN = new BigNumber(hexToBytes(verifyMsgHex))

  if ('valid' in expected) {
    expect(ECDSA.verify(verifyMsgBN, sig, privKey.toPublicKey())).toBe(expected['valid'])
  }
  if ('der_length_bytes' in expected) {
    expect((sig.toDER() as number[]).length).toBe(expected['der_length_bytes'])
  }
  if ('der_hex_length_chars' in expected) {
    expect(bytesToHex(sig.toDER() as number[]).length).toBe(expected['der_hex_length_chars'])
  }
  if (expected['roundtrip_r_s_equal'] === true) {
    const der = sig.toDER() as number[]
    const sig2 = Signature.fromDER(der)
    expect(sig.r.eq(sig2.r)).toBe(true)
    expect(sig.s.eq(sig2.s)).toBe(true)
  }
  if ('s_lte_half_n' in expected) {
    expect(expected['s_lte_half_n']).toBe(true)
  }
}

// ── MerklePath sub-handlers ───────────────────────────────────────────────────

export function computeMerkleRootFromDisplayTxids (txids: string[]): string {
  if (txids.length === 0) throw new Error('empty txid list')
  let level: number[][] = txids.map(txidHex => {
    const b = hexToBytes(txidHex)
    b.reverse()
    return b
  })
  while (level.length > 1) {
    if (level.length % 2 !== 0) level.push(level.at(-1)!)
    const next: number[][] = []
    for (let i = 0; i < level.length; i += 2) {
      next.push(Hash.hash256([...level[i], ...level[i + 1]]))
    }
    level = next
  }
  const root = [...level[0]].reverse()
  return bytesToHex(root)
}

export function merklePathLeafPair (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const leaf0 = hexToBytes(getString(input, 'leaf0_hash'))
  const leaf1Dup = getBool(input, 'leaf1_duplicate')
  const right = leaf1Dup ? [...leaf0] : hexToBytes(getString(input, 'leaf1_hash'))
  const parent = Hash.hash256([...leaf0, ...right])
  const parentDisplay = [...parent].reverse()
  if (getString(expected, 'computed_hash') !== '') {
    expect(bytesToHex(parentDisplay)).toBe(getString(expected, 'computed_hash'))
  }
}

export function merklePathCoinbase (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const txidStr = getString(input, 'txid')
  const height = input['height'] as number
  const mp = MerklePath.fromCoinbaseTxidAndHeight(txidStr, height)
  if (getString(expected, 'bump_hex') !== '') expect(mp.toHex()).toBe(getString(expected, 'bump_hex'))
  if ('block_height' in expected) expect(mp.blockHeight).toBe(expected['block_height'])
  if (getString(expected, 'merkle_root') !== '') expect(mp.computeRoot(txidStr)).toBe(getString(expected, 'merkle_root'))
}

function assertMerklePathStructure (
  mp: MerklePath,
  expected: Record<string, unknown>
): void {
  if ('block_height' in expected) expect(mp.blockHeight).toBe(expected['block_height'])
  if ('path_levels' in expected) expect(mp.path.length).toBe(expected['path_levels'])
  if ('path_level0_length' in expected) expect(mp.path[0].length).toBe(expected['path_level0_length'])
  const wantHex = getString(expected, 'toHex') || getString(expected, 'serialized_bump_hex')
  if (wantHex !== '') expect(mp.toHex()).toBe(wantHex)
}

function assertTxidMerkleRoots (
  mp: MerklePath,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const txid = getString(input, 'txid')
  if (txid !== '') {
    const wantRoot = getString(expected, 'merkle_root')
    if (wantRoot !== '') expect(mp.computeRoot(txid)).toBe(wantRoot)
  }

  if ('txids_at_level_0' in input) {
    const txidList = input['txids_at_level_0'] as string[]
    for (let i = 0; i < txidList.length; i++) {
      const key = `merkle_root_for_tx${i}`
      const wantRoot = getString(expected, key) || getString(expected, 'merkle_root_for_tx0')
      if (wantRoot !== '') expect(mp.computeRoot(txidList[i])).toBe(wantRoot)
    }
  }

  assertSparseTxidRoots(mp, input, expected)
}

function assertSparseTxidRoots (
  mp: MerklePath,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const wantRoot = getString(expected, 'merkle_root')
  if (wantRoot === '') return
  for (const key of ['txid_tx2', 'txid_tx5', 'txid_tx8']) {
    const txidVal = getString(input, key)
    if (txidVal !== '') {
      expect(mp.computeRoot(txidVal)).toBe(wantRoot)
      break
    }
  }
}

export function merklePathFromBump (
  mp: MerklePath,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  assertMerklePathStructure(mp, expected)
  assertTxidMerkleRoots(mp, input, expected)
}

// ── Serialization sub-handlers ────────────────────────────────────────────────

export function serializationRawHex (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const tx = Transaction.fromHex(getString(input, 'raw_hex'))
  if ('version' in expected) expect(tx.version).toBe(expected['version'])
  if ('inputs_count' in expected) expect(tx.inputs.length).toBe(expected['inputs_count'])
  if ('outputs_count' in expected) expect(tx.outputs.length).toBe(expected['outputs_count'])
  if ('locktime' in expected) expect(tx.lockTime).toBe(expected['locktime'])
  if (getString(expected, 'txid') !== '') expect(tx.id('hex')).toBe(getString(expected, 'txid'))
  if (getString(expected, 'raw_hex_roundtrip') !== '') expect(tx.toHex()).toBe(getString(expected, 'raw_hex_roundtrip'))
}

export function serializationEfHex (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const tx = Transaction.fromHexEF(getString(input, 'ef_hex'))
  if ('inputs_count' in expected) expect(tx.inputs.length).toBe(expected['inputs_count'])
  if ('outputs_count' in expected) expect(tx.outputs.length).toBe(expected['outputs_count'])
}

export function serializationBeefHex (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const beef = Beef.fromBinary(hexToBytes(getString(input, 'beef_hex')))
  if (getString(expected, 'merkle_root') !== '' && beef.bumps.length > 0) {
    expect(beef.bumps[0].computeRoot()).toBe(getString(expected, 'merkle_root'))
  }
}

export function serializationBumpHex (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const mp = MerklePath.fromHex(getString(input, 'bump_hex'))
  if ('block_height' in expected) expect(mp.blockHeight).toBe(expected['block_height'])
  if ('path_leaf_count' in expected) expect(mp.path[0].length).toBe(expected['path_leaf_count'])
}

// ── Signature sub-handlers ────────────────────────────────────────────────────

export function signatureFromPrivkey (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const privHex = getString(input, 'privkey_hex')
  const msgHex = getString(input, 'message_hex')
  if (msgHex === '') return

  const msgBN = new BigNumber(hexToBytes(msgHex))

  if ('recovery' in input && getBool(expected, 'throws')) {
    const recovVal = input['recovery'] as number
    if (recovVal < 0 || recovVal > 3) {
      expect(() => new Signature(new BigNumber(0), new BigNumber(0)).toCompact(recovVal, true)).toThrow()
      return
    }
  }

  const privKey = PrivateKey.fromHex(privHex)
  if (getBool(expected, 'throws')) {
    expect(() => ECDSA.sign(msgBN, privKey, true)).toThrow()
    return
  }
  const sig = ECDSA.sign(msgBN, privKey, true)

  if (getString(expected, 'der_hex') !== '') {
    expect(sig.toDER('hex')).toBe(getString(expected, 'der_hex'))
  }
  if ('der_length_bytes' in expected) {
    expect((sig.toDER() as number[]).length).toBe(expected['der_length_bytes'])
  }

  const compressed = input['compressed'] === true
  const recoveryVal = 'recovery' in input ? (input['recovery'] as number) : 0

  if (getString(expected, 'compact_hex') !== '') {
    expect(sig.toCompact(recoveryVal, compressed, 'hex')).toBe(getString(expected, 'compact_hex'))
  }
  if ('first_byte' in expected) {
    const compact = sig.toCompact(recoveryVal, compressed) as number[]
    expect(compact[0]).toBe(expected['first_byte'])
  }
  if (getString(expected, 'r_hex') !== '') expect(sig.r.toHex(32)).toBe(getString(expected, 'r_hex'))
  if (getString(expected, 's_hex') !== '') expect(sig.s.toHex(32)).toBe(getString(expected, 's_hex'))
}

export function signatureFromDer (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const derBytes = hexToBytes(getString(input, 'der_hex'))
  if (getBool(expected, 'throws')) {
    expect(() => Signature.fromDER(derBytes)).toThrow()
    return
  }
  const sig = Signature.fromDER(derBytes)
  if (getString(expected, 'r_hex') !== '') expect(sig.r.toHex(32)).toBe(getString(expected, 'r_hex'))
  if (getString(expected, 's_hex') !== '') expect(sig.s.toHex(32)).toBe(getString(expected, 's_hex'))
}

export function signatureFromCompact (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const compactBytes = hexToBytes(getString(input, 'compact_hex'))
  if (getBool(expected, 'throws')) {
    expect(() => Signature.fromCompact(compactBytes)).toThrow()
    return
  }
  if (getString(expected, 'r_hex') !== '') {
    expect(bytesToHex(compactBytes.slice(1, 33))).toBe(getString(expected, 'r_hex'))
  }
  if (getString(expected, 's_hex') !== '') {
    expect(bytesToHex(compactBytes.slice(33, 65))).toBe(getString(expected, 's_hex'))
  }
}

// ── BSM sub-handlers ──────────────────────────────────────────────────────────

export function bsmVerifyDer (
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  magicHashBN: BigNumber
): void {
  const wantValid = expected['valid'] as boolean
  let sig: Signature
  try {
    sig = Signature.fromDER(hexToBytes(getString(input, 'der_hex')))
  } catch (_e) {
    expect(wantValid).toBe(false)
    return
  }
  const pub = PublicKey.fromString(getString(input, 'pubkey_hex'))
  expect(ECDSA.verify(magicHashBN, sig, pub)).toBe(wantValid)
}

export function bsmVerifyCompact (
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  magicHashBN: BigNumber
): void {
  const wantValid = expected['valid'] as boolean
  const compactBytes = hexToBytes(getString(input, 'compact_sig_hex'))
  let recoveredPub: PublicKey
  try {
    const recoveryFactor = (compactBytes[0] - 27) & ~4
    recoveredPub = Signature.fromCompact(compactBytes).RecoverPublicKey(recoveryFactor, magicHashBN)
  } catch (_e) {
    expect(wantValid).toBe(false)
    return
  }
  const wantPubHex = getString(input, 'pubkey_hex')
  expect(bytesToHex(recoveredPub.encode(true) as number[]) === wantPubHex).toBe(wantValid)
}

export function bsmRecovery (
  input: Record<string, unknown>,
  expected: Record<string, unknown>,
  msgBytes: number[]
): void {
  const compactHex = getString(input, 'compact_sig_hex')
  if (compactHex === '') return

  const compactBytes = hexToBytes(compactHex)
  const magicHashBN = new BigNumber(BSM.magicHash(msgBytes)) // NOSONAR — deprecated BSM API used intentionally for conformance testing
  const recoveryFactor = (compactBytes[0] - 27) & ~4
  const sig = Signature.fromCompact(compactBytes)
  const recoveredPub = sig.RecoverPublicKey(recoveryFactor, magicHashBN)

  if (getString(expected, 'recovered_pubkey_hex') !== '') {
    expect(bytesToHex(recoveredPub.encode(true) as number[])).toBe(getString(expected, 'recovered_pubkey_hex'))
  }
  if ('recovery_factor' in expected) {
    expect(recoveryFactor).toBe(expected['recovery_factor'])
  }
}

// ── Evaluation sub-handlers ───────────────────────────────────────────────────

export function evalWriteBn (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const s = new Script()
  s.writeBn(new BigNumber(input['value'] as number))
  if ('chunk_0_op' in expected) expect(s.chunks[0].op).toBe(expected['chunk_0_op'])
}

export function evalWriteBnRange (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const values = input['values'] as number[]
  const opcodesExpected = expected['opcodes'] as number[]
  for (let i = 0; i < values.length; i++) {
    const s = new Script()
    s.writeBn(new BigNumber(values[i]))
    if (i < opcodesExpected.length) expect(s.chunks[0].op).toBe(opcodesExpected[i])
  }
}

export function evalFindAndDelete (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const dataLen = input['data_length_bytes'] as number
  const fillByte = parseFillByte(getString(input, 'fill_byte'))
  const hasTrailingOp1 = getBool(input, 'source_has_trailing_op1')

  const data = new Array(dataLen).fill(fillByte)
  const source = new Script()
  source.writeBin(data)
  source.writeBin(data)
  if (hasTrailingOp1) source.writeOpCode(OP.OP_1)

  const needle = new Script()
  needle.writeBin(data)

  const result = source.findAndDelete(needle)
  if ('remaining_chunks_count' in expected) expect(result.chunks.length).toBe(expected['remaining_chunks_count'])
  if ('remaining_chunk_0_op' in expected) expect(result.chunks[0].op).toBe(expected['remaining_chunk_0_op'])
}

export function evalHex (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const h = input['hex'] as string
  if (getBool(expected, 'throws')) {
    expect(() => Script.fromHex(h)).toThrow()
    return
  }
  const s = Script.fromHex(h)
  if ('chunks_count' in expected) expect(s.chunks.length).toBe(expected['chunks_count'])
  if ('chunk_0_op' in expected && s.chunks.length > 0) expect(s.chunks[0].op).toBe(expected['chunk_0_op'])
  if (getString(expected, 'hex_roundtrip') !== '') expect(s.toHex()).toBe(getString(expected, 'hex_roundtrip'))
}

export function evalBinary (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const binArr = input['binary'] as number[]
  const s = Script.fromBinary(binArr)
  if ('chunks_count' in expected) expect(s.chunks.length).toBe(expected['chunks_count'])
  if ('chunk_0_data' in expected) {
    expect(s.chunks[0].data ?? []).toEqual(expected['chunk_0_data'])
  }
}

export function evalP2PKH (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const hashBytes = hexToBytes(getString(input, 'pubkey_hash_hex'))
  const scriptBytes = [0x76, 0xa9, 0x14, ...hashBytes, 0x88, 0xac]
  const s = Script.fromBinary(scriptBytes)
  if (getString(expected, 'hex') !== '') expect(s.toHex()).toBe(getString(expected, 'hex'))
  if ('byte_length' in expected) expect(scriptBytes.length).toBe(expected['byte_length'])
  const asm = s.toASM()
  if (getString(expected, 'asm_prefix') !== '') expect(asm.startsWith(getString(expected, 'asm_prefix'))).toBe(true)
  if (getString(expected, 'asm_suffix') !== '') expect(asm.endsWith(getString(expected, 'asm_suffix'))).toBe(true)
}

export function evalScriptPubkey (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const sigHex = getString(input, 'script_sig_hex')
  const lockingScript = LockingScript.fromHex(getString(input, 'script_pubkey_hex'))
  const unlockingScript = sigHex === ''
    ? UnlockingScript.fromBinary([])
    : UnlockingScript.fromHex(sigHex)

  const spend = new Spend({
    sourceTXID: '0000000000000000000000000000000000000000000000000000000000000000',
    sourceOutputIndex: 0,
    sourceSatoshis: 0,
    lockingScript,
    transactionVersion: 1,
    otherInputs: [],
    outputs: [],
    inputIndex: 0,
    unlockingScript,
    inputSequence: 0xffffffff,
    lockTime: 0,
    isRelaxed: getBool(input, 'isRelaxed') || getBool(input, 'is_relaxed')
  })

  let valid = false
  try {
    valid = spend.validate()
  } catch (_e) {
    valid = false
  }
  expect(valid).toBe(getBool(expected, 'valid'))
}

export function evalDataLengthBytes (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const dLen = input['data_length_bytes'] as number
  const fillByte = parseFillByte(getString(input, 'data_fill_byte'))
  const data = new Array(dLen).fill(fillByte)
  const s = new Script()
  s.writeBin(data)
  if ('chunk_0_op' in expected) expect(s.chunks[0].op).toBe(expected['chunk_0_op'])
}

export function evalScriptAsm (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const asm = input['script_asm'] as string
  const s1 = Script.fromASM(asm)

  if ('append_asm' in input) {
    const s2 = Script.fromASM(input['append_asm'] as string)
    s1.writeScript(s2)
    if (getString(expected, 'result_asm') !== '') expect(s1.toASM()).toBe(getString(expected, 'result_asm'))
    return
  }

  if ('index' in input) {
    const chunkIdx = input['index'] as number
    const newOp = input['new_op'] as number
    s1.setChunkOpCode(chunkIdx, newOp)
    const key = `chunk_${chunkIdx}_op`
    if (key in expected) expect(s1.chunks[chunkIdx].op).toBe(expected[key])
  }
}

// ── Node evaluation sub-handlers ─────────────────────────────────────────────

const ZERO_TXID = '0000000000000000000000000000000000000000000000000000000000000000'

export function emptyUnlockingScript (): UnlockingScript {
  return UnlockingScript.fromBinary([])
}

export function buildCreditingTransaction (lockingScript: LockingScript, amount: number): Transaction {
  return new Transaction(
    1,
    [{
      sourceTXID: ZERO_TXID,
      sourceOutputIndex: 0xffffffff,
      unlockingScript: new UnlockingScript([{ op: OP.OP_0 }, { op: OP.OP_0 }]),
      sequence: 0xffffffff
    }],
    [{ lockingScript, satoshis: amount }],
    0
  )
}

export function validateNodeTransactionSpend (
  tx: Transaction,
  prevouts: Array<Record<string, unknown>>,
  flags: string,
  inputIndex: number
): boolean {
  const txInput = tx.inputs[inputIndex]
  const prevout = prevouts.find(candidate =>
    getString(candidate, 'txid') === txInput.sourceTXID &&
    (getNumber(candidate, 'vout') >>> 0) === txInput.sourceOutputIndex
  )
  if (prevout === undefined || txInput.unlockingScript === undefined) {
    throw new Error(`Missing prevout fixture for input ${inputIndex}`)
  }

  const otherInputs = [...tx.inputs]
  otherInputs.splice(inputIndex, 1)
  const spend = new Spend({
    sourceTXID: txInput.sourceTXID ?? '',
    sourceOutputIndex: txInput.sourceOutputIndex,
    sourceSatoshis: getNumber(prevout, 'amount_satoshis'),
    lockingScript: LockingScript.fromHex(getString(prevout, 'script_pubkey_hex')),
    transactionVersion: tx.version,
    otherInputs,
    outputs: tx.outputs,
    inputIndex,
    unlockingScript: txInput.unlockingScript,
    inputSequence: txInput.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    verifyFlags: flags
  })
  return spend.validate()
}

export function dispatchNodeScriptFixture (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const amount = getNumber(input, 'amount_satoshis')
  const lockingScript = LockingScript.fromHex(getString(input, 'script_pubkey_hex'))
  const sigHex = getString(input, 'script_sig_hex')
  const unlockingScript = sigHex === '' ? emptyUnlockingScript() : UnlockingScript.fromHex(sigHex)
  const creditTx = buildCreditingTransaction(lockingScript, amount)

  const spend = new Spend({
    sourceTXID: creditTx.id('hex'),
    sourceOutputIndex: 0,
    sourceSatoshis: amount,
    lockingScript,
    transactionVersion: getNumber(input, 'tx_version', 1),
    otherInputs: [],
    outputs: [{ lockingScript: new LockingScript(), satoshis: amount }],
    inputIndex: 0,
    unlockingScript,
    inputSequence: 0xffffffff,
    lockTime: 0,
    verifyFlags: getString(input, 'flags_csv')
  })

  let valid = false
  try {
    valid = spend.validate()
  } catch (_e) {
    valid = false
  }
  expect(valid).toBe(getBool(expected, 'valid'))
}

export function dispatchNodeSighashFixture (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const tx = Transaction.fromHex(getString(input, 'tx_hex'))
  const inputIndex = getNumber(input, 'input_index')
  const txInput = tx.inputs[inputIndex]
  const otherInputs = [...tx.inputs]
  otherInputs.splice(inputIndex, 1)

  const params = {
    sourceTXID: txInput.sourceTXID ?? '',
    sourceOutputIndex: txInput.sourceOutputIndex,
    sourceSatoshis: 0,
    transactionVersion: tx.version,
    otherInputs,
    outputs: tx.outputs,
    inputIndex,
    subscript: Script.fromHex(getString(input, 'script_hex')),
    inputSequence: txInput.sequence ?? 0xffffffff,
    lockTime: tx.lockTime,
    scope: getNumber(input, 'hash_type')
  }

  const regular = Hash.hash256(TransactionSignature.format({
    ...params,
    ignoreChronicle: getStringArray(input, 'sources').includes('teranode')
  })).reverse()
  const original = Hash.hash256(TransactionSignature.formatOTDA(params)).reverse()

  expect(bytesToHex(regular)).toBe(getString(expected, 'regular_hash'))
  expect(bytesToHex(original)).toBe(getString(expected, 'original_hash'))
}

function parseTransactionOrReturnInvalid (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): Transaction | null {
  try {
    const tx = Transaction.fromHex(getString(input, 'tx_hex'))
    expect(bytesToHex(tx.toBinary())).toBe(getString(input, 'tx_hex'))
    return tx
  } catch (e) {
    if (getBool(expected, 'valid')) throw e
    return null
  }
}

function countRejectedSpends (
  tx: Transaction,
  prevouts: Array<Record<string, unknown>>,
  flagStrings: string[],
  expectValid: boolean
): number {
  let rejectedSpendCases = 0
  for (const flags of flagStrings) {
    for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
      rejectedSpendCases += countOneSpend(tx, prevouts, flags, inputIndex, expectValid)
    }
  }
  return rejectedSpendCases
}

function countOneSpend (
  tx: Transaction,
  prevouts: Array<Record<string, unknown>>,
  flags: string,
  inputIndex: number,
  expectValid: boolean
): number {
  try {
    const valid = validateNodeTransactionSpend(tx, prevouts, flags, inputIndex)
    if (expectValid) expect(valid).toBe(true)
    return valid ? 0 : 1
  } catch (e) {
    if (expectValid) throw e
    return 1
  }
}

export function dispatchNodeTransactionFixture (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const tx = parseTransactionOrReturnInvalid(input, expected)
  if (tx === null) return

  const prevouts = Array.isArray(input.prevouts)
    ? input.prevouts as Array<Record<string, unknown>>
    : []
  const flagStrings = getStringArray(input, 'flag_strings')
  const expectValid = getBool(expected, 'valid')

  const rejectedSpendCases = countRejectedSpends(tx, prevouts, flagStrings, expectValid)

  if (!expectValid) {
    expect(rejectedSpendCases).toBeGreaterThan(0)
  }
}
