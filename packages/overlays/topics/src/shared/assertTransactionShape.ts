import { Transaction } from '@bsv/sdk'

export function assertTransactionInputsAndOutputs(transaction: Transaction): void {
  if (!Array.isArray(transaction.inputs) || transaction.inputs.length < 1) {
    throw new Error('Transaction inputs must be valid')
  }
  if (!Array.isArray(transaction.outputs) || transaction.outputs.length < 1) {
    throw new Error('Transaction outputs must be valid')
  }
}
