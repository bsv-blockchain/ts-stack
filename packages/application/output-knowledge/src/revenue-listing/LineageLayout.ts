import { BigNumber, Script, Utils, type Transaction } from '@bsv/sdk'
import { requireLineage } from './LineagePackage.js'

export function layout(tx: Transaction, genesis: boolean): void {
  requireLineage(
    (tx.version === 1 || tx.version === 2) && tx.lockTime === 0,
    'Invalid listing header'
  )
  requireLineage(
    tx.inputs.length >= (genesis ? 1 : 2) &&
      tx.inputs.length <= 8 &&
      tx.outputs.length >= 1 &&
      tx.outputs.length <= 11,
    'Listing dimensions exceed profile'
  )
  for (const input of tx.inputs)
    requireLineage(input.sequence === 0xffffffff, 'Non-final listing input')
  for (const output of tx.outputs)
    requireLineage(
      Number.isSafeInteger(output.satoshis) &&
        output.satoshis! >= 0 &&
        output.satoshis! <= 2100000000000000,
      'Invalid listing output value'
    )
}

/** Enforce the complete minimal-push ABI before running the authenticated program. */
export function operation(tx: Transaction, inputIndex: number): number {
  const script = tx.inputs[inputIndex].unlockingScript
  requireLineage(
    script !== undefined && script.chunks.length === 14,
    'Invalid listing unlocking ABI'
  )
  const values = script.chunks.map(chunk => {
    if (chunk.data !== undefined) return chunk.data
    if (chunk.op === 0) return []
    requireLineage(chunk.op >= 0x51 && chunk.op <= 0x60, 'Non-push listing argument')
    return [chunk.op - 0x50]
  })
  const canonical = new Script()
  for (const value of values) {
    if (value.length === 1 && value[0] >= 1 && value[0] <= 16) canonical.writeNumber(value[0])
    else canonical.writeBin(value)
  }
  requireLineage(canonical.toHex() === script.toHex(), 'Nonminimal listing argument')
  for (const index of [2, 5, 6, 13]) {
    const number = BigNumber.fromSm(values[index], 'little')
    requireLineage(
      !number.isNeg() && Utils.toHex(number.toSm('little')) === Utils.toHex(values[index]),
      'Noncanonical listing integer'
    )
  }
  requireLineage(
    values[2].length === 1 && values[2][0] >= 1 && values[2][0] <= 6,
    'Unknown listing route'
  )
  requireLineage(values[0].length === 40167, 'Invalid listing preimage size')
  return values[2][0]
}
