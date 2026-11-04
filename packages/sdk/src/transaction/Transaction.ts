// @ts-nocheck
import TransactionInput from './TransactionInput.js'
import TransactionOutput from './TransactionOutput.js'
import UnlockingScript from '../script/UnlockingScript.js'
import LockingScript from '../script/LockingScript.js'
import { scriptSerializationIdentity } from '../script/Script.js'
import {
  Reader,
  Writer,
  toHex,
  toArray,
  ReaderUint8Array,
  toUint8Array,
  WriterUint8Array
} from '../primitives/utils.js'
import { hash256 } from '../primitives/Hash.js'
import FeeModel from './FeeModel.js'
import LivePolicy from './fee-models/LivePolicy.js'
import {
  Broadcaster,
  BroadcastResponse,
  BroadcastFailure,
  validateBroadcastResult
} from './Broadcaster.js'
import MerklePath from './MerklePath.js'
import Spend from '../script/Spend.js'
import ChainTracker from './ChainTracker.js'
import { defaultBroadcaster } from './broadcasters/DefaultBroadcaster.js'
import { defaultChainTracker } from './chaintrackers/DefaultChainTracker.js'
import { Beef, BEEF_V1 } from './Beef.js'
import P2PKH from '../script/templates/P2PKH.js'
import type {
  WalletInterface,
  DescriptionString5to50Bytes,
  CreateActionOptions
} from '../wallet/Wallet.interfaces.js'
import { completeBoundAction, type BoundActionOptions } from '../wallet/completeBoundAction.js'
import TransactionSignature, {
  type SignatureHashCache
} from '../primitives/TransactionSignature.js'
import Random from '../primitives/Random.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { scriptVerificationBackend } from './ScriptVerificationBackend.js'
import {
  evidenceScriptScope,
  scopedScriptBackend,
  type EvidenceScriptScope
} from './EvidenceScriptWork.js'

const serializedBytes = Symbol()
const knownId = Symbol()

/** @internal Returns the synchronized serialization identity without exposing it publicly. */
export function transactionSerializationIdentity(transaction: Transaction): Uint8Array {
  return transaction[serializedBytes]()
}

/** @internal Seeds an ID already computed from the transaction's retained serialization. */
export function cacheKnownTransactionId(transaction: Transaction, txid: string): void {
  transaction[knownId](txid)
}

/** Post-Chronicle height used when an input's source UTXO mined-height is unobtainable. */
const POST_CHRONICLE_HEIGHT_FALLBACK = 943816
const MAX_SATOSHIS = 21e14
const MAX_EF_SOURCE_OUTPUT_INDEX = 1_000_000

function requireSatoshiAmount(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SATOSHIS
  ) {
    throw new RangeError(`${label} must be a non-negative safe integer no greater than 21e14.`)
  }
  return value
}

function addSatoshiAmount(total: number, value: number, label: string): number {
  const sum = total + value
  if (!Number.isSafeInteger(sum) || sum > MAX_SATOSHIS) {
    throw new RangeError(`${label} exceeds the maximum valid monetary range.`)
  }
  return sum
}

function requireUInt32(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${label} must be an unsigned 32-bit integer.`)
  }
  return value
}

function requireTXID(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a 32-byte hexadecimal transaction ID.`)
  }
  return value.toLowerCase()
}

function equalBytes(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

type QueuedScriptVerification = {
  tx: Transaction
  blockHeight: number
  consensus: boolean
  memoryLimit?: number
}

type TransactionVerificationState = {
  scriptsOnly: boolean
  memoryLimit: number | undefined
  txQueue: Transaction[]
  queuedTransactions: Set<Transaction>
  queuedTxids: Set<string>
  verifiedTransactions: Set<Transaction>
  verifiedTxids: Set<string>
}

type UnminedTransactionVerificationContext = TransactionVerificationState & {
  feeModel: FeeModel | undefined
  selectedVerifier: BdkVerifierInterface | undefined
  verifierQueue: QueuedScriptVerification[]
  scriptWork?: EvidenceScriptScope
}

/**
 * Represents a complete Bitcoin transaction. This class encapsulates all the details
 * required for creating, signing, and processing a Bitcoin transaction, including
 * inputs, outputs, and various transaction-related methods.
 *
 * @class Transaction
 * @property {number} version - The version number of the transaction. Used to specify
 *           which set of rules this transaction follows.
 * @property {TransactionInput[]} inputs - An array of TransactionInput objects, representing
 *           the inputs for the transaction. Each input references a previous transaction's output.
 * @property {TransactionOutput[]} outputs - An array of TransactionOutput objects, representing
 *           the outputs for the transaction. Each output specifies the amount of satoshis to be
 *           transferred and the conditions under which they can be spent.
 * @property {number} lockTime - The lock time of the transaction. If non-zero, it specifies the
 *           earliest time or block height at which the transaction can be added to the block chain.
 * @property {Record<string, any>} metadata - A key-value store for attaching additional data to
 *           the transaction object, not included in the transaction itself. Useful for adding descriptions, internal reference numbers, or other information.
 * @property {MerkleProof} [merklePath] - Optional. A merkle proof demonstrating the transaction's
 *           inclusion in a block. Useful for transaction verification using SPV.
 *
 * @example
 * // Creating a new transaction
 * let tx = new Transaction();
 * tx.addInput(...);
 * tx.addOutput(...);
 * await tx.fee();
 * await tx.sign();
 * await tx.broadcast();
 *
 * @description
 * The Transaction class provides comprehensive
 * functionality to handle various aspects of transaction creation, including
 * adding inputs and outputs, computing fees, signing the transaction, and
 * generating its binary or hexadecimal representation.
 */
export default class Transaction {
  version: number
  inputs: TransactionInput[]
  outputs: TransactionOutput[]
  lockTime: number
  metadata: Record<string, any>
  merklePath?: MerklePath
  #cachedHash?: number[]
  #cachedIdHex?: string
  #rawBytesCache?: Uint8Array
  #efBytesCache?: Uint8Array
  #hexCache?: string
  #activeSignatureHashCache?: SignatureHashCache
  #rawCacheState?: {
    version: number
    lockTime: number
    inputs: Array<{
      ref: TransactionInput
      sourceTXID: string | undefined
      sourceTransactionId: string | undefined
      sourceOutputIndex: number
      sequence: number | undefined
      unlockingScript: TransactionInput['unlockingScript']
      unlockingScriptBytes: Uint8Array | undefined
      sourceOutput: TransactionOutput | undefined
      sourceSatoshis: number | undefined
      sourceLockingScript: TransactionOutput['lockingScript'] | undefined
      sourceLockingScriptBytes: Uint8Array | undefined
    }>
    outputs: Array<{
      ref: TransactionOutput
      satoshis: number | undefined
      lockingScript: TransactionOutput['lockingScript']
      lockingScriptBytes: Uint8Array
    }>
  }

  /**
   * Returns the transaction-wide signature hash cache active during signing.
   * Callers outside a signing operation receive an isolated cache.
   *
   * @internal
   */
  getSignatureHashCache(): SignatureHashCache {
    return this.#activeSignatureHashCache ?? { hashOutputsSingle: new Map() }
  }

  #completeSourceTransaction(
    tx: Transaction,
    visiting: Set<Transaction>,
    complete: Set<Transaction>
  ): void {
    for (const input of tx.inputs) {
      if (input.sourceTXID == null && input.sourceTransaction != null) {
        input.sourceTXID = input.sourceTransaction.id('hex')
      }
    }
    visiting.delete(tx)
    complete.add(tx)
  }

  #scheduleSourceTransactions(
    tx: Transaction,
    visiting: Set<Transaction>,
    complete: Set<Transaction>,
    stack: Array<{ tx: Transaction; expanded: boolean }>
  ): void {
    if (visiting.has(tx)) {
      throw new Error('Cyclic source transaction graph')
    }
    visiting.add(tx)
    stack.push({ tx, expanded: true })
    for (let i = tx.inputs.length - 1; i >= 0; i--) {
      const source = tx.inputs[i].sourceTransaction
      if (tx.inputs[i].sourceTXID == null && source != null && !complete.has(source)) {
        stack.push({ tx: source, expanded: false })
      }
    }
  }

  /**
   * Iteratively materializes source transaction IDs so deep spend chains do not
   * recurse through `hash()` while serializing their parents.
   */
  materializeSourceTXIDs(): void {
    const complete = new Set<Transaction>()
    const visiting = new Set<Transaction>()
    const stack: Array<{ tx: Transaction; expanded: boolean }> = [{ tx: this, expanded: false }]

    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame == null) continue
      if (complete.has(frame.tx)) continue

      if (frame.expanded) {
        this.#completeSourceTransaction(frame.tx, visiting, complete)
        continue
      }

      this.#scheduleSourceTransactions(frame.tx, visiting, complete, stack)
    }
  }

  /**
   * Creates a new transaction, linked to its inputs and their associated merkle paths, from a BEEF V1, V2 or Atomic.
   * Optionally, you can provide a specific TXID to retrieve a particular transaction from the BEEF data.
   * If the TXID is provided but not found in the BEEF data, an error will be thrown.
   * If no TXID is provided, the last transaction in the BEEF data is returned, or the atomic txid.
   * @param beef A binary representation of transactions in BEEF format.
   * @param txid Optional TXID of the transaction to retrieve from the BEEF data.
   * @returns An anchored transaction, linked to its associated inputs populated with merkle paths.
   */
  static fromBEEF(beef: number[] | Uint8Array, txid?: string): Transaction {
    const { tx } = Transaction.#fromAnyBeef(beef, txid)
    return tx
  }

  /**
   * Zero-copy variant of {@link fromBEEF}. The caller must not mutate `beef`.
   */
  static fromBEEFView(beef: Uint8Array, txid?: string): Transaction {
    const { tx } = Transaction.#fromAnyBeef(beef, txid, true)
    return tx
  }

  /**
   * Creates a new transaction from an Atomic BEEF (BRC-95) structure.
   * Extracts the subject transaction and supporting merkle path and source transactions contained in the BEEF data
   *
   * @param beef A binary representation of an Atomic BEEF structure.
   * @returns The subject transaction, linked to its associated inputs populated with merkle paths.
   */
  static fromAtomicBEEF(beef: number[] | Uint8Array): Transaction {
    const { tx, txid, beef: b } = Transaction.#fromAnyBeef(beef)
    if (txid !== b.atomicTxid) {
      if (b.atomicTxid == null) {
        throw new Error('beef must conform to BRC-95 and must contain the subject txid.')
      } else {
        throw new Error(`Transaction with TXID ${b.atomicTxid} not found in BEEF data.`)
      }
    }
    if (!b.isAtomic(txid)) throw new Error('Atomic BEEF contains unrelated transaction data.')
    return tx
  }

  /**
   * Zero-copy variant of {@link fromAtomicBEEF}. The caller must not mutate
   * `beef` while any linked transaction remains in use.
   */
  static fromAtomicBEEFView(beef: Uint8Array): Transaction {
    const { tx, txid, beef: b } = Transaction.#fromAnyBeef(beef, undefined, true)
    if (txid !== b.atomicTxid) {
      if (b.atomicTxid == null)
        throw new Error('beef must conform to BRC-95 and must contain the subject txid.')
      throw new Error(`Transaction with TXID ${b.atomicTxid} not found in BEEF data.`)
    }
    if (!b.isAtomic(txid)) throw new Error('Atomic BEEF contains unrelated transaction data.')
    return tx
  }

  static #fromAnyBeef(
    beef: number[] | Uint8Array,
    txid?: string,
    zeroCopy: boolean = false
  ): { tx: Transaction; beef: Beef; txid: string } {
    const b =
      zeroCopy && beef instanceof Uint8Array
        ? Beef.fromBinaryView(beef)
        : Beef.fromBinaryStrict(beef)
    if (b.txs.length < 1) {
      throw new Error('beef must include at least one transaction.')
    }
    const lastTx = b.txs.at(-1)
    if (lastTx == null) {
      throw new Error('beef must include at least one transaction.')
    }
    const target = txid ?? b.atomicTxid ?? lastTx.txid
    const tx = b.findAtomicTransaction(target)
    if (tx == null) {
      if (txid == null) {
        throw new Error('beef does not contain transaction for atomic txid.')
      } else {
        throw new Error(`Transaction with TXID ${String(target)} not found in BEEF data.`)
      }
    }
    return { tx, beef: b, txid: target }
  }

  /**
   * Creates a new transaction, linked to its inputs and their associated merkle paths, from a EF (BRC-30) structure.
   *
   * EF source descriptors contain only a claimed source TXID, locking script,
   * and amount. They do not authenticate the complete source transaction or
   * prove that the described output exists or remains spendable. In an
   * adversarial environment the recipient must already be familiar with the
   * source information or independently verify it through trusted full
   * transaction and chain-state evidence before signing or authorizing value.
   * @param ef A binary representation of a transaction in EF format.
   * @returns An extended transaction, linked to its associated inputs by locking script and satoshis amounts only.
   */
  static fromEF(ef: number[] | Uint8Array): Transaction {
    const br = ReaderUint8Array.makeReader(ef)
    const version = br.readUInt32LE()
    if (toHex(br.read(6)) !== '0000000000ef') {
      throw new Error('Invalid EF marker')
    }
    const inputsLength = br.readVarIntNumStrict(false)
    const inputs: TransactionInput[] = []
    for (let i = 0; i < inputsLength; i++) {
      const sourceTXID = toHex(br.readReverse(32))
      const sourceOutputIndex = br.readUInt32LE()
      if (sourceOutputIndex > MAX_EF_SOURCE_OUTPUT_INDEX) {
        throw new RangeError('EF source output index exceeds the allocation limit')
      }
      const scriptLength = br.readVarIntNumStrict(false)
      const scriptBin = br.read(scriptLength)
      const unlockingScript = UnlockingScript.fromBinary(scriptBin)
      const sequence = br.readUInt32LE()
      const satoshis = br.readUInt64LEBn().toNumber()
      const lockingScriptLength = br.readVarIntNumStrict(false)
      const lockingScriptBin = br.read(lockingScriptLength)
      const lockingScript = LockingScript.fromBinary(lockingScriptBin)
      const sourceTransaction = new Transaction(undefined, [], [], undefined)
      sourceTransaction.outputs = Array.from({ length: sourceOutputIndex + 1 }).fill(null)
      sourceTransaction.outputs[sourceOutputIndex] = {
        satoshis,
        lockingScript
      }
      inputs.push({
        sourceTransaction,
        sourceTXID,
        sourceOutputIndex,
        unlockingScript,
        sequence
      })
    }
    const outputsLength = br.readVarIntNumStrict(false)
    const outputs: TransactionOutput[] = []
    for (let i = 0; i < outputsLength; i++) {
      const satoshis = br.readUInt64LEBn().toNumber()
      const scriptLength = br.readVarIntNumStrict(false)
      const scriptBin = br.read(scriptLength)
      const lockingScript = LockingScript.fromBinary(scriptBin)
      outputs.push({
        satoshis,
        lockingScript
      })
    }
    const lockTime = br.readUInt32LE()
    if (!br.eof()) throw new Error('Serialized EF transaction contains trailing data')
    return new Transaction(version, inputs, outputs, lockTime)
  }

  /**
   * Since the validation of blockchain data is atomically transaction data validation,
   * any application seeking to validate data in output scripts must store the entire transaction as well.
   * Since the transaction data includes the output script data, saving a second copy of potentially
   * large scripts can bloat application storage requirements.
   *
   * This function efficiently parses binary transaction data to determine the offsets and lengths of each script.
   * This supports the efficient retreival of script data from transaction data.
   *
   * @param bin binary transaction data
   * @returns {
   *   inputs: { vin: number, offset: number, length: number }[]
   *   outputs: { vout: number, offset: number, length: number }[]
   * }
   */
  static parseScriptOffsets(bin: number[] | Uint8Array): {
    inputs: Array<{ vin: number; offset: number; length: number }>
    outputs: Array<{ vout: number; offset: number; length: number }>
  } {
    const br = ReaderUint8Array.makeReader(bin)
    const inputs: Array<{ vin: number; offset: number; length: number }> = []
    const outputs: Array<{ vout: number; offset: number; length: number }> = []

    br.read(4) // version
    const inputsLength = br.readVarIntNumStrict(false)
    for (let i = 0; i < inputsLength; i++) {
      br.read(36) // txid and vout
      const scriptLength = br.readVarIntNumStrict(false)
      inputs.push({ vin: i, offset: br.pos, length: scriptLength })
      br.read(scriptLength + 4) // script and sequence
    }
    const outputsLength = br.readVarIntNumStrict(false)
    for (let i = 0; i < outputsLength; i++) {
      br.read(8) // satoshis
      const scriptLength = br.readVarIntNumStrict(false)
      outputs.push({ vout: i, offset: br.pos, length: scriptLength })
      br.read(scriptLength)
    }
    br.read(4) // lock time
    if (!br.eof()) throw new Error('Serialized transaction contains trailing data')
    return { inputs, outputs }
  }

  static fromReader(br: Reader | ReaderUint8Array): Transaction {
    return Transaction.#fromReaderInternal(br, false)
  }

  static #fromReaderInternal(br: Reader | ReaderUint8Array, zeroCopyScripts: boolean): Transaction {
    const version = br.readUInt32LE()
    const inputsLength = br.readVarIntNumStrict(false)
    const inputs: TransactionInput[] = []
    for (let i = 0; i < inputsLength; i++) {
      const sourceTXID = toHex(br.readReverse(32))
      const sourceOutputIndex = br.readUInt32LE()
      const scriptLength = br.readVarIntNumStrict(false)
      const scriptBin =
        zeroCopyScripts && br instanceof ReaderUint8Array
          ? br.readView(scriptLength)
          : br.read(scriptLength)
      const unlockingScript =
        zeroCopyScripts && scriptBin instanceof Uint8Array
          ? UnlockingScript.fromBinaryView(scriptBin)
          : UnlockingScript.fromBinary(scriptBin)
      const sequence = br.readUInt32LE()
      inputs.push({
        sourceTXID,
        sourceOutputIndex,
        unlockingScript,
        sequence
      })
    }
    const outputsLength = br.readVarIntNumStrict(false)
    const outputs: TransactionOutput[] = []
    for (let i = 0; i < outputsLength; i++) {
      const satoshis = br.readUInt64LEBn().toNumber()
      const scriptLength = br.readVarIntNumStrict(false)
      const scriptBin =
        zeroCopyScripts && br instanceof ReaderUint8Array
          ? br.readView(scriptLength)
          : br.read(scriptLength)
      const lockingScript =
        zeroCopyScripts && scriptBin instanceof Uint8Array
          ? LockingScript.fromBinaryView(scriptBin)
          : LockingScript.fromBinary(scriptBin)
      outputs.push({
        satoshis,
        lockingScript
      })
    }
    const lockTime = br.readUInt32LE()
    return new Transaction(version, inputs, outputs, lockTime)
  }

  /**
   * Creates a Transaction instance from a binary array.
   *
   * @static
   * @param {number[]} bin - The binary array representation of the transaction.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromBinary(bin: number[] | Uint8Array): Transaction {
    const rawBytes = Uint8Array.from(bin)
    return Transaction.fromBinaryView(rawBytes)
  }

  /**
   * Parses a transaction while retaining zero-copy views over `bin` for the raw
   * transaction and its scripts. The caller must not mutate `bin`.
   */
  static fromBinaryView(bin: Uint8Array): Transaction {
    const br = new ReaderUint8Array(bin)
    const tx = Transaction.#fromReaderInternal(br, true)
    if (!br.eof()) throw new Error('Serialized transaction contains trailing data')
    tx.#rawBytesCache = bin
    tx.#captureSerializationState()
    return tx
  }

  /**
   * Creates a Transaction instance from a hexadecimal string.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHex(hex: string): Transaction {
    const rawBytes = toUint8Array(hex, 'hex')
    const tx = Transaction.fromBinaryView(rawBytes)
    tx.#hexCache = toHex(rawBytes)
    return tx
  }

  /**
   * Creates a Transaction instance from a hexadecimal string encoded EF.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction EF.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHexEF(hex: string): Transaction {
    return Transaction.fromEF(toUint8Array(hex, 'hex'))
  }

  /**
   * Creates a Transaction instance from a hexadecimal string encoded BEEF.
   * Optionally, you can provide a specific TXID to retrieve a particular transaction from the BEEF data.
   * If the TXID is provided but not found in the BEEF data, an error will be thrown.
   * If no TXID is provided, the last transaction in the BEEF data is returned.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction BEEF.
   * @param {string} [txid] - Optional TXID of the transaction to retrieve from the BEEF data.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHexBEEF(hex: string, txid?: string): Transaction {
    return Transaction.fromBEEF(toUint8Array(hex, 'hex'), txid)
  }

  constructor(
    version: number = 1,
    inputs: TransactionInput[] = [],
    outputs: TransactionOutput[] = [],
    lockTime: number = 0,
    metadata: Record<string, any> = new Map(),
    merklePath?: MerklePath
  ) {
    this.version = version
    this.inputs = inputs
    this.outputs = outputs
    this.lockTime = lockTime
    this.metadata = metadata
    this.merklePath = merklePath
  }

  #invalidateSerializationCaches(): void {
    this.#cachedHash = undefined
    this.#cachedIdHex = undefined
    this.#rawBytesCache = undefined
    this.#efBytesCache = undefined
    this.#hexCache = undefined
    this.#rawCacheState = undefined
  }

  #sourceTransactionId(input: TransactionInput): string | undefined {
    return input.sourceTXID == null ? input.sourceTransaction?.id('hex') : undefined
  }

  #captureSerializationState(): void {
    this.#rawCacheState = {
      version: this.version,
      lockTime: this.lockTime,
      inputs: this.inputs.map(ref => {
        const sourceOutput = ref.sourceTransaction?.outputs[ref.sourceOutputIndex]
        return {
          ref,
          sourceTXID: ref.sourceTXID,
          sourceTransactionId: this.#sourceTransactionId(ref),
          sourceOutputIndex: ref.sourceOutputIndex,
          sequence: ref.sequence,
          unlockingScript: ref.unlockingScript,
          unlockingScriptBytes:
            ref.unlockingScript == null
              ? undefined
              : scriptSerializationIdentity(ref.unlockingScript),
          sourceOutput,
          sourceSatoshis: sourceOutput?.satoshis,
          sourceLockingScript: sourceOutput?.lockingScript,
          sourceLockingScriptBytes:
            sourceOutput == null
              ? undefined
              : scriptSerializationIdentity(sourceOutput.lockingScript)
        }
      }),
      outputs: this.outputs.map(ref => ({
        ref,
        satoshis: ref.satoshis,
        lockingScript: ref.lockingScript,
        lockingScriptBytes: scriptSerializationIdentity(ref.lockingScript)
      }))
    }
  }

  #serializationCacheMatchesState(): boolean {
    const cached = this.#rawCacheState
    if (
      cached?.version !== this.version ||
      cached.lockTime !== this.lockTime ||
      cached.inputs.length !== this.inputs.length ||
      cached.outputs.length !== this.outputs.length
    )
      return false

    for (let i = 0; i < this.inputs.length; i++) {
      const input = this.inputs[i]
      const state = cached.inputs[i]
      const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (
        state.ref !== input ||
        state.sourceTXID !== input.sourceTXID ||
        state.sourceTransactionId !== this.#sourceTransactionId(input) ||
        state.sourceOutputIndex !== input.sourceOutputIndex ||
        state.sequence !== input.sequence ||
        state.unlockingScript !== input.unlockingScript ||
        state.unlockingScriptBytes !==
          (input.unlockingScript == null
            ? undefined
            : scriptSerializationIdentity(input.unlockingScript)) ||
        state.sourceOutput !== sourceOutput ||
        state.sourceSatoshis !== sourceOutput?.satoshis ||
        state.sourceLockingScript !== sourceOutput?.lockingScript ||
        state.sourceLockingScriptBytes !==
          (sourceOutput == null
            ? undefined
            : scriptSerializationIdentity(sourceOutput.lockingScript))
      )
        return false
    }

    for (let i = 0; i < this.outputs.length; i++) {
      const output = this.outputs[i]
      const state = cached.outputs[i]
      if (
        state.ref !== output ||
        state.satoshis !== output.satoshis ||
        state.lockingScript !== output.lockingScript ||
        state.lockingScriptBytes !== scriptSerializationIdentity(output.lockingScript)
      )
        return false
    }
    return true
  }

  /**
   * Adds a new input to the transaction.
   *
   * @param {TransactionInput} input - The TransactionInput object to add to the transaction.
   * @throws {Error} - If the input does not have a sourceTXID or sourceTransaction defined.
   */
  addInput(input: TransactionInput): void {
    if (input.sourceTXID === undefined && input.sourceTransaction === undefined) {
      throw new TypeError(
        'A reference to an an input transaction is required. If the input transaction itself cannot be referenced, its TXID must still be provided.'
      )
    }
    requireUInt32(input.sourceOutputIndex, 'sourceOutputIndex')
    if (input.sourceTXID !== undefined)
      input.sourceTXID = requireTXID(input.sourceTXID, 'sourceTXID')
    if (input.sequence !== undefined) requireUInt32(input.sequence, 'sequence')
    // If the input sequence number hasn't been set, the expectation is that it is final.
    input.sequence ??= 0xffffffff
    this.#invalidateSerializationCaches()
    this.inputs.push(input)
  }

  /**
   * Adds a new output to the transaction.
   *
   * @param {TransactionOutput} output - The TransactionOutput object to add to the transaction.
   */
  addOutput(output: TransactionOutput): void {
    this.#invalidateSerializationCaches()
    if (output.satoshis === undefined && output.change !== true) {
      throw new TypeError('either satoshis must be defined or change must be set to true')
    }
    if (output.satoshis !== undefined) requireSatoshiAmount(output.satoshis, 'satoshis')
    if (output.lockingScript == null) throw new Error('lockingScript must be defined')
    this.outputs.push(output)
  }

  /**
   * Adds a new P2PKH output to the transaction.
   *
   * @param {number[] | string} address - The P2PKH address of the output.
   * @param {number} [satoshis] - The number of satoshis to send to the address - if not provided, the output is considered a change output.
   *
   */
  addP2PKHOutput(address: number[] | string, satoshis?: number): void {
    const lockingScript = new P2PKH().lock(address)
    if (satoshis === undefined) {
      return this.addOutput({ lockingScript, change: true })
    }
    this.addOutput({
      lockingScript,
      satoshis
    })
  }

  /**
   * Updates the transaction's metadata.
   *
   * @param {Record<string, any>} metadata - The metadata object to merge into the existing metadata.
   */
  updateMetadata(metadata: Record<string, any>): void {
    this.metadata = {
      ...this.metadata,
      ...metadata
    }
  }

  /**
   * Computes fees prior to signing.
   * If no fee model is provided, uses a LivePolicy fee model that fetches current rates from ARC.
   * If fee is a number, the transaction uses that value as fee.
   *
   * @param modelOrFee - The initialized fee model to use or fixed fee for the transaction
   * @param changeDistribution - Specifies how the change should be distributed
   * amongst the change outputs
   *
   */
  async fee(
    modelOrFee: FeeModel | number = LivePolicy.getInstance(),
    changeDistribution: 'equal' | 'random' = 'equal'
  ): Promise<void> {
    this.#invalidateSerializationCaches()
    if (changeDistribution !== 'equal' && changeDistribution !== 'random') {
      throw new TypeError('changeDistribution must be either "equal" or "random".')
    }
    if (typeof modelOrFee === 'number') {
      const sats = modelOrFee
      modelOrFee = {
        computeFee: async () => sats
      }
    }
    const baseline = this.#snapshotTransactionGraph(true)
    const result = baseline.#snapshotTransactionGraph(true)
    const modelTransaction = baseline.#snapshotTransactionGraph(true)
    const inputRefs = [...this.inputs]
    const sourceRefs = this.inputs.map(input => input.sourceTransaction)
    const templateRefs = this.inputs.map(input => input.unlockingScriptTemplate)
    const outputRefs = [...this.outputs]
    const modelInputRefs = [...modelTransaction.inputs]
    const modelSourceRefs = modelTransaction.inputs.map(input => input.sourceTransaction)
    const modelTemplateRefs = modelTransaction.inputs.map(input => input.unlockingScriptTemplate)
    const modelOutputRefs = [...modelTransaction.outputs]
    const fee = requireSatoshiAmount(
      await modelOrFee.computeFee(modelTransaction),
      'Computed transaction fee'
    )
    if (
      !modelTransaction.#signingStateMatches(
        baseline,
        modelInputRefs,
        modelSourceRefs,
        modelTemplateRefs,
        modelOutputRefs
      )
    ) {
      throw new Error('Fee model mutated its transaction snapshot')
    }
    const change = result.#calculateChange(fee)
    if (change < 0) {
      throw new RangeError('Transaction inputs are insufficient for the requested outputs and fee.')
    }
    if (!this.#signingStateMatches(baseline, inputRefs, sourceRefs, templateRefs, outputRefs)) {
      throw new Error('Transaction changed while computing its fee; no change was applied')
    }
    if (change === 0) {
      this.outputs = outputRefs.filter(output => output.change !== true)
      this.#invalidateSerializationCaches()
      return
    }
    result.#distributeChange(change, changeDistribution)
    for (let index = 0; index < outputRefs.length; index++) {
      if (outputRefs[index].change === true) {
        outputRefs[index].satoshis = result.outputs[index].satoshis
      }
    }
    this.#invalidateSerializationCaches()
  }

  #calculateChange(fee: number): number {
    let totalInputs = 0
    for (let index = 0; index < this.inputs.length; index++) {
      const input = this.inputs[index]
      if (typeof input.sourceTransaction !== 'object') {
        throw new TypeError(
          'Source transactions are required for all inputs during fee computation'
        )
      }
      requireUInt32(input.sourceOutputIndex, `Input ${index} sourceOutputIndex`)
      const sourceOutput = input.sourceTransaction.outputs[input.sourceOutputIndex]
      if (sourceOutput == null) {
        throw new RangeError(`Input ${index} references a source output that does not exist.`)
      }
      const amount = requireSatoshiAmount(sourceOutput.satoshis, `Input ${index} source amount`)
      totalInputs = addSatoshiAmount(totalInputs, amount, 'Transaction input total')
    }
    let totalOutputs = 0
    for (let index = 0; index < this.outputs.length; index++) {
      const out = this.outputs[index]
      if (out.change !== true) {
        const amount = requireSatoshiAmount(out.satoshis, `Output ${index} amount`)
        totalOutputs = addSatoshiAmount(totalOutputs, amount, 'Transaction output total')
      }
    }
    if (totalOutputs + fee > totalInputs) {
      throw new RangeError('Transaction inputs are insufficient for the requested outputs and fee.')
    }
    return totalInputs - totalOutputs - fee
  }

  #distributeChange(change: number, changeDistribution: 'equal' | 'random'): void {
    const changeOutputs = this.outputs.filter(out => out.change === true)
    // With no designated change output, the unallocated value remains an
    // additional transaction fee. Never redirect it to a recipient output.
    if (changeOutputs.length === 0) return
    if (changeDistribution === 'random') {
      this.#distributeRandomChange(change, changeOutputs)
    } else {
      this.#distributeEqualChange(change, changeOutputs)
    }
  }

  #distributeRandomChange(change: number, changeOutputs: TransactionOutput[]): void {
    let remaining = change
    for (let i = 0; i < changeOutputs.length - 1; i++) {
      const portion = this.#benfordNumber(0, remaining)
      changeOutputs[i].satoshis = portion
      remaining -= portion
    }
    changeOutputs.at(-1).satoshis = remaining
  }

  #distributeEqualChange(change: number, changeOutputs: TransactionOutput[]): void {
    const perOutput = Math.floor(change / changeOutputs.length)
    for (const out of changeOutputs) {
      out.satoshis = perOutput
    }
    changeOutputs.at(-1).satoshis += change - perOutput * changeOutputs.length
  }

  #benfordNumber(min: number, max: number): number {
    const d = (Random(1)[0] % 9) + 1
    return Math.floor(min + ((max - min) * Math.log10(1 + 1 / d)) / Math.log10(10))
  }

  /**
   * Utility method that returns the current fee based on inputs and outputs
   *
   * @returns The current transaction fee
   */
  getFee(): number {
    let totalIn = 0
    for (let index = 0; index < this.inputs.length; index++) {
      const input = this.inputs[index]
      if (typeof input.sourceTransaction !== 'object') {
        throw new TypeError(
          'Source transactions or sourceSatoshis are required for all inputs to calculate fee'
        )
      }
      requireUInt32(input.sourceOutputIndex, `Input ${index} sourceOutputIndex`)
      const sourceOutput = input.sourceTransaction.outputs[input.sourceOutputIndex]
      if (sourceOutput == null) {
        throw new RangeError(`Input ${index} references a source output that does not exist.`)
      }
      totalIn = addSatoshiAmount(
        totalIn,
        requireSatoshiAmount(sourceOutput.satoshis, `Input ${index} source amount`),
        'Transaction input total'
      )
    }
    let totalOut = 0
    for (let index = 0; index < this.outputs.length; index++) {
      totalOut = addSatoshiAmount(
        totalOut,
        requireSatoshiAmount(this.outputs[index].satoshis, `Output ${index} amount`),
        'Transaction output total'
      )
    }
    return totalIn - totalOut
  }

  /**
   * Signs a transaction, hydrating all its unlocking scripts based on the provided script templates where they are available.
   * @param options - Signing behavior. Set `skipExistingSignatures` to preserve inputs that already have an unlocking script.
   */
  async sign(options: { skipExistingSignatures?: boolean } = {}): Promise<void> {
    this.#invalidateSerializationCaches()
    for (let index = 0; index < this.outputs.length; index++) {
      const out = this.outputs[index]
      if (out.satoshis === undefined) {
        if (out.change === true) {
          throw new Error(
            'There are still change outputs with uncomputed amounts. Use the fee() method to compute the change amounts and transaction fees prior to signing.'
          )
        } else {
          throw new Error(
            'One or more transaction outputs is missing an amount. Ensure all output amounts are provided before signing.'
          )
        }
      }
      requireSatoshiAmount(out.satoshis, `Output ${index} amount`)
    }
    this.#totalVerifiedOutputs(this)
    for (let index = 0; index < this.inputs.length; index++) {
      const input = this.inputs[index]
      requireUInt32(input.sourceOutputIndex, `Input ${index} sourceOutputIndex`)
      requireUInt32(input.sequence ?? 0xffffffff, `Input ${index} sequence`)
      if (input.sourceTXID !== undefined) {
        requireTXID(input.sourceTXID, `Input ${index} sourceTXID`)
      }
      if (input.sourceTransaction !== undefined) {
        const sourceOutput = input.sourceTransaction.outputs[input.sourceOutputIndex]
        if (sourceOutput == null) {
          throw new RangeError(`Input ${index} references a source output that does not exist.`)
        }
        requireSatoshiAmount(sourceOutput.satoshis, `Input ${index} source amount`)
        // An EF source descriptor intentionally has no inputs and carries only
        // claimed outpoint data. When a complete or anchored source is supplied,
        // however, never sign a different serialized outpoint with its policy.
        if (
          input.sourceTXID !== undefined &&
          (input.sourceTransaction.inputs.length > 0 ||
            input.sourceTransaction.merklePath != null) &&
          requireTXID(input.sourceTXID, `Input ${index} sourceTXID`) !==
            input.sourceTransaction.id('hex')
        ) {
          throw new Error(
            `Input ${index} sourceTXID does not reference its supplied source transaction.`
          )
        }
      }
    }
    this.materializeSourceTXIDs()
    const signingSnapshot = this.#snapshotTransactionGraph(true)
    const inputRefs = [...this.inputs]
    const sourceRefs = this.inputs.map(input => input.sourceTransaction)
    const templateRefs = this.inputs.map(input => input.unlockingScriptTemplate)
    const outputRefs = [...this.outputs]
    const skipExistingSignatures = options.skipExistingSignatures === true
    let unlockingScripts: Array<UnlockingScript | undefined>
    unlockingScripts = await Promise.all(
      signingSnapshot.inputs.map(async (input, index): Promise<UnlockingScript | undefined> => {
        if (skipExistingSignatures && input.unlockingScript != null) {
          return new UnlockingScript(
            [],
            Uint8Array.from(input.unlockingScript.toUint8Array()),
            undefined,
            false
          )
        }
        const template = templateRefs[index]
        if (template === undefined) return undefined
        const templateTransaction = signingSnapshot.#snapshotTransactionGraph(true)
        for (let templateIndex = 0; templateIndex < templateRefs.length; templateIndex++) {
          templateTransaction.inputs[templateIndex].unlockingScriptTemplate =
            templateRefs[templateIndex]
        }
        templateTransaction.#activeSignatureHashCache = { hashOutputsSingle: new Map() }
        const returned = await template.sign(templateTransaction, index)
        if (returned == null || typeof returned.toUint8Array !== 'function') {
          throw new TypeError(
            `Input ${index} signing template returned an invalid unlocking script`
          )
        }
        const bytes = returned.toUint8Array()
        if (!(bytes instanceof Uint8Array)) {
          throw new TypeError(
            `Input ${index} signing template returned an invalid unlocking script`
          )
        }
        return new UnlockingScript([], Uint8Array.from(bytes), undefined, false)
      })
    )
    if (
      !this.#signingStateMatches(signingSnapshot, inputRefs, sourceRefs, templateRefs, outputRefs)
    ) {
      throw new Error('Transaction changed while signing; no unlocking scripts were applied')
    }
    for (let i = 0, l = this.inputs.length; i < l; i++) {
      if (
        templateRefs[i] !== undefined &&
        !(skipExistingSignatures && inputRefs[i].unlockingScript != null)
      ) {
        this.inputs[i].unlockingScript = unlockingScripts[i]
      }
    }
    // A custom template may serialize the transaction while signing. Ensure
    // bytes cached during template execution cannot survive script hydration.
    this.#invalidateSerializationCaches()
  }

  /**
   * Broadcasts a transaction.
   *
   * @param broadcaster The Broadcaster instance wwhere the transaction will be sent
   * @returns A BroadcastResponse or BroadcastFailure from the Broadcaster
   */
  async broadcast(
    broadcaster: Broadcaster = defaultBroadcaster()
  ): Promise<BroadcastResponse | BroadcastFailure> {
    const snapshot = this.#snapshotTransactionGraph()
    const expectedTxid = snapshot.id('hex')
    return validateBroadcastResult(await broadcaster.broadcast(snapshot), expectedTxid)
  }

  #writeTransactionBody(writer: Writer | WriterUint8Array): void {
    writer.writeUInt32LE(this.version)
    writer.writeVarIntNum(this.inputs.length)
    for (const i of this.inputs) {
      if (i.sourceTXID === undefined) {
        if (i.sourceTransaction == null) {
          throw new Error('sourceTransaction is undefined')
        } else {
          writer.write(i.sourceTransaction.hash() as number[])
        }
      } else {
        writer.writeReverse(toArray(requireTXID(i.sourceTXID, 'sourceTXID'), 'hex'))
      }
      writer.writeUInt32LE(requireUInt32(i.sourceOutputIndex, 'sourceOutputIndex'))
      if (i.unlockingScript == null) {
        throw new Error('unlockingScript is undefined')
      }
      const scriptBin = i.unlockingScript.toUint8Array()
      writer.writeVarIntNum(scriptBin.length)
      writer.write(scriptBin)
      writer.writeUInt32LE(requireUInt32(i.sequence ?? 0xffffffff, 'sequence'))
    }
    writer.writeVarIntNum(this.outputs.length)
    for (const o of this.outputs) {
      writer.writeUInt64LE(o.satoshis ?? 0)
      const scriptBin = o.lockingScript.toUint8Array()
      writer.writeVarIntNum(scriptBin.length)
      writer.write(scriptBin)
    }
    writer.writeUInt32LE(this.lockTime)
  }

  #buildSerializedBytes(): Uint8Array {
    const writer = new WriterUint8Array()
    this.#writeTransactionBody(writer)
    return writer.toUint8Array()
  }

  #getSerializedBytes(): Uint8Array {
    if (this.#rawBytesCache == null || !this.#serializationCacheMatchesState()) {
      this.#invalidateSerializationCaches()
      this.#rawBytesCache = this.#buildSerializedBytes()
      this.#captureSerializationState()
    }
    return this.#rawBytesCache
  }

  [serializedBytes](): Uint8Array {
    return this.#getSerializedBytes()
  }

  [knownId](txid: string): void {
    this.#cachedIdHex = txid
  }

  /**
   * Converts the transaction to a binary array format.
   *
   * @returns {number[]} - The binary array representation of the transaction.
   */
  toBinary(): number[] {
    return Array.from(this.#getSerializedBytes())
  }

  toUint8Array(): Uint8Array {
    return Uint8Array.from(this.#getSerializedBytes())
  }

  #writeEF(writer: Writer | WriterUint8Array): void {
    writer.writeUInt32LE(this.version)
    writer.write([0, 0, 0, 0, 0, 0xef])
    writer.writeVarIntNum(this.inputs.length)
    for (const i of this.inputs) {
      if (i.sourceTransaction === undefined) {
        throw new TypeError(
          'All inputs must have source transactions when serializing to EF format'
        )
      }
      if (i.sourceTXID === undefined) {
        writer.write(i.sourceTransaction.hash() as number[])
      } else {
        writer.write(toArray(i.sourceTXID, 'hex').reverse() as number[])
      }
      writer.writeUInt32LE(i.sourceOutputIndex)
      if (i.unlockingScript == null) {
        throw new Error('unlockingScript is undefined')
      }
      const scriptBin = i.unlockingScript.toUint8Array()
      writer.writeVarIntNum(scriptBin.length)
      writer.write(scriptBin)
      writer.writeUInt32LE(i.sequence ?? 0xffffffff) // default to max sequence
      writer.writeUInt64LE(i.sourceTransaction.outputs[i.sourceOutputIndex].satoshis ?? 0)
      const lockingScriptBin =
        i.sourceTransaction.outputs[i.sourceOutputIndex].lockingScript.toUint8Array()
      writer.writeVarIntNum(lockingScriptBin.length)
      writer.write(lockingScriptBin)
    }
    writer.writeVarIntNum(this.outputs.length)
    for (const o of this.outputs) {
      writer.writeUInt64LE(o.satoshis ?? 0)
      const scriptBin = o.lockingScript.toUint8Array()
      writer.writeVarIntNum(scriptBin.length)
      writer.write(scriptBin)
    }
    writer.writeUInt32LE(this.lockTime)
  }

  /**
   * Converts the transaction to a BRC-30 EF format.
   *
   * @returns {number[]} - The BRC-30 EF representation of the transaction.
   */
  toEF(): number[] {
    return Array.from(this.#getEFBytes())
  }

  /**
   * Converts the transaction to a BRC-30 EF format.
   *
   * @remarks This is an alias for {@link toEFBinary}. The returned view is
   * copied from the internal memoized representation for caller isolation.
   *
   * @returns {Uint8Array} - The BRC-30 EF representation of the transaction.
   */
  toEFUint8Array(): Uint8Array {
    return this.toEFBinary()
  }

  #getEFBytes(): Uint8Array {
    if (this.#efBytesCache == null || !this.#serializationCacheMatchesState()) {
      this.#invalidateSerializationCaches()
      const writer = new WriterUint8Array()
      this.#writeEF(writer)
      this.#efBytesCache = writer.toUint8Array()
      this.#captureSerializationState()
    }
    return this.#efBytesCache
  }

  /**
   * Converts the transaction to an independently owned BRC-30 EF byte array.
   *
   * @remarks Each call returns an independently mutable copy. Internal
   * serialization remains memoized until transaction state changes.
   *
   * @returns {Uint8Array} The cached BRC-30 EF representation.
   */
  toEFBinary(): Uint8Array {
    return Uint8Array.from(this.#getEFBytes())
  }

  /**
   * Converts the transaction to a hexadecimal string EF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction EF.
   */
  toHexEF(): string {
    return toHex(this.toEFBinary())
  }

  /**
   * Converts the transaction to a hexadecimal string format.
   *
   * @returns {string} - The hexadecimal string representation of the transaction.
   */
  toHex(): string {
    const bytes = this.#getSerializedBytes()
    if (this.#hexCache != null) return this.#hexCache
    const hex = toHex(bytes)
    this.#hexCache = hex
    return hex
  }

  /**
   * Converts the transaction to a hexadecimal string BEEF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction BEEF.
   */
  toHexBEEF(): string {
    return toHex(this.toBEEF())
  }

  /**
   * Converts the transaction to a hexadecimal string Atomic BEEF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction Atomic BEEF.
   */
  toHexAtomicBEEF(): string {
    return toHex(this.toAtomicBEEF())
  }

  /**
   * Calculates the transaction's hash.
   *
   * @param {'hex' | undefined} enc - The encoding to use for the hash. If 'hex', returns a hexadecimal string; otherwise returns a binary array.
   * @returns {string | number[]} - The hash of the transaction in the specified format.
   */
  hash(enc?: 'hex'): number[] | string {
    const bytes = this.#getSerializedBytes()
    this.#cachedHash ??= hash256(bytes)
    if (enc === 'hex') {
      return toHex(this.#cachedHash)
    }
    return Array.from(this.#cachedHash)
  }

  /**
   * Calculates the transaction's ID in binary array.
   *
   * @returns {number[]} - The ID of the transaction in the binary array format.
   */
  id(): number[]
  /**
   * Calculates the transaction's ID in hexadecimal format.
   *
   * @param {'hex'} enc - The encoding to use for the ID. If 'hex', returns a hexadecimal string.
   * @returns {string} - The ID of the transaction in the hex format.
   */
  id(enc: 'hex'): string
  /**
   * Calculates the transaction's ID.
   *
   * @param {'hex' | undefined} enc - The encoding to use for the ID. If 'hex', returns a hexadecimal string; otherwise returns a binary array.
   * @returns {string | number[]} - The ID of the transaction in the specified format.
   */
  id(enc?: 'hex'): number[] | string {
    // Validate public mutable transaction state before consulting either ID
    // cache. getSerializedBytes() clears both when any signed field changed.
    this.#getSerializedBytes()
    if (enc === 'hex' && this.#cachedIdHex != null) return this.#cachedIdHex
    const id = [...(this.hash() as number[])]
    id.reverse()
    if (enc === 'hex') {
      this.#cachedIdHex = toHex(id)
      return this.#cachedIdHex
    }
    return id
  }

  async #completeVerificationFromMerklePath(
    tx: Transaction,
    scriptsOnly: boolean,
    chainTracker: ChainTracker | 'scripts only',
    getTxid: () => string,
    verifiedTransactions: Set<Transaction>,
    verifiedTxids: Set<string>
  ): Promise<boolean> {
    if (typeof tx.merklePath !== 'object') return false
    if (scriptsOnly) {
      verifiedTransactions.add(tx)
      return true
    }
    if (await tx.merklePath.verify(getTxid(), chainTracker)) {
      verifiedTxids.add(getTxid())
      return true
    }
    throw new Error(`Invalid merkle path for transaction ${getTxid()}`)
  }

  private async verifyTransactionFee(
    tx: Transaction,
    feeModel: FeeModel | undefined,
    getTxid: () => string
  ): Promise<void> {
    if (feeModel === undefined) return
    if (tx === undefined) throw new Error('Transaction is undefined')
    const copy = Transaction.fromEF(tx.toEF())
    delete copy.outputs[0].satoshis
    copy.outputs[0].change = true
    await copy.fee(feeModel)
    if (tx.getFee() < copy.getFee()) {
      throw new Error(
        `Verification failed because the transaction ${getTxid()} has an insufficient fee and has not been mined.`
      )
    }
  }

  #validateUnminedTransactionStructure(tx: Transaction, getTxid: () => string): void {
    if (tx.inputs.length === 0) {
      throw new Error(`Verification failed because transaction ${getTxid()} has no inputs.`)
    }
    if (tx.outputs.length === 0) {
      throw new Error(`Verification failed because transaction ${getTxid()} has no outputs.`)
    }

    const spentOutpoints = new Set<string>()
    for (let index = 0; index < tx.inputs.length; index++) {
      const input = tx.inputs[index]
      const outputIndex = requireUInt32(input.sourceOutputIndex, `Input ${index} sourceOutputIndex`)
      requireUInt32(input.sequence ?? 0xffffffff, `Input ${index} sequence`)
      const sourceTXID = requireTXID(
        input.sourceTXID ?? input.sourceTransaction?.id('hex'),
        `Input ${index} sourceTXID`
      )
      if (/^0{64}$/.test(sourceTXID) && outputIndex === 0xffffffff) {
        throw new Error(
          `Verification failed because unmined transaction ${getTxid()} contains a coinbase input.`
        )
      }
      const outpoint = `${sourceTXID}:${outputIndex}`
      if (spentOutpoints.has(outpoint)) {
        throw new Error(
          `Verification failed because transaction ${getTxid()} spends outpoint ${outpoint} more than once.`
        )
      }
      spentOutpoints.add(outpoint)
    }

    this.#totalVerifiedOutputs(tx)
  }

  #queueSourceTransactionForVerification(
    sourceTransaction: Transaction,
    sourceTxid: string,
    state: TransactionVerificationState
  ): void {
    if (state.scriptsOnly) {
      if (
        !state.verifiedTransactions.has(sourceTransaction) &&
        !state.queuedTransactions.has(sourceTransaction)
      ) {
        state.txQueue.push(sourceTransaction)
        state.queuedTransactions.add(sourceTransaction)
      }
      return
    }
    if (!state.verifiedTxids.has(sourceTxid) && !state.queuedTxids.has(sourceTxid)) {
      state.txQueue.push(sourceTransaction)
      state.queuedTxids.add(sourceTxid)
    }
  }

  #verifyTransactionInputs(
    tx: Transaction,
    useVerifier: boolean,
    getTxid: () => string,
    state: TransactionVerificationState
  ): { valid: boolean; inputTotal: number } {
    let inputTotal = 0
    const sigHashCache: SignatureHashCache = { hashOutputsSingle: new Map() }
    for (let index = 0; index < tx.inputs.length; index++) {
      const input = tx.inputs[index]
      if (typeof input.sourceTransaction !== 'object') {
        throw new TypeError(
          `Verification failed because the input at index ${index} of transaction ${getTxid()} is missing an associated source transaction. This source transaction is required for transaction verification because there is no merkle proof for the transaction spending a UTXO it contains.`
        )
      }
      if (typeof input.unlockingScript !== 'object') {
        throw new TypeError(
          `Verification failed because the input at index ${index} of transaction ${getTxid()} is missing an associated unlocking script. This script is required for transaction verification because there is no merkle proof for the transaction spending the UTXO.`
        )
      }
      const sourceTransaction = input.sourceTransaction
      const sourceOutput = sourceTransaction.outputs[input.sourceOutputIndex]
      if (sourceOutput == null) {
        throw new RangeError(
          `Verification failed because input ${index} of transaction ${getTxid()} references a source output that does not exist.`
        )
      }
      inputTotal = addSatoshiAmount(
        inputTotal,
        requireSatoshiAmount(sourceOutput.satoshis, `Input ${index} source amount`),
        'Transaction input total'
      )
      const computedSourceTxid = sourceTransaction.id('hex')
      if (
        !state.scriptsOnly &&
        input.sourceTXID !== undefined &&
        requireTXID(input.sourceTXID, `Input ${index} sourceTXID`) !== computedSourceTxid
      ) {
        throw new Error(
          `Verification failed because input ${index} of transaction ${getTxid()} does not reference its supplied source transaction.`
        )
      }
      const sourceTxid =
        state.scriptsOnly && input.sourceTXID !== undefined
          ? input.sourceTXID
          : sourceTransaction.id('hex')
      this.#queueSourceTransactionForVerification(sourceTransaction, sourceTxid, state)
      input.sourceTXID ??= sourceTxid
      if (
        !useVerifier &&
        !new Spend({
          sourceTXID: input.sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          lockingScript: sourceOutput.lockingScript,
          sourceSatoshis: sourceOutput.satoshis ?? 0,
          transactionVersion: tx.version,
          otherInputs: [],
          allInputs: tx.inputs,
          unlockingScript: input.unlockingScript,
          inputSequence: input.sequence ?? 0xffffffff,
          inputIndex: index,
          outputs: tx.outputs,
          lockTime: tx.lockTime,
          memoryLimit: state.memoryLimit,
          sigHashCache
        }).validateJavaScript()
      ) {
        return { valid: false, inputTotal }
      }
    }
    return { valid: true, inputTotal }
  }

  #totalVerifiedOutputs(tx: Transaction): number {
    let outputTotal = 0
    for (let index = 0; index < tx.outputs.length; index++) {
      outputTotal = addSatoshiAmount(
        outputTotal,
        requireSatoshiAmount(tx.outputs[index].satoshis, `Output ${index} amount`),
        'Transaction output total'
      )
    }
    return outputTotal
  }

  async #verifyQueuedScripts(
    verifierQueue: QueuedScriptVerification[],
    selectedVerifier: BdkVerifierInterface | undefined
  ): Promise<void> {
    if (verifierQueue.length === 0 || selectedVerifier === undefined) return
    const scriptVerdicts =
      selectedVerifier.verifyScriptsBatch === undefined
        ? await Promise.all(
            verifierQueue.map(async params => await selectedVerifier.verifyScripts(params))
          )
        : await selectedVerifier.verifyScriptsBatch(verifierQueue)
    if (!Array.isArray(scriptVerdicts) || scriptVerdicts.length !== verifierQueue.length) {
      throw new Error('Script verifier returned an invalid batch result count')
    }
    const ownedVerdicts: boolean[] = []
    for (let index = 0; index < scriptVerdicts.length; index++) {
      if (
        !Object.prototype.hasOwnProperty.call(scriptVerdicts, index) ||
        typeof scriptVerdicts[index] !== 'boolean'
      ) {
        throw new TypeError('Script verifier returned a non-boolean verdict')
      }
      ownedVerdicts.push(scriptVerdicts[index])
    }
    const failedIndex = ownedVerdicts.findIndex(valid => !valid)
    if (failedIndex >= 0) {
      throw new Error(
        `Script verification failed for transaction ${verifierQueue[failedIndex].tx.id('hex')}`
      )
    }
  }

  #isTransactionAlreadyVerified(
    tx: Transaction,
    getTxid: () => string,
    state: TransactionVerificationState
  ): boolean {
    return state.scriptsOnly
      ? state.verifiedTransactions.has(tx)
      : state.verifiedTxids.has(getTxid())
  }

  #snapshotTransactionGraph(includeTemplates: boolean = false): Transaction {
    const snapshots = new Map<Transaction, Transaction>()
    const originals: Transaction[] = [this]
    snapshots.set(this, new Transaction(this.version, [], [], this.lockTime))

    for (let graphIndex = 0; graphIndex < originals.length; graphIndex++) {
      const original = originals[graphIndex]
      const snapshot = snapshots.get(original)
      if (snapshot === undefined) throw new Error('Transaction snapshot is incomplete')

      snapshot.version = original.version
      snapshot.lockTime = original.lockTime
      snapshot.merklePath =
        original.merklePath === undefined
          ? undefined
          : new MerklePath(
              original.merklePath.blockHeight,
              original.merklePath.path.map(level => level.map(leaf => ({ ...leaf })))
            )
      snapshot.outputs = Array.from(original.outputs, output =>
        output == null
          ? output
          : {
              satoshis: output.satoshis,
              lockingScript: new LockingScript(
                [],
                Uint8Array.from(output.lockingScript.toUint8Array()),
                undefined,
                false
              ),
              change: output.change
            }
      )
      snapshot.inputs = Array.from(original.inputs, input => {
        let sourceSnapshot: Transaction | undefined
        if (input.sourceTransaction !== undefined) {
          sourceSnapshot = snapshots.get(input.sourceTransaction)
          if (sourceSnapshot === undefined) {
            sourceSnapshot = new Transaction(
              input.sourceTransaction.version,
              [],
              [],
              input.sourceTransaction.lockTime
            )
            snapshots.set(input.sourceTransaction, sourceSnapshot)
            originals.push(input.sourceTransaction)
          }
        }
        return {
          sourceTransaction: sourceSnapshot,
          sourceTXID: input.sourceTXID,
          sourceOutputIndex: input.sourceOutputIndex,
          unlockingScript:
            input.unlockingScript === undefined
              ? undefined
              : new UnlockingScript(
                  [],
                  Uint8Array.from(input.unlockingScript.toUint8Array()),
                  undefined,
                  false
                ),
          unlockingScriptTemplate: includeTemplates ? input.unlockingScriptTemplate : undefined,
          sequence: input.sequence
        }
      })
    }

    const snapshot = snapshots.get(this)
    if (snapshot === undefined) throw new Error('Transaction snapshot is incomplete')
    return snapshot
  }

  #signingStateMatches(
    snapshot: Transaction,
    inputRefs: TransactionInput[],
    sourceRefs: Array<Transaction | undefined>,
    templateRefs: Array<TransactionInput['unlockingScriptTemplate']>,
    outputRefs: TransactionOutput[]
  ): boolean {
    if (
      this.version !== snapshot.version ||
      this.lockTime !== snapshot.lockTime ||
      this.inputs.length !== snapshot.inputs.length ||
      this.outputs.length !== snapshot.outputs.length
    ) {
      return false
    }
    for (let index = 0; index < this.inputs.length; index++) {
      const current = this.inputs[index]
      const owned = snapshot.inputs[index]
      if (
        current !== inputRefs[index] ||
        current.sourceTransaction !== sourceRefs[index] ||
        current.unlockingScriptTemplate !== templateRefs[index] ||
        current.sourceTXID !== owned.sourceTXID ||
        current.sourceOutputIndex !== owned.sourceOutputIndex ||
        current.sequence !== owned.sequence ||
        !equalBytes(current.unlockingScript?.toUint8Array(), owned.unlockingScript?.toUint8Array())
      ) {
        return false
      }
      const currentSource = current.sourceTransaction?.outputs[current.sourceOutputIndex]
      const ownedSource = owned.sourceTransaction?.outputs[owned.sourceOutputIndex]
      if (currentSource == null || ownedSource == null) {
        if (currentSource !== ownedSource) return false
      } else if (
        !Object.is(currentSource.satoshis, ownedSource.satoshis) ||
        !equalBytes(
          currentSource.lockingScript.toUint8Array(),
          ownedSource.lockingScript.toUint8Array()
        )
      ) {
        return false
      }
    }
    for (let index = 0; index < this.outputs.length; index++) {
      const current = this.outputs[index]
      const owned = snapshot.outputs[index]
      if (
        current !== outputRefs[index] ||
        !Object.is(current.satoshis, owned.satoshis) ||
        current.change !== owned.change ||
        !equalBytes(current.lockingScript.toUint8Array(), owned.lockingScript.toUint8Array())
      ) {
        return false
      }
    }
    return true
  }

  async #verifyUnminedTransaction(
    tx: Transaction,
    getTxid: () => string,
    context: UnminedTransactionVerificationContext
  ): Promise<boolean> {
    const { feeModel, memoryLimit, selectedVerifier, verifierQueue } = context
    this.#validateUnminedTransactionStructure(tx, getTxid)
    await this.verifyTransactionFee(tx, feeModel, getTxid)
    const verifierParams = {
      tx,
      blockHeight: POST_CHRONICLE_HEIGHT_FALLBACK,
      consensus: true,
      ...(memoryLimit === undefined ? {} : { memoryLimit })
    } as const
    const useVerifier =
      selectedVerifier !== undefined &&
      (memoryLimit === undefined || selectedVerifier.supportsMemoryLimit === true) &&
      (selectedVerifier.shouldVerifyScripts?.(verifierParams) ?? true)
    const verifyInputs = (skipScripts: boolean): { valid: boolean; inputTotal: number } =>
      this.#verifyTransactionInputs(tx, skipScripts, getTxid, context)
    const inputVerification =
      !useVerifier && context.scriptWork !== undefined
        ? context.scriptWork.work.inputs(context.scriptWork, verifierParams, verifyInputs)
        : verifyInputs(useVerifier)
    if (!inputVerification.valid) return false
    if (useVerifier) verifierQueue.push(verifierParams)
    if (this.#totalVerifiedOutputs(tx) > inputVerification.inputTotal) return false
    if (context.scriptsOnly) context.verifiedTransactions.add(tx)
    else context.verifiedTxids.add(getTxid())
    return true
  }

  /**
   * Verifies the legitimacy of the Bitcoin transaction according to the rules of SPV by ensuring all the input transactions link back to valid block headers, the chain of spends for all inputs are valid, and the sum of inputs is not less than the sum of outputs.
   *
   * @param chainTracker - An instance of ChainTracker, a Bitcoin block header tracker. If the value is set to 'scripts only', headers will not be verified. If not provided then the default chain tracker will be used.
   * @param feeModel - An instance of FeeModel, a fee model to use for fee calculation. If not provided then the default fee model will be used.
   * @param memoryLimit - Optional caller-supplied local script-interpreter
   * memory budget. If omitted, post-Genesis validation does not impose an
   * arbitrary SDK memory cap.
   * @param verifier - An optional asynchronous script backend. Adaptive backends may decline before execution to preserve the JavaScript path.
   *
   * @returns Whether the transaction is valid according to the rules of SPV.
   *
   * @example tx.verify(new WhatsOnChain(), LivePolicy.getInstance())
   */
  async verify(
    chainTracker: ChainTracker | 'scripts only' = defaultChainTracker(),
    feeModel?: FeeModel,
    memoryLimit?: number,
    verifier?: BdkVerifierInterface
  ): Promise<boolean> {
    if (chainTracker !== 'scripts only') this.materializeSourceTXIDs()
    const scriptWork = chainTracker === 'scripts only' ? undefined : evidenceScriptScope(this)
    return await this.#snapshotTransactionGraph().#verifySnapshot(
      chainTracker,
      feeModel,
      memoryLimit,
      verifier,
      scriptWork
    )
  }

  async #verifySnapshot(
    chainTracker: ChainTracker | 'scripts only',
    feeModel?: FeeModel,
    memoryLimit?: number,
    verifier?: BdkVerifierInterface,
    scriptWork?: EvidenceScriptScope
  ): Promise<boolean> {
    const scriptsOnly = chainTracker === 'scripts only'
    const backend = verifier ?? scriptVerificationBackend()
    const selectedVerifier =
      scriptWork !== undefined && backend !== undefined
        ? scopedScriptBackend(scriptWork, backend)
        : backend
    if (!scriptsOnly) this.materializeSourceTXIDs()
    const verifiedTxids = new Set<string>()
    const verifiedTransactions = new Set<Transaction>()
    const txQueue: Transaction[] = [this]
    const queuedTxids = new Set<string>()
    if (!scriptsOnly) queuedTxids.add(this.id('hex'))
    const queuedTransactions = new Set<Transaction>(txQueue)
    const verifierQueue: QueuedScriptVerification[] = []
    const verificationContext: UnminedTransactionVerificationContext = {
      scriptsOnly,
      memoryLimit,
      txQueue,
      queuedTransactions,
      queuedTxids,
      verifiedTransactions,
      verifiedTxids,
      feeModel,
      selectedVerifier,
      verifierQueue,
      scriptWork
    }
    let queueIndex = 0

    while (queueIndex < txQueue.length) {
      const tx = txQueue[queueIndex++]
      let txid: string | undefined
      const getTxid = (): string => {
        txid ??= tx.id('hex')
        return txid
      }
      if (this.#isTransactionAlreadyVerified(tx, getTxid, verificationContext)) {
        continue
      }

      if (
        await this.#completeVerificationFromMerklePath(
          tx,
          scriptsOnly,
          chainTracker,
          getTxid,
          verifiedTransactions,
          verifiedTxids
        )
      ) {
        continue
      }
      if (!(await this.#verifyUnminedTransaction(tx, getTxid, verificationContext))) return false
    }

    await this.#verifyQueuedScripts(verifierQueue, selectedVerifier)

    return true
  }

  /**
   * Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.
   *
   * @param writer The writer to serialize to
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns The serialized BEEF structure
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  writeSerializedBEEF(writer: Writer | WriterUint8Array, allowPartial?: boolean): void {
    this.materializeSourceTXIDs()
    writer.writeUInt32LE(BEEF_V1)
    const { bumps, txs } = this.#collectBEEFTransactions(allowPartial)

    writer.writeVarIntNum(bumps.length)
    const bumpBytes = this.#reserveBEEFWriter(writer, bumps, txs)
    for (let i = 0; i < bumps.length; i++) {
      writer.write(bumpBytes?.[i] ?? bumps[i].toBinary())
    }
    writer.writeVarIntNum(txs.length)
    for (const item of txs) {
      writer.write(item.tx.toUint8Array())
      if (typeof item.pathIndex === 'number') {
        writer.writeUInt8(1)
        writer.writeVarIntNum(item.pathIndex)
      } else {
        writer.writeUInt8(0)
      }
    }
  }

  #collectBEEFTransactions(allowPartial?: boolean): {
    bumps: MerklePath[]
    txs: Array<{ tx: Transaction; pathIndex?: number }>
  } {
    const bumps: MerklePath[] = []
    const bumpIndexByInstance = new Map<MerklePath, number>()
    const bumpIndexByRoot = new Map<string, number>()
    const txs: Array<{ tx: Transaction; pathIndex?: number }> = []
    const seenTxids = new Set<string>()
    const scheduledTxids = new Set<string>()
    const stack: Array<{ tx: Transaction; expanded: boolean }> = [{ tx: this, expanded: false }]

    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame == null) continue
      if (frame.expanded) {
        this.#appendBEEFTransaction(
          frame.tx,
          seenTxids,
          txs,
          bumps,
          bumpIndexByInstance,
          bumpIndexByRoot
        )
        continue
      }
      this.#scheduleBEEFTransaction(frame.tx, allowPartial, scheduledTxids, stack)
    }

    return { bumps, txs }
  }

  #appendBEEFTransaction(
    tx: Transaction,
    seenTxids: Set<string>,
    txs: Array<{ tx: Transaction; pathIndex?: number }>,
    bumps: MerklePath[],
    bumpIndexByInstance: Map<MerklePath, number>,
    bumpIndexByRoot: Map<string, number>
  ): void {
    const txid = tx.id('hex')
    if (seenTxids.has(txid)) return

    const item: { tx: Transaction; pathIndex?: number } = { tx }
    if (tx.merklePath != null) {
      item.pathIndex = this.#getBEEFPathIndex(
        tx.merklePath,
        bumps,
        bumpIndexByInstance,
        bumpIndexByRoot
      )
    }
    seenTxids.add(txid)
    txs.push(item)
  }

  #scheduleBEEFTransaction(
    tx: Transaction,
    allowPartial: boolean | undefined,
    scheduledTxids: Set<string>,
    stack: Array<{ tx: Transaction; expanded: boolean }>
  ): void {
    const txid = tx.id('hex')
    if (scheduledTxids.has(txid)) return

    scheduledTxids.add(txid)
    stack.push({ tx, expanded: true })
    if (tx.merklePath != null) return

    for (const input of tx.inputs) {
      const source = input.sourceTransaction
      if (source != null) stack.push({ tx: source, expanded: false })
      else if (allowPartial === false) throw new Error('A required source transaction is missing!')
    }
  }

  #getBEEFPathIndex(
    merklePath: MerklePath,
    bumps: MerklePath[],
    bumpIndexByInstance: Map<MerklePath, number>,
    bumpIndexByRoot: Map<string, number>
  ): number {
    const existingByInstance = bumpIndexByInstance.get(merklePath)
    if (existingByInstance !== undefined) return existingByInstance

    const key = `${merklePath.blockHeight}:${merklePath.computeRoot()}`
    const existingByRoot = bumpIndexByRoot.get(key)
    if (existingByRoot !== undefined) {
      bumps[existingByRoot].combine(merklePath)
      bumpIndexByInstance.set(merklePath, existingByRoot)
      return existingByRoot
    }

    const newIndex = bumps.length
    bumps.push(merklePath)
    bumpIndexByInstance.set(merklePath, newIndex)
    bumpIndexByRoot.set(key, newIndex)
    return newIndex
  }

  #reserveBEEFWriter(
    writer: Writer | WriterUint8Array,
    bumps: MerklePath[],
    txs: Array<{ tx: Transaction; pathIndex?: number }>
  ): Uint8Array[] | undefined {
    let bumpBytes: Uint8Array[] | undefined
    if (writer instanceof WriterUint8Array) {
      bumpBytes = bumps.map(bump => bump.toBinaryUint8Array())
      let remainingBytes = 16
      for (const bytes of bumpBytes) remainingBytes += bytes.length
      for (const item of txs) remainingBytes += item.tx.toUint8Array().length + 10
      writer.reserve(remainingBytes)
    }
    return bumpBytes
  }

  /**
   * Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns {number[]} The serialized BEEF structure
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  toBEEF(allowPartial?: boolean): number[] {
    return toArray(this.toBEEFBytes(allowPartial))
  }

  /**
   * Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns {number[]} The serialized BEEF structure
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   * @deprecated This historical method returns a legacy `number[]` at runtime
   * despite its declared type. Use {@link toBEEFBytes} for a real Uint8Array.
   */
  toBEEFUint8Array(allowPartial?: boolean): Uint8Array {
    const writer = new WriterUint8Array()
    this.writeSerializedBEEF(writer, allowPartial)
    return writer.toArray()
  }

  /**
   * Serializes BEEF to a real typed byte array.
   *
   * @remarks This replaces the historical `toBEEFUint8Array` method, whose
   * runtime value is a legacy `number[]` despite its declared return type.
   */
  toBEEFBytes(allowPartial?: boolean): Uint8Array {
    const writer = new WriterUint8Array()
    this.writeSerializedBEEF(writer, allowPartial)
    return writer.toUint8Array()
  }

  /**
   * Serializes this transaction and its inputs into the Atomic BEEF (BRC-95) format.
   * The Atomic BEEF format starts with a 4-byte prefix `0x01010101`, followed by the TXID of the subject transaction,
   * and then the BEEF data containing only the subject transaction and its dependencies.
   * This format ensures that the BEEF structure is atomic and contains no unrelated transactions.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns {number[]} - The serialized Atomic BEEF structure.
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  toAtomicBEEF(allowPartial?: boolean): number[] {
    this.materializeSourceTXIDs()
    const prefix = [1, 1, 1, 1]
    const txHash = this.hash() as number[]
    const beefData = this.toBEEF(allowPartial)
    return prefix.concat(txHash, beefData)
  }

  /**
   * Serializes this transaction and its inputs into the Atomic BEEF (BRC-95) format.
   * The Atomic BEEF format starts with a 4-byte prefix `0x01010101`, followed by the TXID of the subject transaction,
   * and then the BEEF data containing only the subject transaction and its dependencies.
   * This format ensures that the BEEF structure is atomic and contains no unrelated transactions.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns {number[]} - The serialized Atomic BEEF structure.
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  toAtomicBEEFUint8Array(allowPartial?: boolean): Uint8Array {
    this.materializeSourceTXIDs()
    const writer = new WriterUint8Array()
    const prefix = [1, 1, 1, 1]
    writer.write(prefix)
    const txHash = this.hash() as number[]
    writer.write(txHash)
    this.writeSerializedBEEF(writer, allowPartial)
    return writer.toUint8Array()
  }

  /**
   * Completes the transaction using a wallet interface, which will handle
   * signing and transaction finalization. This method converts the current
   * transaction into a format that can be processed by the wallet, and then
   * updates this transaction object with the result from the wallet.
   *
   * @param {WalletInterface} wallet - The BRC-100 compliant wallet to use for completing the transaction
   * @param {string} [actionDescription] - Optional description for the action
   * @param {string} [originator] - Optional originator domain name
   * @param {CreateActionOptions} [options] - Optional settings for transaction creation (e.g., acceptDelayedBroadcast, trustSelf, noSend, etc.)
   * @returns {Promise<void>}
   */
  async completeWithWallet(
    wallet: WalletInterface,
    actionDescription?: DescriptionString5to50Bytes,
    originator?: string,
    options?: CreateActionOptions
  ): Promise<void> {
    const inputCount = this.inputs.length
    const outputCount = this.outputs.length
    const description =
      actionDescription ?? `Transaction with ${inputCount} input(s) and ${outputCount} output(s)`
    const hasTemplates = this.inputs.some(input => input.unlockingScriptTemplate != null)
    const actionArgs = await this.#buildWalletActionArgs(description, hasTemplates)
    actionArgs.options = options
    const inputSigners: NonNullable<BoundActionOptions['inputSigners']> = {}
    for (let index = 0; index < this.inputs.length; index++) {
      const template = this.inputs[index].unlockingScriptTemplate
      if (template == null) continue
      const outpoint = actionArgs.inputs[index].outpoint
      inputSigners[outpoint] = async (transaction, inputIndex) =>
        await template.sign(transaction, inputIndex)
    }
    const newTransaction = await completeBoundAction(
      wallet,
      actionArgs,
      { inputSigners },
      originator,
      this.inputs.map((input, index) => {
        const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
        if (sourceOutput == null) {
          throw new Error(`Input ${index} references a source output that does not exist`)
        }
        return requireSatoshiAmount(sourceOutput.satoshis, `Input ${index} source amount`)
      })
    )

    // Update this transaction's properties with the new transaction's properties
    this.version = newTransaction.version
    this.inputs = newTransaction.inputs
    this.outputs = newTransaction.outputs
    this.lockTime = newTransaction.lockTime
    this.merklePath = newTransaction.merklePath
    this.#invalidateSerializationCaches()

    // Preserve metadata from the original transaction but update with any new metadata
    this.metadata = {
      ...this.metadata,
      ...newTransaction.metadata
    }
  }

  async #buildWalletActionArgs(
    description: DescriptionString5to50Bytes,
    hasTemplates: boolean
  ): Promise<CreateActionArgs> {
    const actionArgs: CreateActionArgs = {
      description,
      inputs: [],
      outputs: [],
      lockTime: this.lockTime,
      version: this.version
    }
    this.materializeSourceTXIDs()
    const beefData = new Beef()
    for (let index = 0; index < this.inputs.length; index++) {
      const input = this.inputs[index]
      if (input.sourceTransaction == null) {
        throw new Error('All inputs must have a sourceTransaction when using completeWithWallet')
      }
      beefData.mergeTransaction(input.sourceTransaction)
      actionArgs.inputs.push(await this.#buildWalletInputArg(input, index, hasTemplates))
    }
    if (this.inputs.length > 0) actionArgs.inputBEEF = beefData.toUint8Array()
    actionArgs.outputs = this.outputs.map(output => ({
      satoshis: output.satoshis,
      lockingScript: output.lockingScript.toHex(),
      outputDescription: 'Output from source transaction'
    }))
    if (Array.isArray(this.metadata?.labels)) actionArgs.labels = this.metadata.labels
    return actionArgs
  }

  async #buildWalletInputArg(
    input: TransactionInput,
    index: number,
    hasTemplates: boolean
  ): Promise<any> {
    const inputArg: any = {
      outpoint: `${input.sourceTransaction.id('hex')}.${input.sourceOutputIndex}`,
      inputDescription: 'Input from source transaction',
      sequenceNumber: input.sequence
    }
    if (!hasTemplates) {
      if (input.unlockingScript == null) {
        throw new Error('All inputs must have an unlockingScript when using completeWithWallet')
      }
      inputArg.unlockingScript = input.unlockingScript.toHex()
      return inputArg
    }
    if (input.unlockingScriptTemplate != null) {
      inputArg.unlockingScriptLength = await input.unlockingScriptTemplate.estimateLength(
        this,
        index
      )
    } else if (input.unlockingScript != null) {
      inputArg.unlockingScript = input.unlockingScript.toHex()
    } else {
      throw new Error(
        `Input ${index} must have either an unlockingScript or unlockingScriptTemplate`
      )
    }
    return inputArg
  }

  /**
   * Returns the formatted preimage of a transaction for the requested input index, signature scope (default SIGHASH_FORKID | SIGHASH_ALL), and optional subscript.
   * @param inputIndex - The index of the input to generate the preimage for
   * @param signatureScope - The signature scope to use for the preimage
   * @param subscript - The subscript to use for the preimage (optional)
   * @returns The formatted preimage
   */
  preimage(inputIndex?: number, signatureScope?: number, subscript?: LockingScript): number[] {
    inputIndex ??= 0
    signatureScope ??= TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL
    if (!Number.isSafeInteger(inputIndex) || inputIndex < 0 || inputIndex >= this.inputs.length) {
      throw new Error('Invalid input index')
    }
    requireUInt32(signatureScope, 'signatureScope')
    const flags = signatureScope & 0xf0
    if (flags !== 224 && flags !== 192 && flags !== 64) {
      throw new Error('FORKID must be set')
    }
    const coverage = signatureScope & 0x0f
    if (coverage < 1 || coverage > 3) {
      throw new Error('Invalid signature coverage, must be all, none or single')
    }
    const input = this.inputs[inputIndex]
    const sourceOutputIndex = requireUInt32(input.sourceOutputIndex, 'sourceOutputIndex')
    if (input.sourceTransaction == null) {
      throw new Error('Source transaction is required')
    }
    const embeddedSourceTXID = requireTXID(
      input.sourceTransaction.id('hex'),
      'sourceTransaction ID'
    )
    if (
      input.sourceTXID !== undefined &&
      requireTXID(input.sourceTXID, 'sourceTXID') !== embeddedSourceTXID
    ) {
      throw new Error('sourceTXID does not match sourceTransaction')
    }
    const output = input.sourceTransaction.outputs[sourceOutputIndex]
    if (output == null) {
      throw new Error(`Source transaction's output at index ${sourceOutputIndex} is required`)
    }
    const sourceSatoshis = requireSatoshiAmount(output.satoshis, 'Source output amount')
    const inputSequence = requireUInt32(input.sequence ?? 0xffffffff, 'inputSequence')
    const resolvedSubscript = subscript ?? output.lockingScript
    if (resolvedSubscript == null || typeof resolvedSubscript.toUint8Array !== 'function') {
      throw new Error('subscript must be a locking script')
    }
    return TransactionSignature.format({
      sourceTXID: embeddedSourceTXID,
      sourceOutputIndex,
      sourceSatoshis,
      transactionVersion: this.version,
      otherInputs: [],
      allInputs: this.inputs,
      inputIndex,
      outputs: this.outputs,
      inputSequence,
      subscript: resolvedSubscript,
      lockTime: this.lockTime,
      scope: signatureScope
    })
  }
}
