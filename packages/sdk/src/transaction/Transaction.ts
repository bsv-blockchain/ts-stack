// @ts-nocheck
import TransactionInput from './TransactionInput.js'
import TransactionOutput from './TransactionOutput.js'
import UnlockingScript from '../script/UnlockingScript.js'
import LockingScript from '../script/LockingScript.js'
import { Reader, Writer, toHex, toArray, ReaderUint8Array, toUint8Array, WriterUint8Array } from '../primitives/utils.js'
import { hash256 } from '../primitives/Hash.js'
import FeeModel from './FeeModel.js'
import LivePolicy from './fee-models/LivePolicy.js'
import { Broadcaster, BroadcastResponse, BroadcastFailure } from './Broadcaster.js'
import MerklePath from './MerklePath.js'
import Spend from '../script/Spend.js'
import ChainTracker from './ChainTracker.js'
import { defaultBroadcaster } from './broadcasters/DefaultBroadcaster.js'
import { defaultChainTracker } from './chaintrackers/DefaultChainTracker.js'
import { Beef, BEEF_V1 } from './Beef.js'
import P2PKH from '../script/templates/P2PKH.js'
import type { WalletInterface, DescriptionString5to50Bytes, CreateActionOptions } from '../wallet/Wallet.interfaces.js'
import TransactionSignature, { type SignatureHashCache } from '../primitives/TransactionSignature.js'
import Random from '../primitives/Random.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { scriptVerificationBackend } from './ScriptVerificationBackend.js'

/** Post-Chronicle height used when an input's source UTXO mined-height is unobtainable. */
const POST_CHRONICLE_HEIGHT_FALLBACK = 943816

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
  private cachedHash?: number[]
  private cachedIdHex?: string
  private rawBytesCache?: Uint8Array
  private efBytesCache?: Uint8Array
  private hexCache?: string
  private activeSignatureHashCache?: SignatureHashCache
  private rawCacheState?: {
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
  getSignatureHashCache (): SignatureHashCache {
    return this.activeSignatureHashCache ?? { hashOutputsSingle: new Map() }
  }

  /**
   * Iteratively materializes source transaction IDs so deep spend chains do not
   * recurse through `hash()` while serializing their parents.
   */
  materializeSourceTXIDs (): void {
    const complete = new Set<Transaction>()
    const visiting = new Set<Transaction>()
    const stack: Array<{ tx: Transaction, expanded: boolean }> = [{ tx: this, expanded: false }]

    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame == null) continue
      if (complete.has(frame.tx)) continue

      if (frame.expanded) {
        for (const input of frame.tx.inputs) {
          if (input.sourceTXID == null && input.sourceTransaction != null) {
            input.sourceTXID = input.sourceTransaction.id('hex')
          }
        }
        visiting.delete(frame.tx)
        complete.add(frame.tx)
        continue
      }

      if (visiting.has(frame.tx)) {
        throw new Error('Cyclic source transaction graph')
      }
      visiting.add(frame.tx)
      stack.push({ tx: frame.tx, expanded: true })
      for (let i = frame.tx.inputs.length - 1; i >= 0; i--) {
        const input = frame.tx.inputs[i]
        if (input.sourceTXID == null && input.sourceTransaction != null && !complete.has(input.sourceTransaction)) {
          stack.push({ tx: input.sourceTransaction, expanded: false })
        }
      }
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
  static fromBEEF (beef: number[] | Uint8Array, txid?: string): Transaction {
    const { tx } = Transaction.fromAnyBeef(beef, txid)
    return tx
  }

  /**
   * Zero-copy variant of {@link fromBEEF}. The caller must not mutate `beef`.
   */
  static fromBEEFView (beef: Uint8Array, txid?: string): Transaction {
    const { tx } = Transaction.fromAnyBeef(beef, txid, true)
    return tx
  }

  /**
   * Creates a new transaction from an Atomic BEEF (BRC-95) structure.
   * Extracts the subject transaction and supporting merkle path and source transactions contained in the BEEF data
   *
   * @param beef A binary representation of an Atomic BEEF structure.
   * @returns The subject transaction, linked to its associated inputs populated with merkle paths.
   */
  static fromAtomicBEEF (beef: number[] | Uint8Array): Transaction {
    const { tx, txid, beef: b } = Transaction.fromAnyBeef(beef)
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
  static fromAtomicBEEFView (beef: Uint8Array): Transaction {
    const { tx, txid, beef: b } = Transaction.fromAnyBeef(beef, undefined, true)
    if (txid !== b.atomicTxid) {
      if (b.atomicTxid == null) throw new Error('beef must conform to BRC-95 and must contain the subject txid.')
      throw new Error(`Transaction with TXID ${b.atomicTxid} not found in BEEF data.`)
    }
    if (!b.isAtomic(txid)) throw new Error('Atomic BEEF contains unrelated transaction data.')
    return tx
  }

  private static fromAnyBeef (beef: number[] | Uint8Array, txid?: string, zeroCopy: boolean = false): { tx: Transaction, beef: Beef, txid: string } {
    const b = zeroCopy && beef instanceof Uint8Array ? Beef.fromBinaryView(beef) : Beef.fromBinary(beef)
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
   * @param ef A binary representation of a transaction in EF format.
   * @returns An extended transaction, linked to its associated inputs by locking script and satoshis amounts only.
   */
  static fromEF (ef: number[] | Uint8Array): Transaction {
    const br = ReaderUint8Array.makeReader(ef)
    const version = br.readUInt32LE()
    if (toHex(br.read(6)) !== '0000000000ef') { throw new Error('Invalid EF marker') }
    const inputsLength = br.readVarIntNum()
    const inputs: TransactionInput[] = []
    for (let i = 0; i < inputsLength; i++) {
      const sourceTXID = toHex(br.readReverse(32))
      const sourceOutputIndex = br.readUInt32LE()
      const scriptLength = br.readVarIntNum()
      const scriptBin = br.read(scriptLength)
      const unlockingScript = UnlockingScript.fromBinary(scriptBin)
      const sequence = br.readUInt32LE()
      const satoshis = br.readUInt64LEBn().toNumber()
      const lockingScriptLength = br.readVarIntNum()
      const lockingScriptBin = br.read(lockingScriptLength)
      const lockingScript = LockingScript.fromBinary(lockingScriptBin)
      const sourceTransaction = new Transaction(undefined, [], [], undefined)
      sourceTransaction.outputs = new Array(sourceOutputIndex + 1).fill(null)
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
    const outputsLength = br.readVarIntNum()
    const outputs: TransactionOutput[] = []
    for (let i = 0; i < outputsLength; i++) {
      const satoshis = br.readUInt64LEBn().toNumber()
      const scriptLength = br.readVarIntNum()
      const scriptBin = br.read(scriptLength)
      const lockingScript = LockingScript.fromBinary(scriptBin)
      outputs.push({
        satoshis,
        lockingScript
      })
    }
    const lockTime = br.readUInt32LE()
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
  static parseScriptOffsets (bin: number[] | Uint8Array): {
    inputs: Array<{ vin: number, offset: number, length: number }>
    outputs: Array<{ vout: number, offset: number, length: number }>
  } {
    const br = ReaderUint8Array.makeReader(bin)
    const inputs: Array<{ vin: number, offset: number, length: number }> = []
    const outputs: Array<{ vout: number, offset: number, length: number }> = []

    br.pos += 4 // version
    const inputsLength = br.readVarIntNum()
    for (let i = 0; i < inputsLength; i++) {
      br.pos += 36 // txid and vout
      const scriptLength = br.readVarIntNum()
      inputs.push({ vin: i, offset: br.pos, length: scriptLength })
      br.pos += scriptLength + 4 // script and sequence
    }
    const outputsLength = br.readVarIntNum()
    for (let i = 0; i < outputsLength; i++) {
      br.pos += 8 // satoshis
      const scriptLength = br.readVarIntNum()
      outputs.push({ vout: i, offset: br.pos, length: scriptLength })
      br.pos += scriptLength
    }
    return { inputs, outputs }
  }

  static fromReader (br: Reader | ReaderUint8Array): Transaction {
    return Transaction.fromReaderInternal(br, false)
  }

  private static fromReaderInternal (br: Reader | ReaderUint8Array, zeroCopyScripts: boolean): Transaction {
    const version = br.readUInt32LE()
    const inputsLength = br.readVarIntNum()
    const inputs: TransactionInput[] = []
    for (let i = 0; i < inputsLength; i++) {
      const sourceTXID = toHex(br.readReverse(32))
      const sourceOutputIndex = br.readUInt32LE()
      const scriptLength = br.readVarIntNum()
      const scriptBin = zeroCopyScripts && br instanceof ReaderUint8Array
        ? br.readView(scriptLength)
        : br.read(scriptLength)
      const unlockingScript = zeroCopyScripts && scriptBin instanceof Uint8Array
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
    const outputsLength = br.readVarIntNum()
    const outputs: TransactionOutput[] = []
    for (let i = 0; i < outputsLength; i++) {
      const satoshis = br.readUInt64LEBn().toNumber()
      const scriptLength = br.readVarIntNum()
      const scriptBin = zeroCopyScripts && br instanceof ReaderUint8Array
        ? br.readView(scriptLength)
        : br.read(scriptLength)
      const lockingScript = zeroCopyScripts && scriptBin instanceof Uint8Array
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
  static fromBinary (bin: number[] | Uint8Array): Transaction {
    const rawBytes = Uint8Array.from(bin)
    const br = new ReaderUint8Array(rawBytes)
    const tx = Transaction.fromReaderInternal(br, true)
    tx.rawBytesCache = rawBytes
    tx.captureSerializationState()
    return tx
  }

  /**
   * Parses a transaction while retaining zero-copy views over `bin` for the raw
   * transaction and its scripts. The caller must not mutate `bin`.
   */
  static fromBinaryView (bin: Uint8Array): Transaction {
    const br = new ReaderUint8Array(bin)
    const tx = Transaction.fromReaderInternal(br, true)
    if (!br.eof()) throw new Error('Serialized transaction contains trailing data')
    tx.rawBytesCache = bin
    tx.captureSerializationState()
    return tx
  }

  /**
   * Creates a Transaction instance from a hexadecimal string.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHex (hex: string): Transaction {
    const rawBytes = toUint8Array(hex, 'hex')
    const br = new ReaderUint8Array(rawBytes)
    const tx = Transaction.fromReaderInternal(br, true)
    tx.rawBytesCache = rawBytes
    tx.hexCache = toHex(rawBytes)
    tx.captureSerializationState()
    return tx
  }

  /**
   * Creates a Transaction instance from a hexadecimal string encoded EF.
   *
   * @static
   * @param {string} hex - The hexadecimal string representation of the transaction EF.
   * @returns {Transaction} - A new Transaction instance.
   */
  static fromHexEF (hex: string): Transaction {
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
  static fromHexBEEF (hex: string, txid?: string): Transaction {
    return Transaction.fromBEEF(toArray(hex, 'hex'), txid)
  }

  constructor (
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

  private invalidateSerializationCaches (): void {
    this.cachedHash = undefined
    this.cachedIdHex = undefined
    this.rawBytesCache = undefined
    this.efBytesCache = undefined
    this.hexCache = undefined
    this.rawCacheState = undefined
  }

  private sourceTransactionId (input: TransactionInput): string | undefined {
    return input.sourceTXID == null ? input.sourceTransaction?.id('hex') : undefined
  }

  private captureSerializationState (): void {
    this.rawCacheState = {
      version: this.version,
      lockTime: this.lockTime,
      inputs: this.inputs.map(ref => {
        const sourceOutput = ref.sourceTransaction?.outputs[ref.sourceOutputIndex]
        return {
          ref,
          sourceTXID: ref.sourceTXID,
          sourceTransactionId: this.sourceTransactionId(ref),
          sourceOutputIndex: ref.sourceOutputIndex,
          sequence: ref.sequence,
          unlockingScript: ref.unlockingScript,
          unlockingScriptBytes: ref.unlockingScript?.toUint8Array(),
          sourceOutput,
          sourceSatoshis: sourceOutput?.satoshis,
          sourceLockingScript: sourceOutput?.lockingScript,
          sourceLockingScriptBytes: sourceOutput?.lockingScript.toUint8Array()
        }
      }),
      outputs: this.outputs.map(ref => ({
        ref,
        satoshis: ref.satoshis,
        lockingScript: ref.lockingScript,
        lockingScriptBytes: ref.lockingScript.toUint8Array()
      }))
    }
  }

  private serializationCacheMatchesState (): boolean {
    const cached = this.rawCacheState
    if (
      cached == null ||
      cached.version !== this.version ||
      cached.lockTime !== this.lockTime ||
      cached.inputs.length !== this.inputs.length ||
      cached.outputs.length !== this.outputs.length
    ) return false

    for (let i = 0; i < this.inputs.length; i++) {
      const input = this.inputs[i]
      const state = cached.inputs[i]
      const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      if (
        state.ref !== input ||
        state.sourceTXID !== input.sourceTXID ||
        state.sourceTransactionId !== this.sourceTransactionId(input) ||
        state.sourceOutputIndex !== input.sourceOutputIndex ||
        state.sequence !== input.sequence ||
        state.unlockingScript !== input.unlockingScript ||
        state.unlockingScriptBytes !== input.unlockingScript?.toUint8Array() ||
        state.sourceOutput !== sourceOutput ||
        state.sourceSatoshis !== sourceOutput?.satoshis ||
        state.sourceLockingScript !== sourceOutput?.lockingScript ||
        state.sourceLockingScriptBytes !== sourceOutput?.lockingScript.toUint8Array()
      ) return false
    }

    for (let i = 0; i < this.outputs.length; i++) {
      const output = this.outputs[i]
      const state = cached.outputs[i]
      if (
        state.ref !== output ||
        state.satoshis !== output.satoshis ||
        state.lockingScript !== output.lockingScript ||
        state.lockingScriptBytes !== output.lockingScript.toUint8Array()
      ) return false
    }
    return true
  }

  /**
   * Adds a new input to the transaction.
   *
   * @param {TransactionInput} input - The TransactionInput object to add to the transaction.
   * @throws {Error} - If the input does not have a sourceTXID or sourceTransaction defined.
   */
  addInput (input: TransactionInput): void {
    if (
      input.sourceTXID === undefined &&
      input.sourceTransaction === undefined
    ) {
      throw new TypeError(
        'A reference to an an input transaction is required. If the input transaction itself cannot be referenced, its TXID must still be provided.'
      )
    }
    // If the input sequence number hasn't been set, the expectation is that it is final.
    input.sequence ??= 0xffffffff
    this.invalidateSerializationCaches()
    this.inputs.push(input)
  }

  /**
   * Adds a new output to the transaction.
   *
   * @param {TransactionOutput} output - The TransactionOutput object to add to the transaction.
   */
  addOutput (output: TransactionOutput): void {
    this.invalidateSerializationCaches()
    if (output.change !== true) {
      if (output.satoshis === undefined) {
        throw new TypeError(
          'either satoshis must be defined or change must be set to true'
        )
      }
      if (output.satoshis < 0) { throw new Error('satoshis must be a positive integer or zero') }
    }
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
  addP2PKHOutput (address: number[] | string, satoshis?: number): void {
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
  updateMetadata (metadata: Record<string, any>): void {
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
  async fee (
    modelOrFee: FeeModel | number = LivePolicy.getInstance(),
    changeDistribution: 'equal' | 'random' = 'equal'
  ): Promise<void> {
    this.invalidateSerializationCaches()
    if (typeof modelOrFee === 'number') {
      const sats = modelOrFee
      modelOrFee = {
        computeFee: async () => sats
      }
    }
    const fee = await modelOrFee.computeFee(this)
    const change = this.calculateChange(fee)
    if (change <= 0) {
      this.outputs = this.outputs.filter((output) => output.change !== true)
      return
    }
    this.distributeChange(change, changeDistribution)
  }

  private calculateChange (fee: number): number {
    let change = 0
    for (const input of this.inputs) {
      if (typeof input.sourceTransaction !== 'object') {
        throw new TypeError(
          'Source transactions are required for all inputs during fee computation'
        )
      }
      change +=
        input.sourceTransaction.outputs[input.sourceOutputIndex].satoshis ?? 0
    }
    change -= fee
    for (const out of this.outputs) {
      if (out.change !== true) {
        if (out.satoshis !== undefined) {
          change -= out.satoshis
        }
      }
    }
    return change
  }

  private distributeChange (
    change: number,
    changeDistribution: 'equal' | 'random'
  ): void {
    let distributedChange = 0
    const changeOutputs = this.outputs.filter((out) => out.change)
    if (changeDistribution === 'random') {
      distributedChange = this.distributeRandomChange(change, changeOutputs)
    } else if (changeDistribution === 'equal') {
      distributedChange = this.distributeEqualChange(change, changeOutputs)
    }
    if (distributedChange < change) {
      const lastOutput = this.outputs.at(-1)
      if (lastOutput.satoshis === undefined) {
        lastOutput.satoshis = change - distributedChange
      } else {
        lastOutput.satoshis += change - distributedChange
      }
    }
  }

  private distributeRandomChange (
    change: number,
    changeOutputs: TransactionOutput[]
  ): number {
    let distributedChange = 0
    let changeToUse = change
    const benfordNumbers = new Array(changeOutputs.length).fill(1)
    changeToUse -= changeOutputs.length
    distributedChange += changeOutputs.length
    for (let i = 0; i < changeOutputs.length - 1; i++) {
      const portion: number = this.benfordNumber(0, changeToUse)
      benfordNumbers[i] = (benfordNumbers[i] as number) + portion
      distributedChange += portion
      changeToUse -= portion
    }
    for (const output of this.outputs) {
      if (output.change === true) output.satoshis = benfordNumbers.shift()
    }
    return distributedChange
  }

  private distributeEqualChange (
    change: number,
    changeOutputs: TransactionOutput[]
  ): number {
    let distributedChange = 0
    const perOutput = Math.floor(change / changeOutputs.length)
    for (const out of changeOutputs) {
      distributedChange += perOutput
      out.satoshis = perOutput
    }
    return distributedChange
  }

  private benfordNumber (min: number, max: number): number {
    const d = Random(1)[0] % 9 + 1
    return Math.floor(
      min + ((max - min) * Math.log10(1 + 1 / d)) / Math.log10(10)
    )
  }

  /**
   * Utility method that returns the current fee based on inputs and outputs
   *
   * @returns The current transaction fee
   */
  getFee (): number {
    let totalIn = 0
    for (const input of this.inputs) {
      if (typeof input.sourceTransaction !== 'object') {
        throw new TypeError(
          'Source transactions or sourceSatoshis are required for all inputs to calculate fee'
        )
      }
      totalIn +=
        input.sourceTransaction.outputs[input.sourceOutputIndex].satoshis ?? 0
    }
    let totalOut = 0
    for (const output of this.outputs) {
      totalOut += output.satoshis ?? 0
    }
    return totalIn - totalOut
  }

  /**
   * Signs a transaction, hydrating all its unlocking scripts based on the provided script templates where they are available.
   * @param options - Signing behavior. Set `skipExistingSignatures` to preserve inputs that already have an unlocking script.
   */
  async sign (options: { skipExistingSignatures?: boolean } = {}): Promise<void> {
    this.invalidateSerializationCaches()
    for (const out of this.outputs) {
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
    }
    this.materializeSourceTXIDs()
    const previousCache = this.activeSignatureHashCache
    this.activeSignatureHashCache = { hashOutputsSingle: new Map() }
    let unlockingScripts: Array<UnlockingScript | undefined>
    try {
      unlockingScripts = await Promise.all(
        this.inputs.map(async (x, i): Promise<UnlockingScript | undefined> => {
          if (options.skipExistingSignatures === true && this.inputs[i].unlockingScript != null) {
            return this.inputs[i].unlockingScript
          }
          if (typeof this.inputs[i].unlockingScriptTemplate === 'object') {
            return await this.inputs[i]?.unlockingScriptTemplate?.sign(this, i)
          } else {
            return await Promise.resolve(undefined)
          }
        })
      )
    } finally {
      this.activeSignatureHashCache = previousCache
    }
    for (let i = 0, l = this.inputs.length; i < l; i++) {
      if (typeof this.inputs[i].unlockingScriptTemplate === 'object') {
        this.inputs[i].unlockingScript = unlockingScripts[i]
      }
    }
    // A custom template may serialize the transaction while signing. Ensure
    // bytes cached during template execution cannot survive script hydration.
    this.invalidateSerializationCaches()
  }

  /**
   * Broadcasts a transaction.
   *
   * @param broadcaster The Broadcaster instance wwhere the transaction will be sent
   * @returns A BroadcastResponse or BroadcastFailure from the Broadcaster
   */
  async broadcast (
    broadcaster: Broadcaster = defaultBroadcaster()
  ): Promise<BroadcastResponse | BroadcastFailure> {
    return await broadcaster.broadcast(this)
  }

  private writeTransactionBody (writer: Writer | WriterUint8Array): void {
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
        writer.writeReverse(toArray(i.sourceTXID, 'hex'))
      }
      writer.writeUInt32LE(i.sourceOutputIndex)
      if (i.unlockingScript == null) {
        throw new Error('unlockingScript is undefined')
      }
      const scriptBin = i.unlockingScript.toUint8Array()
      writer.writeVarIntNum(scriptBin.length)
      writer.write(scriptBin)
      writer.writeUInt32LE(i.sequence ?? 0xffffffff)
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

  private buildSerializedBytes (): Uint8Array {
    const writer = new WriterUint8Array()
    this.writeTransactionBody(writer)
    return writer.toUint8Array()
  }

  private getSerializedBytes (): Uint8Array {
    if (this.rawBytesCache == null || !this.serializationCacheMatchesState()) {
      this.invalidateSerializationCaches()
      this.rawBytesCache = this.buildSerializedBytes()
      this.captureSerializationState()
    }
    return this.rawBytesCache
  }

  /**
   * Converts the transaction to a binary array format.
   *
   * @returns {number[]} - The binary array representation of the transaction.
   */
  toBinary (): number[] {
    return Array.from(this.getSerializedBytes())
  }

  toUint8Array (): Uint8Array {
    return this.getSerializedBytes()
  }

  private writeEF (writer: Writer | WriterUint8Array): void {
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
      writer.writeUInt64LE(
        i.sourceTransaction.outputs[i.sourceOutputIndex].satoshis ?? 0
      )
      const lockingScriptBin =
        i.sourceTransaction.outputs[
          i.sourceOutputIndex
        ].lockingScript.toUint8Array()
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
  toEF (): number[] {
    return Array.from(this.getEFBytes())
  }

  /**
   * Converts the transaction to a BRC-30 EF format.
   *
   * @remarks This is an alias for {@link toEFBinary}. The returned view is
   * memoized for verifier hot paths and must be treated as immutable.
   *
   * @returns {Uint8Array} - The BRC-30 EF representation of the transaction.
   */
  toEFUint8Array (): Uint8Array {
    return this.toEFBinary()
  }

  private getEFBytes (): Uint8Array {
    if (this.efBytesCache == null || !this.serializationCacheMatchesState()) {
      this.invalidateSerializationCaches()
      const writer = new WriterUint8Array()
      this.writeEF(writer)
      this.efBytesCache = writer.toUint8Array()
      this.captureSerializationState()
    }
    return this.efBytesCache
  }

  /**
   * Converts the transaction to a memoized BRC-30 EF byte array.
   *
   * @remarks The returned view is reused until transaction or referenced
   * source-output serialization state changes. Treat it as immutable; call
   * `.slice()` when an independently mutable copy is required.
   *
   * @returns {Uint8Array} The cached BRC-30 EF representation.
   */
  toEFBinary (): Uint8Array {
    return this.getEFBytes()
  }

  /**
   * Converts the transaction to a hexadecimal string EF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction EF.
   */
  toHexEF (): string {
    return toHex(this.toEFBinary())
  }

  /**
   * Converts the transaction to a hexadecimal string format.
   *
   * @returns {string} - The hexadecimal string representation of the transaction.
   */
  toHex (): string {
    const bytes = this.getSerializedBytes()
    if (this.hexCache != null) return this.hexCache
    const hex = toHex(bytes)
    this.hexCache = hex
    return hex
  }

  /**
   * Converts the transaction to a hexadecimal string BEEF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction BEEF.
   */
  toHexBEEF (): string {
    return toHex(this.toBEEF())
  }

  /**
   * Converts the transaction to a hexadecimal string Atomic BEEF.
   *
   * @returns {string} - The hexadecimal string representation of the transaction Atomic BEEF.
   */
  toHexAtomicBEEF (): string {
    return toHex(this.toAtomicBEEF())
  }

  /**
   * Calculates the transaction's hash.
   *
   * @param {'hex' | undefined} enc - The encoding to use for the hash. If 'hex', returns a hexadecimal string; otherwise returns a binary array.
   * @returns {string | number[]} - The hash of the transaction in the specified format.
   */
  hash (enc?: 'hex'): number[] | string {
    const bytes = this.getSerializedBytes()
    this.cachedHash ??= hash256(bytes)
    if (enc === 'hex') {
      return toHex(this.cachedHash)
    }
    return Array.from(this.cachedHash)
  }

  /**
   * Calculates the transaction's ID in binary array.
   *
   * @returns {number[]} - The ID of the transaction in the binary array format.
   */
  id (): number[]
  /**
   * Calculates the transaction's ID in hexadecimal format.
   *
   * @param {'hex'} enc - The encoding to use for the ID. If 'hex', returns a hexadecimal string.
   * @returns {string} - The ID of the transaction in the hex format.
   */
  id (enc: 'hex'): string
  /**
   * Calculates the transaction's ID.
   *
   * @param {'hex' | undefined} enc - The encoding to use for the ID. If 'hex', returns a hexadecimal string; otherwise returns a binary array.
   * @returns {string | number[]} - The ID of the transaction in the specified format.
   */
  id (enc?: 'hex'): number[] | string {
    // Validate public mutable transaction state before consulting either ID
    // cache. getSerializedBytes() clears both when any signed field changed.
    this.getSerializedBytes()
    if (enc === 'hex' && this.cachedIdHex != null) return this.cachedIdHex
    const id = [...(this.hash() as number[])]
    id.reverse()
    if (enc === 'hex') {
      this.cachedIdHex = toHex(id)
      return this.cachedIdHex
    }
    return id
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
  async verify (
    chainTracker: ChainTracker | 'scripts only' = defaultChainTracker(),
    feeModel?: FeeModel,
    memoryLimit?: number,
    verifier?: BdkVerifierInterface
  ): Promise<boolean> {
    const scriptsOnly = chainTracker === 'scripts only'
    const selectedVerifier = verifier ?? scriptVerificationBackend()
    if (!scriptsOnly) this.materializeSourceTXIDs()
    const verifiedTxids = new Set<string>()
    const verifiedTransactions = new Set<Transaction>()
    const txQueue: Transaction[] = [this]
    const queuedTxids = new Set<string>()
    if (!scriptsOnly) queuedTxids.add(this.id('hex'))
    const queuedTransactions = new Set<Transaction>(txQueue)
    const verifierQueue: Array<{
      tx: Transaction
      blockHeight: number
      consensus: boolean
      memoryLimit?: number
    }> = []
    let queueIndex = 0

    while (queueIndex < txQueue.length) {
      const tx = txQueue[queueIndex++]
      let txid: string | undefined
      const getTxid = (): string => {
        txid ??= tx.id('hex')
        return txid
      }
      if (scriptsOnly ? verifiedTransactions.has(tx) : verifiedTxids.has(getTxid())) {
        continue
      }

      // If the transaction has a valid merkle path, verification is complete.
      if (typeof tx.merklePath === 'object') {
        if (scriptsOnly) {
          verifiedTransactions.add(tx)
          continue
        } else {
          const proofValid = await tx.merklePath.verify(getTxid(), chainTracker)
          // If the proof is valid, no need to verify inputs.
          if (proofValid) {
            verifiedTxids.add(getTxid())
            continue
          } else {
            throw new Error(`Invalid merkle path for transaction ${getTxid()}`)
          }
        }
      }

      // Verify fee if feeModel is provided
      if (feeModel !== undefined) {
        if (tx === undefined) {
          throw new Error('Transaction is undefined')
        }
        const cpTx = Transaction.fromEF(tx.toEF())
        delete cpTx.outputs[0].satoshis
        cpTx.outputs[0].change = true
        await cpTx.fee(feeModel)
        if (tx.getFee() < cpTx.getFee()) {
          throw new Error(
            `Verification failed because the transaction ${getTxid()} has an insufficient fee and has not been mined.`
          )
        }
      }

      const verifierParams = {
        tx,
        blockHeight: POST_CHRONICLE_HEIGHT_FALLBACK,
        // Transaction version is script data, not a policy/consensus selector.
        // Graph verification establishes consensus validity by default.
        consensus: true,
        ...(memoryLimit === undefined ? {} : { memoryLimit })
      } as const
      const useVerifier = selectedVerifier !== undefined &&
        (memoryLimit === undefined || selectedVerifier.supportsMemoryLimit === true) &&
        (selectedVerifier.shouldVerifyScripts?.(verifierParams) ?? true)

      // Verify each input transaction and evaluate the spend events.
      // Also, keep a total of the input amounts for later.
      let inputTotal = 0
      const sigHashCache: SignatureHashCache = { hashOutputsSingle: new Map() }
      for (let i = 0; i < tx.inputs.length; i++) {
        const input = tx.inputs[i]
        if (typeof input.sourceTransaction !== 'object') {
          throw new TypeError(
            `Verification failed because the input at index ${i} of transaction ${getTxid()} is missing an associated source transaction. This source transaction is required for transaction verification because there is no merkle proof for the transaction spending a UTXO it contains.`
          )
        }
        if (typeof input.unlockingScript !== 'object') {
          throw new TypeError(
            `Verification failed because the input at index ${i} of transaction ${getTxid()} is missing an associated unlocking script. This script is required for transaction verification because there is no merkle proof for the transaction spending the UTXO.`
          )
        }
        const sourceOutput =
          input.sourceTransaction.outputs[input.sourceOutputIndex]
        inputTotal += sourceOutput.satoshis ?? 0

        const sourceTransaction = input.sourceTransaction
        const sourceTxid = scriptsOnly && input.sourceTXID !== undefined
          ? input.sourceTXID
          : sourceTransaction.id('hex')
        if (scriptsOnly) {
          if (!verifiedTransactions.has(sourceTransaction) && !queuedTransactions.has(sourceTransaction)) {
            txQueue.push(sourceTransaction)
            queuedTransactions.add(sourceTransaction)
          }
        } else if (!verifiedTxids.has(sourceTxid) && !queuedTxids.has(sourceTxid)) {
          txQueue.push(sourceTransaction)
          queuedTxids.add(sourceTxid)
        }

        input.sourceTXID ??= sourceTxid

        if (!useVerifier) {
          const spend = new Spend({
            sourceTXID: input.sourceTXID,
            sourceOutputIndex: input.sourceOutputIndex,
            lockingScript: sourceOutput.lockingScript,
            sourceSatoshis: sourceOutput.satoshis ?? 0,
            transactionVersion: tx.version,
            otherInputs: [],
            allInputs: tx.inputs,
            unlockingScript: input.unlockingScript,
            inputSequence: input.sequence ?? 0xffffffff, // default to max sequence
            inputIndex: i,
            outputs: tx.outputs,
            lockTime: tx.lockTime,
            memoryLimit,
            sigHashCache
          })
          const spendValid = spend.validateJavaScript()

          if (!spendValid) {
            return false
          }
        }
      }

      // When the selected pluggable verifier accepts the transaction, hand the
      // whole transaction to it once. Its verdict is authoritative and any
      // thrown error propagates (no post-selection JavaScript fallback).
      if (useVerifier) {
        // A tx reaching here has no merkle proof (mined txs short-circuit above),
        // so its source UTXO mined-height is unobtainable -> post-Chronicle fallback.
        verifierQueue.push(verifierParams)
      }

      // Total the outputs to ensure they don't amount to more than the inputs
      let outputTotal = 0
      for (const out of tx.outputs) {
        if (typeof out.satoshis !== 'number') {
          throw new TypeError(
            'Every output must have a defined amount during transaction verification.'
          )
        }
        outputTotal += out.satoshis
      }

      if (outputTotal > inputTotal) {
        return false
      }

      if (scriptsOnly) verifiedTransactions.add(tx)
      else verifiedTxids.add(getTxid())
    }

    if (verifierQueue.length > 0 && selectedVerifier !== undefined) {
      const scriptVerdicts = selectedVerifier.verifyScriptsBatch === undefined
        ? await Promise.all(verifierQueue.map(
          async params => await selectedVerifier.verifyScripts(params)
        ))
        : await selectedVerifier.verifyScriptsBatch(verifierQueue)
      if (scriptVerdicts.length !== verifierQueue.length) {
        throw new Error('Script verifier returned an invalid batch result count')
      }
      const failedIndex = scriptVerdicts.findIndex(valid => !valid)
      if (failedIndex >= 0) {
        throw new Error(
          `Script verification failed for transaction ${verifierQueue[failedIndex].tx.id('hex')}`
        )
      }
    }

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
  writeSerializedBEEF (writer: Writer | WriterUint8Array, allowPartial?: boolean): void {
    this.materializeSourceTXIDs()
    writer.writeUInt32LE(BEEF_V1)
    const BUMPs: MerklePath[] = []
    const bumpIndexByInstance = new Map<MerklePath, number>()
    const bumpIndexByRoot = new Map<string, number>()
    const txs: Array<{ tx: Transaction, pathIndex?: number }> = []
    const seenTxids = new Set<string>()

    const getBumpIndex = (merklePath: MerklePath): number => {
      const existingByInstance = bumpIndexByInstance.get(merklePath)
      if (existingByInstance !== undefined) {
        return existingByInstance
      }

      const key = `${merklePath.blockHeight}:${merklePath.computeRoot()}`
      const existingByRoot = bumpIndexByRoot.get(key)
      if (existingByRoot !== undefined) {
        BUMPs[existingByRoot].combine(merklePath)
        bumpIndexByInstance.set(merklePath, existingByRoot)
        return existingByRoot
      }

      const newIndex = BUMPs.length
      BUMPs.push(merklePath)
      bumpIndexByInstance.set(merklePath, newIndex)
      bumpIndexByRoot.set(key, newIndex)
      return newIndex
    }

    const scheduledTxids = new Set<string>()
    const stack: Array<{ tx: Transaction, expanded: boolean }> = [{ tx: this, expanded: false }]
    while (stack.length > 0) {
      const frame = stack.pop()
      if (frame == null) continue
      const txid = frame.tx.id('hex')
      if (frame.expanded) {
        if (seenTxids.has(txid)) continue
        const obj: { tx: Transaction, pathIndex?: number } = { tx: frame.tx }
        if (frame.tx.merklePath != null) obj.pathIndex = getBumpIndex(frame.tx.merklePath)
        seenTxids.add(txid)
        txs.push(obj)
        continue
      }
      if (scheduledTxids.has(txid)) continue
      scheduledTxids.add(txid)
      stack.push({ tx: frame.tx, expanded: true })
      if (frame.tx.merklePath == null) {
        for (let i = 0; i < frame.tx.inputs.length; i++) {
          const source = frame.tx.inputs[i].sourceTransaction
          if (source != null) stack.push({ tx: source, expanded: false })
          else if (allowPartial === false) throw new Error('A required source transaction is missing!')
        }
      }
    }

    writer.writeVarIntNum(BUMPs.length)
    let bumpBytes: Uint8Array[] | undefined
    if (writer instanceof WriterUint8Array) {
      bumpBytes = BUMPs.map(bump => bump.toBinaryUint8Array())
      let remainingBytes = 16
      for (const bytes of bumpBytes) remainingBytes += bytes.length
      for (const item of txs) remainingBytes += item.tx.toUint8Array().length + 10
      writer.reserve(remainingBytes)
    }
    for (let i = 0; i < BUMPs.length; i++) {
      writer.write(bumpBytes?.[i] ?? BUMPs[i].toBinary())
    }
    writer.writeVarIntNum(txs.length)
    for (const t of txs) {
      writer.write(t.tx.toUint8Array())
      if (typeof t.pathIndex === 'number') {
        writer.writeUInt8(1)
        writer.writeVarIntNum(t.pathIndex)
      } else {
        writer.writeUInt8(0)
      }
    }
  }

  /**
   * Serializes this transaction, together with its inputs and the respective merkle proofs, into the BEEF (BRC-62) format. This enables efficient verification of its compliance with the rules of SPV.
   *
   * @param allowPartial If true, error will not be thrown if there are any missing sourceTransactions.
   *
   * @returns {number[]} The serialized BEEF structure
   * @throws Error if there are any missing sourceTransactions unless `allowPartial` is true.
   */
  toBEEF (allowPartial?: boolean): number[] {
    const writer = new Writer()
    this.writeSerializedBEEF(writer, allowPartial)
    return writer.toArray()
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
  toBEEFUint8Array (allowPartial?: boolean): Uint8Array {
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
  toBEEFBytes (allowPartial?: boolean): Uint8Array {
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
  toAtomicBEEF (allowPartial?: boolean): number[] {
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
  toAtomicBEEFUint8Array (allowPartial?: boolean): Uint8Array {
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
  async completeWithWallet (wallet: WalletInterface, actionDescription?: DescriptionString5to50Bytes, originator?: string, options?: CreateActionOptions): Promise<void> {
    const inputCount = this.inputs.length
    const outputCount = this.outputs.length
    const description = actionDescription ?? `Transaction with ${inputCount} input(s) and ${outputCount} output(s)`

    const actionArgs: CreateActionArgs = {
      description,
      inputs: [] as any[],
      outputs: [] as any[],
      lockTime: this.lockTime,
      version: this.version
    }

    // Check if any input has an unlocking script template
    const hasTemplates = this.inputs.some(input => input.unlockingScriptTemplate != null)

    this.materializeSourceTXIDs()
    // Process inputs and merge the shared source graph once.
    const beefData = new Beef()
    for (let i = 0; i < this.inputs.length; i++) {
      const input = this.inputs[i]

      if (input.sourceTransaction == null) {
        throw new Error('All inputs must have a sourceTransaction when using completeWithWallet')
      }

      beefData.mergeTransaction(input.sourceTransaction)

      const sourceTXID = input.sourceTransaction.id('hex')

      const inputArg: any = {
        outpoint: `${sourceTXID}.${input.sourceOutputIndex}`,
        inputDescription: 'Input from source transaction',
        sequenceNumber: input.sequence
      }

      // Handle inputs with templates vs scripts
      if (hasTemplates) {
        // When using signAction flow, need to provide length for templates
        if (input.unlockingScriptTemplate != null) {
          const estimatedLength = await input.unlockingScriptTemplate.estimateLength(this, i)
          inputArg.unlockingScriptLength = estimatedLength
        } else if (input.unlockingScript != null) {
          // Still provide the script if it exists
          inputArg.unlockingScript = input.unlockingScript.toHex()
        } else {
          throw new Error(`Input ${i} must have either an unlockingScript or unlockingScriptTemplate`)
        }
      } else {
        // Original flow: all inputs must have unlocking scripts
        if (input.unlockingScript == null) {
          throw new Error('All inputs must have an unlockingScript when using completeWithWallet')
        }
        inputArg.unlockingScript = input.unlockingScript.toHex()
      }

      actionArgs.inputs.push(inputArg)
    }

    // Add inputBEEF if there are inputs
    if (this.inputs.length > 0) {
      actionArgs.inputBEEF = beefData.toUint8Array()
    }

    // Process outputs
    for (const output of this.outputs) {
      actionArgs.outputs.push({
        satoshis: output.satoshis,
        lockingScript: output.lockingScript.toHex(),
        outputDescription: 'Output from source transaction'
      })
    }

    // Add any labels from metadata if they exist
    if (this.metadata?.labels != null && Array.isArray(this.metadata.labels)) {
      actionArgs.labels = this.metadata.labels
    }

    let atomicBEEF: number[]

    // Use signAction flow for templates
    if (hasTemplates) {
      // Merge user options with required signAndProcess: false for template flow
      actionArgs.options = {
        ...options,
        signAndProcess: false
      }

      const { signableTransaction } = await wallet.createAction(actionArgs, originator)

      if (signableTransaction == null) {
        throw new Error('Wallet createAction did not return signableTransaction')
      }

      // Parse the signable transaction BEEF to get the unsigned transaction
      const partialTx = Transaction.fromBEEF(signableTransaction.tx)

      // Sign inputs with templates and collect all unlocking scripts
      const spends: Record<number, { unlockingScript: string }> = {}

      for (let i = 0; i < this.inputs.length; i++) {
        const input = this.inputs[i]

        if (input.unlockingScriptTemplate != null) {
          // Use the template to sign this input
          const unlockingScript = await input.unlockingScriptTemplate.sign(partialTx, i)
          spends[i] = {
            unlockingScript: unlockingScript.toHex()
          }
        } else if (input.unlockingScript != null) {
          // Include pre-existing unlocking scripts
          spends[i] = {
            unlockingScript: input.unlockingScript.toHex()
          }
        }
      }

      // Extract options that apply to signAction (subset of CreateActionOptions)
      const signActionOptions: SignActionOptions | undefined = options == null
        ? undefined
        : {
            acceptDelayedBroadcast: options.acceptDelayedBroadcast,
            returnTXIDOnly: options.returnTXIDOnly,
            noSend: options.noSend,
            sendWith: options.sendWith
          }

      // Call signAction with the generated unlocking scripts
      const signResult = await wallet.signAction({
        reference: signableTransaction.reference,
        spends,
        options: signActionOptions
      }, originator)

      if (signResult.tx == null) {
        throw new Error('Wallet signAction did not return transaction data')
      }

      atomicBEEF = signResult.tx
    } else {
      // Pass through user options for standard flow
      if (options != null) {
        actionArgs.options = options
      }

      const { tx } = await wallet.createAction(actionArgs, originator)

      if (tx == null) {
        throw new Error('Wallet createAction did not return transaction data')
      }

      atomicBEEF = tx
    }

    // Create a new transaction from the atomic BEEF
    const newTransaction = Transaction.fromAtomicBEEF(atomicBEEF)

    // Update this transaction's properties with the new transaction's properties
    this.version = newTransaction.version
    this.inputs = newTransaction.inputs
    this.outputs = newTransaction.outputs
    this.lockTime = newTransaction.lockTime
    this.merklePath = newTransaction.merklePath
    this.invalidateSerializationCaches()

    // Preserve metadata from the original transaction but update with any new metadata
    this.metadata = {
      ...this.metadata,
      ...newTransaction.metadata
    }
  }

  /**
   * Returns the formatted preimage of a transaction for the requested input index, signature scope (default SIGHASH_FORKID | SIGHASH_ALL), and optional subscript.
   * @param inputIndex - The index of the input to generate the preimage for
   * @param signatureScope - The signature scope to use for the preimage
   * @param subscript - The subscript to use for the preimage (optional)
   * @returns The formatted preimage
   */
  preimage (inputIndex?: number, signatureScope?: number, subscript?: LockingScript): number[] {
    inputIndex ??= 0
    signatureScope ??= TransactionSignature.SIGHASH_FORKID | TransactionSignature.SIGHASH_ALL
    if (inputIndex < 0 || inputIndex >= this.inputs.length) {
      throw new Error('Invalid input index')
    }
    const flags = signatureScope & 0xf0
    if (flags !== 224 && flags !== 192 && flags !== 64) {
      throw new Error('FORKID must be set')
    }
    const coverage = signatureScope & 0x0f
    if (coverage < 1 || coverage > 3) {
      throw new Error('Invalid signature coverage, must be all, none or single')
    }
    const input = this.inputs[inputIndex]
    if (input.sourceTransaction == null) {
      throw new Error('Source transaction is required')
    }
    const output = input.sourceTransaction.outputs[input.sourceOutputIndex]
    if (output == null) {
      throw new Error(`Source transaction's output at index ${input.sourceOutputIndex} is required`)
    }
    return TransactionSignature.format({
      sourceTXID: input.sourceTXID ?? input.sourceTransaction.id('hex'),
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: output.satoshis,
      transactionVersion: this.version,
      otherInputs: [],
      allInputs: this.inputs,
      inputIndex,
      outputs: this.outputs,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript: subscript ?? output.lockingScript,
      lockTime: this.lockTime,
      scope: signatureScope
    })
  }
}
