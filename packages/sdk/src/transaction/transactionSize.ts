/**
 * Returns the byte size of `val` encoded as a Bitcoin VarInt.
 *
 * @param val - A non-negative safe integer.
 * @returns 1, 3, 5 or 9.
 * @throws RangeError when `val` is negative or not a safe integer.
 */
export function varUintSize(val: number): 1 | 3 | 5 | 9 {
  if (!Number.isSafeInteger(val) || val < 0) {
    throw new RangeError('VarInt value must be a non-negative safe integer.')
  }
  if (val <= 0xfc) return 1
  if (val <= 0xffff) return 3
  if (val <= 0xffffffff) return 5
  return 9
}

/**
 * @param scriptSize - Byte length of the input's unlocking script.
 * @returns Serialized byte length of the input: txid, output index, script
 * length, script and sequence number.
 */
export function transactionInputSize(scriptSize: number): number {
  return 32 + 4 + varUintSize(scriptSize) + scriptSize + 4
}

/**
 * @param scriptSize - Byte length of the output's locking script.
 * @returns Serialized byte length of the output: satoshis, script length and
 * script.
 */
export function transactionOutputSize(scriptSize: number): number {
  return varUintSize(scriptSize) + scriptSize + 8
}

/**
 * Computes the serialized byte size of a transaction from the byte length of
 * each input's unlocking script and each output's locking script, so a fee can
 * be estimated before the transaction is built. `SatoshisPerKilobyte` sizes a
 * built transaction with this same function.
 *
 * @param inputs - Unlocking script lengths, one per input, in bytes.
 * @param outputs - Locking script lengths, one per output, in bytes.
 * @returns Total transaction size in bytes, including version and lock time.
 * @throws RangeError when a length is negative or not a safe integer.
 */
export function transactionSize(inputs: number[], outputs: number[]): number {
  return (
    4 + // version
    varUintSize(inputs.length) +
    inputs.reduce((a, e) => a + transactionInputSize(e), 0) +
    varUintSize(outputs.length) +
    outputs.reduce((a, e) => a + transactionOutputSize(e), 0) +
    4 // lock time
  )
}
