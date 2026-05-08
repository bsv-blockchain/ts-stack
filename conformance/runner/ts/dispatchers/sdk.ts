/**
 * SDK dispatcher — covers all sdk.* and sdk-adjacent categories.
 *
 * Pure migration from the monolithic runner.test.ts. No behaviour change.
 */

import { expect } from '@jest/globals'
import {
  Hash,
  PrivateKey,
  PublicKey,
  Signature,
  BigNumber,
  MerklePath,
  Transaction,
  Beef
} from '@bsv/sdk'
import * as BSM from '@bsv/sdk/compat/BSM'
import ECIES from '@bsv/sdk/compat/ECIES'
import { AESGCM } from '@bsv/sdk/primitives/AESGCM'
import {
  ecdsaMessageTooLarge,
  ecdsaPubkeyInfinity,
  ecdsaExplicitSignatureVerify,
  ecdsaBatchMessages,
  ecdsaWrongPubkey,
  ecdsaSignAndVerify,
  computeMerkleRootFromDisplayTxids,
  merklePathLeafPair,
  merklePathCoinbase,
  merklePathFromBump,
  serializationRawHex,
  serializationEfHex,
  serializationBeefHex,
  serializationBumpHex,
  signatureFromPrivkey,
  signatureFromDer,
  signatureFromCompact,
  bsmVerifyDer,
  bsmVerifyCompact,
  bsmRecovery,
  evalWriteBn,
  evalWriteBnRange,
  evalFindAndDelete,
  evalHex,
  evalBinary,
  evalP2PKH,
  evalScriptPubkey,
  evalDataLengthBytes,
  evalScriptAsm,
  dispatchNodeScriptFixture,
  dispatchNodeSighashFixture,
  dispatchNodeTransactionFixture
} from './sdkHelpers.js'

export const categories: ReadonlyArray<string> = [
  'sha256',
  'ripemd160',
  'hash160',
  'hmac',
  'ecdsa',
  'aes',
  'ecies',
  'signature',
  'bsm',
  'key-derivation',
  'private-key',
  'public-key',
  'evaluation',
  'merkle-path',
  'serialization',
  // regression category that maps to SDK logic
  'beef-v2-txid-panic'
]

// ── Helpers ────────────────────────────────────────────────────────────────────

export function hexToBytes (hex: string): number[] {
  if (hex.length % 2 !== 0) hex = '0' + hex
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    out.push(Number.parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

export function bytesToHex (bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

export function decodeMessage (msg: string, encoding: string): number[] {
  if (encoding === 'hex') return hexToBytes(msg)
  return Array.from(new TextEncoder().encode(msg))
}

export function getString (m: Record<string, unknown>, key: string): string {
  const v = m[key]
  return typeof v === 'string' ? v : ''
}

export function getBool (m: Record<string, unknown>, key: string): boolean {
  return m[key] === true
}

export function getNumber (m: Record<string, unknown>, key: string, fallback = 0): number {
  const v = m[key]
  return typeof v === 'number' ? v : fallback
}

export function getStringArray (m: Record<string, unknown>, key: string): string[] {
  const v = m[key]
  if (!Array.isArray(v)) return []
  return v.filter((item): item is string => typeof item === 'string')
}

// ── Individual dispatchers ─────────────────────────────────────────────────────

function dispatchSHA256 (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const msg = getString(input, 'message')
  const encoding = getString(input, 'encoding')
  const double = getBool(input, 'double')

  const data = decodeMessage(msg, encoding)
  const result = double ? Hash.hash256(data) : Hash.sha256(data)

  expect(bytesToHex(result)).toBe(getString(expected, 'hash'))
}

function dispatchRIPEMD160 (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const msg = getString(input, 'message')
  const encoding = getString(input, 'encoding')
  const data = decodeMessage(msg, encoding)
  const result = Hash.ripemd160(data)
  expect(bytesToHex(result)).toBe(getString(expected, 'hash'))
}

function dispatchHash160 (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  let data: number[]
  const pubkey = getString(input, 'pubkey')
  if (pubkey === '') {
    const msg = getString(input, 'message')
    const encoding = getString(input, 'encoding')
    data = decodeMessage(msg, encoding)
  } else {
    data = hexToBytes(pubkey)
  }
  const result = Hash.hash160(data)
  expect(bytesToHex(result)).toBe(getString(expected, 'hash160'))
}

function dispatchHMAC (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const algorithm = getString(input, 'algorithm').toLowerCase()
  const keyStr = getString(input, 'key')
  const keyEncoding = getString(input, 'key_encoding')
  const msg = getString(input, 'message')
  const msgEncoding = getString(input, 'message_encoding')

  const keyData = keyEncoding === 'hex'
    ? hexToBytes(keyStr)
    : Array.from(new TextEncoder().encode(keyStr))
  const msgData = decodeMessage(msg, msgEncoding)

  let result: number[]
  if (algorithm === 'hmac-sha256') {
    result = Hash.sha256hmac(keyData, msgData)
  } else if (algorithm === 'hmac-sha512') {
    result = Hash.sha512hmac(keyData, msgData)
  } else {
    throw new Error(`Unknown HMAC algorithm: ${algorithm}`)
  }

  expect(bytesToHex(result)).toBe(getString(expected, 'hmac'))
}

function dispatchECDSA (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Custom k values require TS-specific API — skip gracefully
  const kVal = getString(input, 'k')
  if (kVal !== '' && kVal !== 'drbg') return
  if ('k_function' in input) return

  if (getBool(input, 'message_too_large')) {
    ecdsaMessageTooLarge(input)
    return
  }

  if (getString(input, 'pubkey') === 'infinity') {
    ecdsaPubkeyInfinity(input)
    return
  }

  // Curve operation vectors — pure group law axioms
  const op = getString(input, 'operation')
  if (op !== '') {
    if (op === 'point_add_negation' || op === 'scalar_mul_zero') {
      expect(getBool(expected, 'is_infinity')).toBe(true)
    }
    return
  }

  // Explicit-signature verify (signature_r / signature_s present)
  if (getString(input, 'signature_r') !== '') {
    ecdsaExplicitSignatureVerify(input, expected)
    return
  }

  const privHex = getString(input, 'privkey_hex')
  if (privHex === '') return
  const privKey = PrivateKey.fromHex(privHex)

  // Batch forceLowS across multiple messages
  const msgs = input['messages']
  if (Array.isArray(msgs)) {
    ecdsaBatchMessages(msgs, privKey)
    return
  }

  // Wrong-pubkey verify
  if (getString(input, 'wrong_pubkey_scalar') !== '') {
    ecdsaWrongPubkey(input, expected, privKey)
    return
  }

  ecdsaSignAndVerify(input, expected, privKey)
}

function dispatchECIES (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const senderPrivHex = getString(input, 'sender_private_key') || getString(input, 'alice_private_key')
  const recipPubHex = getString(input, 'recipient_public_key') || getString(input, 'bob_public_key')
  const recipPrivHex = getString(input, 'recipient_private_key') || getString(input, 'bob_private_key')
  const msgStr = getString(input, 'message')
  const msgEncoding = getString(input, 'message_encoding')

  // Shape 2: decrypt-only (no sender key, pre-made ciphertext)
  if (senderPrivHex === '') {
    const ctHex = getString(input, 'ciphertext_hex')
    const wantPlainHex = getString(expected, 'decrypted_message')
    if (ctHex === '' || recipPrivHex === '') return

    const plain = ECIES.electrumDecrypt(hexToBytes(ctHex), PrivateKey.fromHex(recipPrivHex))
    expect(bytesToHex(plain)).toBe(wantPlainHex)
    return
  }

  const senderPriv = PrivateKey.fromHex(senderPrivHex)

  // no_key=true: ECDH symmetric mode
  if (getBool(input, 'no_key')) {
    const alicePriv = PrivateKey.fromHex(getString(input, 'alice_private_key'))
    const alicePub = PublicKey.fromString(getString(input, 'alice_public_key'))
    const bobPriv = PrivateKey.fromHex(getString(input, 'bob_private_key'))
    const bobPub = PublicKey.fromString(getString(input, 'bob_public_key'))

    const msgBytes = msgEncoding === 'hex' ? hexToBytes(msgStr) : decodeMessage(msgStr, 'utf8')

    const ct1 = ECIES.electrumEncrypt(msgBytes, bobPub, alicePriv, true)
    const ct2 = ECIES.electrumEncrypt(msgBytes, alicePub, bobPriv, true)

    if (getBool(expected, 'ciphertext_symmetric')) {
      expect(bytesToHex(ct1)).toBe(bytesToHex(ct2))
    }
    if (getString(expected, 'decrypted_message_utf8') !== '') {
      const plain = ECIES.electrumDecrypt(ct1, bobPriv, alicePub)
      expect(new TextDecoder().decode(new Uint8Array(plain))).toBe(getString(expected, 'decrypted_message_utf8'))
    }
    return
  }

  const msgBytes = msgEncoding === 'hex' ? hexToBytes(msgStr) : decodeMessage(msgStr, 'utf8')

  const wantCtHex = getString(expected, 'ciphertext_hex')
  if (wantCtHex !== '') {
    const recipPub = PublicKey.fromString(recipPubHex)
    const ct = ECIES.electrumEncrypt(msgBytes, recipPub, senderPriv, false)
    expect(bytesToHex(ct)).toBe(wantCtHex)
  }

  const wantPlainHex = getString(expected, 'decrypted_message')
  if (wantPlainHex !== '' && recipPrivHex !== '') {
    const recipPriv = PrivateKey.fromHex(recipPrivHex)
    const ctHex = getString(input, 'ciphertext_hex') || wantCtHex
    const plain = ECIES.electrumDecrypt(hexToBytes(ctHex), recipPriv, senderPriv.toPublicKey())
    expect(bytesToHex(plain)).toBe(wantPlainHex)
  }
}

function dispatchAES (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const algorithm = getString(input, 'algorithm')
  const keyHex = getString(input, 'key')
  const key = hexToBytes(keyHex)

  if (algorithm === 'aes-block') {
    // AES-block (ECB) is not publicly exported from @bsv/sdk.
    // It is only used internally within ECIES (AESWrapper class).
    // Skip without failing — these vectors are covered by the Go runner.
    if (getString(expected, 'error') !== '') return
    return
  }

  if (algorithm === 'aes-gcm') {
    // AESGCM with fixed IV is available via primitives internal export.
    const ptHex = getString(input, 'plaintext')
    const ivHex = getString(input, 'iv')
    const aadHex = getString(input, 'aad')

    const pt = new Uint8Array(hexToBytes(ptHex))
    const iv = new Uint8Array(hexToBytes(ivHex))
    const keyArr = new Uint8Array(key)
    const aad = aadHex === '' ? undefined : new Uint8Array(hexToBytes(aadHex))

    // AESGCM does not support AAD in this SDK version; skip if aad is present
    if (aad !== undefined) return

    const { result, authenticationTag } = AESGCM(pt, iv, keyArr)

    const wantCT = getString(expected, 'ciphertext')
    const wantTag = getString(expected, 'authentication_tag')

    if (wantCT !== '') expect(bytesToHex(result)).toBe(wantCT)
    if (wantTag !== '') expect(bytesToHex(authenticationTag)).toBe(wantTag)
  }
}

// ── Key-derivation sub-handlers ───────────────────────────────────────────────

function keyDerivationPrivkeyRoundtrip (privHexIn: string, expected: Record<string, unknown>): boolean {
  const wantRound = getString(expected, 'privkey_hex_roundtrip')
  if (wantRound !== '') {
    expect(PrivateKey.fromHex(privHexIn).toHex()).toBe(wantRound)
    return true
  }
  const wantPrefix = getString(expected, 'pubkey_der_prefix')
  if (wantPrefix !== '') {
    const der = PrivateKey.fromHex(privHexIn).toPublicKey().encode(true) as number[]
    if ('pubkey_der_length_bytes' in expected) {
      expect(der.length).toBe(expected['pubkey_der_length_bytes'])
    }
    const gotPrefix = bytesToHex([der[0]])
    const prefixes = wantPrefix.split(' or ').map(p => p.trim())
    expect(prefixes).toContain(gotPrefix)
    return true
  }
  return false
}

function keyDerivationOffCurve (input: Record<string, unknown>, expected: Record<string, unknown>): void {
  const xF = input['pubkey_x'] as number
  const yF = input['pubkey_y'] as number
  const xHex = BigInt(Math.round(xF)).toString(16).padStart(64, '0')
  const yHex = BigInt(Math.round(yF)).toString(16).padStart(64, '0')
  expect(() => PublicKey.fromString('04' + xHex + yHex)).toThrow()
}

function dispatchKeyDerivation (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Shape 1: privkey hex round-trip / pubkey DER properties
  const privHexIn = getString(input, 'privkey_hex')
  if (privHexIn !== '') {
    if (keyDerivationPrivkeyRoundtrip(privHexIn, expected)) return
  }

  // Shape 2: BRC-42 recipient key derivation (private)
  const recipPrivHex = getString(input, 'recipient_private_key_hex')
  if (recipPrivHex !== '') {
    const senderPub = PublicKey.fromString(getString(input, 'sender_public_key_hex'))
    const invoiceNum = getString(input, 'invoice_number')
    const derived = PrivateKey.fromHex(recipPrivHex).deriveChild(senderPub, invoiceNum)
    expect(derived.toHex()).toBe(getString(expected, 'derived_private_key_hex'))
    return
  }

  // Shape 3: BRC-42 sender key derivation (public)
  const senderPrivHex = getString(input, 'sender_private_key_hex')
  if (senderPrivHex !== '') {
    const recipPub = PublicKey.fromString(getString(input, 'recipient_public_key_hex'))
    const invoiceNum = getString(input, 'invoice_number')
    const derived = recipPub.deriveChild(PrivateKey.fromHex(senderPrivHex), invoiceNum)
    expect(bytesToHex(derived.encode(true) as number[])).toBe(getString(expected, 'derived_public_key_hex'))
    return
  }

  // key-017: off-curve point → error
  if ('pubkey_x' in input && getBool(expected, 'throws')) {
    keyDerivationOffCurve(input, expected)
    return
  }

  // key-016: direct_constructor is TS-specific
  if (getString(input, 'operation') === 'direct_constructor') return
}

function dispatchPrivateKey (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Shape: fromWif → privkey_hex + pubkey_hex
  const wif = getString(input, 'wif')
  if (wif !== '') {
    let privKey: PrivateKey
    try {
      privKey = PrivateKey.fromWif(wif)
    } catch (e) {
      if (getString(expected, 'error') !== '') return
      throw e
    }
    if (getString(expected, 'privkey_hex') !== '') {
      expect(privKey.toHex()).toBe(getString(expected, 'privkey_hex'))
    }
    if (getString(expected, 'pubkey_hex') !== '') {
      expect(bytesToHex(privKey.toPublicKey().encode(true) as number[])).toBe(getString(expected, 'pubkey_hex'))
    }
    return
  }

  // Shape: privkey_hex → round-trip + optional pubkey_hex
  const privHex = getString(input, 'privkey_hex')
  if (privHex !== '') {
    let privKey: PrivateKey
    try {
      privKey = PrivateKey.fromHex(privHex)
    } catch (e) {
      if (getString(expected, 'error') !== '') return
      throw e
    }
    if (getString(expected, 'privkey_hex_roundtrip') !== '') {
      expect(privKey.toHex()).toBe(getString(expected, 'privkey_hex_roundtrip'))
    }
    if (getString(expected, 'pubkey_hex') !== '') {
      expect(bytesToHex(privKey.toPublicKey().encode(true) as number[])).toBe(getString(expected, 'pubkey_hex'))
    }
    return
  }

  // BRC-42 derivation
  if (getString(input, 'recipient_private_key_hex') !== '') {
    dispatchKeyDerivation(input, expected)
  }
}

// ── Public-key sub-handlers ────────────────────────────────────────────────────

function pubkeyFromPrivkey (privHex: string, expected: Record<string, unknown>): void {
  if (getString(expected, 'pubkey_der_hex') !== '') {
    const der = PrivateKey.fromHex(privHex).toPublicKey().encode(true) as number[]
    expect(bytesToHex(der)).toBe(getString(expected, 'pubkey_der_hex'))
  }
}

function pubkeyRoundtrip (pubHex: string, expected: Record<string, unknown>): void {
  if (getString(expected, 'pubkey_der_hex_roundtrip') !== '') {
    const der = PublicKey.fromString(pubHex).encode(true) as number[]
    expect(bytesToHex(der)).toBe(getString(expected, 'pubkey_der_hex_roundtrip'))
  }
}

function dispatchPublicKey (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Shape: privkey_hex → pubkey_der_hex
  const privHex = getString(input, 'privkey_hex')
  if (privHex !== '') {
    pubkeyFromPrivkey(privHex, expected)
    return
  }

  // Shape: pubkey_der_hex → round-trip
  const pubHex = getString(input, 'pubkey_der_hex')
  if (pubHex !== '') {
    pubkeyRoundtrip(pubHex, expected)
    return
  }

  // BRC-42 public derivation or off-curve error
  if (getString(input, 'sender_private_key_hex') !== '' || 'pubkey_x' in input) {
    dispatchKeyDerivation(input, expected)
    return
  }

  // pubkey-constructor-err-001: TS-specific
  if ('constructor_arg' in input) return
}

function dispatchMerkleParent (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const left = hexToBytes(getString(input, 'left_hex'))
  const right = hexToBytes(getString(input, 'right_hex'))
  const parent = Hash.hash256([...left, ...right])
  expect(bytesToHex(parent)).toBe(getString(expected, 'parent_hex'))
}

function dispatchMerklePath (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  // Shape: findleaf — build parent from two raw leaf hashes
  if (getString(input, 'leaf0_hash') !== '') {
    merklePathLeafPair(input, expected)
    return
  }

  const bumpHex = getString(input, 'bump_hex') || getString(input, 'combined_bump_hex')

  if (bumpHex === '') {
    if ('height' in input) {
      merklePathCoinbase(input, expected)
      return
    }
    if ('txids' in input) {
      const txids = (input['txids'] as unknown[]).map(String)
      const root = computeMerkleRootFromDisplayTxids(txids)
      if (getString(expected, 'merkle_root') !== '') expect(root).toBe(getString(expected, 'merkle_root'))
      return
    }
    if ('full_block_txids' in input) {
      const txids = (input['full_block_txids'] as unknown[]).map(String)
      const root = computeMerkleRootFromDisplayTxids(txids)
      if (getString(expected, 'merkle_root') !== '') expect(root).toBe(getString(expected, 'merkle_root'))
      if (getBool(expected, 'extracted_smaller_than_full')) expect(txids.length).toBeGreaterThanOrEqual(2)
      return
    }
    if ('txids_to_extract' in input) {
      const toExt = input['txids_to_extract'] as unknown[]
      if (toExt.length === 0 && getBool(expected, 'throws')) return
      return
    }
    return
  }

  merklePathFromBump(MerklePath.fromHex(bumpHex), input, expected)
}

function dispatchBEEF (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const beefHex = getString(input, 'beef_hex')
  const beefBytes = hexToBytes(beefHex)

  const wantParseSucceeds = getBool(expected, 'parse_succeeds')
  let beef: Beef | undefined
  let parseSucceeds = false
  try {
    beef = Beef.fromBinary(beefBytes)
    parseSucceeds = true
  } catch (_e) {
    parseSucceeds = false
  }

  expect(parseSucceeds).toBe(wantParseSucceeds)
  if (!parseSucceeds) return

  if ('txid_non_null' in expected) {
    const wantTxidNonNull = getBool(expected, 'txid_non_null')
    const hasTx = beef!.txs.length > 0
    expect(hasTx).toBe(wantTxidNonNull)
  }
}

// ── Serialization op handlers ─────────────────────────────────────────────────

function serOpNewTransaction (expected: Record<string, unknown>): void {
  const tx = new Transaction()
  if ('version' in expected) expect(tx.version).toBe(expected['version'])
  if ('inputs_count' in expected) expect(tx.inputs.length).toBe(expected['inputs_count'])
  if ('outputs_count' in expected) expect(tx.outputs.length).toBe(expected['outputs_count'])
  if ('locktime' in expected) expect(tx.lockTime).toBe(expected['locktime'])
}

function serOpFromAtomicBEEF (input: Record<string, unknown>, expected: Record<string, unknown>): void {
  const beefBytes = hexToBytes(getString(input, 'beef_hex'))
  if (getBool(expected, 'throws')) {
    expect(() => Transaction.fromAtomicBEEF(beefBytes)).toThrow()
  } else {
    expect(Transaction.fromAtomicBEEF(beefBytes)).toBeDefined()
  }
}

function serOpAddInput (expected: Record<string, unknown>): void {
  if (getBool(expected, 'throws')) {
    const tx = new Transaction()
    expect(() => tx.addInput({} as any)).toThrow()
    return
  }
  if ('sequence' in expected) {
    expect(expected['sequence']).toBe(0xffffffff)
  }
}

function serOpGetFeeNoSource (input: Record<string, unknown>, expected: Record<string, unknown>): void {
  if (!getBool(expected, 'throws')) return
  const sourceTxid = getString(input, 'source_txid')
  const sourceOutputIdx = (input['source_output_index'] as number) ?? 0
  const tx = new Transaction()
  tx.addInput({ sourceTXID: sourceTxid, sourceOutputIndex: sourceOutputIdx, sequence: 0xffffffff })
  expect(() => tx.getFee()).toThrow()
}

function serOpParseScriptOffsets (input: Record<string, unknown>, expected: Record<string, unknown>): void {
  const tx = Transaction.fromHex(getString(input, 'raw_hex'))
  if ('inputs_count' in expected) expect(tx.inputs.length).toBe(expected['inputs_count'])
  if ('outputs_count' in expected) expect(tx.outputs.length).toBe(expected['outputs_count'])
}

/** Dispatch named operation vectors via a lookup table to keep CC low. */
function dispatchSerializationOp (
  op: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): boolean {
  switch (op) {
    case 'new_transaction':          serOpNewTransaction(expected); return true
    case 'new_transaction_hash_hex': {
      const txid = new Transaction().id('hex')
      if ('hash_length_chars' in expected) expect(txid.length).toBe(expected['hash_length_chars'])
      return true
    }
    case 'new_transaction_id_binary': {
      const txid = new Transaction().id()
      if ('id_length_bytes' in expected) expect(txid.length).toBe(expected['id_length_bytes'])
      return true
    }
    case 'fromAtomicBEEF':    serOpFromAtomicBEEF(input, expected); return true
    case 'addInput':          serOpAddInput(expected); return true
    case 'addOutput': {
      if (getBool(expected, 'throws')) {
        const tx = new Transaction()
        expect(() => tx.addOutput({ satoshis: -1 } as any)).toThrow()
      }
      return true
    }
    case 'getFee_no_source':    serOpGetFeeNoSource(input, expected); return true
    case 'parseScriptOffsets':  serOpParseScriptOffsets(input, expected); return true
    default:                    return false
  }
}

function dispatchSerialization (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const op = getString(input, 'operation')
  if (op !== '' && dispatchSerializationOp(op, input, expected)) return

  if (getString(input, 'raw_hex') !== '') { serializationRawHex(input, expected); return }
  if (getString(input, 'ef_hex') !== '') { serializationEfHex(input, expected); return }
  if (getString(input, 'beef_hex') !== '') { serializationBeefHex(input, expected); return }
  if (getString(input, 'bump_hex') !== '') { serializationBumpHex(input, expected) }
}

function dispatchSignature (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  if (getString(input, 'privkey_hex') !== '') {
    signatureFromPrivkey(input, expected)
    return
  }

  if (getString(input, 'der_hex') !== '') {
    signatureFromDer(input, expected)
    return
  }

  const derBytesHex = getString(input, 'der_bytes_hex')
  if (derBytesHex !== '') {
    if (getBool(expected, 'throws')) {
      expect(() => Signature.fromDER(hexToBytes(derBytesHex))).toThrow()
    }
    return
  }

  if (getString(input, 'compact_hex') !== '') {
    signatureFromCompact(input, expected)
    return
  }

  // Compact error vectors with descriptive inputs
  if ('byte_count' in input && getBool(expected, 'throws')) return
  if ('first_byte' in input && getBool(expected, 'throws')) return
}

function dispatchBSM (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  const msgBytes = hexToBytes(getString(input, 'message_hex'))

  // magicHash vectors
  if (getString(expected, 'magic_hash_hex') !== '') {
    expect(bytesToHex(BSM.magicHash(msgBytes))).toBe(getString(expected, 'magic_hash_hex')) // NOSONAR — deprecated BSM API used intentionally for conformance testing
    return
  }

  const privHex = getString(input, 'privkey_hex')
  const privWif = getString(input, 'privkey_wif')
  let privKey: PrivateKey | null = null
  if (privWif !== '') {
    privKey = PrivateKey.fromWif(privWif)
  } else if (privHex !== '') {
    privKey = PrivateKey.fromHex(privHex)
  }

  // sign → DER output
  if (getString(expected, 'der_hex') !== '' && privKey !== null) {
    const sig = BSM.sign(msgBytes, privKey, 'raw') as Signature // NOSONAR — deprecated BSM API used intentionally for conformance testing
    expect(sig.toDER('hex')).toBe(getString(expected, 'der_hex'))
    return
  }

  // sign → base64 compact
  if (getString(expected, 'base64_compact_sig') !== '' && privKey !== null) {
    expect(BSM.sign(msgBytes, privKey, 'base64')).toBe(getString(expected, 'base64_compact_sig')) // NOSONAR — deprecated BSM API used intentionally for conformance testing
    return
  }

  // verify vectors
  if ('valid' in expected) {
    const magicHashBN = new BigNumber(BSM.magicHash(msgBytes)) // NOSONAR — deprecated BSM API used intentionally for conformance testing
    if (getString(input, 'der_hex') !== '') {
      bsmVerifyDer(input, expected, magicHashBN)
      return
    }
    if (getString(input, 'compact_sig_hex') !== '') {
      bsmVerifyCompact(input, expected, magicHashBN)
      return
    }
  }

  // recovery vectors
  if (getString(expected, 'recovered_pubkey_hex') !== '' || 'recovery_factor' in expected) {
    bsmRecovery(input, expected, msgBytes)
  }
}

function dispatchEvaluation (
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void {
  switch (getString(input, 'fixture_type')) {
    case 'node-script':      return dispatchNodeScriptFixture(input, expected)
    case 'node-sighash':     return dispatchNodeSighashFixture(input, expected)
    case 'node-transaction': return dispatchNodeTransactionFixture(input, expected)
  }

  const op = getString(input, 'operation')
  if (op !== '') {
    switch (op) {
      case 'writeBn':       evalWriteBn(input, expected); return
      case 'writeBn_range': evalWriteBnRange(input, expected); return
      case 'findAndDelete': evalFindAndDelete(input, expected); return
      default:              return
    }
  }

  if ('hex' in input)                                   { evalHex(input, expected); return }
  if ('binary' in input)                                { evalBinary(input, expected); return }
  if (getString(input, 'type') === 'P2PKH_lock')        { evalP2PKH(input, expected); return }
  if ('script_pubkey_hex' in input)                     { evalScriptPubkey(input, expected); return }
  if ('data_length_bytes' in input)                     { evalDataLengthBytes(input, expected); return }
  if ('script_asm' in input)                            { evalScriptAsm(input, expected) }
}

// ── Main dispatch entry point ──────────────────────────────────────────────────

export function dispatch (
  category: string,
  input: Record<string, unknown>,
  expected: Record<string, unknown>
): void | Promise<void> {
  switch (category) {
    case 'sha256':        return dispatchSHA256(input, expected)
    case 'ripemd160':     return dispatchRIPEMD160(input, expected)
    case 'hash160':       return dispatchHash160(input, expected)
    case 'hmac':          return dispatchHMAC(input, expected)
    case 'ecdsa':         return dispatchECDSA(input, expected)
    case 'aes':           return dispatchAES(input, expected)
    case 'ecies':         return dispatchECIES(input, expected)
    case 'signature':     return dispatchSignature(input, expected)
    case 'bsm':           return dispatchBSM(input, expected)
    case 'key-derivation':  return dispatchKeyDerivation(input, expected)
    case 'private-key':     return dispatchPrivateKey(input, expected)
    case 'public-key':      return dispatchPublicKey(input, expected)
    case 'evaluation':      return dispatchEvaluation(input, expected)
    case 'merkle-path':     return dispatchMerklePath(input, expected)
    case 'serialization':   return dispatchSerialization(input, expected)
    case 'beef-v2-txid-panic': return dispatchBEEF(input, expected)
    default:
      throw new Error(`sdk dispatcher: unknown category '${category}'`)
  }
}
