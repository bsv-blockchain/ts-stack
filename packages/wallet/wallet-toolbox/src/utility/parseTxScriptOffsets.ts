import { Transaction } from '@bsv/sdk'

export interface TxScriptOffsets {
  inputs: Array<{ vin: number, offset: number, length: number }>
  outputs: Array<{ vout: number, offset: number, length: number }>
}

export function parseTxScriptOffsets (rawTx: number[] | Uint8Array): TxScriptOffsets {
  return Transaction.parseScriptOffsets(rawTx)
}
