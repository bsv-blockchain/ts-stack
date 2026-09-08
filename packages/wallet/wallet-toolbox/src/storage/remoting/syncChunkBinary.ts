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
  for (let i = 0; i < value.length; i++) {
    if (!Number.isInteger(value[i]) || value[i] < 0 || value[i] > 255) return false
  }
  return true
}

/** Copy schema-defined byte fields for the already negotiated binary JSON codec. */
export function syncChunkBinary(chunk: SyncChunk): Record<string, unknown> {
  const result: Record<string, unknown> = { ...chunk }
  for (const [name, fields] of Object.entries(binaryFields)) {
    const rows: unknown = Reflect.get(chunk, name)
    if (!Array.isArray(rows)) continue
    result[name] = rows.map((row: Record<string, unknown>) => {
      const copy = { ...row }
      for (const field of fields) {
        if (isLargeByteArray(copy[field])) copy[field] = Uint8Array.from(copy[field])
      }
      return copy
    })
  }
  return result
}
