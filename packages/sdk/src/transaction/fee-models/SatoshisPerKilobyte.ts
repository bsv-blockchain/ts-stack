import FeeModel from '../FeeModel.js'
import Transaction from '../Transaction.js'
import { transactionSize } from '../transactionSize.js'

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
    // Collect the script lengths; transactionSize applies the serialization layout.
    const inputLengths: number[] = []
    for (let i = 0; i < tx.inputs.length; i++) {
      const input = tx.inputs[i]
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
      inputLengths.push(scriptLength)
    }
    const outputLengths = tx.outputs.map(out => out.lockingScript.toBinary().length)
    const size = transactionSize(inputLengths, outputLengths)
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
