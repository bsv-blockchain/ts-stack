import { Transaction } from '@bsv/sdk'

const MAX_DISCOVERY_BEEF_BYTES = 64 * 1024 * 1024
const MAX_DISCOVERY_TRANSACTION_ITEMS = 100_000

/** Parses one strictly framed, resource-bounded discovery transaction. */
export function parseDiscoveryTransaction(value: unknown): Transaction {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_DISCOVERY_BEEF_BYTES
  ) {
    throw new Error('Discovery BEEF must be a bounded non-empty byte array')
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index)
    if (
      descriptor == null ||
      !('value' in descriptor) ||
      !Number.isInteger(descriptor.value) ||
      descriptor.value < 0 ||
      descriptor.value > 255
    ) {
      throw new Error('Discovery BEEF must be a dense byte array')
    }
  }
  const transaction = Transaction.fromBEEF(value)
  if (
    transaction.inputs.length > MAX_DISCOVERY_TRANSACTION_ITEMS ||
    transaction.outputs.length > MAX_DISCOVERY_TRANSACTION_ITEMS
  ) {
    throw new Error('Discovery transaction exceeds its input or output limit')
  }
  return transaction
}
