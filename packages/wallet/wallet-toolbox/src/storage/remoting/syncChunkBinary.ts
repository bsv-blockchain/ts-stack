import type { SyncChunk } from '../../sdk/WalletStorage.interfaces'

const binaryFields = {
  provenTxs: ['rawTx', 'merklePath'],
  provenTxReqs: ['rawTx', 'inputBEEF'],
  transactions: ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx'],
  outputs: ['lockingScript'],
  commissions: ['lockingScript']
} as const

function isLargeByteArray(value: unknown): value is number[] {
  if (!Array.isArray(value) || value.length < 128) return false
  for (const byte of value) {
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) return false
  }
  return true
}

/** Copy one table's schema-defined byte fields for the already negotiated binary JSON codec. */
export function tableRowsBinary(
  table: keyof typeof binaryFields,
  rows: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  return rows.map(row => {
    const copy = { ...row }
    for (const field of binaryFields[table]) {
      if (isLargeByteArray(copy[field])) copy[field] = Uint8Array.from(copy[field])
    }
    return copy
  })
}

/** Copy schema-defined byte fields for the already negotiated binary JSON codec. */
export function syncChunkBinary(chunk: SyncChunk): Record<string, unknown> {
  const result: Record<string, unknown> = { ...chunk }
  for (const name of Object.keys(binaryFields) as Array<keyof typeof binaryFields>) {
    const rows: unknown = Reflect.get(chunk, name)
    if (Array.isArray(rows)) result[name] = tableRowsBinary(name, rows)
  }
  return result
}
