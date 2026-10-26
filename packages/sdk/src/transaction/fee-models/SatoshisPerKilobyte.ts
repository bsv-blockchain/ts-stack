import FeeModel from '../FeeModel.js'
import Transaction from '../Transaction.js'

/**
 * Represents the "satoshis per kilobyte" transaction fee model.
 */
export default class SatoshisPerKilobyte implements FeeModel {
  /**
   * @property
   * Denotes the number of satoshis paid per kilobyte of transaction size.
   */
  value: number

  /**
   * Constructs an instance of the sat/kb fee model.
   *
   * @param {number} value - The number of satoshis per kilobyte to charge as a fee.
   */
  constructor(value: number) {
    validateRate(value)
    this.value = value
  }

  /**
   * Computes the fee for a given transaction.
   *
   * @param tx The transaction for which a fee is to be computed.
   * @returns The fee in satoshis for the transaction, as a BigNumber.
   */
  async computeFee(tx: Transaction): Promise<number> {
    const rate = this.value
    validateRate(rate)
    const getVarIntSize = (i: number): number => {
      if (i > 0xffffffff) {
        return 9
      } else if (i > 0xffff) {
        return 5
      } else if (i >= 253) {
        return 3
      } else {
        return 1
      }
    }
    // Compute the (potentially estimated) size of the transaction
    let size = 4 // version
    size += getVarIntSize(tx.inputs.length) // number of inputs
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]
      size += 40 // txid, output index, sequence number
      let scriptLength: number
      if (typeof input.unlockingScript === 'object') {
        scriptLength = input.unlockingScript.toBinary().length
      } else if (typeof input.unlockingScriptTemplate === 'object') {
        scriptLength = await input.unlockingScriptTemplate.estimateLength(tx, i)
      } else {
        throw new TypeError(
          'All inputs must have an unlocking script or an unlocking script template for sat/kb fee computation.'
        )
      }
      if (!Number.isSafeInteger(scriptLength) || scriptLength < 0) {
        throw new RangeError('Unlocking script length must be a non-negative safe integer.')
      }
      size += getVarIntSize(scriptLength) // unlocking script length
      size += scriptLength // unlocking script
    }
    size += getVarIntSize(tx.outputs.length) // number of outputs
    for (const out of tx.outputs) {
      size += 8 // satoshis
      const length = out.lockingScript.toBinary().length
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new RangeError('Locking script length must be a non-negative safe integer.')
      }
      size += getVarIntSize(length) // script length
      size += length // script
    }
    size += 4 // lock time
    // We'll use Math.ceil to ensure the miners get the extra satoshi.
    const fee = Math.ceil((size / 1000) * rate)
    if (!Number.isSafeInteger(fee) || fee < 0 || fee > 21e14) {
      throw new RangeError('Computed transaction fee is outside the valid satoshi range.')
    }
    return fee
  }
}

function validateRate(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 21e14) {
    throw new RangeError('Satoshis-per-kilobyte rate must be finite and non-negative.')
  }
}
