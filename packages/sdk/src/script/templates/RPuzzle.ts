import OP from '../OP.js'
import ScriptTemplate from '../ScriptTemplate.js'
import LockingScript from '../LockingScript.js'
import UnlockingScript from '../UnlockingScript.js'
import Transaction from '../../transaction/Transaction.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import TransactionSignature from '../../primitives/TransactionSignature.js'
import { sha256 } from '../../primitives/Hash.js'
import ScriptChunk from '../ScriptChunk.js'
import BigNumber from '../../primitives/BigNumber.js'
import { computeSignatureScope, formatPreimage, resolveSourceDetails } from './SignatureUtils.js'

const R_PUZZLE_TYPES = new Set(['raw', 'SHA1', 'SHA256', 'HASH256', 'RIPEMD160', 'HASH160'])

/**
 * RPuzzle class implementing ScriptTemplate.
 *
 * This class provides methods to create R Puzzle and R Puzzle Hash locking and unlocking scripts, including the unlocking of UTXOs with the correct K value.
 */
export default class RPuzzle implements ScriptTemplate {
  type: 'raw' | 'SHA1' | 'SHA256' | 'HASH256' | 'RIPEMD160' | 'HASH160' = 'raw'

  /**
   * @constructor
   * Constructs an R Puzzle template instance for a given puzzle type
   *
   * @param {'raw'|'SHA1'|'SHA256'|'HASH256'|'RIPEMD160'|'HASH160'} type Denotes the type of puzzle to create
   */
  constructor(type: 'raw' | 'SHA1' | 'SHA256' | 'HASH256' | 'RIPEMD160' | 'HASH160' = 'raw') {
    if (!R_PUZZLE_TYPES.has(type)) throw new Error(`Unsupported R puzzle type: ${type as string}`)
    this.type = type
  }

  /**
   * Creates an R puzzle locking script for a given R value or R value hash.
   *
   * @param {number[]} value - An array representing the R value or its hash.
   * @returns {LockingScript} - An R puzzle locking script.
   */
  lock(value: number[]): LockingScript {
    if (!Array.isArray(value)) throw new TypeError('R puzzle value must be a dense byte array')
    for (let index = 0; index < value.length; index++) {
      const byte = value[index]
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new TypeError('R puzzle value must be a dense byte array')
      }
    }
    const chunks: ScriptChunk[] = [
      { op: OP.OP_OVER },
      { op: OP.OP_3 },
      { op: OP.OP_SPLIT },
      { op: OP.OP_NIP },
      { op: OP.OP_1 },
      { op: OP.OP_SPLIT },
      { op: OP.OP_SWAP },
      { op: OP.OP_SPLIT },
      { op: OP.OP_DROP }
    ]
    if (this.type !== 'raw') {
      chunks.push({
        op: OP['OP_' + this.type] as number
      })
    }
    chunks.push(
      { op: value.length, data: value },
      { op: OP.OP_EQUALVERIFY },
      { op: OP.OP_CHECKSIG }
    )
    return new LockingScript(chunks)
  }

  /**
   * Creates a function that generates an R puzzle unlocking script along with its signature and length estimation.
   *
   * The returned object contains:
   * 1. `sign` - A function that, when invoked with a transaction and an input index,
   *    produces an unlocking script suitable for an R puzzle locked output.
   * 2. `estimateLength` - A function that returns the estimated length of the unlocking script in bytes.
   *
   * @param {BigNumber} k — The K-value used to unlock the R-puzzle.
   * @param {PrivateKey} privateKey - The private key used for signing the transaction. If not provided, a random key will be generated.
   * @param {'all'|'none'|'single'} signOutputs - The signature scope for outputs.
   * @param {boolean} anyoneCanPay - Flag indicating if the signature allows for other inputs to be added later.
   * @returns {Object} - An object containing the `sign` and `estimateLength` functions.
   */
  unlock(
    k: BigNumber,
    privateKey: PrivateKey,
    signOutputs: 'all' | 'none' | 'single' = 'all',
    anyoneCanPay: boolean = false
  ): {
    sign: (tx: Transaction, inputIndex: number) => Promise<UnlockingScript>
    estimateLength: () => Promise<108>
  } {
    return {
      sign: async (tx: Transaction, inputIndex: number) => {
        privateKey ??= PrivateKey.fromRandom()
        const signatureScope = computeSignatureScope(signOutputs, anyoneCanPay)
        if (typeof tx.inputs[inputIndex]?.sourceTransaction !== 'object') {
          throw new TypeError('The source transaction is needed for transaction signing.')
        }
        const resolved = resolveSourceDetails(tx, inputIndex)
        const preimage = formatPreimage({
          tx,
          inputIndex,
          signatureScope,
          sourceTXID: resolved.sourceTXID,
          sourceSatoshis: resolved.sourceSatoshis,
          lockingScript: resolved.lockingScript,
          allInputs: resolved.allInputs
        })

        const rawSignature = privateKey.sign(sha256(preimage), undefined, true, k)
        const sig = new TransactionSignature(rawSignature.r, rawSignature.s, signatureScope)
        const sigForScript = sig.toChecksigFormat()
        const pubkeyForScript = privateKey.toPublicKey().encode(true) as number[]
        return new UnlockingScript([
          { op: sigForScript.length, data: sigForScript },
          { op: pubkeyForScript.length, data: pubkeyForScript }
        ])
      },
      estimateLength: async () => {
        // public key (1+33) + signature (1+73)
        // Note: We add 1 to each element's length because of the associated OP_PUSH
        return 108
      }
    }
  }
}
