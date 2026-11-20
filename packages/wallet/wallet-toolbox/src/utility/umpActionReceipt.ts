import type { WalletInterface } from '@bsv/sdk'

type ReceiptReader = (operationId: string, originator: string) => Promise<number[] | undefined>

const receiptReaders = new WeakMap<WalletInterface, ReceiptReader>()

/** Local capability. A BRC-100 caller cannot invoke it by choosing an originator or action label. */
export function registerUMPActionReceiptReader(wallet: WalletInterface, read: ReceiptReader): void {
  receiptReaders.set(wallet, read)
}

export async function readUMPActionReceipt(
  wallet: WalletInterface,
  operationId: string,
  originator: string
): Promise<number[] | undefined> {
  if (!/^[0-9a-f]{32}$/.test(operationId)) throw new Error('Invalid UMP operation identifier.')
  return await receiptReaders.get(wallet)?.(operationId, originator)
}

export function umpUpdateActionLabel(operationId: string): string {
  return `ump-update:${operationId}`
}
